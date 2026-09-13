SET LOCAL ROLE rpt_owner;

-- Local vertical slice: the release flag AND synthetic tenant boundary are mandatory.
CREATE FUNCTION authz.crm_enabled() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND EXISTS(SELECT 1 FROM authz.tenant t JOIN rpt.feature_flag f ON f.tenant_id=t.id
 WHERE t.id=authz.tenant_id() AND NOT t.real_data_enabled AND f.key='crm_vertical_slice' AND f.enabled
 AND f.policy_version=t.policy_version AND f.rollout_percent=100 AND f.market_id IS NULL
 AND tstzrange(f.effective_from,f.effective_to,'[)') @> statement_timestamp())
$$;
CREATE FUNCTION authz.crm_workspace_right(p_workspace uuid,p_verb text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.crm_enabled() AND authz.capable(authz.actor_id(),'opportunity',p_verb,'CONFIDENTIAL') AND EXISTS(
 SELECT 1 FROM authz.workspace_permission w JOIN authz.tenant t ON t.id=w.tenant_id
 WHERE w.tenant_id=authz.tenant_id() AND w.workspace_id=p_workspace AND w.user_id=authz.actor_id()
 AND w.object_type='opportunity' AND w.verb=p_verb AND w.field_class='CONFIDENTIAL' AND w.policy_version=t.policy_version
 AND w.revoked_at IS NULL AND tstzrange(w.effective_from,w.effective_to,'[)') @> statement_timestamp())
$$;
CREATE TABLE rpt.advisor_profile (
 tenant_id uuid NOT NULL, id uuid NOT NULL, user_id uuid NOT NULL, person_id uuid NOT NULL,
 workspace_id uuid NOT NULL, registration_id uuid NOT NULL, market_id uuid NOT NULL,
 advisor_code text NOT NULL CHECK(advisor_code LIKE 'SIM-%'), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,user_id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,person_id) REFERENCES rpt.person,
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,registration_id,market_id) REFERENCES rpt.market_registration(tenant_id,id,market_id)
);
CREATE TABLE rpt.opportunity (
 tenant_id uuid NOT NULL, id uuid NOT NULL, person_id uuid NOT NULL, workspace_id uuid NOT NULL, owner_id uuid NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 stage text NOT NULL DEFAULT 'new' CHECK(stage IN ('new','contacted','appointment','demo','proposal','pending_approval','won_simulated','won','lost')),
 source text NOT NULL CHECK(source IN ('referral','event','manual','import')),
 priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','high')),
 next_action text NOT NULL DEFAULT 'contact', next_at timestamptz,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,person_id) REFERENCES rpt.person,
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace, FOREIGN KEY(tenant_id,owner_id) REFERENCES authz.user_account
);
CREATE TABLE rpt.appointment (
 tenant_id uuid NOT NULL, id uuid NOT NULL, opportunity_id uuid NOT NULL, starts_at timestamptz NOT NULL,
 timezone text NOT NULL, channel text NOT NULL CHECK(channel IN ('visit','phone','video')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,opportunity_id) REFERENCES rpt.opportunity
);
CREATE TABLE rpt.demo_visit (
 tenant_id uuid NOT NULL, id uuid NOT NULL, opportunity_id uuid NOT NULL, appointment_id uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('customer_agreed','purchase_intent_confirmed','quote_requested','order_started','followup_required','no_sale','referral_generated','recruitment_interest','other')),
 occurred_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,opportunity_id) REFERENCES rpt.opportunity, FOREIGN KEY(tenant_id,appointment_id) REFERENCES rpt.appointment,
 UNIQUE(tenant_id,appointment_id)
);
CREATE TABLE rpt.quote_version (
 tenant_id uuid NOT NULL, id uuid NOT NULL, opportunity_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 product text NOT NULL CHECK(length(product) BETWEEN 1 AND 200), amount numeric(12,2) NOT NULL CHECK(amount>0),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), pricing_authority text NOT NULL DEFAULT 'simulation' CHECK(pricing_authority='simulation'),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,opportunity_id) REFERENCES rpt.opportunity, UNIQUE(tenant_id,opportunity_id,revision)
);
CREATE TABLE rpt.commercial_order (
 tenant_id uuid NOT NULL, id uuid NOT NULL, opportunity_id uuid NOT NULL, quote_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted')),
 simulated_status text CHECK(simulated_status IN ('company_processing','approved','conflict','rejected_or_cancelled','delivered','curation_pending','cured')),
 observation_id uuid, is_simulation boolean NOT NULL DEFAULT true CHECK(is_simulation),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,opportunity_id),
 FOREIGN KEY(tenant_id,opportunity_id) REFERENCES rpt.opportunity, FOREIGN KEY(tenant_id,quote_id) REFERENCES rpt.quote_version,
 FOREIGN KEY(tenant_id,observation_id) REFERENCES rpt.source_observation
);
CREATE TABLE rpt.crm_entry (
 tenant_id uuid NOT NULL, id uuid NOT NULL, opportunity_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('note','task','objection','commitment')),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 1000), due_at timestamptz, completed_at timestamptz,
 actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,opportunity_id) REFERENCES rpt.opportunity, FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account,
 CHECK(kind='task' OR (due_at IS NULL AND completed_at IS NULL))
);
CREATE TABLE rpt.crm_event (
 tenant_id uuid NOT NULL, id uuid NOT NULL, opportunity_id uuid NOT NULL, actor_id uuid NOT NULL,
 action text NOT NULL, source text NOT NULL CHECK(source IN ('RPT_USER','MANUAL_RECONCILIATION')),
 authority text NOT NULL DEFAULT 'manual' CHECK(authority='manual'), request_id uuid NOT NULL,
 observation_id uuid, metric_event_id uuid, occurred_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,opportunity_id) REFERENCES rpt.opportunity,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,observation_id) REFERENCES rpt.source_observation, FOREIGN KEY(tenant_id,metric_event_id) REFERENCES rpt.metric_event_ledger
);
CREATE TABLE rpt.saved_view (
 tenant_id uuid NOT NULL, id uuid NOT NULL, owner_id uuid NOT NULL, workspace_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 60), visibility text NOT NULL CHECK(visibility IN ('private','team','shared')),
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object' AND pg_column_size(config)<=4096),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES authz.user_account, FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace
);
CREATE TABLE rpt.saved_view_recipient (
 tenant_id uuid NOT NULL, id uuid NOT NULL, view_id uuid NOT NULL, user_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,view_id,user_id),
 FOREIGN KEY(tenant_id,view_id) REFERENCES rpt.saved_view, FOREIGN KEY(tenant_id,user_id) REFERENCES authz.user_account
);

