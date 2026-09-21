SET LOCAL ROLE rpt_owner;

CREATE TABLE rpt.crm_import_batch (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 actor_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 source_filename text NOT NULL CHECK(length(source_filename) BETWEEN 1 AND 120),
 source_format text NOT NULL CHECK(source_format IN ('csv','xlsx')),
 file_hash text NOT NULL CHECK(file_hash ~ '^[0-9a-f]{64}$'),
 status text NOT NULL CHECK(status='completed'),
 total_rows integer NOT NULL CHECK(total_rows>=0),
 created_persons integer NOT NULL CHECK(created_persons>=0),
 linked_persons integer NOT NULL CHECK(linked_persons>=0),
 created_opportunities integer NOT NULL CHECK(created_opportunities>=0),
 rejected_rows integer NOT NULL CHECK(rejected_rows>=0),
 conflict_rows integer NOT NULL CHECK(conflict_rows>=0),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
 request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,actor_id,idempotency_key),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace
);

CREATE TABLE rpt.crm_import_item (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 batch_id uuid NOT NULL,
 row_number integer NOT NULL CHECK(row_number>=2),
 person_id uuid NOT NULL,
 opportunity_id uuid NOT NULL,
 person_resolution text NOT NULL CHECK(person_resolution IN ('created','linked')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,batch_id,row_number),
 FOREIGN KEY(tenant_id,batch_id) REFERENCES rpt.crm_import_batch,
 FOREIGN KEY(tenant_id,person_id) REFERENCES rpt.person,
 FOREIGN KEY(tenant_id,opportunity_id) REFERENCES rpt.opportunity
);

ALTER TABLE rpt.crm_import_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.crm_import_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_import_batch_read ON rpt.crm_import_batch FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id()
   AND authz.crm_workspace_right(workspace_id,'read'));
CREATE POLICY crm_import_batch_insert ON rpt.crm_import_batch FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id()
   AND authz.crm_workspace_right(workspace_id,'create'));
CREATE POLICY crm_import_item_read ON rpt.crm_import_item FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND EXISTS(
   SELECT 1 FROM rpt.crm_import_batch b WHERE b.tenant_id=crm_import_item.tenant_id
   AND b.id=crm_import_item.batch_id AND b.actor_id=authz.actor_id()
   AND authz.crm_workspace_right(b.workspace_id,'read')));
CREATE POLICY crm_import_item_insert ON rpt.crm_import_item FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND EXISTS(
   SELECT 1 FROM rpt.crm_import_batch b WHERE b.tenant_id=crm_import_item.tenant_id
   AND b.id=crm_import_item.batch_id AND b.actor_id=authz.actor_id()
   AND authz.crm_workspace_right(b.workspace_id,'create')));
GRANT SELECT,INSERT ON rpt.crm_import_batch,rpt.crm_import_item TO rpt_runtime;

CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON rpt.crm_import_batch
 FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON rpt.crm_import_item
 FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON rpt.crm_import_batch
 FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON rpt.crm_import_item
 FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE INDEX crm_import_batch_actor_idx
 ON rpt.crm_import_batch(tenant_id,actor_id,created_at DESC);
CREATE INDEX crm_import_item_batch_idx
 ON rpt.crm_import_item(tenant_id,batch_id,row_number);

-- Resolves exact tenant-local email/phone matches without returning PII. Multiple,
-- mismatched or unauthorized candidates are intentionally indistinguishable conflicts.
CREATE FUNCTION authz.crm_import_ready(p_workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.crm_workspace_right(p_workspace,'create')
   AND authz.capable(authz.actor_id(),'opportunity','create','CONFIDENTIAL')
   AND authz.capable(authz.actor_id(),'person','create','CONFIDENTIAL')
   AND authz.capable(authz.actor_id(),'person','update','RESTRICTED_PII')
$$;
CREATE FUNCTION authz.crm_import_resolve_person(
 p_workspace uuid,p_email text,p_phone text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE matches integer; candidate uuid; permitted boolean; mismatched boolean;
BEGIN
 IF NOT authz.crm_workspace_right(p_workspace,'create')
 OR (coalesce(p_email,'')='' AND coalesce(p_phone,'')='')
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 SELECT count(DISTINCT p.id),(array_agg(DISTINCT p.id))[1]
 INTO matches,candidate
 FROM rpt.person p JOIN rpt.person_pii pii
   ON (pii.tenant_id,pii.person_id)=(p.tenant_id,p.id)
 WHERE p.tenant_id=authz.tenant_id() AND p.workspace_id=p_workspace AND p.deleted_at IS NULL
   AND ((p_email<>'' AND lower(pii.email)=p_email) OR (p_phone<>'' AND pii.phone=p_phone));
 IF matches=0 THEN RETURN jsonb_build_object('status','none'); END IF;
 IF matches<>1 THEN RETURN jsonb_build_object('status','ambiguous'); END IF;
 SELECT authz.allowed('person',p.id,'read','CONFIDENTIAL'),
   (p_email<>'' AND coalesce(lower(pii.email),'')<>p_email)
   OR (p_phone<>'' AND coalesce(pii.phone,'')<>p_phone)
 INTO permitted,mismatched
 FROM rpt.person p JOIN rpt.person_pii pii
   ON (pii.tenant_id,pii.person_id)=(p.tenant_id,p.id)
 WHERE p.tenant_id=authz.tenant_id() AND p.id=candidate;
 IF NOT permitted OR mismatched THEN RETURN jsonb_build_object('status','ambiguous'); END IF;
 RETURN jsonb_build_object('status','match','personId',candidate);
END $$;
REVOKE ALL ON FUNCTION authz.crm_import_ready(uuid),authz.crm_import_resolve_person(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.crm_import_ready(uuid),authz.crm_import_resolve_person(uuid,text,text) TO rpt_runtime;

CREATE OR REPLACE FUNCTION authz.record_decision(p_object uuid,p_action text,p_result text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR p_action NOT IN ('person.read','person.update','metric.append','grant.create','grant.revoke','privacy.purge','network.stats','crm.context','crm.list','crm.detail','crm.onboard','crm.create','crm.command','crm.view','crm.metrics','crm.grant','crm.import.preview','crm.import.confirm','recruiting.context','recruiting.list','recruiting.detail','recruiting.create','recruiting.command') OR p_result NOT IN ('allow','deny','success','failure')
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO rpt.audit_event(tenant_id,actor_id,action,object_type,object_id,scope,policy_version,request_id,result,reason_code)
 VALUES(authz.tenant_id(),authz.actor_id(),p_action,'permission_decision',p_object,'request',(SELECT policy_version FROM authz.tenant WHERE id=authz.tenant_id()),nullif(current_setting('rpt.request_id',true),'')::uuid,p_result,'server_policy');
END $$;
