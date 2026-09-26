SET LOCAL ROLE rpt_owner;

-- Bounded commercial configuration, not a programmable formula/JSON engine.
-- All configuration is list scoped: pricing object/workspace rights stay additive.
CREATE TABLE rpt.commercial_configuration (
 tenant_id uuid NOT NULL, id uuid NOT NULL, market_id uuid NOT NULL,
 price_list_id uuid NOT NULL, currency text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('bundle','rules','financing')),
 stable_key text NOT NULL CHECK(stable_key ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,market_id,price_list_id,kind,stable_key),
 UNIQUE(tenant_id,id,market_id,price_list_id,kind),
 FOREIGN KEY(tenant_id,price_list_id,market_id,currency) REFERENCES rpt.price_list(tenant_id,id,market_id,currency),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account
);
CREATE TABLE rpt.commercial_configuration_version (
 tenant_id uuid NOT NULL, id uuid NOT NULL, configuration_id uuid NOT NULL,
 market_id uuid NOT NULL, price_list_id uuid NOT NULL, kind text NOT NULL,
 version_no integer NOT NULL CHECK(version_no>0), revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','retired')),
 valid_from timestamptz NOT NULL, valid_to timestamptz,
 pricing_mode text CHECK(pricing_mode IN ('COMPONENT_SUM','PUBLISHED_ANCHOR')),
 anchor_market_product_id uuid,
 financing_mode text CHECK(financing_mode IN ('SURCHARGE_EQUAL_INSTALLMENTS','DOWN_PAYMENT_INSTALLMENT_FACTOR')),
 down_payment_rate numeric(20,10) CHECK(down_payment_rate BETWEEN 0 AND 1),
 down_payment_amount numeric(24,10) CHECK(down_payment_amount>=0),
 allow_additional_balance boolean NOT NULL DEFAULT false,
 actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,market_id), UNIQUE(tenant_id,configuration_id,version_no),
 FOREIGN KEY(tenant_id,configuration_id,market_id,price_list_id,kind)
 REFERENCES rpt.commercial_configuration(tenant_id,id,market_id,price_list_id,kind),
 FOREIGN KEY(tenant_id,anchor_market_product_id,market_id) REFERENCES rpt.market_product(tenant_id,id,market_id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account,
 CHECK(valid_to IS NULL OR valid_to>valid_from),
 CHECK((kind='bundle' AND pricing_mode IS NOT NULL AND financing_mode IS NULL
   AND down_payment_rate IS NULL AND down_payment_amount IS NULL AND NOT allow_additional_balance
   AND ((pricing_mode='PUBLISHED_ANCHOR')=(anchor_market_product_id IS NOT NULL)))
  OR (kind='rules' AND pricing_mode IS NULL AND anchor_market_product_id IS NULL AND financing_mode IS NULL
   AND down_payment_rate IS NULL AND down_payment_amount IS NULL AND NOT allow_additional_balance)
  OR (kind='financing' AND pricing_mode IS NULL AND anchor_market_product_id IS NULL AND financing_mode IS NOT NULL
   AND ((financing_mode='SURCHARGE_EQUAL_INSTALLMENTS' AND down_payment_rate IS NULL
     AND down_payment_amount IS NULL AND NOT allow_additional_balance)
    OR (financing_mode='DOWN_PAYMENT_INSTALLMENT_FACTOR'
     AND ((down_payment_rate IS NULL)<>(down_payment_amount IS NULL)))))),
 EXCLUDE USING gist (tenant_id extensions.gist_uuid_ops WITH =,
  configuration_id extensions.gist_uuid_ops WITH =, tstzrange(valid_from,valid_to,'[)') WITH &&)
  WHERE(status<>'draft')
);
CREATE TABLE rpt.commercial_bundle_line (
 tenant_id uuid NOT NULL, id uuid NOT NULL, version_id uuid NOT NULL, market_id uuid NOT NULL,
 market_product_id uuid NOT NULL, quantity numeric(24,10) NOT NULL CHECK(quantity>0),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,version_id,market_product_id),
 FOREIGN KEY(tenant_id,version_id,market_id) REFERENCES rpt.commercial_configuration_version(tenant_id,id,market_id),
 FOREIGN KEY(tenant_id,market_product_id,market_id) REFERENCES rpt.market_product(tenant_id,id,market_id)
);
CREATE TABLE rpt.commercial_rule (
 tenant_id uuid NOT NULL, id uuid NOT NULL, version_id uuid NOT NULL, market_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('percentage_discount','fixed_discount','percentage_surcharge','fixed_surcharge')),
 value numeric(24,10) NOT NULL CHECK(value>=0), auto_limit numeric(24,10),
 priority integer NOT NULL CHECK(priority BETWEEN 0 AND 1000),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,version_id,priority),
 FOREIGN KEY(tenant_id,version_id,market_id) REFERENCES rpt.commercial_configuration_version(tenant_id,id,market_id),
 CHECK(kind NOT LIKE 'percentage%' OR value<=1),
 -- The configured discount and automatically allowed limit are independent.
 CHECK(auto_limit IS NULL OR (kind LIKE '%discount' AND auto_limit>=0
  AND (kind NOT LIKE 'percentage%' OR auto_limit<=1)))
);
CREATE TABLE rpt.commercial_financing_term (
 tenant_id uuid NOT NULL, id uuid NOT NULL, version_id uuid NOT NULL, market_id uuid NOT NULL,
 months integer NOT NULL CHECK(months BETWEEN 1 AND 120), value numeric(24,10) NOT NULL CHECK(value>=0),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,version_id,months),
 FOREIGN KEY(tenant_id,version_id,market_id) REFERENCES rpt.commercial_configuration_version(tenant_id,id,market_id)
);