CREATE FUNCTION authz.crm_allowed(p_id uuid,p_verb text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.crm_enabled() AND authz.allowed('opportunity',p_id,p_verb,'CONFIDENTIAL') AND EXISTS(
 SELECT 1 FROM rpt.opportunity o JOIN rpt.person p ON (p.tenant_id,p.id)=(o.tenant_id,o.person_id)
 WHERE o.tenant_id=authz.tenant_id() AND o.id=p_id AND p.deleted_at IS NULL AND authz.allowed('person',p.id,'read','CONFIDENTIAL'))
$$;
CREATE FUNCTION authz.crm_child(p_id uuid,p_type text,p_verb text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.crm_allowed(p_id,CASE WHEN p_verb='read' THEN 'read' ELSE 'update' END)
 AND authz.capable(authz.actor_id(),p_type,p_verb,'CONFIDENTIAL')
$$;
CREATE FUNCTION authz.crm_ownership_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO authz.object_access(tenant_id,object_type,object_id,workspace_id,owner_id) VALUES(NEW.tenant_id,'opportunity',NEW.id,NEW.workspace_id,NEW.owner_id);
 INSERT INTO authz.ownership_history(tenant_id,object_type,object_id,workspace_id,owner_id) VALUES(NEW.tenant_id,'opportunity',NEW.id,NEW.workspace_id,NEW.owner_id);
 RETURN NEW;
END $$;
CREATE TRIGGER crm_ownership_sync AFTER INSERT ON rpt.opportunity FOR EACH ROW EXECUTE FUNCTION authz.crm_ownership_sync();

CREATE FUNCTION authz.crm_opportunity_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.stage<>'new' OR NEW.version<>1 THEN RAISE EXCEPTION 'invalid_initial_stage' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF (NEW.tenant_id,NEW.id,NEW.person_id,NEW.workspace_id,NEW.owner_id,NEW.source,NEW.created_at) IS DISTINCT FROM
 (OLD.tenant_id,OLD.id,OLD.person_id,OLD.workspace_id,OLD.owner_id,OLD.source,OLD.created_at) THEN RAISE EXCEPTION 'immutable_context' USING ERRCODE='42501'; END IF;
 IF NEW.stage<>OLD.stage THEN
   IF OLD.stage IN ('won','won_simulated','lost') THEN RAISE EXCEPTION 'terminal_stage' USING ERRCODE='23514'; END IF;
   IF NOT ((OLD.stage='new' AND NEW.stage='contacted') OR
    (OLD.stage IN ('new','contacted') AND NEW.stage='appointment' AND EXISTS(SELECT 1 FROM rpt.appointment WHERE tenant_id=NEW.tenant_id AND opportunity_id=NEW.id)) OR
    (OLD.stage='appointment' AND NEW.stage='demo' AND EXISTS(SELECT 1 FROM rpt.demo_visit WHERE tenant_id=NEW.tenant_id AND opportunity_id=NEW.id)) OR
    (OLD.stage='demo' AND NEW.stage='proposal' AND EXISTS(SELECT 1 FROM rpt.quote_version WHERE tenant_id=NEW.tenant_id AND opportunity_id=NEW.id)) OR
    (OLD.stage='proposal' AND NEW.stage='pending_approval' AND EXISTS(SELECT 1 FROM rpt.commercial_order WHERE tenant_id=NEW.tenant_id AND opportunity_id=NEW.id AND status='submitted')) OR
    (OLD.stage='pending_approval' AND NEW.stage='won_simulated' AND authz.crm_enabled() AND EXISTS(SELECT 1 FROM rpt.commercial_order WHERE tenant_id=NEW.tenant_id AND opportunity_id=NEW.id AND simulated_status='approved' AND observation_id IS NOT NULL)) OR
    (NEW.stage='lost')) THEN RAISE EXCEPTION 'invalid_stage_transition' USING ERRCODE='23514'; END IF;
 END IF;
 -- Actual Won is intentionally unreachable until an official adapter is authorized.
 IF NEW.stage='won' THEN RAISE EXCEPTION 'official_approval_required' USING ERRCODE='42501'; END IF;
 NEW.version=OLD.version+1; NEW.updated_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER crm_opportunity_guard BEFORE INSERT OR UPDATE ON rpt.opportunity FOR EACH ROW EXECUTE FUNCTION authz.crm_opportunity_guard();

CREATE FUNCTION authz.crm_order_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q rpt.quote_version%ROWTYPE; previous text;
BEGIN
 SELECT * INTO q FROM rpt.quote_version WHERE tenant_id=NEW.tenant_id AND id=NEW.quote_id;
 IF q.opportunity_id IS DISTINCT FROM NEW.opportunity_id THEN RAISE EXCEPTION 'invalid_quote_context' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.status<>'draft' OR NEW.simulated_status IS NOT NULL OR NEW.observation_id IS NOT NULL THEN RAISE EXCEPTION 'invalid_initial_order' USING ERRCODE='23514'; END IF;
 ELSE
   IF (NEW.tenant_id,NEW.id,NEW.opportunity_id,NEW.quote_id,NEW.is_simulation) IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.opportunity_id,OLD.quote_id,OLD.is_simulation) THEN RAISE EXCEPTION 'immutable_order_context' USING ERRCODE='42501'; END IF;
   IF NEW.status<>OLD.status AND NOT(OLD.status='draft' AND NEW.status='submitted' AND NEW.simulated_status='company_processing') THEN RAISE EXCEPTION 'invalid_order_transition' USING ERRCODE='23514'; END IF;
   IF NEW.simulated_status IS DISTINCT FROM OLD.simulated_status THEN
     previous=coalesce(OLD.simulated_status,'draft');
     IF NOT ((previous='draft' AND NEW.simulated_status='company_processing') OR
      (previous IN ('company_processing','conflict') AND NEW.simulated_status IN ('approved','conflict','rejected_or_cancelled')) OR
      (previous='approved' AND NEW.simulated_status='delivered') OR
      (previous='delivered' AND NEW.simulated_status='curation_pending') OR
      (previous='curation_pending' AND NEW.simulated_status='cured')) THEN RAISE EXCEPTION 'invalid_simulation_transition' USING ERRCODE='23514'; END IF;
     IF NEW.simulated_status IN ('approved','conflict','rejected_or_cancelled') THEN
       IF NOT authz.crm_child(NEW.opportunity_id,'reconciliation','approve') OR NOT EXISTS(
        SELECT 1 FROM rpt.source_observation s WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.observation_id AND s.subject_id=NEW.opportunity_id
        AND s.source_system='MANUAL_RECONCILIATION' AND s.domain_key='order_simulation' AND s.authority_level='manual' AND s.verified_at IS NULL
        AND s.facts->>'orderId'=NEW.id::text AND s.facts->>'result'=NEW.simulated_status AND s.facts->>'simulation'='true'
        AND s.actor_id=authz.actor_id()) THEN RAISE EXCEPTION 'mock_evidence_required' USING ERRCODE='42501'; END IF;
     ELSE
       IF NEW.observation_id IS DISTINCT FROM OLD.observation_id THEN RAISE EXCEPTION 'immutable_evidence' USING ERRCODE='42501'; END IF;
     END IF;
   ELSIF NEW.observation_id IS DISTINCT FROM OLD.observation_id THEN RAISE EXCEPTION 'immutable_evidence' USING ERRCODE='42501'; END IF;
 END IF;
 NEW.updated_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER crm_order_guard BEFORE INSERT OR UPDATE ON rpt.commercial_order FOR EACH ROW EXECUTE FUNCTION authz.crm_order_guard();
CREATE FUNCTION authz.crm_demo_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM rpt.appointment a WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.appointment_id AND a.opportunity_id=NEW.opportunity_id) THEN RAISE EXCEPTION 'invalid_appointment_context' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_demo_guard BEFORE INSERT ON rpt.demo_visit FOR EACH ROW EXECUTE FUNCTION authz.crm_demo_guard();

