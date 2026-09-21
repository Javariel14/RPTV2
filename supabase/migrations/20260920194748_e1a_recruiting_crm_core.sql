SET LOCAL ROLE rpt_owner;

CREATE FUNCTION authz.recruiting_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND EXISTS(
   SELECT 1 FROM authz.tenant t JOIN rpt.feature_flag f ON f.tenant_id=t.id
   WHERE t.id=authz.tenant_id() AND NOT t.real_data_enabled
   AND f.key='recruiting_crm_core' AND f.enabled AND f.rollout_percent=100
   AND f.policy_version=t.policy_version AND f.market_id IS NULL
   AND tstzrange(f.effective_from,f.effective_to,'[)') @> statement_timestamp()
 )
$$;

CREATE FUNCTION authz.recruiting_workspace_right(p_workspace uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.recruiting_enabled()
 AND authz.capable(authz.actor_id(),'recruitment_profile',p_verb,'CONFIDENTIAL')
 AND EXISTS(
   SELECT 1 FROM rpt.crm_workspace w
   JOIN authz.workspace_permission p ON (p.tenant_id,p.workspace_id)=(w.tenant_id,w.id)
   JOIN authz.tenant t ON t.id=w.tenant_id
   WHERE w.tenant_id=authz.tenant_id() AND w.id=p_workspace AND w.kind='recruitment'
   AND p.user_id=authz.actor_id() AND p.object_type='recruitment_profile'
   AND p.verb=p_verb AND p.field_class='CONFIDENTIAL' AND p.policy_version=t.policy_version
   AND p.revoked_at IS NULL AND tstzrange(p.effective_from,p.effective_to,'[)') @> statement_timestamp()
 )
$$;

CREATE TABLE rpt.recruitment_profile (
 tenant_id uuid NOT NULL, id uuid NOT NULL, person_id uuid NOT NULL, workspace_id uuid NOT NULL,
 owner_id uuid NOT NULL, source text NOT NULL CHECK(source IN ('manual','import','referral','event','telemarketing')),
 stage text NOT NULL DEFAULT 'new' CHECK(stage IN ('new','initial_contact','qualified','interview_to_schedule','interview_scheduled','interviewed','evaluation','followup_decision','onboarding','activated')),
 substatus text CHECK(substatus IS NULL OR substatus IN ('data_validated','duplicate_suspected','first_contact_pending','contacted','no_answer','invalid_number','message_sent','interest_qualified','interview_proposed','interview_scheduled','confirmation_pending','confirmed','no_response','reschedule_requested','rescheduled','cancelled','no_show','attended','evaluation_pending','evaluated','nurture','not_interested','registration_started','onboarding_started','training_pending','activated','withdrawn')),
 priority text CHECK(priority IS NULL OR priority IN ('A','B','C')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,workspace_id,person_id),
 FOREIGN KEY(tenant_id,person_id) REFERENCES rpt.person,
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,owner_id) REFERENCES authz.user_account
);
COMMENT ON COLUMN rpt.recruitment_profile.priority IS 'Operational recruiting priority only; never a psychological or personality attribute.';

CREATE TABLE rpt.recruitment_appointment (
 tenant_id uuid NOT NULL, id uuid NOT NULL, profile_id uuid NOT NULL, starts_at timestamptz NOT NULL,
 timezone text NOT NULL CHECK(length(timezone) BETWEEN 1 AND 64),
 channel text NOT NULL CHECK(channel IN ('in_person','phone','video')),
 actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,profile_id) REFERENCES rpt.recruitment_profile,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account
);
CREATE TABLE rpt.recruitment_interview (
 tenant_id uuid NOT NULL, id uuid NOT NULL, profile_id uuid NOT NULL, occurred_at timestamptz NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('attended','no_show','cancelled','rescheduled')),
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=1000), actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,profile_id) REFERENCES rpt.recruitment_profile,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account
);
CREATE TABLE rpt.recruitment_followup (
 tenant_id uuid NOT NULL, id uuid NOT NULL, profile_id uuid NOT NULL, due_at timestamptz NOT NULL,
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 1000), completed_at timestamptz,
 actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,profile_id) REFERENCES rpt.recruitment_profile,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account
);
CREATE TABLE rpt.recruitment_hook (
 tenant_id uuid NOT NULL, id uuid NOT NULL, profile_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('training','onboarding')), status text NOT NULL DEFAULT 'requested' CHECK(status='requested'),
 reference text CHECK(reference IS NULL OR length(reference)<=200), actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,profile_id) REFERENCES rpt.recruitment_profile,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account
);
CREATE TABLE rpt.recruitment_event (
 tenant_id uuid NOT NULL, id uuid NOT NULL, profile_id uuid NOT NULL, actor_id uuid NOT NULL,
 action text NOT NULL, source text NOT NULL DEFAULT 'RPT_USER' CHECK(source='RPT_USER'),
 authority text NOT NULL DEFAULT 'manual' CHECK(authority='manual'), request_id uuid NOT NULL,
 payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(payload)='object' AND pg_column_size(payload)<=2048),
 occurred_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,profile_id) REFERENCES rpt.recruitment_profile,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account
);

