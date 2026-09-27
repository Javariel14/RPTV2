SET LOCAL ROLE rpt_owner;
-- E3B3: immutable workflow artifacts, not a generic approval platform.
-- Existing E3B2 key IDs/secrets remain the sole commercial authenticity boundary.
CREATE FUNCTION authz.quote_snapshot_authentic(p_version uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM rpt.cpq_quote_version v
 JOIN rpt.cpq_quote q ON q.tenant_id=v.tenant_id AND q.id=v.quote_id
 JOIN authz.quote_calculation_key k ON k.tenant_id=v.tenant_id AND k.id=v.attestation_key_id
 WHERE v.tenant_id=authz.tenant_id() AND v.id=p_version AND authz.session_valid()
 AND v.calculation_attestation=encode(extensions.hmac(convert_to(v.attestation_payload,'UTF8'),k.secret,'sha256'),'hex')
 AND v.attestation_payload::jsonb=jsonb_build_object(
 'schemaVersion',1,'tenantId',v.tenant_id,'actorId',v.created_by,'quoteId',v.quote_id,
 'versionId',v.id,'versionNumber',v.version_number,'workspaceId',q.workspace_id,
 'marketId',v.market_id,'engineIdentity',v.engine_identity,'input',v.input_snapshot,
 'result',v.output_snapshot,'lines',v.attestation_payload::jsonb->'lines'))
$$;
REVOKE ALL ON FUNCTION authz.quote_snapshot_authentic(uuid) FROM PUBLIC;
CREATE FUNCTION authz.quote_workflow_right(p_quote uuid,p_domain text,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM rpt.cpq_quote q JOIN authz.tenant t ON t.id=q.tenant_id
 WHERE q.tenant_id=authz.tenant_id() AND q.id=p_quote
 AND authz.quote_allowed(q.id,'read')
 AND authz.capable(authz.actor_id(),p_domain,p_verb,'CONFIDENTIAL')
 AND (authz.operational_market()=q.market_id OR authz.market_admin_scope(q.market_id,CASE WHEN p_verb='read' THEN 'read' ELSE 'manage' END))
 AND EXISTS(SELECT 1 FROM authz.workspace_permission w WHERE w.tenant_id=q.tenant_id
 AND w.workspace_id=q.workspace_id AND w.user_id=authz.actor_id() AND w.object_type=p_domain
 AND w.verb=p_verb AND w.field_class='CONFIDENTIAL' AND w.policy_version=t.policy_version
 AND w.revoked_at IS NULL AND tstzrange(w.effective_from,w.effective_to,'[)') @> statement_timestamp()))
$$;
REVOKE ALL ON FUNCTION authz.quote_workflow_right(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.quote_workflow_right(uuid,text,text) TO rpt_runtime;

CREATE TABLE rpt.quote_approval_request (
 tenant_id uuid NOT NULL, id uuid NOT NULL, quote_id uuid NOT NULL, quote_version_id uuid NOT NULL,
 workspace_id uuid NOT NULL, market_id uuid NOT NULL, version_number integer NOT NULL,
 calculation_hash text NOT NULL, attestation_key_id uuid NOT NULL, calculation_attestation text NOT NULL,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT statement_timestamp(), request_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 UNIQUE(tenant_id,quote_version_id),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,quote_version_id),
 FOREIGN KEY(tenant_id,quote_version_id,quote_id) REFERENCES rpt.cpq_quote_version(tenant_id,id,quote_id),
 FOREIGN KEY(tenant_id,quote_id,market_id) REFERENCES rpt.cpq_quote(tenant_id,id,market_id),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,created_by) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,attestation_key_id) REFERENCES authz.quote_calculation_key(tenant_id,id)
);
CREATE INDEX quote_approval_request_history ON rpt.quote_approval_request(tenant_id,quote_id,version_number,id);
ALTER TABLE rpt.quote_approval_request ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON rpt.quote_approval_request FOR EACH ROW EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON rpt.quote_approval_request FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.quote_approval_request FOR EACH ROW EXECUTE FUNCTION authz.audit_change();

