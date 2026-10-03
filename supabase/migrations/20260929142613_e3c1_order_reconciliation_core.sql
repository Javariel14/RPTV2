SET LOCAL ROLE rpt_owner;
-- Adapter-neutral, append-only Order evidence. The CRM simulation is deliberately excluded.
CREATE TABLE rpt.order_external_intake (
 tenant_id uuid NOT NULL, id uuid NOT NULL, workspace_id uuid NOT NULL, market_id uuid NOT NULL,
 source_system text NOT NULL CHECK(source_system IN ('HYCITE','INCITE','DOCUCITE','RPT_USER','IMPORT','API')),
 external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 160 AND authz.order_commercial_reason_valid(external_id)),
 source_reference text NOT NULL CHECK(length(source_reference) BETWEEN 1 AND 500 AND authz.order_commercial_reason_valid(source_reference)),
 observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),
 raw_hash text NOT NULL CHECK(raw_hash ~ '^[a-f0-9]{64}$'), correlation_id uuid NOT NULL,
 authority_level text NOT NULL CHECK(authority_level IN ('official','verified','authorized','import','manual')),
 authority_verified_at timestamptz,
 actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,source_system,external_id,raw_hash),
 UNIQUE(tenant_id,id,source_system,external_id),
 UNIQUE(tenant_id,id,source_system,external_id,workspace_id,market_id),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,market_id) REFERENCES rpt.market,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account,
 CHECK(authority_level<>'official' OR source_system NOT IN ('RPT_USER','IMPORT'))
);
CREATE INDEX order_external_intake_history ON rpt.order_external_intake(tenant_id,source_system,external_id,created_at,id);
ALTER TABLE rpt.cpq_order ADD CONSTRAINT cpq_order_scope_identity UNIQUE(tenant_id,id,workspace_id,market_id);
CREATE TABLE rpt.order_external_binding (
 tenant_id uuid NOT NULL, source_system text NOT NULL, external_id text NOT NULL,
 order_id uuid NOT NULL, workspace_id uuid NOT NULL, market_id uuid NOT NULL,
 first_intake_id uuid NOT NULL, actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,source_system,external_id),
 UNIQUE(tenant_id,source_system,external_id,order_id),
 FOREIGN KEY(tenant_id,order_id,workspace_id,market_id) REFERENCES rpt.cpq_order(tenant_id,id,workspace_id,market_id),
 FOREIGN KEY(tenant_id,first_intake_id,source_system,external_id,workspace_id,market_id)
 REFERENCES rpt.order_external_intake(tenant_id,id,source_system,external_id,workspace_id,market_id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account
);
CREATE INDEX order_external_binding_order ON rpt.order_external_binding(tenant_id,order_id);
CREATE TABLE rpt.order_reconciliation_event (
 tenant_id uuid NOT NULL, id uuid NOT NULL, source_system text NOT NULL, external_id text NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0), operation text NOT NULL CHECK(operation IN ('ingest','stale','untrusted','correlate','candidate_conflict','resolve')),
 previous_state text, resulting_state text NOT NULL CHECK(resulting_state IN ('unmatched','matched','conflict','pending_review','resolved_official_wins','resolved_local_verified','ignored_with_reason')),
 intake_id uuid NOT NULL, order_id uuid, candidate_order_id uuid, reason text, actor_id uuid NOT NULL, request_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,source_system,external_id,sequence),
 UNIQUE(tenant_id,source_system,external_id,id,sequence,resulting_state),
 FOREIGN KEY(tenant_id,intake_id,source_system,external_id) REFERENCES rpt.order_external_intake(tenant_id,id,source_system,external_id),
 FOREIGN KEY(tenant_id,source_system,external_id,order_id) REFERENCES rpt.order_external_binding(tenant_id,source_system,external_id,order_id),
 FOREIGN KEY(tenant_id,candidate_order_id) REFERENCES rpt.cpq_order,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account,
 CHECK((operation IN ('correlate','candidate_conflict','resolve') AND authz.order_commercial_reason_valid(reason)) OR
       (operation IN ('ingest','stale','untrusted') AND reason IS NULL)),
 CHECK((operation='candidate_conflict' AND candidate_order_id IS NOT NULL AND candidate_order_id<>order_id)
 OR (operation<>'candidate_conflict' AND candidate_order_id IS NULL)),
 CHECK((sequence=1 AND previous_state IS NULL AND operation='ingest' AND resulting_state='unmatched') OR
       (sequence>1 AND previous_state IS NOT NULL))
);
CREATE TABLE rpt.order_reconciliation_state (
 tenant_id uuid NOT NULL, source_system text NOT NULL, external_id text NOT NULL,
 workspace_id uuid NOT NULL, market_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('unmatched','matched','conflict','pending_review','resolved_official_wins','resolved_local_verified','ignored_with_reason')),
 version integer NOT NULL CHECK(version>0), last_event_id uuid NOT NULL,
 latest_intake_id uuid NOT NULL, latest_effective_at timestamptz NOT NULL, latest_observed_at timestamptz NOT NULL,
 latest_hash text NOT NULL CHECK(latest_hash ~ '^[a-f0-9]{64}$'), order_id uuid,
 observation_id uuid, case_id uuid, pending_intake_id uuid,
 PRIMARY KEY(tenant_id,source_system,external_id),
 FOREIGN KEY(tenant_id,source_system,external_id,last_event_id,version,status)
 REFERENCES rpt.order_reconciliation_event(tenant_id,source_system,external_id,id,sequence,resulting_state),
 FOREIGN KEY(tenant_id,latest_intake_id,source_system,external_id,workspace_id,market_id)
 REFERENCES rpt.order_external_intake(tenant_id,id,source_system,external_id,workspace_id,market_id),
 FOREIGN KEY(tenant_id,pending_intake_id,source_system,external_id,workspace_id,market_id)
 REFERENCES rpt.order_external_intake(tenant_id,id,source_system,external_id,workspace_id,market_id),
 FOREIGN KEY(tenant_id,source_system,external_id,order_id)
 REFERENCES rpt.order_external_binding(tenant_id,source_system,external_id,order_id),
 FOREIGN KEY(tenant_id,observation_id) REFERENCES rpt.source_observation,
 FOREIGN KEY(tenant_id,case_id) REFERENCES rpt.reconciliation_case,
 CHECK((order_id IS NULL AND observation_id IS NULL AND case_id IS NULL) OR order_id IS NOT NULL)
);
CREATE INDEX order_reconciliation_state_order ON rpt.order_reconciliation_state(tenant_id,order_id) WHERE order_id IS NOT NULL;

