SET LOCAL ROLE rpt_owner;
-- Forward hardening: write capabilities must never act as implicit read policies.
DO $$ DECLARE tbl text; prefix text; capability text; verb text; field text; BEGIN
 FOR tbl,prefix,capability,verb,field IN
 SELECT * FROM (VALUES
 ('market','structural','network','update','INTERNAL'),('distribution_group','structural','network','update','INTERNAL'),
 ('market_registration','structural','network','update','INTERNAL'),('network_parent','structural','network','update','INTERNAL'),
 ('commercial_membership','structural','network','update','INTERNAL'),
 ('source_observation','trust','trust','approve','OFFICIAL_COMPENSATION'),('reconciliation_case','trust','trust','approve','OFFICIAL_COMPENSATION'),
 ('official_rank_assignment','trust','trust','approve','OFFICIAL_COMPENSATION'),
 ('consent_record','privacy','privacy','approve','RESTRICTED_PII'),('privacy_request','privacy','privacy','approve','RESTRICTED_PII'),('legal_hold','privacy','privacy','approve','RESTRICTED_PII')) AS p(tbl,prefix,capability,verb,field)
 LOOP
 EXECUTE format('DROP POLICY %I ON rpt.%I',prefix||'_write',tbl);
 EXECUTE format('CREATE POLICY %I ON rpt.%I FOR INSERT TO rpt_runtime WITH CHECK(authz.tenant_allowed(tenant_id,%L,%L,%L))',prefix||'_insert',tbl,capability,verb,field);
 EXECUTE format('CREATE POLICY %I ON rpt.%I FOR UPDATE TO rpt_runtime USING(authz.tenant_allowed(tenant_id,%L,%L,%L)) WITH CHECK(authz.tenant_allowed(tenant_id,%L,%L,%L))',prefix||'_update',tbl,capability,verb,field,capability,verb,field);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION authz.person_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id THEN RAISE EXCEPTION 'immutable_identity' USING ERRCODE='42501'; END IF;
 IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND current_user<>'rpt_owner' THEN RAISE EXCEPTION 'privacy_workflow_required' USING ERRCODE='42501'; END IF;
 IF (NEW.owner_id<>OLD.owner_id OR NEW.workspace_id<>OLD.workspace_id) AND NOT authz.allowed('person',OLD.id,'reassign','CONFIDENTIAL') THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 NEW.version=OLD.version+1; NEW.updated_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION authz.membership_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.tenant_id,NEW.id,NEW.person_id,NEW.group_id,NEW.effective_from,NEW.source) IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.person_id,OLD.group_id,OLD.effective_from,OLD.source)
 OR OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL OR OLD.status NOT IN ('active','historical') OR NEW.status<>'historical'
 THEN RAISE EXCEPTION 'close_then_append_required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION authz.create_grant(p_object uuid,p_grantee uuid,p_verb text,p_field text,p_until timestamptz,p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE grant_id uuid=gen_random_uuid();
BEGIN
 IF NOT authz.session_valid() OR NOT authz.direct_access(authz.actor_id(),'person',p_object,'share',p_field)
 OR NOT authz.direct_access(authz.actor_id(),'person',p_object,p_verb,p_field)
 OR NOT authz.capable(p_grantee,'person',p_verb,p_field) OR p_grantee=authz.actor_id()
 OR p_until<=statement_timestamp() OR p_until>statement_timestamp()+interval '30 days'
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO authz.access_grant(tenant_id,id,object_type,object_id,grantor_id,grantee_id,verb,field_class,effective_from,effective_to,policy_version,reason)
 SELECT authz.tenant_id(),grant_id,'person',p_object,authz.actor_id(),p_grantee,p_verb,p_field,statement_timestamp(),p_until,policy_version,p_reason FROM authz.tenant WHERE id=authz.tenant_id();
 RETURN grant_id;