CREATE TABLE rpt.quote_approval_decision (
 tenant_id uuid NOT NULL, id uuid NOT NULL, quote_id uuid NOT NULL, quote_version_id uuid NOT NULL,
 workspace_id uuid NOT NULL, market_id uuid NOT NULL, version_number integer NOT NULL,
 calculation_hash text NOT NULL, attestation_key_id uuid NOT NULL, calculation_attestation text NOT NULL,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT statement_timestamp(), request_id uuid NOT NULL,
 approval_request_id uuid NOT NULL, decision text NOT NULL CHECK(decision IN ('approved','rejected')), reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500), authority_policy_version integer NOT NULL,
 UNIQUE(tenant_id,approval_request_id), FOREIGN KEY(tenant_id,approval_request_id,quote_version_id) REFERENCES rpt.quote_approval_request(tenant_id,id,quote_version_id),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,quote_version_id),
 FOREIGN KEY(tenant_id,quote_version_id,quote_id) REFERENCES rpt.cpq_quote_version(tenant_id,id,quote_id),
 FOREIGN KEY(tenant_id,quote_id,market_id) REFERENCES rpt.cpq_quote(tenant_id,id,market_id),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,created_by) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,attestation_key_id) REFERENCES authz.quote_calculation_key(tenant_id,id)
);
CREATE INDEX quote_approval_decision_history ON rpt.quote_approval_decision(tenant_id,quote_id,version_number,id);
ALTER TABLE rpt.quote_approval_decision ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON rpt.quote_approval_decision FOR EACH ROW EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON rpt.quote_approval_decision FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.quote_approval_decision FOR EACH ROW EXECUTE FUNCTION authz.audit_change();

CREATE TABLE rpt.quote_publication (
 tenant_id uuid NOT NULL, id uuid NOT NULL, quote_id uuid NOT NULL, quote_version_id uuid NOT NULL,
 workspace_id uuid NOT NULL, market_id uuid NOT NULL, version_number integer NOT NULL,
 calculation_hash text NOT NULL, attestation_key_id uuid NOT NULL, calculation_attestation text NOT NULL,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT statement_timestamp(), request_id uuid NOT NULL,
 UNIQUE(tenant_id,quote_version_id),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,quote_version_id),
 FOREIGN KEY(tenant_id,quote_version_id,quote_id) REFERENCES rpt.cpq_quote_version(tenant_id,id,quote_id),
 FOREIGN KEY(tenant_id,quote_id,market_id) REFERENCES rpt.cpq_quote(tenant_id,id,market_id),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,created_by) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,attestation_key_id) REFERENCES authz.quote_calculation_key(tenant_id,id)
);
CREATE INDEX quote_publication_history ON rpt.quote_publication(tenant_id,quote_id,version_number,id);
ALTER TABLE rpt.quote_publication ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON rpt.quote_publication FOR EACH ROW EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON rpt.quote_publication FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.quote_publication FOR EACH ROW EXECUTE FUNCTION authz.audit_change();