ALTER TABLE rpt.order_external_intake ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.order_external_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.order_reconciliation_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.order_reconciliation_state ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON rpt.order_external_intake,rpt.order_external_binding,rpt.order_reconciliation_event,rpt.order_reconciliation_state TO rpt_runtime;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON rpt.order_external_intake FOR EACH ROW EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON rpt.order_external_intake FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON rpt.order_external_binding FOR EACH ROW EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON rpt.order_external_binding FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON rpt.order_reconciliation_event FOR EACH ROW EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON rpt.order_reconciliation_event FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER no_delete BEFORE DELETE ON rpt.order_reconciliation_state FOR EACH ROW EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON rpt.order_reconciliation_state FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.order_external_intake FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.order_external_binding FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.order_reconciliation_event FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE ON rpt.order_reconciliation_state FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE FUNCTION authz.order_reconciliation_state_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
  IF TG_OP='UPDATE' AND OLD.status IN ('resolved_official_wins','resolved_local_verified','ignored_with_reason')
  THEN RAISE EXCEPTION 'already_resolved' USING ERRCODE='23505'; END IF;
  IF NOT EXISTS(SELECT 1 FROM rpt.order_external_intake i WHERE i.tenant_id=NEW.tenant_id
   AND i.id=NEW.latest_intake_id AND i.source_system=NEW.source_system AND i.external_id=NEW.external_id
   AND i.authority_verified_at IS NOT NULL)
  THEN RAISE EXCEPTION 'untrusted_reconciliation_anchor' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION authz.order_reconciliation_state_guard() FROM PUBLIC;
CREATE TRIGGER order_reconciliation_state_guard BEFORE INSERT OR UPDATE ON rpt.order_reconciliation_state
 FOR EACH ROW EXECUTE FUNCTION authz.order_reconciliation_state_guard();

CREATE FUNCTION authz.order_reconciliation_workspace_right(p_workspace uuid,p_market uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT authz.session_valid() AND p_verb IN ('ingest','correlate','resolve','read')
 AND authz.capable(authz.actor_id(),'order_reconciliation',p_verb,'CONFIDENTIAL')
  -- External IDs are tenant-scoped. A registrar must actually cover every
  -- workspace and market in that namespace; the capability alone is not scope.
  AND (p_verb<>'ingest' OR (authz.capable(authz.actor_id(),'order_reconciliation','identity_registry','CONFIDENTIAL')
   AND authz.capable(authz.actor_id(),'market_admin','global','CONFIDENTIAL')
   AND authz.capable(authz.actor_id(),'market_admin','manage','CONFIDENTIAL')
   AND NOT EXISTS(SELECT 1 FROM rpt.crm_workspace all_workspace WHERE all_workspace.tenant_id=authz.tenant_id()
    AND NOT EXISTS(SELECT 1 FROM authz.workspace_permission registry_workspace JOIN authz.tenant registry_tenant
     ON registry_tenant.id=registry_workspace.tenant_id
     WHERE registry_workspace.tenant_id=all_workspace.tenant_id AND registry_workspace.workspace_id=all_workspace.id
     AND registry_workspace.user_id=authz.actor_id() AND registry_workspace.object_type='order_reconciliation'
     AND registry_workspace.verb='read' AND registry_workspace.field_class='CONFIDENTIAL'
     AND registry_workspace.policy_version=registry_tenant.policy_version AND registry_workspace.revoked_at IS NULL
     AND tstzrange(registry_workspace.effective_from,registry_workspace.effective_to,'[)') @> statement_timestamp()))))
 AND (authz.operational_market()=p_market OR authz.market_admin_scope(p_market,CASE WHEN p_verb='read' THEN 'read' ELSE 'manage' END))
 AND EXISTS(SELECT 1 FROM authz.workspace_permission w JOIN authz.tenant t ON t.id=w.tenant_id
 WHERE w.tenant_id=authz.tenant_id() AND w.workspace_id=p_workspace AND w.user_id=authz.actor_id()
 AND w.object_type='order_reconciliation' AND w.verb=p_verb AND w.field_class='CONFIDENTIAL'
 AND w.policy_version=t.policy_version AND w.revoked_at IS NULL
 AND tstzrange(w.effective_from,w.effective_to,'[)') @> statement_timestamp())
$$;
CREATE FUNCTION authz.order_reconciliation_order_right(p_order uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM rpt.cpq_order o WHERE o.tenant_id=authz.tenant_id() AND o.id=p_order
 AND authz.order_commercial_right(o.id,'read')
 AND authz.order_reconciliation_workspace_right(o.workspace_id,o.market_id,p_verb))
$$;
CREATE FUNCTION authz.order_reconciliation_source_right(p_source text,p_level text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND EXISTS(SELECT 1 FROM authz.source_authority a WHERE a.tenant_id=authz.tenant_id()
 AND a.user_id=authz.actor_id() AND a.source_system=p_source AND a.domain_key='order_reconciliation'
 AND a.authority_level=p_level AND a.revoked_at IS NULL)
$$;
REVOKE ALL ON FUNCTION authz.order_reconciliation_workspace_right(uuid,uuid,text),authz.order_reconciliation_order_right(uuid,text),authz.order_reconciliation_source_right(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.order_reconciliation_workspace_right(uuid,uuid,text),authz.order_reconciliation_order_right(uuid,text) TO rpt_runtime;
CREATE POLICY intake_read ON rpt.order_external_intake FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.order_reconciliation_workspace_right(workspace_id,market_id,'read'));
CREATE POLICY binding_read ON rpt.order_external_binding FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.order_reconciliation_order_right(order_id,'read'));
CREATE POLICY state_read ON rpt.order_reconciliation_state FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.order_reconciliation_workspace_right(workspace_id,market_id,'read')
 AND (order_id IS NULL OR authz.order_reconciliation_order_right(order_id,'read')));