CREATE FUNCTION authz.recruiting_allowed(p_id uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.recruiting_enabled()
 AND authz.allowed('recruitment_profile',p_id,p_verb,'CONFIDENTIAL')
 AND EXISTS(
   SELECT 1 FROM rpt.recruitment_profile r JOIN rpt.person p ON (p.tenant_id,p.id)=(r.tenant_id,r.person_id)
   WHERE r.tenant_id=authz.tenant_id() AND r.id=p_id AND p.deleted_at IS NULL
   AND authz.allowed('person',p.id,'read','CONFIDENTIAL')
 )
$$;
CREATE FUNCTION authz.recruiting_child(p_id uuid,p_type text,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.recruiting_allowed(p_id,CASE WHEN p_verb='read' THEN 'read' ELSE 'update' END)
 AND authz.capable(authz.actor_id(),p_type,p_verb,'CONFIDENTIAL')
$$;
CREATE FUNCTION authz.recruiting_can_assign(p_id uuid,p_owner uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.recruiting_allowed(p_id,'update')
 AND EXISTS(
   SELECT 1 FROM rpt.recruitment_profile r JOIN authz.tenant t ON t.id=r.tenant_id
   WHERE r.tenant_id=authz.tenant_id() AND r.id=p_id
   AND authz.recruiting_workspace_right(r.workspace_id,'reassign')
   AND authz.capable(p_owner,'recruitment_profile','read','CONFIDENTIAL')
   AND authz.capable(p_owner,'recruitment_profile','update','CONFIDENTIAL')
   AND EXISTS(SELECT 1 FROM authz.workspace_permission w WHERE w.tenant_id=r.tenant_id
     AND w.workspace_id=r.workspace_id AND w.user_id=p_owner AND w.object_type='recruitment_profile'
     AND w.verb='read' AND w.field_class='CONFIDENTIAL' AND w.policy_version=t.policy_version
     AND w.revoked_at IS NULL AND tstzrange(w.effective_from,w.effective_to,'[)') @> statement_timestamp())
   AND EXISTS(SELECT 1 FROM authz.workspace_permission w WHERE w.tenant_id=r.tenant_id
     AND w.workspace_id=r.workspace_id AND w.user_id=p_owner AND w.object_type='recruitment_profile'
     AND w.verb='update' AND w.field_class='CONFIDENTIAL' AND w.policy_version=t.policy_version
     AND w.revoked_at IS NULL AND tstzrange(w.effective_from,w.effective_to,'[)') @> statement_timestamp())
 )
$$;

CREATE FUNCTION authz.recruiting_ownership_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   INSERT INTO authz.object_access(tenant_id,object_type,object_id,workspace_id,owner_id)
   VALUES(NEW.tenant_id,'recruitment_profile',NEW.id,NEW.workspace_id,NEW.owner_id);
 ELSE
   UPDATE authz.object_access SET owner_id=NEW.owner_id
   WHERE tenant_id=NEW.tenant_id AND object_type='recruitment_profile' AND object_id=NEW.id;
 END IF;
 IF TG_OP='INSERT' OR NEW.owner_id<>OLD.owner_id THEN
   INSERT INTO authz.ownership_history(tenant_id,object_type,object_id,workspace_id,owner_id)
   VALUES(NEW.tenant_id,'recruitment_profile',NEW.id,NEW.workspace_id,NEW.owner_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recruiting_ownership_sync AFTER INSERT OR UPDATE OF owner_id ON rpt.recruitment_profile
FOR EACH ROW EXECUTE FUNCTION authz.recruiting_ownership_sync();

CREATE FUNCTION authz.recruiting_profile_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE stages text[]:=ARRAY['new','initial_contact','qualified','interview_to_schedule','interview_scheduled','interviewed','evaluation','followup_decision','onboarding','activated'];
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.stage<>'new' OR NEW.version<>1 THEN RAISE EXCEPTION 'invalid_initial_stage' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF (NEW.tenant_id,NEW.id,NEW.person_id,NEW.workspace_id,NEW.source,NEW.created_at) IS DISTINCT FROM
    (OLD.tenant_id,OLD.id,OLD.person_id,OLD.workspace_id,OLD.source,OLD.created_at)
 THEN RAISE EXCEPTION 'immutable_context' USING ERRCODE='42501'; END IF;
 IF NEW.owner_id<>OLD.owner_id AND NOT authz.recruiting_can_assign(OLD.id,NEW.owner_id)
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'invalid_version' USING ERRCODE='23514'; END IF;
 IF NEW.stage<>OLD.stage AND array_position(stages,NEW.stage)<>array_position(stages,OLD.stage)+1
 THEN RAISE EXCEPTION 'invalid_stage_transition' USING ERRCODE='23514'; END IF;
 NEW.updated_at=statement_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER recruiting_profile_guard BEFORE INSERT OR UPDATE ON rpt.recruitment_profile
FOR EACH ROW EXECUTE FUNCTION authz.recruiting_profile_guard();

CREATE FUNCTION authz.recruiting_followup_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.tenant_id,NEW.id,NEW.profile_id,NEW.due_at,NEW.body,NEW.actor_id,NEW.created_at) IS DISTINCT FROM
    (OLD.tenant_id,OLD.id,OLD.profile_id,OLD.due_at,OLD.body,OLD.actor_id,OLD.created_at)
 OR OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL
 THEN RAISE EXCEPTION 'append_only_followup' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recruiting_followup_guard BEFORE UPDATE ON rpt.recruitment_followup
FOR EACH ROW EXECUTE FUNCTION authz.recruiting_followup_guard();

CREATE FUNCTION authz.recruiting_receipt(p_key text,p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r authz.idempotency_receipt%ROWTYPE;
BEGIN
 IF NOT authz.recruiting_enabled() OR length(p_key) NOT BETWEEN 8 AND 128 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||'/recruiting/'||p_key,0));
 SELECT * INTO r FROM authz.idempotency_receipt WHERE tenant_id=authz.tenant_id() AND operation='recruiting.v1' AND key=p_key;
 IF FOUND THEN
   IF r.actor_id<>authz.actor_id() OR r.request_hash<>p_hash THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
   RETURN r.response;
 END IF;
 INSERT INTO authz.idempotency_receipt(tenant_id,operation,key,actor_id,request_hash)
 VALUES(authz.tenant_id(),'recruiting.v1',p_key,authz.actor_id(),p_hash);
 RETURN NULL;
END $$;
CREATE FUNCTION authz.recruiting_finish(p_key text,p_response jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.recruiting_enabled() OR pg_column_size(p_response)>512 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 UPDATE authz.idempotency_receipt SET response=p_response
 WHERE tenant_id=authz.tenant_id() AND operation='recruiting.v1' AND key=p_key
 AND actor_id=authz.actor_id() AND response IS NULL;
END $$;

ALTER TABLE rpt.recruitment_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.recruitment_appointment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.recruitment_interview ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.recruitment_followup ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.recruitment_hook ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.recruitment_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY recruiting_profile_read ON rpt.recruitment_profile FOR SELECT TO rpt_runtime
USING(tenant_id=authz.tenant_id() AND authz.recruiting_allowed(id,'read'));
CREATE POLICY recruiting_profile_create ON rpt.recruitment_profile FOR INSERT TO rpt_runtime
WITH CHECK(tenant_id=authz.tenant_id() AND owner_id=authz.actor_id()
 AND authz.recruiting_workspace_right(workspace_id,'create')
 AND authz.allowed('person',person_id,'read','CONFIDENTIAL'));
CREATE POLICY recruiting_profile_update ON rpt.recruitment_profile FOR UPDATE TO rpt_runtime
USING(tenant_id=authz.tenant_id() AND authz.recruiting_allowed(id,'update'))
WITH CHECK(tenant_id=authz.tenant_id() AND authz.recruiting_allowed(id,'update'));

CREATE POLICY recruiting_appointment_read ON rpt.recruitment_appointment FOR SELECT TO rpt_runtime
USING(tenant_id=authz.tenant_id() AND authz.recruiting_child(profile_id,'recruitment_appointment','read'));
CREATE POLICY recruiting_appointment_create ON rpt.recruitment_appointment FOR INSERT TO rpt_runtime
WITH CHECK(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id() AND authz.recruiting_child(profile_id,'recruitment_appointment','create'));
CREATE POLICY recruiting_interview_read ON rpt.recruitment_interview FOR SELECT TO rpt_runtime
USING(tenant_id=authz.tenant_id() AND authz.recruiting_child(profile_id,'recruitment_interview','read'));
CREATE POLICY recruiting_interview_create ON rpt.recruitment_interview FOR INSERT TO rpt_runtime
WITH CHECK(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id() AND authz.recruiting_child(profile_id,'recruitment_interview','create'));
CREATE POLICY recruiting_followup_read ON rpt.recruitment_followup FOR SELECT TO rpt_runtime
USING(tenant_id=authz.tenant_id() AND authz.recruiting_child(profile_id,'recruitment_followup','read'));
CREATE POLICY recruiting_followup_create ON rpt.recruitment_followup FOR INSERT TO rpt_runtime
WITH CHECK(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id() AND authz.recruiting_child(profile_id,'recruitment_followup','create'));
CREATE POLICY recruiting_followup_update ON rpt.recruitment_followup FOR UPDATE TO rpt_runtime
USING(tenant_id=authz.tenant_id() AND authz.recruiting_child(profile_id,'recruitment_followup','update'))
WITH CHECK(tenant_id=authz.tenant_id() AND authz.recruiting_child(profile_id,'recruitment_followup','update'));
CREATE POLICY recruiting_hook_read ON rpt.recruitment_hook FOR SELECT TO rpt_runtime
USING(tenant_id=authz.tenant_id() AND authz.recruiting_child(profile_id,'recruitment_hook','read'));
CREATE POLICY recruiting_hook_create ON rpt.recruitment_hook FOR INSERT TO rpt_runtime
WITH CHECK(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id() AND authz.recruiting_child(profile_id,'recruitment_hook','create'));
CREATE POLICY recruiting_event_read ON rpt.recruitment_event FOR SELECT TO rpt_runtime
USING(tenant_id=authz.tenant_id() AND authz.recruiting_allowed(profile_id,'read'));
CREATE POLICY recruiting_event_create ON rpt.recruitment_event FOR INSERT TO rpt_runtime
WITH CHECK(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id() AND authz.recruiting_allowed(profile_id,'update'));

GRANT SELECT,INSERT,UPDATE ON rpt.recruitment_profile TO rpt_runtime;
GRANT SELECT,INSERT ON rpt.recruitment_appointment,rpt.recruitment_interview,rpt.recruitment_hook,rpt.recruitment_event TO rpt_runtime;
GRANT SELECT,INSERT,UPDATE ON rpt.recruitment_followup TO rpt_runtime;
GRANT EXECUTE ON FUNCTION authz.recruiting_enabled(),authz.recruiting_workspace_right(uuid,text),authz.recruiting_allowed(uuid,text),authz.recruiting_child(uuid,text,text),authz.recruiting_can_assign(uuid,uuid),authz.recruiting_receipt(text,text),authz.recruiting_finish(text,jsonb) TO rpt_runtime;

CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON rpt.recruitment_profile FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON rpt.recruitment_appointment FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON rpt.recruitment_interview FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON rpt.recruitment_followup FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON rpt.recruitment_hook FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.recruitment_event FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON rpt.recruitment_event FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();

CREATE OR REPLACE FUNCTION authz.record_decision(p_object uuid,p_action text,p_result text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR p_action NOT IN ('person.read','person.update','metric.append','grant.create','grant.revoke','privacy.purge','network.stats','crm.context','crm.list','crm.detail','crm.onboard','crm.create','crm.command','crm.view','crm.metrics','crm.grant','recruiting.list','recruiting.detail','recruiting.create','recruiting.command') OR p_result NOT IN ('allow','deny','success','failure')
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO rpt.audit_event(tenant_id,actor_id,action,object_type,object_id,scope,policy_version,request_id,result,reason_code)
 VALUES(authz.tenant_id(),authz.actor_id(),p_action,'permission_decision',p_object,'request',(SELECT policy_version FROM authz.tenant WHERE id=authz.tenant_id()),nullif(current_setting('rpt.request_id',true),'')::uuid,p_result,'server_policy');
END $$;

CREATE INDEX recruitment_profile_work_idx ON rpt.recruitment_profile(tenant_id,workspace_id,owner_id,stage,id);
CREATE INDEX recruitment_appointment_profile_idx ON rpt.recruitment_appointment(tenant_id,profile_id,starts_at);
CREATE INDEX recruitment_interview_profile_idx ON rpt.recruitment_interview(tenant_id,profile_id,occurred_at);
CREATE INDEX recruitment_followup_profile_idx ON rpt.recruitment_followup(tenant_id,profile_id,due_at);
CREATE INDEX recruitment_hook_profile_idx ON rpt.recruitment_hook(tenant_id,profile_id,created_at);
CREATE INDEX recruitment_event_profile_idx ON rpt.recruitment_event(tenant_id,profile_id,occurred_at);