CREATE TABLE rpt.quote_acceptance (
 tenant_id uuid NOT NULL, id uuid NOT NULL, quote_id uuid NOT NULL, quote_version_id uuid NOT NULL,
 workspace_id uuid NOT NULL, market_id uuid NOT NULL, version_number integer NOT NULL,
 calculation_hash text NOT NULL, attestation_key_id uuid NOT NULL, calculation_attestation text NOT NULL,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT statement_timestamp(), request_id uuid NOT NULL,
 publication_id uuid NOT NULL, person_id uuid, method text NOT NULL CHECK(method IN ('administrative_record','recorded_in_person','recorded_phone','recorded_written')), note text NOT NULL CHECK(length(note) BETWEEN 1 AND 500),
 UNIQUE(tenant_id,quote_id), UNIQUE(tenant_id,quote_version_id), FOREIGN KEY(tenant_id,publication_id,quote_version_id) REFERENCES rpt.quote_publication(tenant_id,id,quote_version_id), FOREIGN KEY(tenant_id,person_id) REFERENCES rpt.person,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,quote_version_id),
 FOREIGN KEY(tenant_id,quote_version_id,quote_id) REFERENCES rpt.cpq_quote_version(tenant_id,id,quote_id),
 FOREIGN KEY(tenant_id,quote_id,market_id) REFERENCES rpt.cpq_quote(tenant_id,id,market_id),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,created_by) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,attestation_key_id) REFERENCES authz.quote_calculation_key(tenant_id,id)
);
CREATE INDEX quote_acceptance_history ON rpt.quote_acceptance(tenant_id,quote_id,version_number,id);
ALTER TABLE rpt.quote_acceptance ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON rpt.quote_acceptance FOR EACH ROW EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON rpt.quote_acceptance FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.quote_acceptance FOR EACH ROW EXECUTE FUNCTION authz.audit_change();

CREATE TABLE rpt.cpq_order (
 tenant_id uuid NOT NULL, id uuid NOT NULL, quote_id uuid NOT NULL, quote_version_id uuid NOT NULL,
 workspace_id uuid NOT NULL, market_id uuid NOT NULL, version_number integer NOT NULL,
 calculation_hash text NOT NULL, attestation_key_id uuid NOT NULL, calculation_attestation text NOT NULL,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT statement_timestamp(), request_id uuid NOT NULL,
 acceptance_id uuid NOT NULL, person_id uuid, currency text NOT NULL, commercial_snapshot jsonb NOT NULL, status text NOT NULL DEFAULT 'created' CHECK(status='created'),
 UNIQUE(tenant_id,quote_version_id), FOREIGN KEY(tenant_id,acceptance_id,quote_version_id) REFERENCES rpt.quote_acceptance(tenant_id,id,quote_version_id), FOREIGN KEY(tenant_id,person_id) REFERENCES rpt.person,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,quote_version_id),
 FOREIGN KEY(tenant_id,quote_version_id,quote_id) REFERENCES rpt.cpq_quote_version(tenant_id,id,quote_id),
 FOREIGN KEY(tenant_id,quote_id,market_id) REFERENCES rpt.cpq_quote(tenant_id,id,market_id),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,created_by) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,attestation_key_id) REFERENCES authz.quote_calculation_key(tenant_id,id)
);
CREATE INDEX cpq_order_history ON rpt.cpq_order(tenant_id,quote_id,version_number,id);
ALTER TABLE rpt.cpq_order ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON rpt.cpq_order FOR EACH ROW EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON rpt.cpq_order FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.cpq_order FOR EACH ROW EXECUTE FUNCTION authz.audit_change();

-- Completed decisions remain valid historical authorizations after later grant revocation.
-- Their insert-time guard establishes authority; new decisions always evaluate fresh grants.
CREATE FUNCTION authz.quote_publishable(p_version uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM rpt.cpq_quote_version v JOIN rpt.cpq_quote q ON q.tenant_id=v.tenant_id AND q.id=v.quote_id
 WHERE v.tenant_id=authz.tenant_id() AND v.id=p_version AND q.current_version_number=v.version_number
 AND authz.quote_snapshot_authentic(v.id) AND v.output_snapshot#>>'{totals,grandTotal}' IS NOT NULL
 AND ((v.output_snapshot->>'status'='final' AND v.output_snapshot->>'requiresApproval'='false')
 OR (v.output_snapshot->>'status'='requires_approval' AND v.output_snapshot->>'requiresApproval'='true'
 AND EXISTS(SELECT 1 FROM rpt.quote_approval_request r JOIN rpt.quote_approval_decision d
 ON d.tenant_id=r.tenant_id AND d.approval_request_id=r.id AND d.quote_version_id=r.quote_version_id
 WHERE r.tenant_id=v.tenant_id AND r.quote_version_id=v.id AND r.quote_id=v.quote_id
 AND r.workspace_id=q.workspace_id AND r.market_id=v.market_id AND r.version_number=v.version_number
 AND r.calculation_hash=v.calculation_hash AND r.attestation_key_id=v.attestation_key_id
 AND r.calculation_attestation=v.calculation_attestation AND d.decision='approved'))))
