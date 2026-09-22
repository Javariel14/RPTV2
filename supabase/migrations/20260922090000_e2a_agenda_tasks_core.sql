SET LOCAL ROLE rpt_owner;

CREATE FUNCTION authz.agenda_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND EXISTS(
   SELECT 1 FROM authz.tenant t JOIN rpt.feature_flag f ON f.tenant_id=t.id
   WHERE t.id=authz.tenant_id() AND NOT t.real_data_enabled
   AND f.key='agenda_tasks_core' AND f.enabled AND f.rollout_percent=100
   AND f.policy_version=t.policy_version AND f.market_id IS NULL
   AND tstzrange(f.effective_from,f.effective_to,'[)') @> statement_timestamp()
 )
$$;

CREATE FUNCTION authz.agenda_workspace_right(p_workspace uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.agenda_enabled()
 AND authz.capable(authz.actor_id(),'agenda_item',p_verb,'CONFIDENTIAL')
 AND EXISTS(
   SELECT 1 FROM rpt.crm_workspace w
   JOIN authz.workspace_permission p ON (p.tenant_id,p.workspace_id)=(w.tenant_id,w.id)
   JOIN authz.tenant t ON t.id=w.tenant_id
   WHERE w.tenant_id=authz.tenant_id() AND w.id=p_workspace
   AND p.user_id=authz.actor_id() AND p.object_type='agenda_item' AND p.verb=p_verb
   AND p.field_class='CONFIDENTIAL' AND p.policy_version=t.policy_version
   AND p.revoked_at IS NULL AND tstzrange(p.effective_from,p.effective_to,'[)') @> statement_timestamp()
 )
$$;

CREATE FUNCTION authz.valid_reminder_minutes(p_values integer[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(bool_and(value BETWEEN 0 AND 43200),true) FROM unnest(p_values) value
$$;

CREATE FUNCTION authz.workspace_timezone(p_workspace uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT m.timezone FROM rpt.crm_workspace w
 JOIN rpt.market_registration r ON (r.tenant_id,r.id)=(w.tenant_id,w.registration_id)
 JOIN rpt.market m ON (m.tenant_id,m.id)=(r.tenant_id,r.market_id)
 WHERE w.tenant_id=authz.tenant_id() AND w.id=p_workspace AND authz.agenda_enabled()
$$;

CREATE TABLE rpt.agenda_item (
 tenant_id uuid NOT NULL, id uuid NOT NULL, workspace_id uuid NOT NULL, owner_id uuid NOT NULL,
 type text NOT NULL CHECK(type IN ('appointment','task')),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200 AND position('@' IN title)=0),
 summary text CHECK(summary IS NULL OR (length(summary) BETWEEN 1 AND 1000 AND position('@' IN summary)=0)),
 starts_at timestamptz, ends_at timestamptz, due_at timestamptz,
 timezone text NOT NULL CHECK(length(timezone) BETWEEN 1 AND 64),
 status text NOT NULL CHECK(status IN ('scheduled','open','completed','cancelled')),
 confirmation_state text CHECK(confirmation_state IS NULL OR confirmation_state IN ('pending','confirmed','declined','cancelled')),
 priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high')),
 source text NOT NULL CHECK(source IN ('manual','commercial_crm','recruiting_crm')),
 person_id uuid, opportunity_id uuid, recruitment_profile_id uuid,
 series_id uuid, occurrence_index integer NOT NULL DEFAULT 0 CHECK(occurrence_index>=0),
 recurrence_rule jsonb CHECK(recurrence_rule IS NULL OR (jsonb_typeof(recurrence_rule)='object' AND pg_column_size(recurrence_rule)<=1024)),
 reminder_minutes integer[] NOT NULL DEFAULT '{}' CHECK(cardinality(reminder_minutes)<=4),
 origin_label text CHECK(origin_label IS NULL OR length(origin_label) BETWEEN 1 AND 200),
 destination_label text CHECK(destination_label IS NULL OR length(destination_label) BETWEEN 1 AND 300),
 estimated_travel_minutes integer CHECK(estimated_travel_minutes BETWEEN 0 AND 1440),
 preparation_minutes integer CHECK(preparation_minutes BETWEEN 0 AND 1440),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(), updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,owner_id) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,person_id) REFERENCES rpt.person,
 FOREIGN KEY(tenant_id,opportunity_id) REFERENCES rpt.opportunity,
 FOREIGN KEY(tenant_id,recruitment_profile_id) REFERENCES rpt.recruitment_profile,
 CHECK(num_nonnulls(opportunity_id,recruitment_profile_id)<=1),
 CHECK((type='appointment' AND starts_at IS NOT NULL AND ends_at>starts_at AND due_at IS NULL AND status IN ('scheduled','cancelled') AND confirmation_state IS NOT NULL)
    OR (type='task' AND starts_at IS NULL AND ends_at IS NULL AND due_at IS NOT NULL AND status IN ('open','completed') AND confirmation_state IS NULL)),
 CHECK((source='commercial_crm' AND opportunity_id IS NOT NULL AND recruitment_profile_id IS NULL)
    OR (source='recruiting_crm' AND recruitment_profile_id IS NOT NULL AND opportunity_id IS NULL)
    OR source='manual'),
 CHECK(array_position(reminder_minutes,NULL) IS NULL AND authz.valid_reminder_minutes(reminder_minutes))
);
CREATE UNIQUE INDEX agenda_series_occurrence_unique ON rpt.agenda_item(tenant_id,series_id,occurrence_index) WHERE series_id IS NOT NULL;

CREATE TABLE rpt.agenda_reminder (
 tenant_id uuid NOT NULL, id uuid NOT NULL, item_id uuid NOT NULL,
 reminder_at timestamptz NOT NULL, channel text NOT NULL DEFAULT 'internal' CHECK(channel='internal'),
 status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','cancelled','delivered','failed')),
 dedupe_key text NOT NULL CHECK(length(dedupe_key) BETWEEN 8 AND 128), retry_count integer NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 10),
 last_error text CHECK(last_error IS NULL OR length(last_error)<=500),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(), updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,dedupe_key),
 FOREIGN KEY(tenant_id,item_id) REFERENCES rpt.agenda_item
);