CREATE FUNCTION authz.commercial_market_right(p_market uuid,p_list uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND p_verb IN ('calculate','configure')
 AND authz.capable(authz.actor_id(),'commercial',p_verb,'CONFIDENTIAL')
 AND EXISTS(SELECT 1 FROM rpt.price_list p WHERE p.tenant_id=authz.tenant_id()
  AND p.id=p_list AND p.market_id=p_market AND authz.pricing_allowed(p.id,'read'))
 AND CASE WHEN p_verb='configure' THEN authz.market_admin_scope(p_market,'manage')
  AND authz.pricing_allowed(p_list,'update')
 ELSE authz.operational_market()=p_market OR authz.market_admin_scope(p_market,'read') END
$$;
CREATE FUNCTION authz.commercial_version_right(p_version uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM rpt.commercial_configuration_version v
 WHERE v.tenant_id=authz.tenant_id() AND v.id=p_version
 AND authz.commercial_market_right(v.market_id,v.price_list_id,p_verb)
 AND (p_verb='configure' OR (v.status<>'draft'
  AND (v.kind<>'bundle' OR (
   EXISTS(SELECT 1 FROM rpt.commercial_bundle_line l WHERE l.tenant_id=v.tenant_id AND l.version_id=v.id)
   AND NOT EXISTS(SELECT 1 FROM rpt.commercial_bundle_line l WHERE l.tenant_id=v.tenant_id AND l.version_id=v.id
    AND NOT authz.catalog_allowed(l.market_product_id,'read'))
   AND (v.pricing_mode<>'PUBLISHED_ANCHOR' OR authz.catalog_allowed(v.anchor_market_product_id,'read')))))))
$$;
CREATE FUNCTION authz.commercial_configuration_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.actor_id<>authz.actor_id() THEN RAISE EXCEPTION 'invalid_configuration' USING ERRCODE='23514'; END IF;
 ELSE
  IF (to_jsonb(NEW)-'version') IS DISTINCT FROM (to_jsonb(OLD)-'version') OR NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'immutable_configuration' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commercial_configuration_guard BEFORE INSERT OR UPDATE ON rpt.commercial_configuration
 FOR EACH ROW EXECUTE FUNCTION authz.commercial_configuration_guard();
CREATE FUNCTION authz.commercial_version_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer; k text;
BEGIN
 IF NOT authz.commercial_market_right(NEW.market_id,NEW.price_list_id,'configure')
 THEN RAISE EXCEPTION 'commercial_configure_required' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT version INTO n FROM rpt.commercial_configuration WHERE tenant_id=NEW.tenant_id AND id=NEW.configuration_id;
  IF NEW.status<>'draft' OR NEW.revision<>1 OR NEW.version_no<>n OR NEW.actor_id<>authz.actor_id()
  THEN RAISE EXCEPTION 'draft_creation_required' USING ERRCODE='23514'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['revision','status','valid_to']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','status','valid_to'])
   OR NEW.revision<>OLD.revision+1 OR NOT (
    (OLD.status='draft' AND NEW.status='active' AND NEW.valid_to IS NOT DISTINCT FROM OLD.valid_to)
    OR (OLD.status='active' AND NEW.status='retired' AND NEW.valid_to IS NOT NULL
     AND NEW.valid_to>OLD.valid_from AND (OLD.valid_to IS NULL OR NEW.valid_to<=OLD.valid_to)))
  THEN RAISE EXCEPTION 'invalid_commercial_transition' USING ERRCODE='23514'; END IF;
  IF NEW.status='active' THEN
   IF NOT EXISTS(SELECT 1 FROM rpt.catalog_market WHERE tenant_id=NEW.tenant_id AND market_id=NEW.market_id AND status='active')
   THEN RAISE EXCEPTION 'market_not_active' USING ERRCODE='23514'; END IF;
   IF NEW.kind='bundle' THEN SELECT count(*) INTO n FROM rpt.commercial_bundle_line WHERE tenant_id=NEW.tenant_id AND version_id=NEW.id;
   ELSIF NEW.kind='rules' THEN SELECT count(*) INTO n FROM rpt.commercial_rule WHERE tenant_id=NEW.tenant_id AND version_id=NEW.id;
   ELSE SELECT count(*) INTO n FROM rpt.commercial_financing_term WHERE tenant_id=NEW.tenant_id AND version_id=NEW.id; END IF;
   IF n=0 THEN RAISE EXCEPTION 'empty_configuration' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commercial_version_guard BEFORE INSERT OR UPDATE ON rpt.commercial_configuration_version
 FOR EACH ROW EXECUTE FUNCTION authz.commercial_version_guard();
CREATE FUNCTION authz.commercial_child_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v rpt.commercial_configuration_version%ROWTYPE; expected text;
BEGIN
 SELECT * INTO v FROM rpt.commercial_configuration_version WHERE tenant_id=NEW.tenant_id AND id=NEW.version_id FOR UPDATE;
 expected:=CASE TG_TABLE_NAME WHEN 'commercial_bundle_line' THEN 'bundle' WHEN 'commercial_rule' THEN 'rules' ELSE 'financing' END;
 IF v.id IS NULL OR v.kind<>expected OR v.status<>'draft' OR NOT authz.commercial_version_right(v.id,'configure')
 THEN RAISE EXCEPTION 'invalid_commercial_child' USING ERRCODE='23514'; END IF;
 IF expected='bundle' THEN
  IF NOT authz.catalog_allowed(NEW.market_product_id,'read') THEN RAISE EXCEPTION 'component_not_authorized' USING ERRCODE='42501'; END IF;
 ELSIF expected='financing' THEN
  IF v.financing_mode='DOWN_PAYMENT_INSTALLMENT_FACTOR' AND NEW.value<=0 THEN RAISE EXCEPTION 'positive_factor_required' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['commercial_configuration','commercial_configuration_version','commercial_bundle_line','commercial_rule','commercial_financing_term'] LOOP
  EXECUTE format('ALTER TABLE rpt.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('GRANT SELECT,INSERT ON rpt.%I TO rpt_runtime',tbl);
  EXECUTE format('CREATE TRIGGER audit_change AFTER INSERT OR UPDATE ON rpt.%I FOR EACH ROW EXECUTE FUNCTION authz.audit_change()',tbl);
  EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE OR TRUNCATE ON rpt.%I FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable()',tbl);
 END LOOP;
 FOREACH tbl IN ARRAY ARRAY['commercial_bundle_line','commercial_rule','commercial_financing_term'] LOOP
  EXECUTE format('CREATE POLICY commercial_child_read ON rpt.%I FOR SELECT TO rpt_runtime USING(tenant_id=authz.tenant_id() AND (authz.commercial_version_right(version_id,''calculate'') OR authz.commercial_version_right(version_id,''configure'')))',tbl);
  EXECUTE format('CREATE POLICY commercial_child_insert ON rpt.%I FOR INSERT TO rpt_runtime WITH CHECK(tenant_id=authz.tenant_id() AND authz.commercial_version_right(version_id,''configure''))',tbl);
  EXECUTE format('CREATE TRIGGER commercial_child_guard BEFORE INSERT ON rpt.%I FOR EACH ROW EXECUTE FUNCTION authz.commercial_child_guard()',tbl);
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE ON rpt.%I FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable()',tbl);
 END LOOP;
END $$;
GRANT UPDATE ON rpt.commercial_configuration,rpt.commercial_configuration_version TO rpt_runtime;
CREATE POLICY commercial_config_read ON rpt.commercial_configuration FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND (authz.commercial_market_right(market_id,price_list_id,'calculate') OR authz.commercial_market_right(market_id,price_list_id,'configure')));
CREATE POLICY commercial_config_create ON rpt.commercial_configuration FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.commercial_market_right(market_id,price_list_id,'configure'));
CREATE POLICY commercial_config_update ON rpt.commercial_configuration FOR UPDATE TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.commercial_market_right(market_id,price_list_id,'configure'))
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.commercial_market_right(market_id,price_list_id,'configure'));
CREATE POLICY commercial_version_read ON rpt.commercial_configuration_version FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND (authz.commercial_version_right(id,'calculate') OR authz.commercial_version_right(id,'configure')));
CREATE POLICY commercial_version_create ON rpt.commercial_configuration_version FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND status='draft' AND authz.commercial_market_right(market_id,price_list_id,'configure'));
CREATE POLICY commercial_version_update ON rpt.commercial_configuration_version FOR UPDATE TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.commercial_version_right(id,'configure'))
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.commercial_version_right(id,'configure'));

