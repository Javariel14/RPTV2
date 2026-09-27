SET LOCAL ROLE rpt_owner;
-- Deployment-provisioned secrets, never readable/writable by runtime identities.
-- Retain old keys for history; active controls authentication of NEW snapshots only.
CREATE TABLE authz.quote_calculation_key (
 tenant_id uuid NOT NULL REFERENCES authz.tenant, id uuid NOT NULL,
 secret bytea NOT NULL CHECK(octet_length(secret) BETWEEN 32 AND 64),
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id)
);
ALTER TABLE authz.quote_calculation_key ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON authz.quote_calculation_key FROM PUBLIC,rpt_runtime;
-- E3B2: separate from the historical CRM simulation quote_version.
CREATE TABLE rpt.cpq_quote (
 tenant_id uuid NOT NULL, id uuid NOT NULL, workspace_id uuid NOT NULL,
 market_id uuid NOT NULL, person_id uuid, owner_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued','accepted','rejected','expired','cancelled')),
 current_version_number integer NOT NULL DEFAULT 0 CHECK(current_version_number>=0),
 version integer NOT NULL DEFAULT 0 CHECK(version>=0), valid_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,market_id),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,market_id) REFERENCES rpt.catalog_market,
 FOREIGN KEY(tenant_id,person_id) REFERENCES rpt.person,
 FOREIGN KEY(tenant_id,owner_id) REFERENCES authz.user_account
);
CREATE TABLE rpt.cpq_quote_version (
 tenant_id uuid NOT NULL, id uuid NOT NULL, quote_id uuid NOT NULL, market_id uuid NOT NULL,
 version_number integer NOT NULL CHECK(version_number>0), currency text NOT NULL,
 price_list_id uuid NOT NULL, price_list_version integer NOT NULL CHECK(price_list_version>0),
 calculation_hash text NOT NULL CHECK(calculation_hash ~ '^[a-f0-9]{64}$'),
 engine_identity text NOT NULL CHECK(engine_identity='E3B1/v1'),
 input_snapshot jsonb NOT NULL, output_snapshot jsonb NOT NULL,
 attestation_key_id uuid NOT NULL, attestation_payload text NOT NULL CHECK(octet_length(attestation_payload)<=2097152),
 calculation_attestation text NOT NULL CHECK(calculation_attestation ~ '^[a-f0-9]{64}$'),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,quote_id,version_number),
 UNIQUE(tenant_id,id,quote_id),
 FOREIGN KEY(tenant_id,quote_id,market_id) REFERENCES rpt.cpq_quote(tenant_id,id,market_id),
 FOREIGN KEY(tenant_id,price_list_id,market_id,currency) REFERENCES rpt.price_list(tenant_id,id,market_id,currency),
 FOREIGN KEY(tenant_id,created_by) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,attestation_key_id) REFERENCES authz.quote_calculation_key(tenant_id,id),
 CHECK(jsonb_typeof(input_snapshot)='object' AND jsonb_typeof(output_snapshot)='object'),
 CHECK(input_snapshot ?& ARRAY['schemaVersion','asOf','priceListId','lines']),
 CHECK(output_snapshot ?& ARRAY['schemaVersion','status','requiresApproval','effectiveMarketId','asOf','priceListId','priceListVersion','currency','minorUnits','roundingPolicy','lines','appliedRules','totals','calculationHash']),
 CHECK(pg_column_size(input_snapshot)<=262144 AND pg_column_size(output_snapshot)<=1048576),
 CHECK(output_snapshot->>'schemaVersion'='1' AND input_snapshot->>'schemaVersion'='1'),
 CHECK(output_snapshot->>'effectiveMarketId'=market_id::text AND output_snapshot->>'currency'=currency),
 CHECK(output_snapshot->>'priceListId'=price_list_id::text AND output_snapshot->>'priceListVersion'=price_list_version::text),
 CHECK(output_snapshot->>'calculationHash'=calculation_hash),
 CHECK(input_snapshot->>'priceListId'=price_list_id::text AND (input_snapshot->>'asOf')::timestamptz=(output_snapshot->>'asOf')::timestamptz),
 CHECK(output_snapshot->>'status' IN ('final','requires_approval','incomplete_tax_semantics') AND jsonb_typeof(output_snapshot->'requiresApproval')='boolean'),
 CHECK(output_snapshot->>'roundingPolicy'='ROUND_HALF_UP'),
 CHECK(jsonb_typeof(output_snapshot->'lines')='array' AND jsonb_array_length(output_snapshot->'lines') BETWEEN 1 AND 250)
);
CREATE TABLE rpt.cpq_quote_line (
 tenant_id uuid NOT NULL, id uuid NOT NULL, quote_id uuid NOT NULL, quote_version_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 250), snapshot jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,quote_version_id,ordinal),
 FOREIGN KEY(tenant_id,quote_version_id,quote_id) REFERENCES rpt.cpq_quote_version(tenant_id,id,quote_id),
 CHECK(jsonb_typeof(snapshot)='object' AND pg_column_size(snapshot)<=65536)
);
CREATE INDEX cpq_quote_workspace ON rpt.cpq_quote(tenant_id,workspace_id,market_id,created_at,id);

