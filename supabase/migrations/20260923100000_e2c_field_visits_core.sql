SET LOCAL ROLE rpt_owner;

CREATE FUNCTION authz.visit_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND EXISTS(
   SELECT 1 FROM authz.tenant t JOIN rpt.feature_flag f ON f.tenant_id=t.id
   WHERE t.id=authz.tenant_id() AND NOT t.real_data_enabled
   AND f.key='field_visits_core' AND f.enabled AND f.rollout_percent=100
   AND f.policy_version=t.policy_version AND f.market_id IS NULL
   AND tstzrange(f.effective_from,f.effective_to,'[)') @> statement_timestamp()
 )
$$;

CREATE FUNCTION authz.visit_workspace_right(p_workspace uuid,p_verb text,p_field text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.visit_enabled()
 AND p_field IN ('CONFIDENTIAL','RESTRICTED_LOCATION')
 AND authz.capable(authz.actor_id(),'field_visit',p_verb,p_field)
 AND EXISTS(
   SELECT 1 FROM rpt.crm_workspace w
   JOIN authz.workspace_permission p ON (p.tenant_id,p.workspace_id)=(w.tenant_id,w.id)
   JOIN authz.tenant t ON t.id=w.tenant_id
   WHERE w.tenant_id=authz.tenant_id() AND w.id=p_workspace
   AND p.user_id=authz.actor_id() AND p.object_type='field_visit' AND p.verb=p_verb
   AND p.field_class=p_field AND p.policy_version=t.policy_version
   AND p.revoked_at IS NULL AND tstzrange(p.effective_from,p.effective_to,'[)') @> statement_timestamp()
 )
$$;

CREATE FUNCTION authz.visit_context_allowed(p_person uuid,p_opportunity uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT (p_person IS NULL OR authz.allowed('person',p_person,'read','CONFIDENTIAL'))
 AND (p_opportunity IS NULL OR authz.crm_allowed(p_opportunity,'read'))
$$;

CREATE TABLE rpt.field_visit (
 tenant_id uuid NOT NULL, id uuid NOT NULL, workspace_id uuid NOT NULL, owner_id uuid NOT NULL,
 agenda_item_id uuid, person_id uuid, opportunity_id uuid,
 status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','completed','cancelled','no_show')),
 scheduled_at timestamptz NOT NULL,
 purpose text NOT NULL CHECK(length(purpose) BETWEEN 1 AND 500 AND position('@' IN purpose)=0),
 actual_start timestamptz, actual_end timestamptz,
 outcome text CHECK(outcome IS NULL OR length(outcome) BETWEEN 1 AND 200),
 notes text CHECK(notes IS NULL OR (length(notes) BETWEEN 1 AND 1000 AND position('@' IN notes)=0)),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,owner_id) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,agenda_item_id) REFERENCES rpt.agenda_item,
 FOREIGN KEY(tenant_id,person_id) REFERENCES rpt.person,
 FOREIGN KEY(tenant_id,opportunity_id) REFERENCES rpt.opportunity,
 CHECK((status='planned' AND actual_start IS NULL AND actual_end IS NULL AND outcome IS NULL AND notes IS NULL)
    OR (status='in_progress' AND actual_start IS NOT NULL AND actual_end IS NULL AND outcome IS NULL AND notes IS NULL)
    OR (status='completed' AND actual_start IS NOT NULL AND actual_end>=actual_start AND outcome IS NOT NULL)
    OR (status IN ('cancelled','no_show') AND actual_start IS NULL AND actual_end IS NULL AND outcome IS NULL AND notes IS NULL))
);

CREATE TABLE rpt.field_visit_location (
 tenant_id uuid NOT NULL, id uuid NOT NULL, visit_id uuid NOT NULL, actor_id uuid NOT NULL,
 phase text NOT NULL CHECK(phase IN ('check_in','check_out')),
 latitude numeric(9,6) NOT NULL CHECK(latitude BETWEEN -90 AND 90),
 longitude numeric(9,6) NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 accuracy_meters numeric(8,2) CHECK(accuracy_meters BETWEEN 0 AND 100000),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 source text NOT NULL CHECK(source='device_explicit'),
 purpose text NOT NULL CHECK(purpose IN ('visit_check_in','visit_check_out')),
 consent_context text NOT NULL CHECK(consent_context='explicit_visit_action'),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,visit_id,phase),
 FOREIGN KEY(tenant_id,visit_id) REFERENCES rpt.field_visit,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account,
 CHECK((phase='check_in' AND purpose='visit_check_in')
    OR (phase='check_out' AND purpose='visit_check_out'))
);

CREATE TABLE rpt.field_visit_event (
 tenant_id uuid NOT NULL, id uuid NOT NULL, visit_id uuid NOT NULL, actor_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('created','updated','checked_in','checked_out','cancelled','no_show')),
 source text NOT NULL DEFAULT 'RPT_USER' CHECK(source='RPT_USER'),
 authority text NOT NULL DEFAULT 'manual' CHECK(authority='manual'),
 request_id uuid NOT NULL,
 payload jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(payload)='object' AND pg_column_size(payload)<=2048),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,visit_id) REFERENCES rpt.field_visit,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account
);