-- Typed evidence uses the SAME immutable ledger, not a parallel source store.
-- A common version PK space + kind validation prevents cross-kind UUID aliasing.
ALTER TABLE rpt.source_observation ADD COLUMN commercial_subject_type text;
ALTER TABLE rpt.source_observation ADD CONSTRAINT commercial_subject_type_check CHECK(
 (domain_key='commercial_configuration' AND commercial_subject_type IS NOT NULL
  AND commercial_subject_type IN ('bundle_version','rule_set_version','financing_plan_version'))
 OR (domain_key<>'commercial_configuration' AND commercial_subject_type IS NULL));
CREATE FUNCTION authz.commercial_source_right(p_id uuid,p_kind text,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM rpt.commercial_configuration_version v WHERE v.tenant_id=authz.tenant_id() AND v.id=p_id
 AND p_kind=CASE v.kind WHEN 'bundle' THEN 'bundle_version' WHEN 'rules' THEN 'rule_set_version' ELSE 'financing_plan_version' END
 AND authz.commercial_version_right(v.id,p_verb))
$$;
CREATE FUNCTION authz.commercial_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.domain_key='commercial_configuration' AND NOT EXISTS(
  SELECT 1 FROM rpt.commercial_configuration_version v WHERE v.tenant_id=NEW.tenant_id AND v.id=NEW.subject_id
  AND NEW.commercial_subject_type=CASE v.kind WHEN 'bundle' THEN 'bundle_version' WHEN 'rules' THEN 'rule_set_version' ELSE 'financing_plan_version' END)
 THEN RAISE EXCEPTION 'invalid_commercial_subject' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commercial_source_guard BEFORE INSERT ON rpt.source_observation FOR EACH ROW EXECUTE FUNCTION authz.commercial_source_guard();