CREATE POLICY event_read ON rpt.order_reconciliation_event FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND EXISTS(SELECT 1 FROM rpt.order_reconciliation_state s
 WHERE s.tenant_id=rpt.order_reconciliation_event.tenant_id
 AND s.source_system=rpt.order_reconciliation_event.source_system
 AND s.external_id=rpt.order_reconciliation_event.external_id
 AND authz.order_reconciliation_workspace_right(s.workspace_id,s.market_id,'read')
 AND (s.order_id IS NULL OR authz.order_reconciliation_order_right(s.order_id,'read'))));

-- Only the trusted mutation functions write; ordinary runtime SQL has SELECT only.
CREATE FUNCTION authz.order_reconciliation_receipt(p_operation text,p_key text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r authz.idempotency_receipt%ROWTYPE; h text;
BEGIN
 IF NOT authz.session_valid() OR p_operation NOT IN ('ingest','correlate','resolve') OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9:_-]{8,128}$'
 THEN RAISE EXCEPTION 'invalid_reconciliation_receipt' USING ERRCODE='23514'; END IF;
 h:=encode(extensions.digest(convert_to(p_payload::text,'UTF8'),'sha256'),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||'/order_reconciliation.'||p_operation||'/'||p_key,0));
 SELECT * INTO r FROM authz.idempotency_receipt WHERE tenant_id=authz.tenant_id() AND operation='order_reconciliation.'||p_operation AND key=p_key;
 IF FOUND THEN
  IF r.actor_id<>authz.actor_id() OR r.request_hash<>h OR r.response IS NULL THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN r.response;
 END IF;
 INSERT INTO authz.idempotency_receipt(tenant_id,operation,key,actor_id,request_hash)
 VALUES(authz.tenant_id(),'order_reconciliation.'||p_operation,p_key,authz.actor_id(),h);
 RETURN NULL;