CREATE FUNCTION authz.visit_allowed(p_id uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.visit_enabled() AND authz.allowed('field_visit',p_id,p_verb,'CONFIDENTIAL')
 AND EXISTS(SELECT 1 FROM rpt.field_visit v WHERE v.tenant_id=authz.tenant_id() AND v.id=p_id)
$$;

CREATE FUNCTION authz.visit_location_allowed(p_id uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.visit_enabled() AND authz.allowed('field_visit',p_id,p_verb,'RESTRICTED_LOCATION')
 AND EXISTS(SELECT 1 FROM rpt.field_visit v WHERE v.tenant_id=authz.tenant_id() AND v.id=p_id)
$$;

CREATE FUNCTION authz.visit_ownership_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO authz.object_access(tenant_id,object_type,object_id,workspace_id,owner_id)
 VALUES(NEW.tenant_id,'field_visit',NEW.id,NEW.workspace_id,NEW.owner_id);
 INSERT INTO authz.ownership_history(tenant_id,object_type,object_id,workspace_id,owner_id)
 VALUES(NEW.tenant_id,'field_visit',NEW.id,NEW.workspace_id,NEW.owner_id);
 RETURN NEW;
END $$;
CREATE TRIGGER visit_ownership_sync AFTER INSERT ON rpt.field_visit
FOR EACH ROW EXECUTE FUNCTION authz.visit_ownership_sync();

CREATE FUNCTION authz.field_visit_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE agenda_row rpt.agenda_item%ROWTYPE;
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.version<>1 OR NEW.owner_id<>authz.actor_id()
   OR NOT authz.visit_workspace_right(NEW.workspace_id,'create','CONFIDENTIAL')
   OR NOT authz.visit_context_allowed(NEW.person_id,NEW.opportunity_id)
   THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
   IF NEW.agenda_item_id IS NOT NULL THEN
     SELECT * INTO agenda_row FROM rpt.agenda_item WHERE tenant_id=NEW.tenant_id AND id=NEW.agenda_item_id;
     IF NOT FOUND OR NOT authz.agenda_allowed(NEW.agenda_item_id,'read')
     OR agenda_row.type<>'appointment' OR agenda_row.status<>'scheduled'
     OR agenda_row.workspace_id<>NEW.workspace_id
     OR (NEW.person_id IS NOT NULL AND agenda_row.person_id IS NOT NULL AND NEW.person_id<>agenda_row.person_id)
     OR (NEW.opportunity_id IS NOT NULL AND agenda_row.opportunity_id IS NOT NULL AND NEW.opportunity_id<>agenda_row.opportunity_id)
     THEN RAISE EXCEPTION 'invalid_agenda_context' USING ERRCODE='23514'; END IF;
   END IF;
   RETURN NEW;
 END IF;
 IF (NEW.tenant_id,NEW.id,NEW.workspace_id,NEW.owner_id,NEW.agenda_item_id,NEW.person_id,
     NEW.opportunity_id,NEW.created_at)
 IS DISTINCT FROM
    (OLD.tenant_id,OLD.id,OLD.workspace_id,OLD.owner_id,OLD.agenda_item_id,OLD.person_id,
     OLD.opportunity_id,OLD.created_at)
 THEN RAISE EXCEPTION 'immutable_visit_context' USING ERRCODE='42501'; END IF;
 IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'invalid_version' USING ERRCODE='23514'; END IF;
 IF OLD.agenda_item_id IS NOT NULL AND NEW.scheduled_at<>OLD.scheduled_at
 THEN RAISE EXCEPTION 'agenda_schedule_is_canonical' USING ERRCODE='23514'; END IF;
 IF OLD.status='planned' AND NEW.status='in_progress' THEN
   NEW.actual_start=clock_timestamp(); NEW.actual_end=NULL; NEW.outcome=NULL;
 ELSIF OLD.status='in_progress' AND NEW.status='completed' THEN
   NEW.actual_end=clock_timestamp();
   IF NEW.outcome IS NULL OR NEW.actual_end<OLD.actual_start
   THEN RAISE EXCEPTION 'invalid_checkout' USING ERRCODE='23514'; END IF;
 ELSIF OLD.status='planned' AND NEW.status IN ('planned','cancelled','no_show') THEN
   NULL;
 ELSE
   RAISE EXCEPTION 'invalid_visit_transition' USING ERRCODE='23514';
 END IF;
 NEW.updated_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER field_visit_guard BEFORE INSERT OR UPDATE ON rpt.field_visit
FOR EACH ROW EXECUTE FUNCTION authz.field_visit_guard();

CREATE FUNCTION authz.visit_receipt(p_key text,p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r authz.idempotency_receipt%ROWTYPE;
BEGIN
 IF NOT authz.visit_enabled() OR length(p_key) NOT BETWEEN 8 AND 128
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||'/visit/'||p_key,0));
 SELECT * INTO r FROM authz.idempotency_receipt
 WHERE tenant_id=authz.tenant_id() AND operation='visit.v1' AND key=p_key;
 IF FOUND THEN
   IF r.actor_id<>authz.actor_id() OR r.request_hash<>p_hash
   THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
   RETURN r.response;
 END IF;
 INSERT INTO authz.idempotency_receipt(tenant_id,operation,key,actor_id,request_hash)
 VALUES(authz.tenant_id(),'visit.v1',p_key,authz.actor_id(),p_hash);
 RETURN NULL;
END $$;

CREATE FUNCTION authz.visit_finish(p_key text,p_response jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.visit_enabled() OR pg_column_size(p_response)>2048
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 UPDATE authz.idempotency_receipt SET response=p_response
 WHERE tenant_id=authz.tenant_id() AND operation='visit.v1' AND key=p_key
 AND actor_id=authz.actor_id() AND response IS NULL;
END $$;

ALTER TABLE rpt.field_visit ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.field_visit_location ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.field_visit_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY field_visit_read ON rpt.field_visit FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.visit_allowed(id,'read'));
CREATE POLICY field_visit_create ON rpt.field_visit FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND owner_id=authz.actor_id()
 AND authz.visit_workspace_right(workspace_id,'create','CONFIDENTIAL')
 AND authz.visit_context_allowed(person_id,opportunity_id));