-- Restrictive guard prevents ANY existing permissive legacy branch from opening
-- the new domain. Legacy rows retain their exact earlier algebra.
CREATE POLICY commercial_source_boundary ON rpt.source_observation AS RESTRICTIVE FOR ALL TO rpt_runtime
 USING(domain_key<>'commercial_configuration' OR authz.commercial_source_right(subject_id,commercial_subject_type,'calculate') OR authz.commercial_source_right(subject_id,commercial_subject_type,'configure'))
 WITH CHECK(domain_key<>'commercial_configuration' OR authz.commercial_source_right(subject_id,commercial_subject_type,'configure'));
CREATE POLICY commercial_source_read ON rpt.source_observation FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND domain_key='commercial_configuration'
 AND (authz.commercial_source_right(subject_id,commercial_subject_type,'calculate') OR authz.commercial_source_right(subject_id,commercial_subject_type,'configure')));
CREATE FUNCTION authz.commercial_source_authority(p_system text,p_authority text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND EXISTS(SELECT 1 FROM authz.source_authority a
 WHERE a.tenant_id=authz.tenant_id() AND a.user_id=authz.actor_id() AND a.domain_key='commercial_configuration'
 AND a.source_system=p_system AND a.authority_level=p_authority AND a.revoked_at IS NULL)
$$;
CREATE POLICY commercial_source_insert ON rpt.source_observation FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND domain_key='commercial_configuration' AND actor_id=authz.actor_id()
 AND authz.commercial_source_right(subject_id,commercial_subject_type,'configure')
 AND authz.commercial_source_authority(source_system,authority_level));