$$;
REVOKE ALL ON FUNCTION authz.quote_publishable(uuid) FROM PUBLIC;
CREATE OR REPLACE FUNCTION authz.quote_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v rpt.cpq_quote_version%ROWTYPE; action text;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.tenant_id<>authz.tenant_id() OR NEW.owner_id<>authz.actor_id() OR NEW.status<>'draft'
   OR NEW.version<>0 OR NEW.current_version_number<>0
   OR NOT authz.quote_workspace_right(NEW.workspace_id,NEW.market_id,'create')
   OR NOT EXISTS(SELECT 1 FROM rpt.catalog_market WHERE tenant_id=NEW.tenant_id AND market_id=NEW.market_id AND status='active')
   OR (NEW.person_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rpt.person p WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.person_id
    AND p.workspace_id=NEW.workspace_id AND authz.allowed('person',p.id,'read','CONFIDENTIAL')))
  THEN RAISE EXCEPTION 'invalid_quote_creation' USING ERRCODE='42501'; END IF;
  NEW.created_at:=clock_timestamp();
 ELSE
  IF (NEW.tenant_id,NEW.id,NEW.workspace_id,NEW.market_id,NEW.person_id,NEW.owner_id,NEW.valid_until,NEW.created_at)
    IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.workspace_id,OLD.market_id,OLD.person_id,OLD.owner_id,OLD.valid_until,OLD.created_at)
    OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'immutable_quote_identity' USING ERRCODE='23514'; END IF;
  IF NEW.current_version_number=OLD.current_version_number+1 THEN
   SELECT * INTO v FROM rpt.cpq_quote_version WHERE tenant_id=OLD.tenant_id AND quote_id=OLD.id AND version_number=NEW.current_version_number;
   IF NOT FOUND OR OLD.status NOT IN ('draft','issued') OR NEW.status<>'draft'
    OR NOT authz.quote_allowed(OLD.id,CASE WHEN OLD.current_version_number=0 THEN 'create' ELSE 'revise' END)
   THEN RAISE EXCEPTION 'invalid_quote_revision' USING ERRCODE='23514'; END IF;
  ELSE
   action:=CASE NEW.status WHEN 'issued' THEN 'issue' WHEN 'accepted' THEN 'accept' WHEN 'rejected' THEN 'reject'
    WHEN 'expired' THEN 'expire' WHEN 'cancelled' THEN 'cancel' ELSE NULL END;
   IF NEW.current_version_number<>OLD.current_version_number OR action IS NULL OR NOT authz.quote_allowed(OLD.id,action)
    OR NOT ((OLD.status='draft' AND NEW.status='issued') OR (OLD.status='issued' AND NEW.status IN ('accepted','rejected'))
      OR (OLD.status IN ('draft','issued') AND NEW.status IN ('expired','cancelled')))
   THEN RAISE EXCEPTION 'invalid_quote_transition' USING ERRCODE='23514'; END IF;
   SELECT * INTO v FROM rpt.cpq_quote_version WHERE tenant_id=OLD.tenant_id AND quote_id=OLD.id AND version_number=OLD.current_version_number;
   IF NOT FOUND THEN RAISE EXCEPTION 'missing_current_quote_version' USING ERRCODE='23514'; END IF;
   IF NEW.status IN ('issued','accepted') AND NOT authz.quote_publishable(v.id)
   THEN RAISE EXCEPTION 'quote_not_publishable' USING ERRCODE='23514'; END IF;
   IF NEW.status IN ('issued','accepted') AND OLD.valid_until IS NOT NULL AND OLD.valid_until<=statement_timestamp()
   THEN RAISE EXCEPTION 'quote_deadline_passed' USING ERRCODE='23514'; END IF;
   IF NEW.status='expired' AND (OLD.valid_until IS NULL OR OLD.valid_until>statement_timestamp())
   THEN RAISE EXCEPTION 'quote_not_expired' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 NEW.updated_at:=clock_timestamp(); RETURN NEW;
