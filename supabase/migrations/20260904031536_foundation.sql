SET LOCAL ROLE rpt_owner;
CREATE SCHEMA authz AUTHORIZATION rpt_owner;
CREATE SCHEMA rpt AUTHORIZATION rpt_owner;
REVOKE ALL ON SCHEMA authz, rpt FROM PUBLIC;
GRANT USAGE ON SCHEMA rpt, authz TO rpt_runtime, rpt_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA authz REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA rpt REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE authz.tenant (
 id uuid PRIMARY KEY, slug text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9-]{3,50}$'),
 status text NOT NULL CHECK (status IN ('active','suspended')),
 policy_version integer NOT NULL CHECK (policy_version > 0),
 timezone text NOT NULL DEFAULT 'America/Guayaquil', real_data_enabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE authz.user_account (
 tenant_id uuid NOT NULL REFERENCES authz.tenant, id uuid NOT NULL,
 issuer text NOT NULL, subject uuid NOT NULL, email text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
 high_privilege boolean NOT NULL DEFAULT false, person_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id), UNIQUE (issuer,subject)
);
CREATE UNIQUE INDEX user_email_per_tenant ON authz.user_account(tenant_id,lower(email));
CREATE TABLE authz.session (
 tenant_id uuid NOT NULL, id uuid NOT NULL, user_id uuid NOT NULL, expires_at timestamptz NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,user_id) REFERENCES authz.user_account
);
CREATE TABLE authz.role_capability (
 tenant_id uuid NOT NULL REFERENCES authz.tenant, role_key text NOT NULL, object_type text NOT NULL,
 verb text NOT NULL, field_class text NOT NULL, requires_aal2 boolean NOT NULL DEFAULT false,
 policy_version integer NOT NULL, PRIMARY KEY (tenant_id,role_key,object_type,verb,field_class,policy_version)
);
CREATE TABLE authz.role_assignment (
 tenant_id uuid NOT NULL, id uuid NOT NULL, user_id uuid NOT NULL, role_key text NOT NULL,
 effective_from timestamptz NOT NULL DEFAULT now(), effective_to timestamptz,
 revoked_at timestamptz, PRIMARY KEY (tenant_id,id),
 FOREIGN KEY (tenant_id,user_id) REFERENCES authz.user_account,
 CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE TABLE rpt.market (
 tenant_id uuid NOT NULL REFERENCES authz.tenant, id uuid NOT NULL, code text NOT NULL,
 timezone text NOT NULL, currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,code)
);
CREATE TABLE rpt.distribution_group (
 tenant_id uuid NOT NULL REFERENCES authz.tenant, id uuid NOT NULL, name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id)
);
CREATE TABLE rpt.market_registration (
 tenant_id uuid NOT NULL, id uuid NOT NULL, group_id uuid NOT NULL, market_id uuid NOT NULL,
 external_number text, plan_version text, price_level_key text,
 effective_from timestamptz NOT NULL, effective_to timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,market_id),
 FOREIGN KEY(tenant_id,group_id) REFERENCES rpt.distribution_group,
 FOREIGN KEY(tenant_id,market_id) REFERENCES rpt.market,
 CHECK(effective_to IS NULL OR effective_to > effective_from),
 EXCLUDE USING gist (tenant_id extensions.gist_uuid_ops WITH =, group_id extensions.gist_uuid_ops WITH =, market_id extensions.gist_uuid_ops WITH =, tstzrange(effective_from,effective_to,'[)') WITH &&)
);
CREATE TABLE rpt.crm_workspace (
 tenant_id uuid NOT NULL REFERENCES authz.tenant, id uuid NOT NULL, name text NOT NULL,
 registration_id uuid, kind text NOT NULL CHECK(kind IN ('commercial','recruitment')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,registration_id) REFERENCES rpt.market_registration
);
CREATE TABLE authz.workspace_permission (
 tenant_id uuid NOT NULL, id uuid NOT NULL, workspace_id uuid NOT NULL, user_id uuid NOT NULL,
 object_type text NOT NULL, verb text NOT NULL, field_class text NOT NULL,
 policy_version integer NOT NULL, effective_from timestamptz NOT NULL DEFAULT now(),
 effective_to timestamptz, revoked_at timestamptz,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,user_id) REFERENCES authz.user_account,
 CHECK(effective_to IS NULL OR effective_to > effective_from)
);
CREATE TABLE rpt.person (
 tenant_id uuid NOT NULL REFERENCES authz.tenant, id uuid NOT NULL, workspace_id uuid NOT NULL,
 owner_id uuid NOT NULL, display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
 lifecycle text NOT NULL DEFAULT 'prospect' CHECK(lifecycle IN ('referral','prospect','customer','candidate','advisor','distributor','collaborator')),
 version integer NOT NULL DEFAULT 1, deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,owner_id) REFERENCES authz.user_account
);
ALTER TABLE authz.user_account ADD FOREIGN KEY(tenant_id,person_id) REFERENCES rpt.person;
CREATE TABLE rpt.person_pii (
 tenant_id uuid NOT NULL, person_id uuid NOT NULL, email text, phone text,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,person_id),
 FOREIGN KEY(tenant_id,person_id) REFERENCES rpt.person
);
-- Private ownership projection has no direct runtime grants; avoids recursive Person RLS.
CREATE TABLE authz.object_access (
 tenant_id uuid NOT NULL, object_type text NOT NULL, object_id uuid NOT NULL,
 workspace_id uuid NOT NULL, owner_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,object_type,object_id), FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,owner_id) REFERENCES authz.user_account
);
CREATE TABLE authz.ownership_history (
 tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), object_type text NOT NULL,
 object_id uuid NOT NULL, workspace_id uuid NOT NULL, owner_id uuid NOT NULL,
 effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE authz.access_grant (
 tenant_id uuid NOT NULL, id uuid NOT NULL, object_type text NOT NULL, object_id uuid NOT NULL,
 grantor_id uuid NOT NULL, grantee_id uuid NOT NULL, verb text NOT NULL, field_class text NOT NULL,
 effective_from timestamptz NOT NULL, effective_to timestamptz NOT NULL, revoked_at timestamptz,
 policy_version integer NOT NULL, reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,object_type,object_id) REFERENCES authz.object_access,
 FOREIGN KEY(tenant_id,grantor_id) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,grantee_id) REFERENCES authz.user_account,
 CHECK(effective_to > effective_from), CHECK(grantor_id <> grantee_id)
);
CREATE TABLE rpt.commercial_membership (
 tenant_id uuid NOT NULL, id uuid NOT NULL, person_id uuid NOT NULL, group_id uuid NOT NULL,
 effective_from timestamptz NOT NULL, effective_to timestamptz,
 status text NOT NULL CHECK(status IN ('active','historical','pending','rejected','cancelled')),
 source text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,person_id) REFERENCES rpt.person,
 FOREIGN KEY(tenant_id,group_id) REFERENCES rpt.distribution_group,
 CHECK(effective_to IS NULL OR effective_to > effective_from),
 EXCLUDE USING gist (tenant_id extensions.gist_uuid_ops WITH =, person_id extensions.gist_uuid_ops WITH =, tstzrange(effective_from,effective_to,'[)') WITH &&) WHERE(status IN ('active','historical'))
);
CREATE TABLE rpt.network_parent (
 tenant_id uuid NOT NULL, id uuid NOT NULL, market_id uuid NOT NULL,
 child_id uuid NOT NULL, parent_id uuid, effective_from timestamptz NOT NULL, effective_to timestamptz,
 source text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,child_id,market_id) REFERENCES rpt.market_registration(tenant_id,id,market_id),
 FOREIGN KEY(tenant_id,parent_id,market_id) REFERENCES rpt.market_registration(tenant_id,id,market_id),
 CHECK(child_id IS DISTINCT FROM parent_id), CHECK(effective_to IS NULL OR effective_to > effective_from),
 EXCLUDE USING gist (tenant_id extensions.gist_uuid_ops WITH =, child_id extensions.gist_uuid_ops WITH =, tstzrange(effective_from,effective_to,'[)') WITH &&)
);
CREATE TABLE authz.statistical_scope (
 tenant_id uuid NOT NULL, id uuid NOT NULL, user_id uuid NOT NULL, ancestor_id uuid NOT NULL,
 effective_from timestamptz NOT NULL, effective_to timestamptz, revoked_at timestamptz,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,user_id) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,ancestor_id) REFERENCES rpt.market_registration,
 CHECK(effective_to IS NULL OR effective_to > effective_from)
);
CREATE TABLE rpt.policy_version (
 tenant_id uuid NOT NULL REFERENCES authz.tenant, id uuid NOT NULL, version integer NOT NULL,
 market_id uuid, policy_key text NOT NULL, config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'),
 effective_from timestamptz NOT NULL, effective_to timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,market_id) REFERENCES rpt.market,
 UNIQUE NULLS NOT DISTINCT(tenant_id,policy_key,market_id,version),
 CHECK(effective_to IS NULL OR effective_to>effective_from)
);
CREATE TABLE rpt.feature_flag (
 tenant_id uuid NOT NULL REFERENCES authz.tenant, id uuid NOT NULL, key text NOT NULL,
 market_id uuid, policy_version integer NOT NULL, enabled boolean NOT NULL DEFAULT false,
 rollout_percent integer NOT NULL CHECK(rollout_percent BETWEEN 0 AND 100),
 effective_from timestamptz NOT NULL, effective_to timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,market_id) REFERENCES rpt.market,
 UNIQUE NULLS NOT DISTINCT(tenant_id,key,market_id,policy_version),
 CHECK(effective_to IS NULL OR effective_to>effective_from)
);
CREATE TABLE authz.source_authority (
 tenant_id uuid NOT NULL, user_id uuid NOT NULL, source_system text NOT NULL,
 domain_key text NOT NULL, authority_level text NOT NULL CHECK(authority_level IN ('official','verified','authorized','import','manual','inference')),
 revoked_at timestamptz, PRIMARY KEY(tenant_id,user_id,source_system,domain_key),
 FOREIGN KEY(tenant_id,user_id) REFERENCES authz.user_account
);
CREATE TABLE rpt.source_observation (
 tenant_id uuid NOT NULL REFERENCES authz.tenant, id uuid NOT NULL, source_system text NOT NULL CHECK(source_system IN ('HYCITE','INCITE','DOCUCITE','RPT_USER','RPT_AI','IMPORT','API','SYSTEM_CALCULATION','MANUAL_RECONCILIATION')),
 domain_key text NOT NULL, subject_id uuid NOT NULL, external_id text NOT NULL, source_reference text NOT NULL,
 observed_at timestamptz NOT NULL, effective_at timestamptz NOT NULL, verified_at timestamptz,
 authority_level text NOT NULL CHECK(authority_level IN ('official','verified','authorized','import','manual','inference')),
 raw_hash text NOT NULL CHECK(raw_hash ~ '^[a-f0-9]{64}$'), sync_run_id uuid NOT NULL,
 reconciliation_state text NOT NULL CHECK(reconciliation_state IN ('pending','matched','conflict','resolved','superseded','reversed','pending_review')),
 actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account,
 UNIQUE(tenant_id,source_system,external_id,raw_hash),
 CHECK(source_system <> 'RPT_AI' OR authority_level='inference'),
 CHECK(authority_level <> 'official' OR verified_at IS NOT NULL)
);
CREATE TABLE rpt.reconciliation_case (
 tenant_id uuid NOT NULL, id uuid NOT NULL, observation_id uuid NOT NULL, previous_observation_id uuid,
 state text NOT NULL CHECK(state IN ('pending','matched','conflict','missing_local','missing_external','pending_review','resolved_official_wins','resolved_local_verified','ignored_with_reason','superseded','reversed')),
 reason_code text NOT NULL, resolution_of uuid,
 actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,observation_id) REFERENCES rpt.source_observation,
 FOREIGN KEY(tenant_id,previous_observation_id) REFERENCES rpt.source_observation,
 FOREIGN KEY(tenant_id,resolution_of) REFERENCES rpt.reconciliation_case,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account
);
CREATE TABLE rpt.official_rank_assignment (
 tenant_id uuid NOT NULL, id uuid NOT NULL, group_id uuid NOT NULL, rank_key text NOT NULL,
 observation_id uuid NOT NULL, effective_from timestamptz NOT NULL, effective_to timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,group_id) REFERENCES rpt.distribution_group,
 FOREIGN KEY(tenant_id,observation_id) REFERENCES rpt.source_observation,
 CHECK(effective_to IS NULL OR effective_to>effective_from),
 EXCLUDE USING gist (tenant_id extensions.gist_uuid_ops WITH =, group_id extensions.gist_uuid_ops WITH =, tstzrange(effective_from,effective_to,'[)') WITH &&)
);
CREATE TABLE rpt.metric_event_ledger (
 tenant_id uuid NOT NULL, id uuid NOT NULL, schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1),
 metric_key text NOT NULL CHECK(metric_key IN ('calls','appointments','demos','sales','recruiting','training','followups','goals')),
 actor_id uuid NOT NULL, subject_person_id uuid NOT NULL, registration_id uuid NOT NULL,
 market_id uuid NOT NULL, office_context uuid, occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(), value numeric(20,6) NOT NULL, unit text NOT NULL,
 source text NOT NULL, observation_id uuid, verification text NOT NULL CHECK(verification IN ('unverified','verified','official')),
 policy_version integer NOT NULL, idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
 event_kind text NOT NULL CHECK(event_kind IN ('original','reversal','adjustment')), reversal_of uuid,
 correlation_id uuid NOT NULL, causation_id uuid,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,subject_person_id) REFERENCES rpt.person,
 FOREIGN KEY(tenant_id,registration_id,market_id) REFERENCES rpt.market_registration(tenant_id,id,market_id),
 FOREIGN KEY(tenant_id,observation_id) REFERENCES rpt.source_observation,
 FOREIGN KEY(tenant_id,reversal_of) REFERENCES rpt.metric_event_ledger,
 CHECK((event_kind='original' AND reversal_of IS NULL AND value >= 0) OR (event_kind IN ('reversal','adjustment') AND reversal_of IS NOT NULL)),
 CHECK(verification <> 'official' OR observation_id IS NOT NULL),
 UNIQUE(tenant_id,idempotency_key)
);
CREATE UNIQUE INDEX one_reversal ON rpt.metric_event_ledger(tenant_id,reversal_of) WHERE(event_kind='reversal');
CREATE TABLE authz.idempotency_receipt (
 tenant_id uuid NOT NULL REFERENCES authz.tenant, operation text NOT NULL, key text NOT NULL,
 actor_id uuid NOT NULL, request_hash text NOT NULL, response jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,operation,key),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account
);
CREATE TABLE rpt.consent_record (
 tenant_id uuid NOT NULL, id uuid NOT NULL, person_id uuid NOT NULL, purpose text NOT NULL,
 modality text NOT NULL, policy_version integer NOT NULL, language text NOT NULL, channel text NOT NULL,
 state text NOT NULL CHECK(state IN ('granted','withdrawn','denied')), evidence_hash text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(), supersedes uuid, PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,person_id) REFERENCES rpt.person,
 FOREIGN KEY(tenant_id,supersedes) REFERENCES rpt.consent_record
);
CREATE TABLE rpt.legal_hold (
 tenant_id uuid NOT NULL, id uuid NOT NULL, person_id uuid NOT NULL, reason_code text NOT NULL,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,person_id) REFERENCES rpt.person
);
CREATE TABLE rpt.privacy_request (
 tenant_id uuid NOT NULL, id uuid NOT NULL, person_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('access','rectification','deletion','objection','portability')),
 state text NOT NULL CHECK(state IN ('pending_verification','verified','held','approved','completed','rejected')),
 verified_at timestamptz, due_at timestamptz NOT NULL, reason_code text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,person_id) REFERENCES rpt.person
);
CREATE TABLE rpt.audit_event (
 tenant_id uuid NOT NULL REFERENCES authz.tenant, id uuid NOT NULL DEFAULT gen_random_uuid(),
 actor_id uuid, action text NOT NULL, object_type text NOT NULL, object_id uuid,
 scope text NOT NULL, policy_version integer NOT NULL, request_id uuid,
 result text NOT NULL CHECK(result IN ('allow','deny','success','failure')), reason_code text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), before_digest text, after_digest text,
 PRIMARY KEY(tenant_id,id)
);