END $$;
CREATE FUNCTION authz.order_reconciliation_finish(p_operation text,p_key text,p_response jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE authz.idempotency_receipt SET response=p_response WHERE tenant_id=authz.tenant_id()
 AND operation='order_reconciliation.'||p_operation AND key=p_key AND actor_id=authz.actor_id() AND response IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'missing_reconciliation_receipt' USING ERRCODE='23514'; END IF;
 RETURN p_response;
END $$;
REVOKE ALL ON FUNCTION authz.order_reconciliation_receipt(text,text,jsonb),authz.order_reconciliation_finish(text,text,jsonb) FROM PUBLIC;

CREATE FUNCTION authz.ingest_external_order(p_workspace uuid,p_market uuid,p_source text,p_external text,p_reference text,
 p_observed timestamptz,p_effective timestamptz,p_hash text,p_correlation uuid,p_level text,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s rpt.order_reconciliation_state%ROWTYPE; old rpt.order_external_intake%ROWTYPE;
 i uuid:=gen_random_uuid(); e uuid:=gen_random_uuid(); result_status text; operation text:='ingest'; result jsonb; replay jsonb; evidence jsonb; trusted boolean;
BEGIN
 IF NOT authz.order_reconciliation_workspace_right(p_workspace,p_market,'ingest')
 THEN RAISE EXCEPTION 'reconciliation_denied' USING ERRCODE='42501'; END IF;
 IF p_source NOT IN ('HYCITE','INCITE','DOCUCITE','RPT_USER','IMPORT','API') OR p_external IS NULL OR length(p_external) NOT BETWEEN 1 AND 160 OR NOT authz.order_commercial_reason_valid(p_external)
 OR p_reference IS NULL OR length(p_reference) NOT BETWEEN 1 AND 500 OR NOT authz.order_commercial_reason_valid(p_reference)
 OR p_observed IS NULL OR p_effective IS NULL OR NOT isfinite(p_observed) OR NOT isfinite(p_effective)
 OR p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' OR p_correlation IS NULL
 OR p_level NOT IN ('official','verified','authorized','import','manual') OR (p_level='official' AND p_source IN ('RPT_USER','IMPORT'))
 THEN RAISE EXCEPTION 'invalid_external_order' USING ERRCODE='23514'; END IF;
 replay:=authz.order_reconciliation_receipt('ingest',p_key,jsonb_build_object('workspace',p_workspace,'market',p_market,'source',p_source,'external',p_external,
 'reference',p_reference,'observed',p_observed,'effective',p_effective,'hash',p_hash,'correlation',p_correlation,'level',p_level));
 IF replay IS NOT NULL THEN
  IF replay->>'sourceAuthorized'='true' AND NOT authz.order_reconciliation_source_right(p_source,p_level)
  THEN RAISE EXCEPTION 'reconciliation_denied' USING ERRCODE='42501'; END IF;
  RETURN replay;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||'/'||p_source||'/'||p_external,0));
 IF NOT authz.order_reconciliation_workspace_right(p_workspace,p_market,'ingest')
 THEN RAISE EXCEPTION 'reconciliation_denied' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM authz.source_authority a WHERE a.tenant_id=authz.tenant_id() AND a.user_id=authz.actor_id()
   AND a.source_system=p_source AND a.domain_key='order_reconciliation' AND a.authority_level=p_level
   AND a.revoked_at IS NULL FOR SHARE;
  trusted:=FOUND;
 SELECT * INTO old FROM rpt.order_external_intake WHERE tenant_id=authz.tenant_id() AND source_system=p_source AND external_id=p_external AND raw_hash=p_hash;
 IF FOUND THEN
  IF (old.workspace_id,old.market_id,old.source_reference,old.observed_at,old.effective_at,old.correlation_id,old.authority_level)
     IS DISTINCT FROM (p_workspace,p_market,p_reference,p_observed,p_effective,p_correlation,p_level)
  THEN RAISE EXCEPTION 'conflicting_external_duplicate' USING ERRCODE='23505'; END IF;
  SELECT * INTO s FROM rpt.order_reconciliation_state WHERE tenant_id=authz.tenant_id() AND source_system=p_source AND external_id=p_external;
   result:=jsonb_build_object('intakeId',old.id,'status',CASE WHEN old.authority_verified_at IS NULL OR NOT trusted THEN 'pending_review' ELSE s.status END,
    'version',coalesce(s.version,0),'duplicate',true,
    'sourceAuthorized',trusted);
  RETURN authz.order_reconciliation_finish('ingest',p_key,result);
 END IF;
 SELECT * INTO s FROM rpt.order_reconciliation_state WHERE tenant_id=authz.tenant_id() AND source_system=p_source AND external_id=p_external FOR UPDATE;
 IF FOUND AND (s.workspace_id,s.market_id) IS DISTINCT FROM (p_workspace,p_market) THEN RAISE EXCEPTION 'external_scope_conflict' USING ERRCODE='23505'; END IF;
 INSERT INTO rpt.order_external_intake(tenant_id,id,workspace_id,market_id,source_system,external_id,source_reference,observed_at,effective_at,raw_hash,correlation_id,authority_level,authority_verified_at,actor_id)
 VALUES(authz.tenant_id(),i,p_workspace,p_market,p_source,p_external,p_reference,p_observed,p_effective,p_hash,p_correlation,p_level,
  CASE WHEN trusted THEN statement_timestamp() ELSE NULL END,authz.actor_id());
  IF NOT trusted THEN
   result:=jsonb_build_object('intakeId',i,'status','pending_review','version',coalesce(s.version,0),'duplicate',false,'sourceAuthorized',false);
   RETURN authz.order_reconciliation_finish('ingest',p_key,result);
  ELSIF s.version IS NOT NULL AND s.status IN ('resolved_official_wins','resolved_local_verified','ignored_with_reason') THEN
   result:=jsonb_build_object('intakeId',i,'status','pending_review','version',s.version,'duplicate',false,'sourceAuthorized',true);
   RETURN authz.order_reconciliation_finish('ingest',p_key,result);
  ELSIF s.version IS NULL THEN
  INSERT INTO rpt.order_reconciliation_event(tenant_id,id,source_system,external_id,sequence,operation,resulting_state,intake_id,actor_id,request_id)
  VALUES(authz.tenant_id(),e,p_source,p_external,1,'ingest','unmatched',i,authz.actor_id(),nullif(current_setting('rpt.request_id',true),'')::uuid);
  INSERT INTO rpt.order_reconciliation_state(tenant_id,source_system,external_id,workspace_id,market_id,status,version,last_event_id,latest_intake_id,latest_effective_at,latest_observed_at,latest_hash,pending_intake_id)
   VALUES(authz.tenant_id(),p_source,p_external,p_workspace,p_market,'unmatched',1,e,i,p_effective,p_observed,p_hash,NULL);
  result_status:='unmatched';
 ELSE
   IF p_effective<s.latest_effective_at OR (p_effective=s.latest_effective_at AND p_observed<s.latest_observed_at) THEN
   result_status:=s.status; operation:='stale';
  ELSIF (p_effective=s.latest_effective_at AND p_observed=s.latest_observed_at)
   OR (p_effective>s.latest_effective_at AND p_observed<s.latest_observed_at) THEN
   result_status:='conflict';
  ELSE
   result_status:=CASE WHEN s.order_id IS NULL THEN 'unmatched' ELSE 'pending_review' END;
  END IF;
  INSERT INTO rpt.order_reconciliation_event(tenant_id,id,source_system,external_id,sequence,operation,previous_state,resulting_state,intake_id,order_id,actor_id,request_id)
  VALUES(authz.tenant_id(),e,p_source,p_external,s.version+1,operation,s.status,result_status,i,s.order_id,authz.actor_id(),nullif(current_setting('rpt.request_id',true),'')::uuid);
  UPDATE rpt.order_reconciliation_state SET status=result_status,version=s.version+1,last_event_id=e,
   latest_intake_id=CASE WHEN operation IN ('stale','untrusted') OR result_status='conflict' THEN s.latest_intake_id ELSE i END,
   latest_effective_at=CASE WHEN operation IN ('stale','untrusted') OR result_status='conflict' THEN s.latest_effective_at ELSE p_effective END,
   latest_observed_at=CASE WHEN operation IN ('stale','untrusted') OR result_status='conflict' THEN s.latest_observed_at ELSE p_observed END,
   latest_hash=CASE WHEN operation IN ('stale','untrusted') OR result_status='conflict' THEN s.latest_hash ELSE p_hash END,
   pending_intake_id=CASE WHEN operation='untrusted' THEN i
    WHEN operation='stale' OR result_status='conflict' THEN s.pending_intake_id ELSE NULL END
  WHERE tenant_id=authz.tenant_id() AND source_system=p_source AND external_id=p_external;
   IF s.order_id IS NOT NULL THEN
   evidence:=authz.order_reconciliation_record(i,s.order_id,CASE WHEN operation='stale' THEN 'pending_review' ELSE result_status END,s.case_id,'order_external_ingest');
   IF operation<>'stale' THEN
    UPDATE rpt.order_reconciliation_state SET observation_id=(evidence->>'observationId')::uuid,case_id=(evidence->>'caseId')::uuid
    WHERE tenant_id=authz.tenant_id() AND source_system=p_source AND external_id=p_external;
   END IF;
  END IF;
 END IF;
 result:=jsonb_build_object('intakeId',i,'status',result_status,'version',coalesce(s.version,0)+1,'duplicate',false,
  'sourceAuthorized',trusted);
 RETURN authz.order_reconciliation_finish('ingest',p_key,result);