END $$;

-- Bind every artifact to the exact authenticated immutable version, never a hash alone.
CREATE FUNCTION authz.quote_workflow_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q rpt.cpq_quote%ROWTYPE; v rpt.cpq_quote_version%ROWTYPE; r rpt.quote_approval_request%ROWTYPE;
 a rpt.quote_acceptance%ROWTYPE; p rpt.quote_publication%ROWTYPE; expected jsonb; k text;
BEGIN
 SELECT * INTO v FROM rpt.cpq_quote_version WHERE tenant_id=NEW.tenant_id AND id=NEW.quote_version_id;
 IF NOT FOUND OR NEW.tenant_id IS DISTINCT FROM authz.tenant_id() THEN RAISE EXCEPTION 'invalid_workflow_version' USING ERRCODE='42501'; END IF;
 SELECT * INTO q FROM rpt.cpq_quote WHERE tenant_id=v.tenant_id AND id=v.quote_id FOR UPDATE;
 IF NOT authz.quote_snapshot_authentic(v.id) OR q.current_version_number<>v.version_number THEN
 RAISE EXCEPTION 'stale_or_inauthentic_workflow_version' USING ERRCODE='23514'; END IF;
 expected:=jsonb_build_object('quote_id',q.id,'workspace_id',q.workspace_id,'market_id',v.market_id,
 'version_number',v.version_number,'calculation_hash',v.calculation_hash,'attestation_key_id',v.attestation_key_id,
 'calculation_attestation',v.calculation_attestation,'created_by',authz.actor_id(),
 'request_id',nullif(current_setting('rpt.request_id',true),'')::uuid);
 FOR k IN SELECT jsonb_object_keys(expected) LOOP
  IF to_jsonb(NEW)->k <> 'null'::jsonb AND to_jsonb(NEW)->k IS DISTINCT FROM expected->k THEN
   RAISE EXCEPTION 'workflow_context_substitution' USING ERRCODE='23514'; END IF;
 END LOOP;
 NEW:=jsonb_populate_record(NEW,expected); NEW.created_at:=statement_timestamp();
 IF TG_TABLE_NAME='quote_approval_request' THEN
  IF NOT authz.quote_workflow_right(q.id,'quote_approval','request') OR q.status<>'draft'
  OR v.output_snapshot->>'status'<>'requires_approval' OR v.output_snapshot->>'requiresApproval'<>'true'
  THEN RAISE EXCEPTION 'approval_request_denied' USING ERRCODE='42501'; END IF;
 ELSIF TG_TABLE_NAME='quote_approval_decision' THEN
  SELECT * INTO r FROM rpt.quote_approval_request WHERE tenant_id=NEW.tenant_id AND id=NEW.approval_request_id;
  IF NOT FOUND OR r.quote_version_id<>v.id OR q.status<>'draft'
  OR NOT authz.quote_workflow_right(q.id,'quote_approval','decide')
  OR authz.actor_id() IN (r.created_by,q.owner_id,v.created_by)
  THEN RAISE EXCEPTION 'approval_decision_denied' USING ERRCODE='42501'; END IF;
  NEW.authority_policy_version:=(SELECT policy_version FROM authz.tenant WHERE id=NEW.tenant_id);
 ELSIF TG_TABLE_NAME='quote_acceptance' THEN
  SELECT * INTO p FROM rpt.quote_publication WHERE tenant_id=NEW.tenant_id AND id=NEW.publication_id;
  IF NOT FOUND OR p.quote_version_id<>v.id OR q.status<>'issued' OR NOT authz.quote_allowed(q.id,'accept')
   OR NOT authz.quote_publishable(v.id) OR (q.valid_until IS NOT NULL AND q.valid_until<=statement_timestamp())
   OR NEW.person_id IS DISTINCT FROM q.person_id
  THEN RAISE EXCEPTION 'quote_acceptance_denied' USING ERRCODE='42501'; END IF;
 ELSIF TG_TABLE_NAME='cpq_order' THEN
  SELECT * INTO a FROM rpt.quote_acceptance WHERE tenant_id=NEW.tenant_id AND id=NEW.acceptance_id;
  IF NOT FOUND OR a.quote_version_id<>v.id OR q.status<>'accepted'
   OR NOT authz.quote_workflow_right(q.id,'cpq_order','create') OR NOT authz.quote_publishable(v.id)
   OR NEW.person_id IS DISTINCT FROM a.person_id OR NEW.currency IS DISTINCT FROM v.currency
   OR NEW.commercial_snapshot IS DISTINCT FROM v.output_snapshot
  THEN RAISE EXCEPTION 'order_conversion_denied' USING ERRCODE='42501'; END IF;
 ELSE RAISE EXCEPTION 'unsupported_workflow_artifact' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION authz.quote_workflow_guard() FROM PUBLIC;