CREATE FUNCTION authz.crm_saved_view_read(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.crm_enabled() AND EXISTS(SELECT 1 FROM rpt.saved_view v WHERE v.tenant_id=authz.tenant_id() AND v.id=p_id AND
 (v.owner_id=authz.actor_id() OR (v.visibility<>'private' AND authz.crm_workspace_right(v.workspace_id,'read') AND
 EXISTS(SELECT 1 FROM authz.workspace_permission w JOIN authz.tenant t ON t.id=w.tenant_id WHERE w.tenant_id=v.tenant_id AND w.user_id=v.owner_id
 AND w.workspace_id=v.workspace_id AND w.object_type='opportunity' AND w.verb='share' AND w.field_class='CONFIDENTIAL'
 AND w.revoked_at IS NULL AND w.policy_version=t.policy_version AND tstzrange(w.effective_from,w.effective_to,'[)') @> statement_timestamp()
 AND authz.capable(v.owner_id,'opportunity','share','CONFIDENTIAL'))
 AND (v.visibility='team' OR EXISTS(SELECT 1 FROM rpt.saved_view_recipient r WHERE r.tenant_id=v.tenant_id AND r.view_id=v.id AND r.user_id=authz.actor_id())))))
$$;

DO $$ DECLARE tbl text; typ text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['advisor_profile','opportunity','appointment','demo_visit','quote_version','commercial_order','crm_entry','crm_event','saved_view','saved_view_recipient'] LOOP
 EXECUTE format('ALTER TABLE rpt.%I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON rpt.%I FOR EACH ROW EXECUTE FUNCTION authz.audit_change()',tbl);
 END LOOP;
 FOR tbl,typ IN SELECT * FROM(VALUES('appointment','appointment'),('demo_visit','demo'),('quote_version','quote'),('commercial_order','order'),('crm_entry','entry'),('crm_event','activity')) t(tbl,typ) LOOP
 EXECUTE format('CREATE POLICY crm_read ON rpt.%I FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND authz.crm_child(opportunity_id,%L,''read''))',tbl,typ);
 EXECUTE format('CREATE POLICY crm_insert ON rpt.%I FOR INSERT TO rpt_runtime WITH CHECK(tenant_id=authz.tenant_id() AND authz.crm_child(opportunity_id,%L,''create''))',tbl,typ);
 END LOOP;
 FOREACH tbl IN ARRAY ARRAY['appointment','demo_visit','quote_version','crm_event'] LOOP
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON rpt.%I FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable()',tbl);
 END LOOP;
END $$;
CREATE POLICY advisor_read ON rpt.advisor_profile FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND user_id=authz.actor_id() AND authz.crm_enabled());
CREATE POLICY opportunity_read ON rpt.opportunity FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND authz.crm_allowed(id,'read'));
CREATE POLICY opportunity_create ON rpt.opportunity FOR INSERT TO rpt_runtime WITH CHECK(tenant_id=authz.tenant_id() AND owner_id=authz.actor_id() AND authz.crm_workspace_right(workspace_id,'create') AND authz.allowed('person',person_id,'read','CONFIDENTIAL'));
CREATE POLICY opportunity_update ON rpt.opportunity FOR UPDATE TO rpt_runtime USING(tenant_id=authz.tenant_id() AND authz.crm_allowed(id,'update')) WITH CHECK(tenant_id=authz.tenant_id() AND authz.crm_allowed(id,'update'));
CREATE POLICY order_update ON rpt.commercial_order FOR UPDATE TO rpt_runtime USING(tenant_id=authz.tenant_id() AND authz.crm_child(opportunity_id,'order','update')) WITH CHECK(tenant_id=authz.tenant_id() AND authz.crm_child(opportunity_id,'order','update'));
CREATE POLICY entry_update ON rpt.crm_entry FOR UPDATE TO rpt_runtime USING(tenant_id=authz.tenant_id() AND authz.crm_child(opportunity_id,'entry','update')) WITH CHECK(tenant_id=authz.tenant_id() AND authz.crm_child(opportunity_id,'entry','update'));
CREATE POLICY saved_read ON rpt.saved_view FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND authz.crm_saved_view_read(id));
CREATE POLICY saved_create ON rpt.saved_view FOR INSERT TO rpt_runtime WITH CHECK(tenant_id=authz.tenant_id() AND owner_id=authz.actor_id() AND authz.crm_enabled() AND authz.capable(authz.actor_id(),'opportunity','read','CONFIDENTIAL') AND (visibility='private' OR (authz.crm_workspace_right(workspace_id,'share') AND authz.crm_workspace_right(workspace_id,'read'))));
CREATE POLICY recipient_read ON rpt.saved_view_recipient FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND user_id=authz.actor_id() AND authz.crm_saved_view_read(view_id));
CREATE POLICY mock_source_create ON rpt.source_observation FOR INSERT TO rpt_runtime WITH CHECK(tenant_id=authz.tenant_id() AND authz.crm_child(subject_id,'reconciliation','approve') AND source_system='MANUAL_RECONCILIATION' AND domain_key='order_simulation' AND authority_level='manual' AND verified_at IS NULL AND actor_id=authz.actor_id() AND facts->>'simulation'='true');
CREATE POLICY mock_case_create ON rpt.reconciliation_case FOR INSERT TO rpt_runtime WITH CHECK(tenant_id=authz.tenant_id() AND authz.crm_enabled() AND actor_id=authz.actor_id() AND EXISTS(SELECT 1 FROM rpt.source_observation s WHERE s.tenant_id=authz.tenant_id() AND s.id=observation_id AND s.domain_key='order_simulation' AND authz.crm_child(s.subject_id,'reconciliation','approve')));
CREATE POLICY mock_source_read ON rpt.source_observation FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND domain_key='order_simulation' AND authz.crm_child(subject_id,'reconciliation','read'));
GRANT SELECT ON rpt.advisor_profile,rpt.opportunity,rpt.appointment,rpt.demo_visit,rpt.quote_version,rpt.commercial_order,rpt.crm_entry,rpt.crm_event,rpt.saved_view,rpt.saved_view_recipient TO rpt_runtime;
GRANT INSERT ON rpt.opportunity,rpt.appointment,rpt.demo_visit,rpt.quote_version,rpt.commercial_order,rpt.crm_entry,rpt.crm_event,rpt.saved_view TO rpt_runtime;
GRANT UPDATE ON rpt.opportunity,rpt.commercial_order,rpt.crm_entry TO rpt_runtime;