END $$;
CREATE FUNCTION authz.revoke_grant(p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() THEN RETURN false; END IF;
 UPDATE authz.access_grant SET revoked_at=clock_timestamp() WHERE tenant_id=authz.tenant_id() AND id=p_id AND grantor_id=authz.actor_id() AND revoked_at IS NULL;
 RETURN FOUND;
END $$;

-- No CRM/person identifiers are returned. Sales are suppressed until a customer
-- cohort policy and disclosure review are configured; no global ancestor bypass.
CREATE FUNCTION authz.network_statistics(p_ancestor uuid,p_at timestamptz) RETURNS TABLE(metric_key text,total numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.tenant_allowed(authz.tenant_id(),'network','statistics','INTERNAL') OR NOT EXISTS(
 SELECT 1 FROM authz.statistical_scope s WHERE s.tenant_id=authz.tenant_id() AND s.user_id=authz.actor_id()
 AND s.ancestor_id=p_ancestor AND s.revoked_at IS NULL AND tstzrange(s.effective_from,s.effective_to,'[)') @> statement_timestamp()) THEN RETURN; END IF;
 RETURN QUERY WITH RECURSIVE descendants(id,path) AS (
 SELECT p_ancestor,ARRAY[p_ancestor]
 UNION ALL SELECT n.child_id,d.path||n.child_id FROM rpt.network_parent n JOIN descendants d ON n.parent_id=d.id
 WHERE n.tenant_id=authz.tenant_id() AND tstzrange(n.effective_from,n.effective_to,'[)') @> p_at AND NOT n.child_id=ANY(d.path))
 SELECT l.metric_key,sum(l.value) FROM rpt.metric_event_ledger l JOIN descendants d ON d.id=l.registration_id
 WHERE l.tenant_id=authz.tenant_id() AND l.occurred_at<=p_at AND l.metric_key<>'sales' GROUP BY l.metric_key;
END $$;

CREATE FUNCTION authz.append_activity(p_subject uuid,p_registration uuid,p_market uuid,p_metric text,p_value numeric,p_occurred timestamptz,p_unit text,p_key text,p_reversal uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE request_hash text; receipt authz.idempotency_receipt%ROWTYPE; event_id uuid; original rpt.metric_event_ledger%ROWTYPE;
BEGIN
 -- Every retry reauthorizes before touching a receipt, including after revocation.
 IF NOT authz.tenant_allowed(authz.tenant_id(),'metric','create','INTERNAL') OR NOT authz.allowed('person',p_subject,'update','CONFIDENTIAL') THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 IF length(p_key) NOT BETWEEN 8 AND 128 OR p_metric='sales' OR p_value IS NULL OR p_occurred IS NULL OR length(p_unit) NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'invalid_activity' USING ERRCODE='23514'; END IF;
 request_hash=encode(extensions.digest(jsonb_build_array(p_subject,p_registration,p_market,p_metric,p_value,p_occurred,p_unit,p_reversal)::text,'sha256'),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||'/activity/'||p_key,0));
 SELECT * INTO receipt FROM authz.idempotency_receipt WHERE tenant_id=authz.tenant_id() AND operation='activity.v1' AND key=p_key;
 IF FOUND THEN
 IF receipt.actor_id<>authz.actor_id() OR receipt.request_hash<>request_hash THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
 RETURN (receipt.response->>'id')::uuid;
 END IF;
 IF p_reversal IS NOT NULL THEN
 SELECT * INTO original FROM rpt.metric_event_ledger WHERE tenant_id=authz.tenant_id() AND id=p_reversal;
 IF NOT FOUND OR original.source<>'RPT_USER' OR original.verification<>'unverified' OR original.office_context IS NOT NULL THEN RAISE EXCEPTION 'invalid_reversal' USING ERRCODE='23514'; END IF;
 END IF;
 event_id=gen_random_uuid();
 INSERT INTO rpt.metric_event_ledger(tenant_id,id,metric_key,actor_id,subject_person_id,registration_id,market_id,occurred_at,value,unit,source,verification,policy_version,idempotency_key,event_kind,reversal_of,correlation_id)
 SELECT authz.tenant_id(),event_id,p_metric,authz.actor_id(),p_subject,p_registration,p_market,p_occurred,p_value,p_unit,'RPT_USER','unverified',policy_version,p_key,CASE WHEN p_reversal IS NULL THEN 'original' ELSE 'reversal' END,p_reversal,nullif(current_setting('rpt.request_id',true),'')::uuid FROM authz.tenant WHERE id=authz.tenant_id();
 INSERT INTO authz.idempotency_receipt(tenant_id,operation,key,actor_id,request_hash,response) VALUES(authz.tenant_id(),'activity.v1',p_key,authz.actor_id(),request_hash,jsonb_build_object('id',event_id));
 RETURN event_id;
END $$;

CREATE FUNCTION authz.purge_person(p_request uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target uuid;
BEGIN
 IF NOT authz.tenant_allowed(authz.tenant_id(),'privacy','approve','RESTRICTED_PII') OR current_setting('rpt.aal',true)<>'aal2' THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 SELECT person_id INTO target FROM rpt.privacy_request WHERE tenant_id=authz.tenant_id() AND id=p_request AND kind='deletion' AND state='approved' AND verified_at IS NOT NULL FOR UPDATE;
 IF target IS NULL OR NOT authz.allowed('person',target,'delete','RESTRICTED_PII') THEN RETURN false; END IF;
 -- A shared per-person lock coordinates hold creation and erasure.
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||target::text,1));
 IF EXISTS(SELECT 1 FROM rpt.legal_hold WHERE tenant_id=authz.tenant_id() AND person_id=target AND active) THEN RETURN false; END IF;
 DELETE FROM rpt.person_pii WHERE tenant_id=authz.tenant_id() AND person_id=target;
 UPDATE rpt.person SET display_name='[erased]',deleted_at=clock_timestamp() WHERE tenant_id=authz.tenant_id() AND id=target;
 UPDATE rpt.privacy_request SET state='completed' WHERE tenant_id=authz.tenant_id() AND id=p_request;
 PERFORM authz.record_decision(target,'privacy.purge','success');
 RETURN true;
END $$;
CREATE FUNCTION authz.hold_lock() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||NEW.person_id::text,1)); RETURN NEW; END $$;
CREATE TRIGGER hold_lock BEFORE INSERT OR UPDATE ON rpt.legal_hold FOR EACH ROW EXECUTE FUNCTION authz.hold_lock();
GRANT EXECUTE ON FUNCTION authz.create_grant(uuid,uuid,text,text,timestamptz,text),authz.revoke_grant(uuid),authz.network_statistics(uuid,timestamptz),authz.append_activity(uuid,uuid,uuid,text,numeric,timestamptz,text,text,uuid),authz.purge_person(uuid) TO rpt_runtime;

-- Runtime cannot append arbitrary metric facts, rank or provenance via public SQL.
-- Official adapter activation needs a reviewed, separately privileged ingestion path.
REVOKE INSERT ON rpt.metric_event_ledger FROM rpt_runtime;
CREATE INDEX privacy_hold_idx ON rpt.legal_hold(tenant_id,person_id) WHERE active;