-- All runtime tenant/actor values are set only AFTER cryptographic auth verification
-- by the trusted backend, inside a transaction. No Data API grants to end-users.
CREATE FUNCTION authz.tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('rpt.tenant_id',true),'')::uuid $$;
CREATE FUNCTION authz.actor_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('rpt.actor_id',true),'')::uuid $$;
CREATE FUNCTION authz.session_valid() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM authz.session s JOIN authz.user_account u ON (u.tenant_id,u.id)=(s.tenant_id,s.user_id)
 JOIN authz.tenant t ON t.id=u.tenant_id
 WHERE t.id=authz.tenant_id() AND u.id=authz.actor_id() AND s.id=nullif(current_setting('rpt.session_id',true),'')::uuid
 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND u.status='active' AND t.status='active'
 AND (NOT u.high_privilege OR current_setting('rpt.aal',true)='aal2'))
$$;
CREATE FUNCTION authz.resolve_identity(p_issuer text,p_subject uuid,p_session uuid) RETURNS TABLE(tenant_id uuid,actor_id uuid,policy_version integer,high_privilege boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.tenant_id,u.id,t.policy_version,u.high_privilege FROM authz.user_account u
 JOIN authz.tenant t ON t.id=u.tenant_id JOIN authz.session s ON (s.tenant_id,s.user_id)=(u.tenant_id,u.id)
 WHERE u.issuer=p_issuer AND u.subject=p_subject AND u.status='active' AND t.status='active'
 AND s.id=p_session AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
$$;
CREATE FUNCTION authz.capable(p_actor uuid,p_type text,p_verb text,p_field text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM authz.role_assignment a
 JOIN authz.role_capability c ON (c.tenant_id,c.role_key)=(a.tenant_id,a.role_key)
 JOIN authz.tenant t ON t.id=a.tenant_id JOIN authz.user_account u ON (u.tenant_id,u.id)=(a.tenant_id,a.user_id)
 WHERE a.tenant_id=authz.tenant_id() AND a.user_id=p_actor AND u.status='active' AND t.status='active'
 AND a.revoked_at IS NULL AND a.effective_from<=statement_timestamp() AND (a.effective_to IS NULL OR a.effective_to>statement_timestamp())
 AND c.object_type=p_type AND c.verb=p_verb AND c.field_class=p_field AND c.policy_version=t.policy_version
 AND (NOT c.requires_aal2 OR current_setting('rpt.aal',true)='aal2'))
$$;
CREATE FUNCTION authz.direct_access(p_actor uuid,p_type text,p_id uuid,p_verb text,p_field text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.capable(p_actor,p_type,p_verb,p_field) AND EXISTS (
 SELECT 1 FROM authz.object_access o JOIN authz.tenant t ON t.id=o.tenant_id
 WHERE o.tenant_id=authz.tenant_id() AND o.object_type=p_type AND o.object_id=p_id AND (
 o.owner_id=p_actor OR EXISTS(SELECT 1 FROM authz.workspace_permission w WHERE w.tenant_id=o.tenant_id
 AND w.workspace_id=o.workspace_id AND w.user_id=p_actor AND w.object_type=p_type AND w.verb=p_verb AND w.field_class=p_field
 AND w.policy_version=t.policy_version AND w.revoked_at IS NULL AND w.effective_from<=statement_timestamp()
 AND (w.effective_to IS NULL OR w.effective_to>statement_timestamp()))))
$$;
CREATE FUNCTION authz.allowed(p_type text,p_id uuid,p_verb text,p_field text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND authz.capable(authz.actor_id(),p_type,p_verb,p_field) AND (
 authz.direct_access(authz.actor_id(),p_type,p_id,p_verb,p_field) OR EXISTS(
 SELECT 1 FROM authz.access_grant g JOIN authz.tenant t ON t.id=g.tenant_id
 WHERE g.tenant_id=authz.tenant_id() AND g.grantee_id=authz.actor_id() AND g.object_type=p_type AND g.object_id=p_id
 AND g.verb=p_verb AND g.field_class=p_field AND g.revoked_at IS NULL AND g.effective_from<=statement_timestamp()
 AND g.effective_to>statement_timestamp() AND g.policy_version=t.policy_version
 AND authz.direct_access(g.grantor_id,p_type,p_id,p_verb,p_field)
 AND authz.direct_access(g.grantor_id,p_type,p_id,'share',p_field)))
$$;
CREATE FUNCTION authz.tenant_allowed(p_tenant uuid,p_type text,p_verb text,p_field text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p_tenant=authz.tenant_id() AND authz.session_valid() AND authz.capable(authz.actor_id(),p_type,p_verb,p_field)
$$;
CREATE FUNCTION authz.workspace_create(p_tenant uuid,p_workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p_tenant=authz.tenant_id() AND authz.session_valid() AND authz.capable(authz.actor_id(),'person','create','CONFIDENTIAL') AND EXISTS(
 SELECT 1 FROM authz.workspace_permission w JOIN authz.tenant t ON t.id=w.tenant_id
 WHERE w.tenant_id=p_tenant AND w.workspace_id=p_workspace AND w.user_id=authz.actor_id()
 AND w.object_type='person' AND w.verb='create' AND w.field_class='CONFIDENTIAL' AND w.policy_version=t.policy_version
 AND w.revoked_at IS NULL AND w.effective_from<=statement_timestamp() AND (w.effective_to IS NULL OR w.effective_to>statement_timestamp()))
$$;
CREATE FUNCTION authz.ownership_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO authz.object_access(tenant_id,object_type,object_id,workspace_id,owner_id)
 VALUES(NEW.tenant_id,'person',NEW.id,NEW.workspace_id,NEW.owner_id)
 ON CONFLICT(tenant_id,object_type,object_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,owner_id=EXCLUDED.owner_id;
 IF TG_OP='INSERT' OR NEW.owner_id<>OLD.owner_id OR NEW.workspace_id<>OLD.workspace_id THEN
 INSERT INTO authz.ownership_history(tenant_id,object_type,object_id,workspace_id,owner_id) VALUES(NEW.tenant_id,'person',NEW.id,NEW.workspace_id,NEW.owner_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ownership_sync AFTER INSERT OR UPDATE ON rpt.person FOR EACH ROW EXECUTE FUNCTION authz.ownership_sync();
CREATE FUNCTION authz.person_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id THEN RAISE EXCEPTION 'immutable_identity' USING ERRCODE='42501'; END IF;
 IF (NEW.owner_id<>OLD.owner_id OR NEW.workspace_id<>OLD.workspace_id) AND NOT authz.allowed('person',OLD.id,'reassign','CONFIDENTIAL') THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 NEW.version=OLD.version+1; NEW.updated_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER person_guard BEFORE UPDATE ON rpt.person FOR EACH ROW EXECUTE FUNCTION authz.person_guard();

CREATE FUNCTION authz.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'append_only' USING ERRCODE='42501'; END $$;
CREATE FUNCTION authz.audit_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r jsonb; old_row jsonb; new_row jsonb;
BEGIN
 IF TG_OP <> 'INSERT' THEN old_row=to_jsonb(OLD); END IF;
 IF TG_OP <> 'DELETE' THEN new_row=to_jsonb(NEW); END IF;
 r=coalesce(new_row,old_row);
 INSERT INTO rpt.audit_event(tenant_id,actor_id,action,object_type,object_id,scope,policy_version,request_id,result,reason_code,before_digest,after_digest)
 VALUES((r->>'tenant_id')::uuid,authz.actor_id(),lower(TG_OP),TG_TABLE_NAME,coalesce(r->>'id',r->>'person_id')::uuid,'tenant/object',
 (SELECT policy_version FROM authz.tenant WHERE id=(r->>'tenant_id')::uuid),nullif(current_setting('rpt.request_id',true),'')::uuid,'success','db_change',
 CASE WHEN old_row IS NOT NULL THEN encode(extensions.digest(old_row::text,'sha256'),'hex') END,
 CASE WHEN new_row IS NOT NULL THEN encode(extensions.digest(new_row::text,'sha256'),'hex') END);
 RETURN coalesce(NEW,OLD);
END $$;
CREATE FUNCTION authz.record_decision(p_object uuid,p_action text,p_result text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR p_action NOT IN ('person.read','person.update','metric.append','grant.create','grant.revoke','privacy.purge','network.stats') OR p_result NOT IN ('allow','deny','success','failure') THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO rpt.audit_event(tenant_id,actor_id,action,object_type,object_id,scope,policy_version,request_id,result,reason_code)
 VALUES(authz.tenant_id(),authz.actor_id(),p_action,'permission_decision',p_object,'request',
 (SELECT policy_version FROM authz.tenant WHERE id=authz.tenant_id()),nullif(current_setting('rpt.request_id',true),'')::uuid,p_result,'server_policy');
END $$;

-- Temporal cycles test the common intersection along each path, not just current edges.
CREATE FUNCTION authz.network_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE has_cycle boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text,0));
 IF TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.child_id<>OLD.child_id OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.effective_from<>OLD.effective_from OR OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL) THEN RAISE EXCEPTION 'close_then_append_required' USING ERRCODE='23514'; END IF;
 WITH RECURSIVE ancestors(node,period,path) AS (
 SELECT NEW.parent_id,tstzrange(NEW.effective_from,NEW.effective_to,'[)'),ARRAY[NEW.child_id]
 UNION ALL SELECT n.parent_id,a.period*tstzrange(n.effective_from,n.effective_to,'[)'),a.path||a.node
 FROM rpt.network_parent n JOIN ancestors a ON n.child_id=a.node
 WHERE n.tenant_id=NEW.tenant_id AND n.id<>NEW.id AND n.parent_id IS NOT NULL
 AND tstzrange(n.effective_from,n.effective_to,'[)') && a.period AND NOT a.node=ANY(a.path)
 ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE node=NEW.child_id) INTO has_cycle;
 IF has_cycle THEN RAISE EXCEPTION 'network_cycle' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER network_guard BEFORE INSERT OR UPDATE ON rpt.network_parent FOR EACH ROW EXECUTE FUNCTION authz.network_guard();
CREATE FUNCTION authz.membership_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.person_id<>OLD.person_id OR NEW.group_id<>OLD.group_id OR NEW.effective_from<>OLD.effective_from
 OR OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL THEN RAISE EXCEPTION 'close_then_append_required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER membership_guard BEFORE UPDATE ON rpt.commercial_membership FOR EACH ROW EXECUTE FUNCTION authz.membership_guard();
CREATE FUNCTION authz.observation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM authz.source_authority a WHERE a.tenant_id=NEW.tenant_id AND a.user_id=authz.actor_id()
 AND a.source_system=NEW.source_system AND a.domain_key=NEW.domain_key AND a.authority_level=NEW.authority_level AND a.revoked_at IS NULL)
 OR NEW.actor_id<>authz.actor_id() THEN RAISE EXCEPTION 'source_not_authorized' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER observation_guard BEFORE INSERT ON rpt.source_observation FOR EACH ROW EXECUTE FUNCTION authz.observation_guard();
CREATE FUNCTION authz.rank_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM rpt.source_observation o JOIN authz.source_authority a ON a.tenant_id=o.tenant_id AND a.source_system=o.source_system AND a.domain_key=o.domain_key
 WHERE o.tenant_id=NEW.tenant_id AND o.id=NEW.observation_id AND o.subject_id=NEW.group_id AND o.authority_level='official' AND o.domain_key='rank'
 AND o.verified_at IS NOT NULL AND o.reconciliation_state IN ('matched','resolved') AND a.authority_level='official' AND a.user_id=authz.actor_id() AND a.revoked_at IS NULL)
 THEN RAISE EXCEPTION 'official_confirmation_required' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.rank_key<>OLD.rank_key OR NEW.group_id<>OLD.group_id OR NEW.observation_id<>OLD.observation_id OR NEW.effective_from<>OLD.effective_from OR OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL) THEN RAISE EXCEPTION 'close_then_append_required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rank_guard BEFORE INSERT OR UPDATE ON rpt.official_rank_assignment FOR EACH ROW EXECUTE FUNCTION authz.rank_guard();
CREATE FUNCTION authz.ledger_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE original rpt.metric_event_ledger%ROWTYPE;
BEGIN
 IF NEW.actor_id<>authz.actor_id() OR NEW.policy_version<>(SELECT policy_version FROM authz.tenant WHERE id=NEW.tenant_id)
 OR NOT authz.allowed('person',NEW.subject_person_id,'update','CONFIDENTIAL') THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 IF NEW.event_kind='original' AND NOT EXISTS(SELECT 1 FROM rpt.commercial_membership m JOIN rpt.market_registration r ON (r.tenant_id,r.group_id)=(m.tenant_id,m.group_id)
 WHERE m.tenant_id=NEW.tenant_id AND m.person_id=NEW.subject_person_id AND r.id=NEW.registration_id
 AND m.status IN ('active','historical') AND tstzrange(m.effective_from,m.effective_to,'[)') @> NEW.occurred_at
 AND tstzrange(r.effective_from,r.effective_to,'[)') @> NEW.occurred_at) THEN RAISE EXCEPTION 'invalid_event_context' USING ERRCODE='23514'; END IF;
 IF NEW.reversal_of IS NOT NULL THEN
 SELECT * INTO original FROM rpt.metric_event_ledger WHERE tenant_id=NEW.tenant_id AND id=NEW.reversal_of;
 IF NOT FOUND OR original.event_kind<>'original' OR (NEW.metric_key,NEW.subject_person_id,NEW.registration_id,NEW.market_id,NEW.unit,NEW.occurred_at) IS DISTINCT FROM (original.metric_key,original.subject_person_id,original.registration_id,original.market_id,original.unit,original.occurred_at)
 OR (NEW.event_kind='reversal' AND NEW.value<>-original.value) THEN RAISE EXCEPTION 'invalid_reversal' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.metric_key='sales' OR NEW.verification='official' THEN
 IF NOT EXISTS(SELECT 1 FROM rpt.source_observation o JOIN authz.source_authority a ON a.tenant_id=o.tenant_id AND a.source_system=o.source_system AND a.domain_key=o.domain_key
 WHERE o.tenant_id=NEW.tenant_id AND o.id=NEW.observation_id AND o.subject_id=NEW.subject_person_id AND o.authority_level='official' AND o.verified_at IS NOT NULL AND o.domain_key='sales' AND o.reconciliation_state IN ('matched','resolved') AND a.user_id=authz.actor_id() AND a.authority_level='official' AND a.revoked_at IS NULL) THEN RAISE EXCEPTION 'official_confirmation_required' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ledger_guard BEFORE INSERT ON rpt.metric_event_ledger FOR EACH ROW EXECUTE FUNCTION authz.ledger_guard();

-- Owner bypass is deliberate ONLY inside non-exposed functions; no owner membership
-- reaches runtime/admin. RLS enabled on EVERY table; authz tables have NO runtime grants.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('authz','rpt') LOOP
 EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',r.schemaname,r.tablename);
 END LOOP;
END $$;
CREATE POLICY person_read ON rpt.person FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND deleted_at IS NULL AND authz.allowed('person',id,'read','CONFIDENTIAL'));
CREATE POLICY person_create ON rpt.person FOR INSERT TO rpt_runtime WITH CHECK(owner_id=authz.actor_id() AND authz.workspace_create(tenant_id,workspace_id));
CREATE POLICY person_update ON rpt.person FOR UPDATE TO rpt_runtime USING(tenant_id=authz.tenant_id() AND deleted_at IS NULL AND authz.allowed('person',id,'update','CONFIDENTIAL')) WITH CHECK(tenant_id=authz.tenant_id() AND authz.allowed('person',id,'update','CONFIDENTIAL'));
CREATE POLICY pii_read ON rpt.person_pii FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND authz.allowed('person',person_id,'read','RESTRICTED_PII'));
CREATE POLICY pii_update ON rpt.person_pii FOR UPDATE TO rpt_runtime USING(tenant_id=authz.tenant_id() AND authz.allowed('person',person_id,'update','RESTRICTED_PII')) WITH CHECK(tenant_id=authz.tenant_id() AND authz.allowed('person',person_id,'update','RESTRICTED_PII'));
CREATE POLICY pii_insert ON rpt.person_pii FOR INSERT TO rpt_runtime WITH CHECK(tenant_id=authz.tenant_id() AND authz.allowed('person',person_id,'update','RESTRICTED_PII'));
CREATE POLICY audit_read ON rpt.audit_event FOR SELECT TO rpt_runtime USING(authz.tenant_allowed(tenant_id,'audit','read','SECURITY_AUDIT'));
CREATE POLICY ledger_read ON rpt.metric_event_ledger FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND authz.allowed('person',subject_person_id,'read','CONFIDENTIAL'));
CREATE POLICY ledger_append ON rpt.metric_event_ledger FOR INSERT TO rpt_runtime WITH CHECK(authz.tenant_allowed(tenant_id,'metric','create','INTERNAL') AND authz.allowed('person',subject_person_id,'update','CONFIDENTIAL'));
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['market','distribution_group','market_registration','network_parent','commercial_membership'] LOOP
 EXECUTE format('CREATE POLICY structural_read ON rpt.%I FOR SELECT TO rpt_runtime USING(authz.tenant_allowed(tenant_id,''network'',''read'',''INTERNAL''))',tbl);
 EXECUTE format('CREATE POLICY structural_write ON rpt.%I FOR ALL TO rpt_runtime USING(authz.tenant_allowed(tenant_id,''network'',''update'',''INTERNAL'')) WITH CHECK(authz.tenant_allowed(tenant_id,''network'',''update'',''INTERNAL''))',tbl);
 END LOOP;
 FOREACH tbl IN ARRAY ARRAY['policy_version','feature_flag'] LOOP
 EXECUTE format('CREATE POLICY config_read ON rpt.%I FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND authz.session_valid())',tbl);
 EXECUTE format('CREATE POLICY config_append ON rpt.%I FOR INSERT TO rpt_runtime WITH CHECK(authz.tenant_allowed(tenant_id,''policy'',''publish_policy'',''INTERNAL''))',tbl);
 END LOOP;
 FOREACH tbl IN ARRAY ARRAY['source_observation','reconciliation_case','official_rank_assignment'] LOOP
 EXECUTE format('CREATE POLICY trust_read ON rpt.%I FOR SELECT TO rpt_runtime USING(authz.tenant_allowed(tenant_id,''trust'',''read'',''OFFICIAL_COMPENSATION''))',tbl);
 EXECUTE format('CREATE POLICY trust_write ON rpt.%I FOR ALL TO rpt_runtime USING(authz.tenant_allowed(tenant_id,''trust'',''approve'',''OFFICIAL_COMPENSATION'')) WITH CHECK(authz.tenant_allowed(tenant_id,''trust'',''approve'',''OFFICIAL_COMPENSATION''))',tbl);
 END LOOP;
 FOREACH tbl IN ARRAY ARRAY['consent_record','privacy_request','legal_hold'] LOOP
 EXECUTE format('CREATE POLICY privacy_read ON rpt.%I FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND authz.allowed(''person'',person_id,''read'',''RESTRICTED_PII''))',tbl);
 EXECUTE format('CREATE POLICY privacy_write ON rpt.%I FOR ALL TO rpt_runtime USING(authz.tenant_allowed(tenant_id,''privacy'',''approve'',''RESTRICTED_PII'')) WITH CHECK(authz.tenant_allowed(tenant_id,''privacy'',''approve'',''RESTRICTED_PII''))',tbl);
 END LOOP;