CREATE FUNCTION authz.quote_workspace_right(p_workspace uuid,p_market uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND authz.capable(authz.actor_id(),'cpq_quote',p_verb,'CONFIDENTIAL')
 AND (authz.operational_market()=p_market OR authz.market_admin_scope(p_market,CASE WHEN p_verb='read' THEN 'read' ELSE 'manage' END))
 AND EXISTS(SELECT 1 FROM authz.workspace_permission w JOIN authz.tenant t ON t.id=w.tenant_id
 WHERE w.tenant_id=authz.tenant_id() AND w.workspace_id=p_workspace AND w.user_id=authz.actor_id()
 AND w.object_type='cpq_quote' AND w.verb=p_verb AND w.field_class='CONFIDENTIAL'
 AND w.policy_version=t.policy_version AND w.revoked_at IS NULL
 AND tstzrange(w.effective_from,w.effective_to,'[)') @> statement_timestamp())
$$;
CREATE FUNCTION authz.quote_allowed(p_quote uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM rpt.cpq_quote q WHERE q.tenant_id=authz.tenant_id() AND q.id=p_quote
 AND authz.quote_workspace_right(q.workspace_id,q.market_id,p_verb)
 AND authz.allowed('cpq_quote',q.id,p_verb,'CONFIDENTIAL'))
$$;
CREATE FUNCTION authz.quote_projection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO authz.object_access(tenant_id,object_type,object_id,workspace_id,owner_id)
 VALUES(NEW.tenant_id,'cpq_quote',NEW.id,NEW.workspace_id,NEW.owner_id);
 INSERT INTO authz.ownership_history(tenant_id,object_type,object_id,workspace_id,owner_id)
 VALUES(NEW.tenant_id,'cpq_quote',NEW.id,NEW.workspace_id,NEW.owner_id);
 RETURN NEW;
END $$;
CREATE TRIGGER quote_projection AFTER INSERT ON rpt.cpq_quote FOR EACH ROW EXECUTE FUNCTION authz.quote_projection();

CREATE FUNCTION authz.quote_guard() RETURNS trigger
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
   IF NEW.status='issued' AND (v.output_snapshot->>'status' IS DISTINCT FROM 'final'
    OR v.output_snapshot->>'requiresApproval' IS DISTINCT FROM 'false' OR v.output_snapshot#>>'{totals,grandTotal}' IS NULL)
   THEN RAISE EXCEPTION 'quote_not_publishable' USING ERRCODE='23514'; END IF;
   IF NEW.status IN ('issued','accepted') AND OLD.valid_until IS NOT NULL AND OLD.valid_until<=statement_timestamp()
   THEN RAISE EXCEPTION 'quote_deadline_passed' USING ERRCODE='23514'; END IF;
   IF NEW.status='expired' AND (OLD.valid_until IS NULL OR OLD.valid_until>statement_timestamp())
   THEN RAISE EXCEPTION 'quote_not_expired' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 NEW.updated_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER quote_guard BEFORE INSERT OR UPDATE ON rpt.cpq_quote FOR EACH ROW EXECUTE FUNCTION authz.quote_guard();
CREATE FUNCTION authz.quote_version_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q rpt.cpq_quote%ROWTYPE; envelope jsonb; signing_key bytea;
BEGIN
 SELECT * INTO q FROM rpt.cpq_quote WHERE tenant_id=NEW.tenant_id AND id=NEW.quote_id FOR UPDATE;
 IF NOT FOUND OR q.status NOT IN ('draft','issued') OR NEW.created_by<>authz.actor_id()
 OR NEW.version_number<>q.current_version_number+1
 OR NOT authz.quote_allowed(q.id,CASE WHEN q.current_version_number=0 THEN 'create' ELSE 'revise' END)
 OR NOT authz.pricing_allowed(NEW.price_list_id,'read')
 OR NOT EXISTS(SELECT 1 FROM rpt.price_list p WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.price_list_id AND p.status='active'
 AND tstzrange(p.valid_from,p.valid_to,'[)') @> (NEW.output_snapshot->>'asOf')::timestamptz AND p.version=NEW.price_list_version)
 THEN RAISE EXCEPTION 'invalid_quote_version' USING ERRCODE='42501'; END IF;
 IF NEW.output_snapshot->>'effectiveMarketId' IS DISTINCT FROM NEW.market_id::text
 OR NEW.output_snapshot->>'currency' IS DISTINCT FROM NEW.currency
 OR NEW.output_snapshot->>'priceListId' IS DISTINCT FROM NEW.price_list_id::text
 OR NEW.output_snapshot->>'priceListVersion' IS DISTINCT FROM NEW.price_list_version::text
 OR NEW.output_snapshot->>'calculationHash' IS DISTINCT FROM NEW.calculation_hash
 OR NEW.input_snapshot->>'priceListId' IS DISTINCT FROM NEW.price_list_id::text
 OR NEW.output_snapshot->>'schemaVersion' IS DISTINCT FROM '1'
 OR NEW.input_snapshot->>'schemaVersion' IS DISTINCT FROM '1'
 OR NEW.output_snapshot->>'roundingPolicy' IS DISTINCT FROM 'ROUND_HALF_UP'
 OR jsonb_typeof(NEW.output_snapshot->'totals') IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'invalid_quote_snapshot_identity' USING ERRCODE='23514'; END IF;
 -- Authenticate the exact server-resolved result, NOT a caller's duplicated flag/hash string.
 -- No runtime signing oracle: this trigger can only verify, and secrets have no runtime grants.
 SELECT secret INTO signing_key FROM authz.quote_calculation_key
 WHERE tenant_id=NEW.tenant_id AND id=NEW.attestation_key_id AND active;
 IF NOT FOUND OR NEW.tenant_id IS DISTINCT FROM authz.tenant_id()
 OR NEW.calculation_attestation IS DISTINCT FROM encode(extensions.hmac(convert_to(NEW.attestation_payload,'UTF8'),signing_key,'sha256'),'hex')
 THEN RAISE EXCEPTION 'unauthenticated_quote_calculation' USING ERRCODE='23514'; END IF;
 envelope:=NEW.attestation_payload::jsonb;
 IF jsonb_typeof(envelope) IS DISTINCT FROM 'object'
 OR envelope IS DISTINCT FROM jsonb_build_object(
  'schemaVersion',1,'tenantId',NEW.tenant_id,'actorId',NEW.created_by,
  'quoteId',NEW.quote_id,'versionId',NEW.id,'versionNumber',NEW.version_number,
  'workspaceId',q.workspace_id,'marketId',NEW.market_id,'engineIdentity',NEW.engine_identity,
  'input',NEW.input_snapshot,'result',NEW.output_snapshot,'lines',envelope->'lines')
 OR jsonb_typeof(envelope->'lines') IS DISTINCT FROM 'array'
 OR jsonb_array_length(envelope->'lines')<>jsonb_array_length(NEW.output_snapshot->'lines')
 OR (NEW.output_snapshot->>'status'='final' AND
     (NEW.output_snapshot->>'requiresApproval' IS DISTINCT FROM 'false' OR NEW.output_snapshot#>>'{totals,grandTotal}' IS NULL))
 OR (NEW.output_snapshot->>'status'='requires_approval' AND NEW.output_snapshot->>'requiresApproval' IS DISTINCT FROM 'true')
 OR (NEW.output_snapshot->>'status'='incomplete_tax_semantics' AND NEW.output_snapshot#>>'{totals,grandTotal}' IS NOT NULL)
 THEN RAISE EXCEPTION 'inconsistent_authenticated_quote_snapshot' USING ERRCODE='23514'; END IF;
 NEW.created_at:=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER quote_version_guard BEFORE INSERT ON rpt.cpq_quote_version FOR EACH ROW EXECUTE FUNCTION authz.quote_version_guard();
CREATE FUNCTION authz.quote_advance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE rpt.cpq_quote SET current_version_number=NEW.version_number,version=version+1,status='draft'
 WHERE tenant_id=NEW.tenant_id AND id=NEW.quote_id;
 RETURN NEW;
END $$;
CREATE TRIGGER quote_advance AFTER INSERT ON rpt.cpq_quote_version FOR EACH ROW EXECUTE FUNCTION authz.quote_advance();
CREATE FUNCTION authz.quote_line_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v rpt.cpq_quote_version%ROWTYPE; mp uuid; entry uuid;
BEGIN
 SELECT * INTO v FROM rpt.cpq_quote_version WHERE tenant_id=NEW.tenant_id AND id=NEW.quote_version_id AND quote_id=NEW.quote_id;
 mp:=(NEW.snapshot#>>'{commercial,marketProductId}')::uuid; entry:=(NEW.snapshot#>>'{commercial,entryId}')::uuid;
 IF NOT FOUND OR NEW.ordinal>jsonb_array_length(v.output_snapshot->'lines')
 OR NOT (NEW.snapshot ?& ARRAY['commercial','catalog','source','bundleComposition'])
 OR NEW.snapshot->'commercial' IS DISTINCT FROM v.output_snapshot->'lines'->(NEW.ordinal-1)
 OR NEW.snapshot IS DISTINCT FROM v.attestation_payload::jsonb->'lines'->(NEW.ordinal-1)
 OR NEW.snapshot#>>'{catalog,marketProductId}' IS DISTINCT FROM mp::text
 OR NEW.snapshot#>>'{catalog,marketId}' IS DISTINCT FROM v.market_id::text
 OR NOT EXISTS(SELECT 1 FROM rpt.price_list_entry e WHERE e.tenant_id=NEW.tenant_id AND e.id=entry
 AND e.price_list_id=v.price_list_id AND e.market_product_id=mp AND e.market_id=v.market_id
 AND e.observation_id::text=NEW.snapshot#>>'{source,observationId}'
 AND e.source_literal=NEW.snapshot#>>'{source,sourceLiteral}'
 AND e.amount=(NEW.snapshot#>>'{commercial,unitPrice}')::numeric
 AND e.tax_treatment=NEW.snapshot#>>'{commercial,taxTreatment}'
 AND e.tax_rate IS NOT DISTINCT FROM (NEW.snapshot#>>'{commercial,taxRate}')::numeric)
 OR NOT EXISTS(SELECT 1 FROM rpt.market_product m WHERE m.tenant_id=NEW.tenant_id AND m.id=mp AND m.market_id=v.market_id
 AND m.node_id::text=NEW.snapshot#>>'{catalog,nodeId}' AND m.display_name=NEW.snapshot#>>'{catalog,displayName}'
 AND m.commercial_code=NEW.snapshot#>>'{catalog,commercialCode}')
 THEN RAISE EXCEPTION 'invalid_quote_line' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quote_line_guard BEFORE INSERT ON rpt.cpq_quote_line FOR EACH ROW EXECUTE FUNCTION authz.quote_line_guard();
CREATE FUNCTION authz.quote_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE qid uuid; q rpt.cpq_quote%ROWTYPE; v rpt.cpq_quote_version%ROWTYPE;
BEGIN
 qid:=(CASE WHEN TG_TABLE_NAME='cpq_quote' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'quote_id' END)::uuid;
 SELECT * INTO q FROM rpt.cpq_quote WHERE tenant_id=NEW.tenant_id AND id=qid;
 IF TG_TABLE_NAME='cpq_quote_version' THEN
  SELECT * INTO v FROM rpt.cpq_quote_version WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
 ELSE
  SELECT * INTO v FROM rpt.cpq_quote_version WHERE tenant_id=NEW.tenant_id AND quote_id=qid AND version_number=q.current_version_number;
 END IF;
 IF NOT FOUND OR (SELECT count(*) FROM rpt.cpq_quote_line WHERE tenant_id=NEW.tenant_id AND quote_version_id=v.id)
 <>jsonb_array_length(v.output_snapshot->'lines') THEN RAISE EXCEPTION 'incomplete_quote_snapshot' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER quote_complete AFTER INSERT OR UPDATE ON rpt.cpq_quote DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION authz.quote_complete();
CREATE CONSTRAINT TRIGGER version_complete AFTER INSERT ON rpt.cpq_quote_version DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION authz.quote_complete();
CREATE TRIGGER quote_version_immutable BEFORE UPDATE OR DELETE ON rpt.cpq_quote_version FOR EACH ROW EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER quote_line_immutable BEFORE UPDATE OR DELETE ON rpt.cpq_quote_line FOR EACH ROW EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER quote_version_no_truncate BEFORE TRUNCATE ON rpt.cpq_quote_version FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER quote_line_no_truncate BEFORE TRUNCATE ON rpt.cpq_quote_line FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();

ALTER TABLE rpt.cpq_quote ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.cpq_quote_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.cpq_quote_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY quote_read ON rpt.cpq_quote FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND authz.quote_allowed(id,'read'));
CREATE POLICY quote_create ON rpt.cpq_quote FOR INSERT TO rpt_runtime WITH CHECK(tenant_id=authz.tenant_id() AND owner_id=authz.actor_id() AND authz.quote_workspace_right(workspace_id,market_id,'create'));
CREATE POLICY quote_update ON rpt.cpq_quote FOR UPDATE TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND (authz.quote_allowed(id,'revise') OR authz.quote_allowed(id,'issue') OR authz.quote_allowed(id,'accept') OR authz.quote_allowed(id,'reject') OR authz.quote_allowed(id,'expire') OR authz.quote_allowed(id,'cancel')))
 WITH CHECK(tenant_id=authz.tenant_id());
CREATE POLICY quote_version_read ON rpt.cpq_quote_version FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND authz.quote_allowed(quote_id,'read'));
CREATE POLICY quote_version_create ON rpt.cpq_quote_version FOR INSERT TO rpt_runtime WITH CHECK(tenant_id=authz.tenant_id() AND created_by=authz.actor_id()
 AND (authz.quote_allowed(quote_id,'create') OR authz.quote_allowed(quote_id,'revise')));
CREATE POLICY quote_line_read ON rpt.cpq_quote_line FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND authz.quote_allowed(quote_id,'read'));
CREATE POLICY quote_line_create ON rpt.cpq_quote_line FOR INSERT TO rpt_runtime WITH CHECK(tenant_id=authz.tenant_id() AND (authz.quote_allowed(quote_id,'create') OR authz.quote_allowed(quote_id,'revise')));
GRANT SELECT,INSERT,UPDATE ON rpt.cpq_quote TO rpt_runtime;
GRANT SELECT,INSERT ON rpt.cpq_quote_version,rpt.cpq_quote_line TO rpt_runtime;
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE ON rpt.cpq_quote FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.cpq_quote_version FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.cpq_quote_line FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
REVOKE ALL ON FUNCTION authz.quote_workspace_right(uuid,uuid,text),authz.quote_allowed(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.quote_workspace_right(uuid,uuid,text),authz.quote_allowed(uuid,text) TO rpt_runtime;
REVOKE ALL ON FUNCTION authz.quote_projection(),authz.quote_guard(),authz.quote_version_guard(),authz.quote_advance(),authz.quote_line_guard(),authz.quote_complete() FROM PUBLIC;

CREATE FUNCTION authz.quote_receipt(p_key text,p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r authz.idempotency_receipt%ROWTYPE;
BEGIN
 IF NOT authz.session_valid() OR length(p_key) NOT BETWEEN 8 AND 128 OR p_hash !~ '^[a-f0-9]{64}$'
 OR NOT (authz.capable(authz.actor_id(),'cpq_quote','create','CONFIDENTIAL') OR authz.capable(authz.actor_id(),'cpq_quote','revise','CONFIDENTIAL'))
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||'/cpq.v1/'||p_key,0));
 SELECT * INTO r FROM authz.idempotency_receipt WHERE tenant_id=authz.tenant_id() AND operation='cpq.v1' AND key=p_key;
 IF FOUND THEN
  IF r.actor_id<>authz.actor_id() OR r.request_hash<>p_hash THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN r.response;
 END IF;
 INSERT INTO authz.idempotency_receipt(tenant_id,operation,key,actor_id,request_hash) VALUES(authz.tenant_id(),'cpq.v1',p_key,authz.actor_id(),p_hash);
 RETURN NULL;
END $$;
CREATE FUNCTION authz.quote_finish(p_key text,p_response jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR pg_column_size(p_response)>2048 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 UPDATE authz.idempotency_receipt SET response=p_response WHERE tenant_id=authz.tenant_id() AND operation='cpq.v1'
 AND key=p_key AND actor_id=authz.actor_id() AND response IS NULL;
END $$;
CREATE FUNCTION authz.quote_decision(p_object uuid,p_action text,p_result text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR p_action NOT IN ('cpq.create','cpq.read','cpq.revise','cpq.transition','cpq.evidence')
 OR p_result NOT IN ('success','deny','failure') THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO rpt.audit_event(tenant_id,actor_id,action,object_type,object_id,scope,policy_version,request_id,result,reason_code)
 VALUES(authz.tenant_id(),authz.actor_id(),p_action,'permission_decision',p_object,'request',
 (SELECT policy_version FROM authz.tenant WHERE id=authz.tenant_id()),nullif(current_setting('rpt.request_id',true),'')::uuid,p_result,'server_policy');
END $$;
REVOKE ALL ON FUNCTION authz.quote_receipt(text,text),authz.quote_finish(text,jsonb),authz.quote_decision(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.quote_receipt(text,text),authz.quote_finish(text,jsonb),authz.quote_decision(uuid,text,text) TO rpt_runtime;

ALTER TABLE rpt.source_observation ADD COLUMN quote_subject_type text;
ALTER TABLE rpt.source_observation ADD CONSTRAINT quote_subject_type_check CHECK(
 (domain_key='cpq_quote' AND quote_subject_type IS NOT NULL AND quote_subject_type IN ('quote','quote_version'))
 OR (domain_key<>'cpq_quote' AND quote_subject_type IS NULL));
CREATE FUNCTION authz.quote_source_right(p_id uuid,p_type text,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE p_type WHEN 'quote' THEN authz.quote_allowed(p_id,p_verb)
 WHEN 'quote_version' THEN EXISTS(SELECT 1 FROM rpt.cpq_quote_version v WHERE v.tenant_id=authz.tenant_id() AND v.id=p_id AND authz.quote_allowed(v.quote_id,p_verb))
 ELSE false END
$$;
CREATE FUNCTION authz.quote_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.domain_key='cpq_quote' AND NOT (CASE NEW.quote_subject_type
 WHEN 'quote' THEN EXISTS(SELECT 1 FROM rpt.cpq_quote WHERE tenant_id=NEW.tenant_id AND id=NEW.subject_id)
 WHEN 'quote_version' THEN EXISTS(SELECT 1 FROM rpt.cpq_quote_version WHERE tenant_id=NEW.tenant_id AND id=NEW.subject_id)
 ELSE false END) THEN RAISE EXCEPTION 'invalid_quote_subject' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quote_source_guard BEFORE INSERT ON rpt.source_observation FOR EACH ROW EXECUTE FUNCTION authz.quote_source_guard();
CREATE POLICY quote_source_boundary ON rpt.source_observation AS RESTRICTIVE FOR ALL TO rpt_runtime
 USING(domain_key<>'cpq_quote' OR authz.quote_source_right(subject_id,quote_subject_type,'read'))
 WITH CHECK(domain_key<>'cpq_quote' OR authz.quote_source_right(subject_id,quote_subject_type,'revise'));
CREATE POLICY quote_source_read ON rpt.source_observation FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND domain_key='cpq_quote' AND authz.quote_source_right(subject_id,quote_subject_type,'read'));
CREATE FUNCTION authz.quote_source_authority(p_system text,p_authority text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND EXISTS(SELECT 1 FROM authz.source_authority a WHERE a.tenant_id=authz.tenant_id() AND a.user_id=authz.actor_id()
 AND a.domain_key='cpq_quote' AND a.source_system=p_system AND a.authority_level=p_authority AND a.revoked_at IS NULL)
$$;
CREATE POLICY quote_source_insert ON rpt.source_observation FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id() AND domain_key='cpq_quote'
 AND authz.quote_source_right(subject_id,quote_subject_type,'revise')
 AND authz.quote_source_authority(source_system,authority_level));
REVOKE ALL ON FUNCTION authz.quote_source_right(uuid,text,text),authz.quote_source_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.quote_source_right(uuid,text,text) TO rpt_runtime;
REVOKE ALL ON FUNCTION authz.quote_source_authority(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.quote_source_authority(text,text) TO rpt_runtime;