CREATE TRIGGER workflow_guard BEFORE INSERT ON rpt.quote_approval_request FOR EACH ROW EXECUTE FUNCTION authz.quote_workflow_guard();
CREATE TRIGGER workflow_guard BEFORE INSERT ON rpt.quote_approval_decision FOR EACH ROW EXECUTE FUNCTION authz.quote_workflow_guard();
CREATE TRIGGER workflow_guard BEFORE INSERT ON rpt.quote_acceptance FOR EACH ROW EXECUTE FUNCTION authz.quote_workflow_guard();
CREATE TRIGGER workflow_guard BEFORE INSERT ON rpt.cpq_order FOR EACH ROW EXECUTE FUNCTION authz.quote_workflow_guard();

CREATE FUNCTION authz.quote_publication_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v rpt.cpq_quote_version%ROWTYPE;
BEGIN
 IF NEW.status='issued' AND OLD.status='draft' THEN
 SELECT * INTO v FROM rpt.cpq_quote_version WHERE tenant_id=NEW.tenant_id AND quote_id=NEW.id AND version_number=NEW.current_version_number;
 INSERT INTO rpt.quote_publication(tenant_id,id,quote_id,quote_version_id,workspace_id,market_id,version_number,
 calculation_hash,attestation_key_id,calculation_attestation,created_by,request_id)
 VALUES(NEW.tenant_id,extensions.gen_random_uuid(),NEW.id,v.id,NEW.workspace_id,NEW.market_id,v.version_number,
 v.calculation_hash,v.attestation_key_id,v.calculation_attestation,authz.actor_id(),nullif(current_setting('rpt.request_id',true),'')::uuid);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quote_publication_record AFTER UPDATE ON rpt.cpq_quote FOR EACH ROW EXECUTE FUNCTION authz.quote_publication_record();
CREATE FUNCTION authz.quote_acceptance_advance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE rpt.cpq_quote SET status='accepted',version=version+1 WHERE tenant_id=NEW.tenant_id AND id=NEW.quote_id;
 RETURN NEW;
END $$;
CREATE TRIGGER quote_acceptance_advance AFTER INSERT ON rpt.quote_acceptance FOR EACH ROW EXECUTE FUNCTION authz.quote_acceptance_advance();
CREATE FUNCTION authz.quote_acceptance_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.status='accepted' AND NOT EXISTS(SELECT 1 FROM rpt.quote_acceptance a JOIN rpt.cpq_quote_version v
 ON v.tenant_id=a.tenant_id AND v.id=a.quote_version_id WHERE a.tenant_id=NEW.tenant_id
 AND a.quote_id=NEW.id AND v.version_number=NEW.current_version_number)
 THEN RAISE EXCEPTION 'missing_exact_quote_acceptance' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER quote_acceptance_complete AFTER UPDATE ON rpt.cpq_quote DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION authz.quote_acceptance_complete();
