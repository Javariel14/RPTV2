SET LOCAL ROLE rpt_owner;

-- Referral is a link to the canonical Person; it never creates or grants access.
ALTER TABLE rpt.opportunity ADD COLUMN referrer_person_id uuid;
ALTER TABLE rpt.opportunity
  ADD CONSTRAINT opportunity_referrer_fk
  FOREIGN KEY(tenant_id,referrer_person_id) REFERENCES rpt.person(tenant_id,id),
  ADD CONSTRAINT opportunity_referrer_not_self CHECK(referrer_person_id IS NULL OR referrer_person_id<>person_id);

-- Internal facts only. No external delivery/telephony integration is attached.
CREATE TABLE rpt.crm_activity (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 opportunity_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('call','message')),
 occurred_at timestamptz NOT NULL,
 actor_id uuid NOT NULL,
 summary text NOT NULL CHECK(length(summary) BETWEEN 1 AND 1000),
 source text NOT NULL DEFAULT 'RPT_USER' CHECK(source='RPT_USER'),
 request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,opportunity_id) REFERENCES rpt.opportunity,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account
);
ALTER TABLE rpt.crm_activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_activity_read ON rpt.crm_activity FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.crm_child(opportunity_id,'activity','read'));
CREATE POLICY crm_activity_insert ON rpt.crm_activity FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id()
   AND authz.crm_child(opportunity_id,'activity','create'));
GRANT SELECT,INSERT ON rpt.crm_activity TO rpt_runtime;
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON rpt.crm_activity
 FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON rpt.crm_activity
 FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE INDEX crm_activity_opportunity_idx
 ON rpt.crm_activity(tenant_id,opportunity_id,occurred_at DESC,id);
CREATE INDEX opportunity_referrer_idx
 ON rpt.opportunity(tenant_id,referrer_person_id) WHERE referrer_person_id IS NOT NULL;

-- Collaborators are the existing explicit Opportunity grants, tagged so removal
-- cannot revoke an unrelated delegation.
CREATE FUNCTION authz.crm_collaborators(p_object uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value jsonb;
BEGIN
 IF NOT authz.crm_allowed(p_object,'read') THEN
   RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501';
 END IF;
 SELECT coalesce(jsonb_agg(x ORDER BY x."userId"),'[]'::jsonb) INTO value
 FROM (
   SELECT g.grantee_id AS "userId",
     CASE WHEN bool_or(g.verb='update') THEN 'update' ELSE 'read' END AS access,
     max(g.effective_to) AS "until"
   FROM authz.access_grant g JOIN authz.tenant t ON t.id=g.tenant_id
   WHERE g.tenant_id=authz.tenant_id() AND g.object_type='opportunity'
     AND g.object_id=p_object AND g.reason='crm_collaborator'
     AND g.field_class='CONFIDENTIAL' AND g.policy_version=t.policy_version
     AND g.revoked_at IS NULL
     AND tstzrange(g.effective_from,g.effective_to,'[)') @> statement_timestamp()
     AND authz.capable(g.grantee_id,'opportunity',g.verb,'CONFIDENTIAL')
     AND authz.direct_access(g.grantor_id,'opportunity',p_object,g.verb,'CONFIDENTIAL')
     AND authz.direct_access(g.grantor_id,'opportunity',p_object,'share','CONFIDENTIAL')
     AND EXISTS(
       SELECT 1 FROM rpt.opportunity o JOIN authz.access_grant pg
         ON pg.tenant_id=o.tenant_id AND pg.object_type='person' AND pg.object_id=o.person_id
       WHERE o.tenant_id=g.tenant_id AND o.id=g.object_id AND pg.grantee_id=g.grantee_id
         AND pg.verb='read' AND pg.field_class='CONFIDENTIAL'
         AND pg.reason='crm_collaborator_person:'||p_object::text
         AND pg.policy_version=t.policy_version AND pg.revoked_at IS NULL
         AND tstzrange(pg.effective_from,pg.effective_to,'[)') @> statement_timestamp()
         AND authz.capable(pg.grantee_id,'person','read','CONFIDENTIAL')
         AND authz.direct_access(pg.grantor_id,'person',o.person_id,'read','CONFIDENTIAL')
         AND authz.direct_access(pg.grantor_id,'person',o.person_id,'share','CONFIDENTIAL')
     )
   GROUP BY g.grantee_id
 ) x;
 RETURN value;
END $$;

CREATE FUNCTION authz.crm_add_collaborator(
 p_object uuid,p_grantee uuid,p_access text,p_until timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE person_id uuid;
BEGIN
 IF p_access NOT IN ('read','update') OR p_grantee=authz.actor_id()
 OR EXISTS(
   SELECT 1 FROM authz.access_grant g JOIN authz.tenant t ON t.id=g.tenant_id
   WHERE g.tenant_id=authz.tenant_id() AND g.object_type='opportunity'
     AND g.object_id=p_object AND g.grantee_id=p_grantee
     AND g.reason='crm_collaborator' AND g.policy_version=t.policy_version
     AND g.revoked_at IS NULL
     AND tstzrange(g.effective_from,g.effective_to,'[)') @> statement_timestamp()
 ) THEN RAISE EXCEPTION 'invalid_collaborator' USING ERRCODE='23514'; END IF;
 SELECT o.person_id INTO person_id FROM rpt.opportunity o
 WHERE o.tenant_id=authz.tenant_id() AND o.id=p_object;
 IF person_id IS NULL THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 PERFORM authz.crm_grant(p_object,p_grantee,'read',p_until,'crm_collaborator');
 PERFORM authz.create_grant(person_id,p_grantee,'read','CONFIDENTIAL',p_until,'crm_collaborator_person:'||p_object::text);
 IF p_access='update' THEN
   PERFORM authz.crm_grant(p_object,p_grantee,'update',p_until,'crm_collaborator');
 END IF;
END $$;

CREATE FUNCTION authz.crm_remove_collaborator(p_object uuid,p_grantee uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE person_id uuid;
BEGIN
 IF NOT authz.crm_allowed(p_object,'share')
 OR NOT authz.direct_access(authz.actor_id(),'opportunity',p_object,'share','CONFIDENTIAL')
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 SELECT o.person_id INTO person_id FROM rpt.opportunity o
 WHERE o.tenant_id=authz.tenant_id() AND o.id=p_object;
 UPDATE authz.access_grant SET revoked_at=clock_timestamp()
 WHERE tenant_id=authz.tenant_id() AND object_type='opportunity'
   AND object_id=p_object AND grantee_id=p_grantee
   AND reason='crm_collaborator' AND revoked_at IS NULL
   AND effective_to>statement_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'collaborator_not_found' USING ERRCODE='P0002'; END IF;
 UPDATE authz.access_grant SET revoked_at=clock_timestamp()
 WHERE tenant_id=authz.tenant_id() AND object_type='person'
   AND object_id=person_id AND grantee_id=p_grantee
   AND reason='crm_collaborator_person:'||p_object::text AND revoked_at IS NULL;
END $$;

REVOKE ALL ON FUNCTION authz.crm_collaborators(uuid),authz.crm_add_collaborator(uuid,uuid,text,timestamptz),authz.crm_remove_collaborator(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.crm_collaborators(uuid),authz.crm_add_collaborator(uuid,uuid,text,timestamptz),authz.crm_remove_collaborator(uuid,uuid) TO rpt_runtime;