END $$;
CREATE POLICY workspace_read ON rpt.crm_workspace FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND authz.session_valid() AND authz.workspace_create(tenant_id,id));
GRANT SELECT ON ALL TABLES IN SCHEMA rpt TO rpt_runtime;
GRANT INSERT,UPDATE ON rpt.person,rpt.person_pii,rpt.network_parent,rpt.commercial_membership,rpt.official_rank_assignment,rpt.privacy_request,rpt.legal_hold TO rpt_runtime;
GRANT INSERT ON rpt.metric_event_ledger,rpt.source_observation,rpt.reconciliation_case,rpt.consent_record,rpt.policy_version,rpt.feature_flag TO rpt_runtime;
-- Explicit function allowlist. Internal capable/direct_access functions remain private.
GRANT EXECUTE ON FUNCTION authz.tenant_id(),authz.actor_id(),authz.session_valid(),authz.resolve_identity(text,uuid,uuid),authz.allowed(text,uuid,text,text),authz.tenant_allowed(uuid,text,text,text),authz.workspace_create(uuid,uuid),authz.record_decision(uuid,text,text) TO rpt_runtime;

DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('rpt','authz') AND tablename NOT IN ('tenant','audit_event','idempotency_receipt','object_access','ownership_history') LOOP
 EXECUTE format('CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION authz.audit_change()',r.schemaname,r.tablename);
 END LOOP;
 FOR r IN SELECT unnest(ARRAY['audit_event','metric_event_ledger','source_observation','reconciliation_case','consent_record','policy_version','feature_flag']) AS name LOOP
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON rpt.%I FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable()',r.name);
 END LOOP;
END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON authz.ownership_history FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE INDEX person_workspace_idx ON rpt.person(tenant_id,workspace_id,owner_id,id) WHERE deleted_at IS NULL;
CREATE INDEX grant_lookup_idx ON authz.access_grant(tenant_id,grantee_id,object_type,object_id,verb,field_class) WHERE revoked_at IS NULL;
CREATE INDEX ledger_context_idx ON rpt.metric_event_ledger(tenant_id,registration_id,occurred_at,metric_key);
CREATE INDEX network_traversal_idx ON rpt.network_parent(tenant_id,parent_id,child_id,effective_from);
CREATE INDEX audit_request_idx ON rpt.audit_event(tenant_id,request_id,occurred_at);
CREATE INDEX workspace_permission_idx ON authz.workspace_permission(tenant_id,user_id,workspace_id,verb,field_class) WHERE revoked_at IS NULL;