CREATE POLICY field_visit_update ON rpt.field_visit FOR UPDATE TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.visit_allowed(id,'update'))
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.visit_allowed(id,'update'));
CREATE POLICY field_visit_location_read ON rpt.field_visit_location FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.visit_location_allowed(visit_id,'read'));
CREATE POLICY field_visit_location_create ON rpt.field_visit_location FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id()
 AND authz.visit_location_allowed(visit_id,'update'));
CREATE POLICY field_visit_event_read ON rpt.field_visit_event FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.visit_allowed(visit_id,'read'));
CREATE POLICY field_visit_event_create ON rpt.field_visit_event FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id()
 AND authz.visit_allowed(visit_id,'update'));

GRANT SELECT,INSERT,UPDATE ON rpt.field_visit TO rpt_runtime;
GRANT SELECT,INSERT ON rpt.field_visit_location,rpt.field_visit_event TO rpt_runtime;
REVOKE ALL ON FUNCTION authz.visit_enabled(),authz.visit_workspace_right(uuid,text,text),
 authz.visit_context_allowed(uuid,uuid),authz.visit_allowed(uuid,text),
 authz.visit_location_allowed(uuid,text),authz.visit_receipt(text,text),authz.visit_finish(text,jsonb)
 FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.visit_enabled(),authz.visit_workspace_right(uuid,text,text),
 authz.visit_context_allowed(uuid,uuid),authz.visit_allowed(uuid,text),
 authz.visit_location_allowed(uuid,text),authz.visit_receipt(text,text),authz.visit_finish(text,jsonb)
 TO rpt_runtime;

CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON rpt.field_visit
FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.field_visit_location
FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.field_visit_event
FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON rpt.field_visit_location
FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON rpt.field_visit_event
FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();

CREATE INDEX field_visit_range_idx ON rpt.field_visit(tenant_id,owner_id,scheduled_at,id);
CREATE INDEX field_visit_status_range_idx ON rpt.field_visit(tenant_id,status,scheduled_at,id);
CREATE INDEX field_visit_context_idx ON rpt.field_visit(tenant_id,agenda_item_id,opportunity_id,person_id);
CREATE INDEX field_visit_event_idx ON rpt.field_visit_event(tenant_id,visit_id,occurred_at,id);

CREATE OR REPLACE FUNCTION authz.record_decision(p_object uuid,p_action text,p_result text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR p_action NOT IN ('person.read','person.update','metric.append','grant.create','grant.revoke','privacy.purge','network.stats','crm.context','crm.list','crm.detail','crm.onboard','crm.create','crm.command','crm.view','crm.metrics','crm.grant','crm.import.preview','crm.import.confirm','recruiting.context','recruiting.list','recruiting.detail','recruiting.create','recruiting.command','agenda.list','agenda.detail','agenda.create','agenda.command','visit.list','visit.detail','visit.create','visit.command') OR p_result NOT IN ('allow','deny','success','failure')
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO rpt.audit_event(tenant_id,actor_id,action,object_type,object_id,scope,policy_version,request_id,result,reason_code)
 VALUES(authz.tenant_id(),authz.actor_id(),p_action,'permission_decision',p_object,'request',(SELECT policy_version FROM authz.tenant WHERE id=authz.tenant_id()),nullif(current_setting('rpt.request_id',true),'')::uuid,p_result,'server_policy');
END $$;
