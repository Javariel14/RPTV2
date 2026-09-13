SET LOCAL ROLE rpt_owner;
-- Append a normalized, minimized fact; existing observations stay preserved.
ALTER TABLE rpt.source_observation ADD COLUMN facts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(facts)='object' AND pg_column_size(facts)<=65536);
CREATE OR REPLACE FUNCTION authz.rank_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM rpt.source_observation o JOIN authz.source_authority a ON a.tenant_id=o.tenant_id AND a.source_system=o.source_system AND a.domain_key=o.domain_key
 WHERE o.tenant_id=NEW.tenant_id AND o.id=NEW.observation_id AND o.subject_id=NEW.group_id AND o.facts->>'rankKey'=NEW.rank_key
 AND o.authority_level='official' AND o.domain_key='rank' AND o.verified_at IS NOT NULL AND o.reconciliation_state IN ('matched','resolved')
 AND a.authority_level='official' AND a.user_id=authz.actor_id() AND a.revoked_at IS NULL)
 THEN RAISE EXCEPTION 'official_confirmation_required' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.rank_key<>OLD.rank_key OR NEW.group_id<>OLD.group_id OR NEW.observation_id<>OLD.observation_id OR NEW.effective_from<>OLD.effective_from OR OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL) THEN RAISE EXCEPTION 'close_then_append_required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION authz.direct_access(p_actor uuid,p_type text,p_id uuid,p_verb text,p_field text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.capable(p_actor,p_type,p_verb,p_field) AND EXISTS (
 SELECT 1 FROM authz.object_access o JOIN authz.tenant t ON t.id=o.tenant_id
 WHERE o.tenant_id=authz.tenant_id() AND o.object_type=p_type AND o.object_id=p_id
 AND (p_type<>'person' OR EXISTS(SELECT 1 FROM rpt.person p WHERE (p.tenant_id,p.id)=(o.tenant_id,o.object_id) AND p.deleted_at IS NULL))
 AND (o.owner_id=p_actor OR EXISTS(SELECT 1 FROM authz.workspace_permission w WHERE w.tenant_id=o.tenant_id
 AND w.workspace_id=o.workspace_id AND w.user_id=p_actor AND w.object_type=p_type AND w.verb=p_verb AND w.field_class=p_field
 AND w.policy_version=t.policy_version AND w.revoked_at IS NULL AND w.effective_from<=statement_timestamp()
 AND (w.effective_to IS NULL OR w.effective_to>statement_timestamp()))))
$$;

CREATE FUNCTION authz.audit_tenant_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO rpt.audit_event(tenant_id,actor_id,action,object_type,object_id,scope,policy_version,request_id,result,reason_code,after_digest)
 VALUES(NEW.id,authz.actor_id(),lower(TG_OP),'tenant',NEW.id,'tenant/config',NEW.policy_version,nullif(current_setting('rpt.request_id',true),'')::uuid,'success',CASE WHEN authz.actor_id() IS NULL THEN 'operator_bootstrap' ELSE 'policy_change' END,encode(extensions.digest(to_jsonb(NEW)::text,'sha256'),'hex'));
 RETURN NEW;
END $$;
CREATE TRIGGER audit_tenant_change AFTER INSERT OR UPDATE ON authz.tenant FOR EACH ROW EXECUTE FUNCTION authz.audit_tenant_change();

-- Structural membership contains person IDs and therefore is NOT a network read DTO.
DROP POLICY structural_read ON rpt.commercial_membership;
CREATE POLICY membership_object_read ON rpt.commercial_membership FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND authz.allowed('person',person_id,'read','CONFIDENTIAL'));