END $$;
REVOKE ALL ON FUNCTION authz.ingest_external_order(uuid,uuid,text,text,text,timestamptz,timestamptz,text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.ingest_external_order(uuid,uuid,text,text,text,timestamptz,timestamptz,text,uuid,text,text) TO rpt_runtime;

-- Typed provenance for a *bound* canonical Order. Unmatched intake has no invented subject.
-- An external event may be evidence for different typed domains; its identity is domain-scoped.
DO $$ DECLARE old_constraint name; BEGIN
 SELECT c.conname INTO old_constraint FROM pg_constraint c
 WHERE c.conrelid='rpt.source_observation'::regclass AND c.contype='u'
 AND pg_get_constraintdef(c.oid) LIKE 'UNIQUE (tenant_id, source_system, external_id, raw_hash)%';
 IF old_constraint IS NULL THEN RAISE EXCEPTION 'missing_source_observation_identity_constraint'; END IF;
 EXECUTE format('ALTER TABLE rpt.source_observation DROP CONSTRAINT %I',old_constraint);
END $$;
ALTER TABLE rpt.source_observation ADD CONSTRAINT source_observation_domain_identity
 UNIQUE(tenant_id,source_system,domain_key,external_id,raw_hash);
ALTER TABLE rpt.source_observation ADD COLUMN order_reconciliation_subject_type text;
ALTER TABLE rpt.source_observation ADD CONSTRAINT order_reconciliation_subject_type_check CHECK(
 (domain_key='order_reconciliation' AND order_reconciliation_subject_type='order') OR
 (domain_key<>'order_reconciliation' AND order_reconciliation_subject_type IS NULL));
CREATE FUNCTION authz.order_reconciliation_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i rpt.order_external_intake%ROWTYPE; b rpt.order_external_binding%ROWTYPE;
BEGIN
 IF NEW.domain_key<>'order_reconciliation' THEN RETURN NEW; END IF;
 SELECT * INTO i FROM rpt.order_external_intake WHERE tenant_id=NEW.tenant_id AND id=(NEW.facts->>'intakeId')::uuid;
 SELECT * INTO b FROM rpt.order_external_binding WHERE tenant_id=NEW.tenant_id AND source_system=NEW.source_system AND external_id=NEW.external_id;
 IF i.id IS NULL OR b.order_id IS DISTINCT FROM NEW.subject_id OR i.source_system IS DISTINCT FROM NEW.source_system
 OR i.external_id IS DISTINCT FROM NEW.external_id OR i.raw_hash IS DISTINCT FROM NEW.raw_hash
 OR i.workspace_id IS DISTINCT FROM b.workspace_id OR i.market_id IS DISTINCT FROM b.market_id
 OR NOT authz.order_reconciliation_order_right(NEW.subject_id,'read')
 THEN RAISE EXCEPTION 'invalid_order_reconciliation_subject' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION authz.order_reconciliation_source_guard() FROM PUBLIC;
CREATE TRIGGER order_reconciliation_source_guard BEFORE INSERT ON rpt.source_observation FOR EACH ROW EXECUTE FUNCTION authz.order_reconciliation_source_guard();
CREATE POLICY order_reconciliation_source_boundary ON rpt.source_observation AS RESTRICTIVE FOR ALL TO rpt_runtime
 USING(domain_key<>'order_reconciliation' OR (tenant_id=authz.tenant_id() AND order_reconciliation_subject_type='order'
 AND authz.order_reconciliation_order_right(subject_id,'read')))
 WITH CHECK(domain_key<>'order_reconciliation');
CREATE POLICY order_reconciliation_source_read ON rpt.source_observation FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND domain_key='order_reconciliation' AND order_reconciliation_subject_type='order'
 AND authz.order_reconciliation_order_right(subject_id,'read'));
CREATE FUNCTION authz.order_reconciliation_case_right(p_case uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM rpt.reconciliation_case c JOIN rpt.source_observation o
 ON o.tenant_id=c.tenant_id AND o.id=c.observation_id WHERE c.tenant_id=authz.tenant_id() AND c.id=p_case
 AND o.domain_key='order_reconciliation' AND o.order_reconciliation_subject_type='order'
 AND authz.order_reconciliation_order_right(o.subject_id,'read'))