REVOKE ALL ON FUNCTION authz.quote_publication_record(),authz.quote_acceptance_advance(),authz.quote_acceptance_complete() FROM PUBLIC;

CREATE POLICY approval_request_read ON rpt.quote_approval_request FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.quote_workflow_right(quote_id,'quote_approval','read'));
CREATE POLICY approval_request_create ON rpt.quote_approval_request FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.quote_workflow_right(quote_id,'quote_approval','request'));
CREATE POLICY approval_decision_read ON rpt.quote_approval_decision FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.quote_workflow_right(quote_id,'quote_approval','read'));
CREATE POLICY approval_decision_create ON rpt.quote_approval_decision FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.quote_workflow_right(quote_id,'quote_approval','decide'));
CREATE POLICY publication_read ON rpt.quote_publication FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.quote_allowed(quote_id,'read'));
CREATE POLICY acceptance_read ON rpt.quote_acceptance FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.quote_allowed(quote_id,'read'));
CREATE POLICY acceptance_create ON rpt.quote_acceptance FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.quote_allowed(quote_id,'accept'));
CREATE POLICY order_read ON rpt.cpq_order FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.quote_workflow_right(quote_id,'cpq_order','read'));
CREATE POLICY order_create ON rpt.cpq_order FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.quote_workflow_right(quote_id,'cpq_order','create'));
GRANT SELECT,INSERT ON rpt.quote_approval_request,rpt.quote_approval_decision,rpt.quote_acceptance,rpt.cpq_order TO rpt_runtime;
GRANT SELECT ON rpt.quote_publication TO rpt_runtime;

CREATE FUNCTION authz.quote_workflow_receipt(p_operation text,p_key text,p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r authz.idempotency_receipt%ROWTYPE; domain text; verb text;
BEGIN
 domain:=CASE WHEN p_operation IN ('request','decide') THEN 'quote_approval' WHEN p_operation='order' THEN 'cpq_order' ELSE 'cpq_quote' END;
 verb:=CASE p_operation WHEN 'request' THEN 'request' WHEN 'decide' THEN 'decide' WHEN 'accept' THEN 'accept' WHEN 'order' THEN 'create' END;
 IF NOT authz.session_valid() OR verb IS NULL OR length(p_key) NOT BETWEEN 8 AND 128 OR p_hash !~ '^[a-f0-9]{64}$'
 OR NOT authz.capable(authz.actor_id(),domain,verb,'CONFIDENTIAL') THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||'/quote_workflow.'||p_operation||'/'||p_key,0));
 SELECT * INTO r FROM authz.idempotency_receipt WHERE tenant_id=authz.tenant_id() AND operation='quote_workflow.'||p_operation AND key=p_key;
 IF FOUND THEN
 IF r.actor_id<>authz.actor_id() OR r.request_hash<>p_hash THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
 RETURN r.response;
 END IF;
 INSERT INTO authz.idempotency_receipt(tenant_id,operation,key,actor_id,request_hash)
 VALUES(authz.tenant_id(),'quote_workflow.'||p_operation,p_key,authz.actor_id(),p_hash);
 RETURN NULL;