-- These private commands exist only for private identity/receipt/grant projections.
CREATE FUNCTION authz.crm_onboard(p_workspace uuid,p_name text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing uuid; person uuid; profile uuid=gen_random_uuid(); reg rpt.market_registration%ROWTYPE;
BEGIN
 IF NOT authz.crm_workspace_right(p_workspace,'create') OR NOT authz.workspace_create(authz.tenant_id(),p_workspace) OR length(p_name) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||authz.actor_id()::text,23));
 SELECT id INTO existing FROM rpt.advisor_profile WHERE tenant_id=authz.tenant_id() AND user_id=authz.actor_id();
 IF existing IS NOT NULL THEN RETURN existing; END IF;
 SELECT r.* INTO reg FROM rpt.market_registration r JOIN rpt.crm_workspace w ON (w.tenant_id,w.registration_id)=(r.tenant_id,r.id)
 WHERE w.tenant_id=authz.tenant_id() AND w.id=p_workspace AND w.kind='commercial' AND tstzrange(r.effective_from,r.effective_to,'[)') @> statement_timestamp();
 IF reg.id IS NULL THEN RAISE EXCEPTION 'invalid_workspace' USING ERRCODE='23514'; END IF;
 SELECT person_id INTO person FROM authz.user_account WHERE tenant_id=authz.tenant_id() AND id=authz.actor_id();
 IF person IS NULL THEN
 person=gen_random_uuid();
 INSERT INTO rpt.person(tenant_id,id,workspace_id,owner_id,display_name,lifecycle) VALUES(authz.tenant_id(),person,p_workspace,authz.actor_id(),p_name,'advisor');
 UPDATE authz.user_account SET person_id=person WHERE tenant_id=authz.tenant_id() AND id=authz.actor_id();
 END IF;
 IF NOT authz.allowed('person',person,'update','CONFIDENTIAL') THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM rpt.commercial_membership m WHERE m.tenant_id=authz.tenant_id() AND m.person_id=person AND m.status='active' AND tstzrange(m.effective_from,m.effective_to,'[)') @> statement_timestamp()) THEN
 INSERT INTO rpt.commercial_membership(tenant_id,id,person_id,group_id,effective_from,status,source,reason) VALUES(authz.tenant_id(),gen_random_uuid(),person,reg.group_id,statement_timestamp(),'active','SIMULATION','local fixture onboarding');
 END IF;
 INSERT INTO rpt.advisor_profile(tenant_id,id,user_id,person_id,workspace_id,registration_id,market_id,advisor_code) VALUES(authz.tenant_id(),profile,authz.actor_id(),person,p_workspace,reg.id,reg.market_id,'SIM-'||left(profile::text,8));
 RETURN profile;