$$;
REVOKE ALL ON FUNCTION authz.order_reconciliation_case_right(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.order_reconciliation_case_right(uuid) TO rpt_runtime;
-- Only these Foundation domains have migration-governed generic Trust-case
-- eligibility. Unknown and future typed domains fail closed until registered.
CREATE TABLE authz.generic_reconciliation_domain (
 domain_key text PRIMARY KEY CHECK(length(domain_key) BETWEEN 1 AND 64
  AND domain_key COLLATE "C" ~ '^[a-z][a-z0-9_]*$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO authz.generic_reconciliation_domain(domain_key) VALUES('rank'),('sales');
ALTER TABLE authz.generic_reconciliation_domain ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON authz.generic_reconciliation_domain FROM PUBLIC,rpt_runtime;
-- Replace only Foundation's generic Trust source policies. Specialized
-- product, commerce, quote, Order, and CRM policies remain independent.
CREATE FUNCTION authz.generic_reconciliation_source_read(p_tenant uuid,p_observation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p_tenant=authz.tenant_id() AND authz.session_valid()
 AND authz.tenant_allowed(p_tenant,'trust','read','OFFICIAL_COMPENSATION')
 AND EXISTS(SELECT 1 FROM rpt.source_observation o
  JOIN authz.generic_reconciliation_domain g ON g.domain_key COLLATE "C" = o.domain_key COLLATE "C"
  WHERE o.tenant_id=p_tenant AND o.id=p_observation)
$$;
CREATE FUNCTION authz.generic_reconciliation_source_write(p_tenant uuid,p_domain text,p_source text,p_authority text,p_actor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p_tenant=authz.tenant_id() AND authz.session_valid() AND p_actor=authz.actor_id()
 AND authz.tenant_allowed(p_tenant,'trust','approve','OFFICIAL_COMPENSATION')
 AND EXISTS(SELECT 1 FROM authz.generic_reconciliation_domain g
  WHERE g.domain_key COLLATE "C" = p_domain COLLATE "C")
 AND EXISTS(SELECT 1 FROM authz.source_authority a WHERE a.tenant_id=p_tenant
  AND a.user_id=p_actor AND a.source_system=p_source AND a.domain_key=p_domain
  AND a.authority_level=p_authority AND a.revoked_at IS NULL)
$$;
REVOKE ALL ON FUNCTION authz.generic_reconciliation_source_read(uuid,uuid),authz.generic_reconciliation_source_write(uuid,text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.generic_reconciliation_source_read(uuid,uuid),authz.generic_reconciliation_source_write(uuid,text,text,text,uuid) TO rpt_runtime;
DROP POLICY trust_read ON rpt.source_observation;
DROP POLICY trust_legacy_insert ON rpt.source_observation;
DROP POLICY trust_legacy_update ON rpt.source_observation;
CREATE POLICY trust_read ON rpt.source_observation FOR SELECT TO rpt_runtime
 USING(authz.generic_reconciliation_source_read(tenant_id,id));
CREATE POLICY trust_legacy_insert ON rpt.source_observation FOR INSERT TO rpt_runtime
 WITH CHECK(authz.generic_reconciliation_source_write(tenant_id,domain_key,source_system,authority_level,actor_id));
CREATE POLICY trust_legacy_update ON rpt.source_observation FOR UPDATE TO rpt_runtime
 USING(authz.generic_reconciliation_source_write(tenant_id,domain_key,source_system,authority_level,actor_id))
 WITH CHECK(authz.generic_reconciliation_source_write(tenant_id,domain_key,source_system,authority_level,actor_id));
-- The privileged lookup sees authoritative observation/registry rows. Its
-- result is an actor-scoped authorization decision, never raw classification.
CREATE FUNCTION authz.order_reconciliation_generic_observation(p_tenant uuid,p_observation uuid,p_operation text) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT authz.session_valid() AND p_tenant=authz.tenant_id() AND coalesce(p_operation IN ('read','write'),false)
  AND EXISTS(SELECT 1 FROM rpt.source_observation o WHERE o.tenant_id=p_tenant
   AND o.id=p_observation
   AND ((EXISTS(SELECT 1 FROM authz.generic_reconciliation_domain g
    WHERE g.domain_key COLLATE "C" = o.domain_key COLLATE "C")
    AND CASE WHEN p_operation='read' THEN
     authz.tenant_allowed(p_tenant,'trust','read','OFFICIAL_COMPENSATION')
     OR authz.tenant_allowed(p_tenant,'trust','approve','OFFICIAL_COMPENSATION')
    ELSE authz.tenant_allowed(p_tenant,'trust','approve','OFFICIAL_COMPENSATION') END)
   OR (o.domain_key='order_simulation' AND CASE WHEN p_operation='read' THEN
     authz.crm_child(o.subject_id,'reconciliation','read')
    ELSE authz.crm_child(o.subject_id,'reconciliation','approve') END)))
 $$;
REVOKE ALL ON FUNCTION authz.order_reconciliation_generic_observation(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.order_reconciliation_generic_observation(uuid,uuid,text) TO rpt_runtime;
CREATE POLICY order_reconciliation_case_boundary ON rpt.reconciliation_case AS RESTRICTIVE FOR ALL TO rpt_runtime
 USING(authz.order_reconciliation_generic_observation(tenant_id,observation_id,'read')
 OR authz.order_reconciliation_case_right(id))
 WITH CHECK(authz.order_reconciliation_generic_observation(tenant_id,observation_id,'write'));
CREATE POLICY order_reconciliation_case_read ON rpt.reconciliation_case FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.order_reconciliation_case_right(id));

CREATE FUNCTION authz.order_reconciliation_record(p_intake uuid,p_order uuid,p_case_state text,p_previous_case uuid,p_reason_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i rpt.order_external_intake%ROWTYPE; observation uuid:=gen_random_uuid(); case_id uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO STRICT i FROM rpt.order_external_intake WHERE tenant_id=authz.tenant_id() AND id=p_intake;
 IF NOT authz.order_reconciliation_source_right(i.source_system,i.authority_level)
 OR NOT authz.order_reconciliation_order_right(p_order,'read') OR p_case_state NOT IN ('matched','conflict','pending_review')
 THEN RAISE EXCEPTION 'reconciliation_evidence_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO rpt.source_observation(tenant_id,id,source_system,domain_key,order_reconciliation_subject_type,subject_id,external_id,source_reference,
 observed_at,effective_at,verified_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id,facts)
 VALUES(i.tenant_id,observation,i.source_system,'order_reconciliation','order',p_order,i.external_id,i.source_reference,
 i.observed_at,i.effective_at,CASE WHEN i.authority_level='official' THEN statement_timestamp() ELSE NULL END,
 i.authority_level,i.raw_hash,i.correlation_id,p_case_state,authz.actor_id(),jsonb_build_object('intakeId',i.id,'workspaceId',i.workspace_id,'marketId',i.market_id));
 INSERT INTO rpt.reconciliation_case(tenant_id,id,observation_id,state,reason_code,resolution_of,actor_id)
 VALUES(i.tenant_id,case_id,observation,p_case_state,p_reason_code,p_previous_case,authz.actor_id());
 RETURN jsonb_build_object('observationId',observation,'caseId',case_id);
END $$;
REVOKE ALL ON FUNCTION authz.order_reconciliation_record(uuid,uuid,text,uuid,text) FROM PUBLIC;

CREATE FUNCTION authz.correlate_external_order(p_intake uuid,p_order uuid,p_expected integer,p_reason text,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i rpt.order_external_intake%ROWTYPE; s rpt.order_reconciliation_state%ROWTYPE;
 b rpt.order_external_binding%ROWTYPE; evidence jsonb; e uuid:=gen_random_uuid(); result jsonb; replay jsonb;
BEGIN
 SELECT * INTO i FROM rpt.order_external_intake WHERE tenant_id=authz.tenant_id() AND id=p_intake;
 IF i.id IS NULL OR NOT authz.order_reconciliation_workspace_right(i.workspace_id,i.market_id,'correlate')
 OR NOT authz.order_reconciliation_order_right(p_order,'correlate')
 OR NOT authz.order_reconciliation_source_right(i.source_system,i.authority_level)
 THEN RAISE EXCEPTION 'reconciliation_denied' USING ERRCODE='42501'; END IF;
 IF p_expected IS NULL OR p_expected<1 OR NOT authz.order_commercial_reason_valid(p_reason)
 THEN RAISE EXCEPTION 'invalid_correlation' USING ERRCODE='23514'; END IF;
 replay:=authz.order_reconciliation_receipt('correlate',p_key,jsonb_build_object('intake',p_intake,'order',p_order,'expected',p_expected,'reason',p_reason));
 IF replay IS NOT NULL THEN RETURN replay; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||'/'||i.source_system||'/'||i.external_id,0));
 SELECT * INTO STRICT s FROM rpt.order_reconciliation_state WHERE tenant_id=i.tenant_id AND source_system=i.source_system AND external_id=i.external_id FOR UPDATE;
 IF NOT authz.order_reconciliation_workspace_right(i.workspace_id,i.market_id,'correlate')
 THEN RAISE EXCEPTION 'reconciliation_denied' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM authz.source_authority a WHERE a.tenant_id=authz.tenant_id() AND a.user_id=authz.actor_id()
   AND a.source_system=i.source_system AND a.domain_key='order_reconciliation' AND a.authority_level=i.authority_level
   AND a.revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconciliation_denied' USING ERRCODE='42501'; END IF;
 IF s.version<>p_expected OR s.latest_intake_id<>p_intake THEN RAISE EXCEPTION 'stale_reconciliation' USING ERRCODE='40001'; END IF;
 IF NOT authz.order_reconciliation_order_right(p_order,'correlate')
 OR (SELECT (workspace_id,market_id) FROM rpt.cpq_order WHERE tenant_id=i.tenant_id AND id=p_order)
 IS DISTINCT FROM (i.workspace_id,i.market_id)
 THEN RAISE EXCEPTION 'reconciliation_scope_denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO b FROM rpt.order_external_binding WHERE tenant_id=i.tenant_id AND source_system=i.source_system AND external_id=i.external_id;
  IF s.status IN ('resolved_official_wins','resolved_local_verified','ignored_with_reason')
   AND b.order_id IS DISTINCT FROM p_order
  THEN RAISE EXCEPTION 'already_resolved' USING ERRCODE='23505'; END IF;
 IF b.order_id IS NOT NULL AND b.order_id<>p_order THEN
  IF NOT authz.order_reconciliation_order_right(b.order_id,'read') THEN RAISE EXCEPTION 'reconciliation_denied' USING ERRCODE='42501'; END IF;
  INSERT INTO rpt.order_reconciliation_event(tenant_id,id,source_system,external_id,sequence,operation,previous_state,resulting_state,intake_id,order_id,candidate_order_id,reason,actor_id,request_id)
  VALUES(i.tenant_id,e,i.source_system,i.external_id,s.version+1,'candidate_conflict',s.status,'conflict',p_intake,b.order_id,p_order,p_reason,authz.actor_id(),nullif(current_setting('rpt.request_id',true),'')::uuid);
  UPDATE rpt.order_reconciliation_state SET status='conflict',version=s.version+1,last_event_id=e
  WHERE tenant_id=i.tenant_id AND source_system=i.source_system AND external_id=i.external_id;
  result:=jsonb_build_object('status','conflict','version',s.version+1,'orderId',b.order_id,'eventId',e);
  RETURN authz.order_reconciliation_finish('correlate',p_key,result);
 END IF;
 IF b.order_id=p_order THEN
  result:=jsonb_build_object('status',s.status,'version',s.version,'orderId',p_order,'eventId',s.last_event_id);
  RETURN authz.order_reconciliation_finish('correlate',p_key,result);
 END IF;
 INSERT INTO rpt.order_external_binding(tenant_id,source_system,external_id,order_id,workspace_id,market_id,first_intake_id,actor_id)
 VALUES(i.tenant_id,i.source_system,i.external_id,p_order,i.workspace_id,i.market_id,p_intake,authz.actor_id());
 evidence:=authz.order_reconciliation_record(p_intake,p_order,'matched',NULL,'order_explicit_correlation');
 INSERT INTO rpt.order_reconciliation_event(tenant_id,id,source_system,external_id,sequence,operation,previous_state,resulting_state,intake_id,order_id,reason,actor_id,request_id)
 VALUES(i.tenant_id,e,i.source_system,i.external_id,s.version+1,'correlate',s.status,'matched',p_intake,p_order,p_reason,authz.actor_id(),nullif(current_setting('rpt.request_id',true),'')::uuid);
 UPDATE rpt.order_reconciliation_state SET status='matched',version=s.version+1,last_event_id=e,order_id=p_order,pending_intake_id=NULL,
 observation_id=(evidence->>'observationId')::uuid,case_id=(evidence->>'caseId')::uuid
 WHERE tenant_id=i.tenant_id AND source_system=i.source_system AND external_id=i.external_id;
 result:=jsonb_build_object('status','matched','version',s.version+1,'orderId',p_order,'eventId',e);
 RETURN authz.order_reconciliation_finish('correlate',p_key,result);
END $$;
REVOKE ALL ON FUNCTION authz.correlate_external_order(uuid,uuid,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.correlate_external_order(uuid,uuid,integer,text,text) TO rpt_runtime;

CREATE FUNCTION authz.resolve_external_order(p_source text,p_external text,p_expected integer,p_outcome text,p_reason text,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s rpt.order_reconciliation_state%ROWTYPE; i rpt.order_external_intake%ROWTYPE;
 e uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); result jsonb; replay jsonb;
BEGIN
 SELECT * INTO s FROM rpt.order_reconciliation_state WHERE tenant_id=authz.tenant_id() AND source_system=p_source AND external_id=p_external;
 IF s.order_id IS NULL OR NOT authz.order_reconciliation_order_right(s.order_id,'resolve')
 THEN RAISE EXCEPTION 'reconciliation_denied' USING ERRCODE='42501'; END IF;
 IF p_expected IS NULL OR p_expected<1 OR p_outcome NOT IN ('matched','resolved_official_wins','resolved_local_verified','ignored_with_reason')
 OR NOT authz.order_commercial_reason_valid(p_reason) THEN RAISE EXCEPTION 'invalid_resolution' USING ERRCODE='23514'; END IF;
 replay:=authz.order_reconciliation_receipt('resolve',p_key,jsonb_build_object('source',p_source,'external',p_external,'expected',p_expected,'outcome',p_outcome,'reason',p_reason));
 IF replay IS NOT NULL THEN RETURN replay; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||'/'||p_source||'/'||p_external,0));
 SELECT * INTO STRICT s FROM rpt.order_reconciliation_state WHERE tenant_id=authz.tenant_id() AND source_system=p_source AND external_id=p_external FOR UPDATE;
 IF s.version<>p_expected THEN RAISE EXCEPTION 'stale_reconciliation' USING ERRCODE='40001'; END IF;
 IF NOT authz.order_reconciliation_order_right(s.order_id,'resolve') OR s.observation_id IS NULL
 THEN RAISE EXCEPTION 'reconciliation_denied' USING ERRCODE='42501'; END IF;
 IF s.status IN ('resolved_official_wins','resolved_local_verified','ignored_with_reason')
 THEN RAISE EXCEPTION 'already_resolved' USING ERRCODE='23505'; END IF;
 IF p_outcome IN ('matched','resolved_official_wins') AND s.pending_intake_id IS NOT NULL
 THEN RAISE EXCEPTION 'external_source_pending' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT i FROM rpt.order_external_intake WHERE tenant_id=s.tenant_id AND id=s.latest_intake_id;
  IF p_outcome IN ('matched','resolved_official_wins') THEN
   PERFORM 1 FROM authz.source_authority a WHERE a.tenant_id=authz.tenant_id() AND a.user_id=authz.actor_id()
    AND a.source_system=i.source_system AND a.domain_key='order_reconciliation' AND a.authority_level=i.authority_level
    AND a.revoked_at IS NULL FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'external_source_pending' USING ERRCODE='42501'; END IF;
  END IF;
 IF p_outcome='resolved_official_wins' AND (i.authority_level<>'official'
 OR NOT EXISTS(SELECT 1 FROM rpt.source_observation o WHERE o.tenant_id=s.tenant_id AND o.id=s.observation_id
 AND o.subject_id=s.order_id AND o.authority_level='official' AND o.verified_at IS NOT NULL))
 THEN RAISE EXCEPTION 'official_source_not_verified' USING ERRCODE='42501'; END IF;
 IF s.status=p_outcome THEN RAISE EXCEPTION 'already_resolved' USING ERRCODE='23505'; END IF;
 INSERT INTO rpt.reconciliation_case(tenant_id,id,observation_id,previous_observation_id,state,reason_code,resolution_of,actor_id)
 VALUES(s.tenant_id,c,s.observation_id,s.observation_id,p_outcome,'order_authorized_resolution',s.case_id,authz.actor_id());
 INSERT INTO rpt.order_reconciliation_event(tenant_id,id,source_system,external_id,sequence,operation,previous_state,resulting_state,intake_id,order_id,reason,actor_id,request_id)
 VALUES(s.tenant_id,e,p_source,p_external,s.version+1,'resolve',s.status,p_outcome,coalesce(s.pending_intake_id,s.latest_intake_id),s.order_id,p_reason,authz.actor_id(),nullif(current_setting('rpt.request_id',true),'')::uuid);
 UPDATE rpt.order_reconciliation_state SET status=p_outcome,version=s.version+1,last_event_id=e,case_id=c,pending_intake_id=NULL
 WHERE tenant_id=s.tenant_id AND source_system=p_source AND external_id=p_external;
 result:=jsonb_build_object('status',p_outcome,'version',s.version+1,'orderId',s.order_id,'eventId',e,'caseId',c);
 RETURN authz.order_reconciliation_finish('resolve',p_key,result);
END $$;
REVOKE ALL ON FUNCTION authz.resolve_external_order(text,text,integer,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.resolve_external_order(text,text,integer,text,text,text) TO rpt_runtime;