CREATE TABLE rpt.agenda_event (
 tenant_id uuid NOT NULL, id uuid NOT NULL, item_id uuid NOT NULL, actor_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('created','updated','rescheduled','cancelled','confirmed','declined','completed','reopened','reminders_replaced')),
 source text NOT NULL DEFAULT 'RPT_USER' CHECK(source='RPT_USER'), authority text NOT NULL DEFAULT 'manual' CHECK(authority='manual'),
 request_id uuid NOT NULL, payload jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(payload)='object' AND pg_column_size(payload)<=4096),
 occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,item_id) REFERENCES rpt.agenda_item,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account
);

CREATE FUNCTION authz.agenda_allowed(p_id uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.agenda_enabled() AND authz.allowed('agenda_item',p_id,p_verb,'CONFIDENTIAL')
 AND EXISTS(SELECT 1 FROM rpt.agenda_item i WHERE i.tenant_id=authz.tenant_id() AND i.id=p_id)
$$;

CREATE FUNCTION authz.agenda_context_allowed(p_person uuid,p_opportunity uuid,p_profile uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT (p_person IS NULL OR authz.allowed('person',p_person,'read','CONFIDENTIAL'))
 AND (p_opportunity IS NULL OR authz.crm_allowed(p_opportunity,'read'))
 AND (p_profile IS NULL OR authz.recruiting_allowed(p_profile,'read'))
$$;

CREATE FUNCTION authz.agenda_ownership_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO authz.object_access(tenant_id,object_type,object_id,workspace_id,owner_id)
 VALUES(NEW.tenant_id,'agenda_item',NEW.id,NEW.workspace_id,NEW.owner_id);
 INSERT INTO authz.ownership_history(tenant_id,object_type,object_id,workspace_id,owner_id)
 VALUES(NEW.tenant_id,'agenda_item',NEW.id,NEW.workspace_id,NEW.owner_id);
 RETURN NEW;
END $$;
CREATE TRIGGER agenda_ownership_sync AFTER INSERT ON rpt.agenda_item FOR EACH ROW EXECUTE FUNCTION authz.agenda_ownership_sync();

CREATE FUNCTION authz.agenda_item_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE linked_person uuid; linked_workspace uuid;
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.version<>1 OR NEW.owner_id<>authz.actor_id() OR NOT authz.agenda_workspace_right(NEW.workspace_id,'create')
   OR NOT authz.agenda_context_allowed(NEW.person_id,NEW.opportunity_id,NEW.recruitment_profile_id)
   THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
   IF NEW.opportunity_id IS NOT NULL THEN
     SELECT person_id,workspace_id INTO linked_person,linked_workspace FROM rpt.opportunity WHERE tenant_id=NEW.tenant_id AND id=NEW.opportunity_id;
   ELSIF NEW.recruitment_profile_id IS NOT NULL THEN
     SELECT person_id,workspace_id INTO linked_person,linked_workspace FROM rpt.recruitment_profile WHERE tenant_id=NEW.tenant_id AND id=NEW.recruitment_profile_id;
   END IF;
   IF linked_workspace IS NOT NULL AND linked_workspace<>NEW.workspace_id
   THEN RAISE EXCEPTION 'invalid_workspace_context' USING ERRCODE='23514'; END IF;
   IF linked_person IS NOT NULL AND NEW.person_id IS NOT NULL AND linked_person<>NEW.person_id
   THEN RAISE EXCEPTION 'invalid_person_context' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF (NEW.tenant_id,NEW.id,NEW.workspace_id,NEW.owner_id,NEW.type,NEW.source,NEW.person_id,NEW.opportunity_id,NEW.recruitment_profile_id,NEW.series_id,NEW.occurrence_index,NEW.recurrence_rule,NEW.created_at)
 IS DISTINCT FROM
 (OLD.tenant_id,OLD.id,OLD.workspace_id,OLD.owner_id,OLD.type,OLD.source,OLD.person_id,OLD.opportunity_id,OLD.recruitment_profile_id,OLD.series_id,OLD.occurrence_index,OLD.recurrence_rule,OLD.created_at)
 THEN RAISE EXCEPTION 'immutable_agenda_context' USING ERRCODE='42501'; END IF;
 IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'invalid_version' USING ERRCODE='23514'; END IF;
 IF OLD.status IN ('completed','cancelled') AND NEW.status<>OLD.status
 THEN RAISE EXCEPTION 'terminal_item' USING ERRCODE='23514'; END IF;
 NEW.updated_at=statement_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER agenda_item_guard BEFORE INSERT OR UPDATE ON rpt.agenda_item FOR EACH ROW EXECUTE FUNCTION authz.agenda_item_guard();

CREATE FUNCTION authz.agenda_receipt(p_key text,p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r authz.idempotency_receipt%ROWTYPE;
BEGIN
 IF NOT authz.agenda_enabled() OR length(p_key) NOT BETWEEN 8 AND 128 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||'/agenda/'||p_key,0));
 SELECT * INTO r FROM authz.idempotency_receipt WHERE tenant_id=authz.tenant_id() AND operation='agenda.v1' AND key=p_key;
 IF FOUND THEN
   IF r.actor_id<>authz.actor_id() OR r.request_hash<>p_hash THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
   RETURN r.response;
 END IF;
 INSERT INTO authz.idempotency_receipt(tenant_id,operation,key,actor_id,request_hash)
 VALUES(authz.tenant_id(),'agenda.v1',p_key,authz.actor_id(),p_hash);
 RETURN NULL;
END $$;
CREATE FUNCTION authz.agenda_finish(p_key text,p_response jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.agenda_enabled() OR pg_column_size(p_response)>4096 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 UPDATE authz.idempotency_receipt SET response=p_response
 WHERE tenant_id=authz.tenant_id() AND operation='agenda.v1' AND key=p_key
 AND actor_id=authz.actor_id() AND response IS NULL;
END $$;

ALTER TABLE rpt.agenda_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.agenda_reminder ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.agenda_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY agenda_item_read ON rpt.agenda_item FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.agenda_allowed(id,'read'));
CREATE POLICY agenda_item_create ON rpt.agenda_item FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND owner_id=authz.actor_id()
 AND authz.agenda_workspace_right(workspace_id,'create')
 AND authz.agenda_context_allowed(person_id,opportunity_id,recruitment_profile_id));