END $$;
CREATE FUNCTION authz.crm_context() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('actorId',u.id,'tenantLabel',t.slug,'timezone',t.timezone,'simulation',true,
 'role',CASE WHEN authz.capable(u.id,'opportunity','create','CONFIDENTIAL') THEN 'advisor' WHEN authz.capable(u.id,'opportunity','read','CONFIDENTIAL') THEN 'assistant' WHEN authz.capable(u.id,'network','statistics','INTERNAL') THEN 'network' ELSE 'restricted' END,
 'canList',authz.capable(u.id,'opportunity','read','CONFIDENTIAL'), 'canCreate',coalesce(authz.crm_workspace_right(w.id,'create'),false),
 'canShareView',coalesce(authz.crm_workspace_right(w.id,'share') AND authz.crm_workspace_right(w.id,'read'),false),
 'canReconcile',authz.capable(u.id,'reconciliation','approve','CONFIDENTIAL'),
 'workspaceId',w.id,'advisorId',a.id,'advisorCode',a.advisor_code)
 FROM authz.user_account u JOIN authz.tenant t ON t.id=u.tenant_id
 LEFT JOIN rpt.advisor_profile a ON (a.tenant_id,a.user_id)=(u.tenant_id,u.id)
 LEFT JOIN LATERAL(SELECT cw.id FROM rpt.crm_workspace cw WHERE cw.tenant_id=u.tenant_id AND cw.kind='commercial'
 AND (authz.crm_workspace_right(cw.id,'create') OR EXISTS(SELECT 1 FROM rpt.opportunity o WHERE o.tenant_id=cw.tenant_id AND o.workspace_id=cw.id AND authz.crm_allowed(o.id,'read'))) ORDER BY cw.id LIMIT 1) w ON true
 WHERE u.tenant_id=authz.tenant_id() AND u.id=authz.actor_id() AND authz.crm_enabled()