CREATE FUNCTION authz.commercial_receipt(p_key text,p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r authz.idempotency_receipt%ROWTYPE;
BEGIN
 IF NOT authz.session_valid() OR NOT authz.capable(authz.actor_id(),'commercial','configure','CONFIDENTIAL')
 OR length(p_key) NOT BETWEEN 8 AND 128 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||'/commercial.v1/'||p_key,0));
 SELECT * INTO r FROM authz.idempotency_receipt WHERE tenant_id=authz.tenant_id() AND operation='commercial.v1' AND key=p_key;
 IF FOUND THEN
  IF r.actor_id<>authz.actor_id() OR r.request_hash<>p_hash THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN r.response;
 END IF;
 INSERT INTO authz.idempotency_receipt(tenant_id,operation,key,actor_id,request_hash) VALUES(authz.tenant_id(),'commercial.v1',p_key,authz.actor_id(),p_hash);
 RETURN NULL;
END $$;
CREATE FUNCTION authz.commercial_finish(p_key text,p_response jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR NOT authz.capable(authz.actor_id(),'commercial','configure','CONFIDENTIAL') OR pg_column_size(p_response)>2048
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 UPDATE authz.idempotency_receipt SET response=p_response WHERE tenant_id=authz.tenant_id() AND operation='commercial.v1'
 AND key=p_key AND actor_id=authz.actor_id() AND response IS NULL;
END $$;
REVOKE ALL ON FUNCTION authz.commercial_market_right(uuid,uuid,text),authz.commercial_version_right(uuid,text),authz.commercial_source_right(uuid,text,text),authz.commercial_receipt(text,text),authz.commercial_finish(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.commercial_market_right(uuid,uuid,text),authz.commercial_version_right(uuid,text),authz.commercial_source_right(uuid,text,text),authz.commercial_receipt(text,text),authz.commercial_finish(text,jsonb) TO rpt_runtime;
REVOKE ALL ON FUNCTION authz.commercial_configuration_guard(),authz.commercial_version_guard(),authz.commercial_child_guard(),authz.commercial_source_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.commercial_source_authority(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.commercial_source_authority(text,text) TO rpt_runtime;
CREATE FUNCTION authz.commercial_decision(p_object uuid,p_action text,p_result text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR p_action NOT IN ('commercial.configure','commercial.calculate','commercial.history','commercial.evidence')
 OR p_result NOT IN ('success','deny','failure') THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO rpt.audit_event(tenant_id,actor_id,action,object_type,object_id,scope,policy_version,request_id,result,reason_code)
 VALUES(authz.tenant_id(),authz.actor_id(),p_action,'permission_decision',p_object,'request',
 (SELECT policy_version FROM authz.tenant WHERE id=authz.tenant_id()),nullif(current_setting('rpt.request_id',true),'')::uuid,p_result,'server_policy');
END $$;
REVOKE ALL ON FUNCTION authz.commercial_decision(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.commercial_decision(uuid,text,text) TO rpt_runtime;