END $$;
CREATE FUNCTION authz.quote_workflow_finish(p_operation text,p_key text,p_response jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR p_operation NOT IN ('request','decide','accept','order') OR pg_column_size(p_response)>2048
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 UPDATE authz.idempotency_receipt SET response=p_response WHERE tenant_id=authz.tenant_id()
 AND operation='quote_workflow.'||p_operation AND key=p_key AND actor_id=authz.actor_id() AND response IS NULL;
END $$;
REVOKE ALL ON FUNCTION authz.quote_workflow_receipt(text,text,text),authz.quote_workflow_finish(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.quote_workflow_receipt(text,text,text),authz.quote_workflow_finish(text,text,jsonb) TO rpt_runtime;
-- Typed workflow evidence extends SourceObservation, never authorizes by an untyped UUID.
ALTER TABLE rpt.source_observation ADD COLUMN workflow_subject_type text;
ALTER TABLE rpt.source_observation ADD CONSTRAINT workflow_subject_type_check CHECK(
 (domain_key='quote_workflow' AND workflow_subject_type IS NOT NULL AND workflow_subject_type IN ('approval_request','approval_decision','acceptance','order'))
 OR (domain_key<>'quote_workflow' AND workflow_subject_type IS NULL));
CREATE FUNCTION authz.quote_workflow_subject(p_id uuid,p_type text,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE p_type
 WHEN 'approval_request' THEN EXISTS(SELECT 1 FROM rpt.quote_approval_request r WHERE r.tenant_id=authz.tenant_id() AND r.id=p_id AND authz.quote_workflow_right(r.quote_id,'quote_approval',CASE WHEN p_verb='read' THEN 'read' ELSE 'request' END))
 WHEN 'approval_decision' THEN EXISTS(SELECT 1 FROM rpt.quote_approval_decision r WHERE r.tenant_id=authz.tenant_id() AND r.id=p_id AND authz.quote_workflow_right(r.quote_id,'quote_approval',CASE WHEN p_verb='read' THEN 'read' ELSE 'decide' END))
 WHEN 'acceptance' THEN EXISTS(SELECT 1 FROM rpt.quote_acceptance r WHERE r.tenant_id=authz.tenant_id() AND r.id=p_id AND authz.quote_allowed(r.quote_id,CASE WHEN p_verb='read' THEN 'read' ELSE 'accept' END))
 WHEN 'order' THEN EXISTS(SELECT 1 FROM rpt.cpq_order r WHERE r.tenant_id=authz.tenant_id() AND r.id=p_id AND authz.quote_workflow_right(r.quote_id,'cpq_order',CASE WHEN p_verb='read' THEN 'read' ELSE 'create' END))
 ELSE false END
$$;
CREATE FUNCTION authz.quote_workflow_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.domain_key='quote_workflow' AND NOT authz.quote_workflow_subject(NEW.subject_id,NEW.workflow_subject_type,'append')
 THEN RAISE EXCEPTION 'invalid_workflow_subject' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_source_guard BEFORE INSERT ON rpt.source_observation FOR EACH ROW EXECUTE FUNCTION authz.quote_workflow_source_guard();
CREATE POLICY workflow_source_boundary ON rpt.source_observation AS RESTRICTIVE FOR ALL TO rpt_runtime
 USING(domain_key<>'quote_workflow' OR authz.quote_workflow_subject(subject_id,workflow_subject_type,'read'))
 WITH CHECK(domain_key<>'quote_workflow' OR authz.quote_workflow_subject(subject_id,workflow_subject_type,'append'));
CREATE POLICY workflow_source_read ON rpt.source_observation FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND domain_key='quote_workflow' AND authz.quote_workflow_subject(subject_id,workflow_subject_type,'read'));
CREATE FUNCTION authz.quote_workflow_source_authority(p_system text,p_authority text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND EXISTS(SELECT 1 FROM authz.source_authority a WHERE a.tenant_id=authz.tenant_id()
 AND a.user_id=authz.actor_id() AND a.domain_key='quote_workflow' AND a.source_system=p_system
 AND a.authority_level=p_authority AND a.revoked_at IS NULL)
$$;
CREATE POLICY workflow_source_insert ON rpt.source_observation FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id() AND domain_key='quote_workflow'
 AND authz.quote_workflow_subject(subject_id,workflow_subject_type,'append')
 AND authz.quote_workflow_source_authority(source_system,authority_level));
REVOKE ALL ON FUNCTION authz.quote_workflow_subject(uuid,text,text),authz.quote_workflow_source_guard(),authz.quote_workflow_source_authority(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.quote_workflow_subject(uuid,text,text),authz.quote_workflow_source_authority(text,text) TO rpt_runtime;