CREATE POLICY agenda_item_update ON rpt.agenda_item FOR UPDATE TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.agenda_allowed(id,'update'))
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.agenda_allowed(id,'update'));
CREATE POLICY agenda_reminder_read ON rpt.agenda_reminder FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.agenda_allowed(item_id,'read'));
CREATE POLICY agenda_reminder_create ON rpt.agenda_reminder FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.agenda_allowed(item_id,'update'));
CREATE POLICY agenda_reminder_update ON rpt.agenda_reminder FOR UPDATE TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.agenda_allowed(item_id,'update'))
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.agenda_allowed(item_id,'update'));
CREATE POLICY agenda_event_read ON rpt.agenda_event FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.agenda_allowed(item_id,'read'));
CREATE POLICY agenda_event_create ON rpt.agenda_event FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id() AND authz.agenda_allowed(item_id,'update'));

GRANT SELECT,INSERT,UPDATE ON rpt.agenda_item,rpt.agenda_reminder TO rpt_runtime;
GRANT SELECT,INSERT ON rpt.agenda_event TO rpt_runtime;
REVOKE ALL ON FUNCTION authz.agenda_enabled(),authz.agenda_workspace_right(uuid,text),authz.valid_reminder_minutes(integer[]),authz.workspace_timezone(uuid),authz.agenda_allowed(uuid,text),authz.agenda_context_allowed(uuid,uuid,uuid),authz.agenda_receipt(text,text),authz.agenda_finish(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.agenda_enabled(),authz.agenda_workspace_right(uuid,text),authz.valid_reminder_minutes(integer[]),authz.workspace_timezone(uuid),authz.agenda_allowed(uuid,text),authz.agenda_context_allowed(uuid,uuid,uuid),authz.agenda_receipt(text,text),authz.agenda_finish(text,jsonb) TO rpt_runtime;

CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON rpt.agenda_item FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON rpt.agenda_reminder FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.agenda_event FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON rpt.agenda_event FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();

CREATE INDEX agenda_range_idx ON rpt.agenda_item(tenant_id,owner_id,coalesce(starts_at,due_at),id);
CREATE INDEX agenda_context_idx ON rpt.agenda_item(tenant_id,opportunity_id,recruitment_profile_id,person_id);
CREATE INDEX agenda_reminder_due_idx ON rpt.agenda_reminder(tenant_id,status,reminder_at,id);
CREATE INDEX agenda_event_item_idx ON rpt.agenda_event(tenant_id,item_id,occurred_at,id);

CREATE OR REPLACE FUNCTION authz.record_decision(p_object uuid,p_action text,p_result text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR p_action NOT IN ('person.read','person.update','metric.append','grant.create','grant.revoke','privacy.purge','network.stats','crm.context','crm.list','crm.detail','crm.onboard','crm.create','crm.command','crm.view','crm.metrics','crm.grant','crm.import.preview','crm.import.confirm','recruiting.context','recruiting.list','recruiting.detail','recruiting.create','recruiting.command','agenda.list','agenda.detail','agenda.create','agenda.command') OR p_result NOT IN ('allow','deny','success','failure')
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO rpt.audit_event(tenant_id,actor_id,action,object_type,object_id,scope,policy_version,request_id,result,reason_code)
 VALUES(authz.tenant_id(),authz.actor_id(),p_action,'permission_decision',p_object,'request',(SELECT policy_version FROM authz.tenant WHERE id=authz.tenant_id()),nullif(current_setting('rpt.request_id',true),'')::uuid,p_result,'server_policy');
END $$;