$$;
CREATE FUNCTION authz.crm_receipt(p_key text,p_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r authz.idempotency_receipt%ROWTYPE;
BEGIN
 IF NOT authz.crm_enabled() OR length(p_key) NOT BETWEEN 8 AND 128 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||'/crm/'||p_key,0));
 SELECT * INTO r FROM authz.idempotency_receipt WHERE tenant_id=authz.tenant_id() AND operation='crm.v1' AND key=p_key;
 IF FOUND THEN
 IF r.actor_id<>authz.actor_id() OR r.request_hash<>p_hash THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
 RETURN r.response;
 END IF;
 INSERT INTO authz.idempotency_receipt(tenant_id,operation,key,actor_id,request_hash) VALUES(authz.tenant_id(),'crm.v1',p_key,authz.actor_id(),p_hash);
 RETURN NULL;
END $$;
CREATE FUNCTION authz.crm_finish(p_key text,p_response jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.crm_enabled() OR pg_column_size(p_response)>512 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 UPDATE authz.idempotency_receipt SET response=p_response WHERE tenant_id=authz.tenant_id() AND operation='crm.v1' AND key=p_key AND actor_id=authz.actor_id() AND response IS NULL;
END $$;
CREATE FUNCTION authz.crm_grant(p_object uuid,p_grantee uuid,p_verb text,p_until timestamptz,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE grant_id uuid=gen_random_uuid();
BEGIN
 IF NOT authz.crm_allowed(p_object,'share') OR NOT authz.direct_access(authz.actor_id(),'opportunity',p_object,p_verb,'CONFIDENTIAL')
 OR NOT authz.direct_access(authz.actor_id(),'opportunity',p_object,'share','CONFIDENTIAL') OR NOT authz.capable(p_grantee,'opportunity',p_verb,'CONFIDENTIAL')
 OR p_verb NOT IN ('read','update') OR p_until<=statement_timestamp() OR p_until>statement_timestamp()+interval '30 days' THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO authz.access_grant(tenant_id,id,object_type,object_id,grantor_id,grantee_id,verb,field_class,effective_from,effective_to,policy_version,reason)
 SELECT authz.tenant_id(),grant_id,'opportunity',p_object,authz.actor_id(),p_grantee,p_verb,'CONFIDENTIAL',statement_timestamp(),p_until,policy_version,p_reason FROM authz.tenant WHERE id=authz.tenant_id();
 RETURN grant_id;
END $$;
CREATE FUNCTION authz.crm_add_view_recipient(p_view uuid,p_user uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v rpt.saved_view%ROWTYPE;
BEGIN
 SELECT * INTO v FROM rpt.saved_view WHERE tenant_id=authz.tenant_id() AND id=p_view AND owner_id=authz.actor_id() AND visibility='shared';
 IF v.id IS NULL OR NOT authz.crm_workspace_right(v.workspace_id,'share') OR NOT EXISTS(SELECT 1 FROM authz.workspace_permission w JOIN authz.tenant t ON t.id=w.tenant_id WHERE w.tenant_id=v.tenant_id AND w.workspace_id=v.workspace_id AND w.user_id=p_user
 AND w.object_type='opportunity' AND w.verb='read' AND w.field_class='CONFIDENTIAL' AND w.revoked_at IS NULL AND w.policy_version=t.policy_version AND tstzrange(w.effective_from,w.effective_to,'[)') @> statement_timestamp() AND authz.capable(p_user,'opportunity','read','CONFIDENTIAL')) THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO rpt.saved_view_recipient VALUES(authz.tenant_id(),gen_random_uuid(),p_view,p_user);
END $$;
CREATE OR REPLACE FUNCTION authz.record_decision(p_object uuid,p_action text,p_result text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR p_action NOT IN ('person.read','person.update','metric.append','grant.create','grant.revoke','privacy.purge','network.stats','crm.context','crm.list','crm.detail','crm.onboard','crm.create','crm.command','crm.view','crm.metrics','crm.grant') OR p_result NOT IN ('allow','deny','success','failure') THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO rpt.audit_event(tenant_id,actor_id,action,object_type,object_id,scope,policy_version,request_id,result,reason_code)
 VALUES(authz.tenant_id(),authz.actor_id(),p_action,'permission_decision',p_object,'request',(SELECT policy_version FROM authz.tenant WHERE id=authz.tenant_id()),nullif(current_setting('rpt.request_id',true),'')::uuid,p_result,'server_policy');
END $$;
GRANT EXECUTE ON FUNCTION authz.crm_enabled(),authz.crm_workspace_right(uuid,text),authz.crm_allowed(uuid,text),authz.crm_child(uuid,text,text),authz.crm_saved_view_read(uuid),authz.crm_onboard(uuid,text),authz.crm_context(),authz.crm_receipt(text,text),authz.crm_finish(text,jsonb),authz.crm_grant(uuid,uuid,text,timestamptz,text),authz.crm_add_view_recipient(uuid,uuid) TO rpt_runtime;

CREATE INDEX opportunity_work_idx ON rpt.opportunity(tenant_id,workspace_id,owner_id,stage,id);
CREATE INDEX opportunity_sort_idx ON rpt.opportunity(tenant_id,updated_at,id);
CREATE INDEX appointment_opportunity_idx ON rpt.appointment(tenant_id,opportunity_id,starts_at);
CREATE INDEX demo_opportunity_idx ON rpt.demo_visit(tenant_id,opportunity_id);
CREATE INDEX entry_opportunity_idx ON rpt.crm_entry(tenant_id,opportunity_id,created_at);
CREATE INDEX event_opportunity_idx ON rpt.crm_event(tenant_id,opportunity_id,occurred_at);
CREATE INDEX saved_workspace_idx ON rpt.saved_view(tenant_id,workspace_id,owner_id);
