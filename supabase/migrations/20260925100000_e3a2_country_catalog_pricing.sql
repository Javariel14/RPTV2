SET LOCAL ROLE rpt_owner;

-- Currency is controlled reference data. Amounts retain four decimal places; the
-- currency's published minor-unit scale is enforced before an entry is accepted.
CREATE TABLE rpt.catalog_currency (
 tenant_id uuid NOT NULL REFERENCES authz.tenant, code text NOT NULL CHECK(code ~ '^[A-Z]{3}$'),
 minor_units integer NOT NULL CHECK(minor_units BETWEEN 0 AND 4),
 name text NOT NULL DEFAULT 'Standards seed' CHECK(length(name) BETWEEN 1 AND 100),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 source_kind text NOT NULL DEFAULT 'standards_seed' CHECK(source_kind IN ('standards_seed','manual_admin')),
 FOREIGN KEY(tenant_id,created_by) REFERENCES authz.user_account,
 PRIMARY KEY(tenant_id,code)
);
CREATE FUNCTION authz.seed_catalog_currencies() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO rpt.catalog_currency(tenant_id,code,minor_units)
 SELECT NEW.id,code,2 FROM unnest(ARRAY['USD','MXN','COP','PEN','ARS','BRL','DOP','PAB']) AS code;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION authz.record_decision(p_object uuid,p_action text,p_result text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR p_action NOT IN ('person.read','person.update','metric.append','grant.create','grant.revoke','privacy.purge','network.stats','crm.context','crm.list','crm.detail','crm.onboard','crm.create','crm.command','crm.view','crm.metrics','crm.grant','crm.import.preview','crm.import.confirm','recruiting.context','recruiting.list','recruiting.detail','recruiting.create','recruiting.command','agenda.list','agenda.detail','agenda.create','agenda.command','visit.list','visit.detail','visit.create','visit.command','product.list','product.detail','product.create','product.command','catalog.list','catalog.create','catalog.command','catalog.admin','pricing.list','pricing.create','pricing.command','pricing.fx') OR p_result NOT IN ('allow','deny','success','failure')
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO rpt.audit_event(tenant_id,actor_id,action,object_type,object_id,scope,policy_version,request_id,result,reason_code)
 VALUES(authz.tenant_id(),authz.actor_id(),p_action,'permission_decision',p_object,'request',(SELECT policy_version FROM authz.tenant WHERE id=authz.tenant_id()),nullif(current_setting('rpt.request_id',true),'')::uuid,p_result,'server_policy');
END $$;
CREATE TRIGGER seed_catalog_currencies AFTER INSERT ON authz.tenant
FOR EACH ROW EXECUTE FUNCTION authz.seed_catalog_currencies();
INSERT INTO rpt.catalog_currency(tenant_id,code,minor_units)
SELECT t.id,c.code,2 FROM authz.tenant t
CROSS JOIN unnest(ARRAY['USD','MXN','COP','PEN','ARS','BRL','DOP','PAB']) AS c(code);
CREATE FUNCTION authz.catalog_currency_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.source_kind='standards_seed' AND pg_trigger_depth()>1 THEN RETURN NEW; END IF;
 IF NOT authz.session_valid() OR NOT authz.capable(authz.actor_id(),'market_admin','manage','CONFIDENTIAL')
  OR NOT authz.capable(authz.actor_id(),'market_admin','global','CONFIDENTIAL')
 THEN RAISE EXCEPTION 'global_market_admin_required' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.created_by<>authz.actor_id() OR NEW.source_kind<>'manual_admin' OR NEW.status<>'inactive'
  THEN RAISE EXCEPTION 'invalid_currency_registration' USING ERRCODE='23514'; END IF;
 ELSE
  IF (NEW.tenant_id,NEW.code,NEW.minor_units,NEW.name,NEW.created_by,NEW.created_at,NEW.source_kind)
   IS DISTINCT FROM (OLD.tenant_id,OLD.code,OLD.minor_units,OLD.name,OLD.created_by,OLD.created_at,OLD.source_kind)
    OR NEW.version<>OLD.version+1 OR NEW.status=OLD.status
    OR (NEW.status='inactive' AND EXISTS(SELECT 1 FROM rpt.market m
      JOIN rpt.catalog_market cm ON (cm.tenant_id,cm.market_id)=(m.tenant_id,m.id)
      WHERE m.tenant_id=NEW.tenant_id AND m.currency=NEW.code AND cm.status='active'))
  THEN RAISE EXCEPTION 'invalid_currency_transition' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_currency_guard BEFORE INSERT OR UPDATE ON rpt.catalog_currency
 FOR EACH ROW EXECUTE FUNCTION authz.catalog_currency_guard();

-- rpt.market remains the structural market identity. This opt-in commercial
-- profile does not grant Product/Catalog access through legacy Network policies.
CREATE TABLE rpt.catalog_market (
 tenant_id uuid NOT NULL, market_id uuid NOT NULL,
 country_code text NOT NULL CHECK(country_code ~ '^[A-Z]{2}$'),
 locale text NOT NULL CHECK(locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
 status text NOT NULL CHECK(status IN ('draft','active','retired')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,market_id), UNIQUE(tenant_id,country_code),
 FOREIGN KEY(tenant_id,market_id) REFERENCES rpt.market
);
CREATE FUNCTION authz.catalog_market_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE m rpt.market%ROWTYPE; currency_status text;
BEGIN
 SELECT * INTO m FROM rpt.market WHERE tenant_id=NEW.tenant_id AND id=NEW.market_id;
 IF NOT FOUND OR m.code<>NEW.country_code OR NOT EXISTS(
  SELECT 1 FROM rpt.catalog_currency c WHERE c.tenant_id=NEW.tenant_id AND c.code=m.currency)
 THEN RAISE EXCEPTION 'invalid_catalog_market' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND ((NEW.tenant_id,NEW.market_id,NEW.country_code,NEW.locale,NEW.created_at)
  IS DISTINCT FROM (OLD.tenant_id,OLD.market_id,OLD.country_code,OLD.locale,OLD.created_at)
  OR NEW.version<>OLD.version+1 OR NOT authz.market_admin_scope(OLD.market_id,'manage')
  OR (OLD.status='draft' AND NEW.status NOT IN ('draft','active'))
  OR (OLD.status='active' AND NEW.status NOT IN ('active','retired'))
  OR OLD.status='retired')
 THEN RAISE EXCEPTION 'immutable_market_identity' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND NEW.status='active' AND OLD.status='draft' THEN
  SELECT c.status INTO currency_status FROM rpt.catalog_currency c WHERE c.tenant_id=NEW.tenant_id AND c.code=m.currency;
  IF currency_status<>'active' OR NOT EXISTS(SELECT 1 FROM authz.admin_market_scope s
   WHERE s.tenant_id=NEW.tenant_id AND s.market_id=NEW.market_id AND s.revoked_at IS NULL)
  THEN RAISE EXCEPTION 'market_not_ready' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_market_guard BEFORE INSERT OR UPDATE ON rpt.catalog_market
FOR EACH ROW EXECUTE FUNCTION authz.catalog_market_guard();

-- Operational assignment is singular and temporal. Administration is a
-- different, explicitly granted scope and never creates operational access.
CREATE TABLE authz.operational_market_assignment (
 tenant_id uuid NOT NULL, id uuid NOT NULL, user_id uuid NOT NULL, market_id uuid NOT NULL,
 valid_from timestamptz NOT NULL, valid_to timestamptz,
 assigned_by uuid NOT NULL, reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 300),
 request_id uuid NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,market_id) REFERENCES rpt.catalog_market,
 FOREIGN KEY(tenant_id,assigned_by) REFERENCES authz.user_account,
 CHECK(valid_to IS NULL OR valid_to>valid_from),
 EXCLUDE USING gist (tenant_id extensions.gist_uuid_ops WITH =,
  user_id extensions.gist_uuid_ops WITH =, tstzrange(valid_from,valid_to,'[)') WITH &&)
);
CREATE INDEX operational_market_current ON authz.operational_market_assignment(tenant_id,user_id,valid_from DESC);
CREATE TABLE authz.admin_market_scope (
 tenant_id uuid NOT NULL, id uuid NOT NULL, user_id uuid NOT NULL, market_id uuid NOT NULL,
 granted_by uuid NOT NULL, granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz, request_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,market_id) REFERENCES rpt.catalog_market,
 FOREIGN KEY(tenant_id,granted_by) REFERENCES authz.user_account,
 CHECK(revoked_at IS NULL OR revoked_at>=granted_at)
);
CREATE UNIQUE INDEX admin_market_scope_active ON authz.admin_market_scope(tenant_id,user_id,market_id)
 WHERE revoked_at IS NULL;
CREATE FUNCTION authz.market_admin_scope(p_market uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND p_verb IN ('read','manage')
 AND authz.capable(authz.actor_id(),'market_admin',p_verb,'CONFIDENTIAL')
 AND EXISTS(SELECT 1 FROM rpt.catalog_market m WHERE m.tenant_id=authz.tenant_id() AND m.market_id=p_market)
 AND (authz.capable(authz.actor_id(),'market_admin','global','CONFIDENTIAL')
  OR EXISTS(SELECT 1 FROM authz.admin_market_scope s WHERE s.tenant_id=authz.tenant_id()
   AND s.user_id=authz.actor_id() AND s.market_id=p_market AND s.revoked_at IS NULL))
$$;
CREATE FUNCTION authz.operational_market() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT a.market_id FROM authz.operational_market_assignment a
 JOIN rpt.catalog_market m ON (m.tenant_id,m.market_id)=(a.tenant_id,a.market_id)
 WHERE authz.session_valid() AND a.tenant_id=authz.tenant_id() AND a.user_id=authz.actor_id()
 AND a.valid_from<=statement_timestamp() AND (a.valid_to IS NULL OR a.valid_to>statement_timestamp())
 AND m.status='active' LIMIT 1
$$;
CREATE FUNCTION authz.market_authorized(p_market uuid,p_domain text,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p_domain IN ('catalog','pricing') AND p_verb IN ('read','create','update')
 AND authz.session_valid() AND authz.capable(authz.actor_id(),p_domain,p_verb,'CONFIDENTIAL')
 AND (authz.operational_market()=p_market
  OR authz.market_admin_scope(p_market,CASE WHEN p_verb='read' THEN 'read' ELSE 'manage' END))
$$;
CREATE FUNCTION authz.market_user_exists(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND authz.capable(authz.actor_id(),'market_admin','manage','CONFIDENTIAL')
 AND EXISTS(SELECT 1 FROM authz.user_account u WHERE u.tenant_id=authz.tenant_id()
 AND u.id=p_user AND u.status='active')
$$;
CREATE FUNCTION authz.market_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE market_status text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.tenant_id,NEW.id,NEW.user_id,NEW.market_id,NEW.valid_from,NEW.assigned_by,
   NEW.reason,NEW.request_id,NEW.created_at)
   IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.user_id,OLD.market_id,OLD.valid_from,OLD.assigned_by,
   OLD.reason,OLD.request_id,OLD.created_at)
   OR OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL OR NEW.valid_to<=OLD.valid_from
   OR NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'invalid_market_assignment_close' USING ERRCODE='23514'; END IF;
  IF NOT authz.market_admin_scope(OLD.market_id,'manage') OR NEW.user_id=authz.actor_id()
  THEN RAISE EXCEPTION 'market_admin_required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 SELECT status INTO market_status FROM rpt.catalog_market WHERE tenant_id=NEW.tenant_id AND market_id=NEW.market_id;
 IF market_status<>'active' OR NEW.assigned_by<>authz.actor_id() OR NEW.user_id=authz.actor_id()
  OR NOT authz.market_admin_scope(NEW.market_id,'manage')
 THEN RAISE EXCEPTION 'market_admin_required' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER market_assignment_guard BEFORE INSERT OR UPDATE ON authz.operational_market_assignment
 FOR EACH ROW EXECUTE FUNCTION authz.market_assignment_guard();
CREATE FUNCTION authz.admin_market_scope_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR NOT authz.capable(authz.actor_id(),'market_admin','manage','CONFIDENTIAL')
  OR NOT authz.capable(authz.actor_id(),'market_admin','global','CONFIDENTIAL')
 THEN RAISE EXCEPTION 'global_market_admin_required' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.tenant_id,NEW.id,NEW.user_id,NEW.market_id,NEW.granted_by,NEW.granted_at,NEW.request_id)
   IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.user_id,OLD.market_id,OLD.granted_by,OLD.granted_at,OLD.request_id)
   OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
  THEN RAISE EXCEPTION 'invalid_scope_revocation' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.granted_by<>authz.actor_id() THEN RAISE EXCEPTION 'invalid_scope_actor' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER admin_market_scope_guard BEFORE INSERT OR UPDATE ON authz.admin_market_scope
 FOR EACH ROW EXECUTE FUNCTION authz.admin_market_scope_guard();

CREATE TABLE rpt.market_product (
 tenant_id uuid NOT NULL, id uuid NOT NULL, market_id uuid NOT NULL, node_id uuid NOT NULL,
 workspace_id uuid NOT NULL, owner_id uuid NOT NULL,
 stable_key text NOT NULL CHECK(stable_key ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
 commercial_code text NOT NULL CHECK(length(commercial_code) BETWEEN 1 AND 100),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,market_id,stable_key),
 UNIQUE(tenant_id,market_id,commercial_code),
 FOREIGN KEY(tenant_id,market_id) REFERENCES rpt.catalog_market,
 FOREIGN KEY(tenant_id,node_id) REFERENCES rpt.product_node,
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,owner_id) REFERENCES authz.user_account,
 UNIQUE(tenant_id,id,market_id)
);
CREATE INDEX market_product_node_idx ON rpt.market_product(tenant_id,node_id,market_id);
CREATE FUNCTION authz.catalog_allowed(p_id uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM rpt.market_product m WHERE m.tenant_id=authz.tenant_id() AND m.id=p_id
 AND authz.allowed('catalog',m.id,p_verb,'CONFIDENTIAL')
 AND authz.market_authorized(m.market_id,'catalog',p_verb)
 AND authz.product_allowed(m.node_id,CASE WHEN p_verb='read' THEN 'read' ELSE 'update' END))
$$;
CREATE FUNCTION authz.market_product_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n rpt.product_node%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.tenant_id,NEW.id,NEW.market_id,NEW.node_id,NEW.workspace_id,NEW.owner_id,
   NEW.stable_key,NEW.display_name,NEW.commercial_code,NEW.created_at)
   IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.market_id,OLD.node_id,OLD.workspace_id,OLD.owner_id,
   OLD.stable_key,OLD.display_name,OLD.commercial_code,OLD.created_at)
   OR NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'immutable_market_product_identity' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO n FROM rpt.product_node WHERE tenant_id=NEW.tenant_id AND id=NEW.node_id;
 IF NOT FOUND OR n.workspace_id<>NEW.workspace_id OR NEW.owner_id<>authz.actor_id()
  OR NOT authz.product_allowed(NEW.node_id,'update')
  OR NOT authz.market_authorized(NEW.market_id,'catalog','create')
 THEN RAISE EXCEPTION 'catalog_permission_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO authz.object_access(tenant_id,object_type,object_id,workspace_id,owner_id)
 VALUES(NEW.tenant_id,'catalog',NEW.id,NEW.workspace_id,NEW.owner_id);
 INSERT INTO authz.ownership_history(tenant_id,object_type,object_id,workspace_id,owner_id)
 VALUES(NEW.tenant_id,'catalog',NEW.id,NEW.workspace_id,NEW.owner_id);
 RETURN NEW;
END $$;
CREATE TRIGGER market_product_guard BEFORE INSERT OR UPDATE ON rpt.market_product
FOR EACH ROW EXECUTE FUNCTION authz.market_product_guard();

-- Availability is an append-only sequence of effective instants. It is not
-- derived from Product/Model lifecycle and never overwrites earlier states.
CREATE TABLE rpt.market_availability (
 tenant_id uuid NOT NULL, id uuid NOT NULL, market_product_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('planned','available','temporarily_unavailable','discontinued','withdrawn')),
 effective_at timestamptz NOT NULL, observation_id uuid NOT NULL,
 actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,market_product_id,effective_at),
 FOREIGN KEY(tenant_id,market_product_id) REFERENCES rpt.market_product,
 FOREIGN KEY(tenant_id,observation_id) REFERENCES rpt.source_observation,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account
);
CREATE FUNCTION authz.market_availability_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o rpt.source_observation%ROWTYPE; latest timestamptz;
BEGIN
 SELECT * INTO o FROM rpt.source_observation WHERE tenant_id=NEW.tenant_id AND id=NEW.observation_id;
 SELECT max(effective_at) INTO latest FROM rpt.market_availability
 WHERE tenant_id=NEW.tenant_id AND market_product_id=NEW.market_product_id;
 IF o.id IS NULL OR o.domain_key<>'market_catalog' OR o.subject_id<>NEW.market_product_id
  OR o.facts->>'availability' IS DISTINCT FROM NEW.status OR NEW.effective_at<=latest
  OR NEW.actor_id<>authz.actor_id()
 THEN RAISE EXCEPTION 'invalid_availability_evidence' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER market_availability_guard BEFORE INSERT ON rpt.market_availability
FOR EACH ROW EXECUTE FUNCTION authz.market_availability_guard();

CREATE TABLE rpt.price_list (
 tenant_id uuid NOT NULL, id uuid NOT NULL, market_id uuid NOT NULL,
 workspace_id uuid NOT NULL, owner_id uuid NOT NULL,
 stable_key text NOT NULL CHECK(stable_key ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 status text NOT NULL CHECK(status IN ('draft','active','closed')),
 valid_from timestamptz NOT NULL, valid_to timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,market_id,stable_key),
 UNIQUE(tenant_id,id,market_id,currency),
 FOREIGN KEY(tenant_id,market_id) REFERENCES rpt.catalog_market,
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,owner_id) REFERENCES authz.user_account,
 FOREIGN KEY(tenant_id,currency) REFERENCES rpt.catalog_currency,
 CHECK(valid_to IS NULL OR valid_to>valid_from)
);
CREATE FUNCTION authz.pricing_workspace_right(p_workspace uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND authz.capable(authz.actor_id(),'pricing',p_verb,'CONFIDENTIAL')
 AND EXISTS(SELECT 1 FROM authz.workspace_permission w JOIN authz.tenant t ON t.id=w.tenant_id
 WHERE w.tenant_id=authz.tenant_id() AND w.workspace_id=p_workspace AND w.user_id=authz.actor_id()
 AND w.object_type='pricing' AND w.verb=p_verb AND w.field_class='CONFIDENTIAL'
 AND w.policy_version=t.policy_version AND w.revoked_at IS NULL
 AND tstzrange(w.effective_from,w.effective_to,'[)') @> statement_timestamp())
$$;
CREATE FUNCTION authz.pricing_allowed(p_id uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM rpt.price_list p WHERE p.tenant_id=authz.tenant_id() AND p.id=p_id
  AND authz.allowed('pricing',p.id,p_verb,'CONFIDENTIAL')
  AND authz.market_authorized(p.market_id,'pricing',p_verb)
  AND (p_verb<>'read' OR p.status='active' OR authz.market_admin_scope(p.market_id,'read')))
$$;
CREATE FUNCTION authz.commerce_source_right(p_domain text,p_system text,p_authority text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p_domain IN ('market_catalog','pricing','fx') AND authz.session_valid()
 AND EXISTS(SELECT 1 FROM authz.source_authority a WHERE a.tenant_id=authz.tenant_id()
 AND a.user_id=authz.actor_id() AND a.domain_key=p_domain AND a.source_system=p_system
 AND a.authority_level=p_authority AND a.revoked_at IS NULL)
$$;
CREATE FUNCTION authz.price_list_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE market_currency text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.tenant_id,NEW.id,NEW.market_id,NEW.workspace_id,NEW.owner_id,NEW.stable_key,
   NEW.name,NEW.currency,NEW.valid_from,NEW.created_at)
   IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.market_id,OLD.workspace_id,OLD.owner_id,OLD.stable_key,
   OLD.name,OLD.currency,OLD.valid_from,OLD.created_at)
  OR OLD.status='closed' OR (NEW.status<>OLD.status AND NOT (
    authz.market_admin_scope(NEW.market_id,'manage')
    AND authz.capable(authz.actor_id(),'pricing','manage','CONFIDENTIAL')
    AND ((OLD.status='draft' AND NEW.status='active'
      AND EXISTS(SELECT 1 FROM rpt.catalog_market cm WHERE cm.tenant_id=NEW.tenant_id
        AND cm.market_id=NEW.market_id AND cm.status='active'))
      OR (OLD.status='active' AND NEW.status='closed'))))
   OR (NEW.valid_to IS DISTINCT FROM OLD.valid_to AND NEW.status<>'closed')
   OR NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'invalid_price_list_transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 SELECT m.currency INTO market_currency FROM rpt.market m WHERE m.tenant_id=NEW.tenant_id AND m.id=NEW.market_id;
  IF market_currency IS DISTINCT FROM NEW.currency OR NEW.owner_id<>authz.actor_id()
  OR NEW.status<>'draft'
  OR NOT authz.pricing_workspace_right(NEW.workspace_id,'create')
  OR NOT authz.market_authorized(NEW.market_id,'pricing','create')
  OR NOT EXISTS(SELECT 1 FROM rpt.catalog_market cm WHERE cm.tenant_id=NEW.tenant_id
   AND cm.market_id=NEW.market_id AND (NEW.status='draft' OR cm.status='active'))
 THEN RAISE EXCEPTION 'price_list_permission_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO authz.object_access(tenant_id,object_type,object_id,workspace_id,owner_id)
 VALUES(NEW.tenant_id,'pricing',NEW.id,NEW.workspace_id,NEW.owner_id);
 INSERT INTO authz.ownership_history(tenant_id,object_type,object_id,workspace_id,owner_id)
 VALUES(NEW.tenant_id,'pricing',NEW.id,NEW.workspace_id,NEW.owner_id);
 RETURN NEW;
END $$;
CREATE TRIGGER price_list_guard BEFORE INSERT OR UPDATE ON rpt.price_list
FOR EACH ROW EXECUTE FUNCTION authz.price_list_guard();

-- Half-open intervals prevent boundary ambiguity. Price facts never UPDATE;
-- a new interval is a new row with its own immutable observation.
CREATE TABLE rpt.price_list_entry (
 tenant_id uuid NOT NULL, id uuid NOT NULL, price_list_id uuid NOT NULL,
 market_product_id uuid NOT NULL, market_id uuid NOT NULL,
 currency text NOT NULL, amount numeric(18,4) NOT NULL CHECK(amount>=0),
 tax_treatment text NOT NULL CHECK(tax_treatment IN ('tax_inclusive','tax_exclusive','tax_not_applicable','tax_unknown')),
 tax_rate numeric(9,6) CHECK(tax_rate>=0 AND tax_rate<=1),
 source_literal text NOT NULL CHECK(length(source_literal) BETWEEN 1 AND 1000),
 valid_from timestamptz NOT NULL, valid_to timestamptz,
 observation_id uuid NOT NULL, actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,price_list_id,market_id,currency) REFERENCES rpt.price_list(tenant_id,id,market_id,currency),
 FOREIGN KEY(tenant_id,market_product_id,market_id) REFERENCES rpt.market_product(tenant_id,id,market_id),
 FOREIGN KEY(tenant_id,observation_id) REFERENCES rpt.source_observation,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account,
 CHECK(valid_to IS NULL OR valid_to>valid_from),
 CHECK(tax_treatment<>'tax_unknown' OR tax_rate IS NULL),
 EXCLUDE USING gist (tenant_id extensions.gist_uuid_ops WITH =,
  price_list_id extensions.gist_uuid_ops WITH =, market_product_id extensions.gist_uuid_ops WITH =,
  tstzrange(valid_from,valid_to,'[)') WITH &&)
);
CREATE INDEX price_list_entry_lookup ON rpt.price_list_entry(tenant_id,price_list_id,market_product_id,valid_from DESC);
CREATE FUNCTION authz.price_entry_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p rpt.price_list%ROWTYPE; m rpt.market_product%ROWTYPE; minor integer; o rpt.source_observation%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.tenant_id,NEW.id,NEW.price_list_id,NEW.market_product_id,NEW.market_id,
   NEW.currency,NEW.amount,NEW.tax_treatment,NEW.tax_rate,NEW.source_literal,
   NEW.valid_from,NEW.observation_id,NEW.actor_id,NEW.created_at)
   IS DISTINCT FROM
   (OLD.tenant_id,OLD.id,OLD.price_list_id,OLD.market_product_id,OLD.market_id,
   OLD.currency,OLD.amount,OLD.tax_treatment,OLD.tax_rate,OLD.source_literal,
   OLD.valid_from,OLD.observation_id,OLD.actor_id,OLD.created_at)
   OR OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL OR NEW.valid_to<=OLD.valid_from
   OR NOT authz.pricing_allowed(OLD.price_list_id,'update')
  THEN RAISE EXCEPTION 'invalid_price_supersession' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO p FROM rpt.price_list WHERE tenant_id=NEW.tenant_id AND id=NEW.price_list_id;
 SELECT * INTO m FROM rpt.market_product WHERE tenant_id=NEW.tenant_id AND id=NEW.market_product_id;
 SELECT minor_units INTO minor FROM rpt.catalog_currency WHERE tenant_id=NEW.tenant_id AND code=NEW.currency;
 SELECT * INTO o FROM rpt.source_observation WHERE tenant_id=NEW.tenant_id AND id=NEW.observation_id;
 IF p.id IS NULL OR m.id IS NULL OR p.status NOT IN ('active','draft') OR p.market_id<>m.market_id
  OR (p.status='draft' AND NOT authz.market_admin_scope(p.market_id,'manage'))
  OR NEW.market_id<>p.market_id OR NEW.currency<>p.currency OR NEW.amount<>round(NEW.amount,minor)
  OR NEW.valid_from<p.valid_from OR (p.valid_to IS NOT NULL AND (NEW.valid_to IS NULL OR NEW.valid_to>p.valid_to))
  OR NEW.actor_id<>authz.actor_id() OR NOT authz.pricing_allowed(p.id,'update')
  OR NOT authz.catalog_allowed(m.id,'read')
  OR o.domain_key<>'pricing' OR o.subject_id<>p.id
  OR o.facts->>'sourceLiteral' IS DISTINCT FROM NEW.source_literal
  OR o.facts->>'currency' IS DISTINCT FROM NEW.currency
  OR o.facts->>'amount' IS DISTINCT FROM NEW.amount::text
  OR o.facts->>'taxTreatment' IS DISTINCT FROM NEW.tax_treatment
  OR o.facts->>'taxRate' IS DISTINCT FROM NEW.tax_rate::text
 THEN RAISE EXCEPTION 'invalid_price_entry' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER price_entry_guard BEFORE INSERT OR UPDATE ON rpt.price_list_entry
FOR EACH ROW EXECUTE FUNCTION authz.price_entry_guard();

-- Market-scoped reference rates cannot become published PriceListEntry rows.
CREATE TABLE rpt.exchange_rate (
 tenant_id uuid NOT NULL, id uuid NOT NULL, market_id uuid NOT NULL,
 base_currency text NOT NULL, quote_currency text NOT NULL,
 rate numeric(24,10) NOT NULL CHECK(rate>0),
 valid_from timestamptz NOT NULL, valid_to timestamptz,
 status text NOT NULL CHECK(status IN ('active','retired')),
 source_literal text NOT NULL CHECK(length(source_literal) BETWEEN 1 AND 1000),
 observation_id uuid NOT NULL, actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,market_id) REFERENCES rpt.catalog_market,
 FOREIGN KEY(tenant_id,base_currency) REFERENCES rpt.catalog_currency,
 FOREIGN KEY(tenant_id,quote_currency) REFERENCES rpt.catalog_currency,
 FOREIGN KEY(tenant_id,observation_id) REFERENCES rpt.source_observation,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account,
 CHECK(base_currency<>quote_currency), CHECK(valid_to IS NULL OR valid_to>valid_from),
 EXCLUDE USING gist (tenant_id extensions.gist_uuid_ops WITH =,
 market_id extensions.gist_uuid_ops WITH =, base_currency WITH =, quote_currency WITH =,
 tstzrange(valid_from,valid_to,'[)') WITH &&)
);
CREATE INDEX exchange_rate_lookup ON rpt.exchange_rate(tenant_id,market_id,base_currency,quote_currency,valid_from DESC);
CREATE FUNCTION authz.exchange_rate_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o rpt.source_observation%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.tenant_id,NEW.id,NEW.market_id,NEW.base_currency,NEW.quote_currency,
   NEW.rate,NEW.valid_from,NEW.source_literal,NEW.observation_id,NEW.actor_id,NEW.created_at)
   IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.market_id,OLD.base_currency,OLD.quote_currency,
   OLD.rate,OLD.valid_from,OLD.source_literal,OLD.observation_id,OLD.actor_id,OLD.created_at)
   OR OLD.valid_to IS NOT NULL OR OLD.status<>'active' OR NEW.status<>'retired'
   OR NEW.valid_to IS NULL OR NEW.valid_to<=OLD.valid_from
   OR NOT authz.market_admin_scope(OLD.market_id,'manage')
  THEN RAISE EXCEPTION 'invalid_fx_retirement' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO o FROM rpt.source_observation WHERE tenant_id=NEW.tenant_id AND id=NEW.observation_id;
 IF NEW.status<>'active' OR NEW.actor_id<>authz.actor_id()
  OR NOT authz.market_admin_scope(NEW.market_id,'manage')
  OR NOT authz.market_authorized(NEW.market_id,'pricing','create')
  OR o.id IS NULL OR o.domain_key<>'fx' OR o.subject_id<>NEW.market_id
  OR o.facts->>'rateId' IS DISTINCT FROM NEW.id::text
  OR o.facts->>'rate' IS DISTINCT FROM NEW.rate::text
  OR o.facts->>'baseCurrency' IS DISTINCT FROM NEW.base_currency
  OR o.facts->>'quoteCurrency' IS DISTINCT FROM NEW.quote_currency
  OR o.facts->>'sourceLiteral' IS DISTINCT FROM NEW.source_literal
 THEN RAISE EXCEPTION 'invalid_fx_evidence' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER exchange_rate_guard BEFORE INSERT OR UPDATE ON rpt.exchange_rate
 FOR EACH ROW EXECUTE FUNCTION authz.exchange_rate_guard();

-- SourceObservation predates commerce and has a polymorphic UUID subject. A
-- commerce observation must name its actual parent kind; dependent availability,
-- price-entry and FX rows additionally carry tenant-safe observation FKs and
-- guards that bind the observation to that exact historical row.
ALTER TABLE rpt.source_observation ADD COLUMN commerce_subject_type text;
ALTER TABLE rpt.source_observation ADD CONSTRAINT commerce_subject_type_check CHECK (
 (domain_key='market_catalog' AND commerce_subject_type IS NOT NULL
  AND commerce_subject_type IN ('market','market_product'))
 OR (domain_key='pricing' AND commerce_subject_type IS NOT NULL AND commerce_subject_type='price_list')
 OR (domain_key='fx' AND commerce_subject_type IS NOT NULL AND commerce_subject_type='market')
 OR (domain_key NOT IN ('market_catalog','pricing','fx') AND commerce_subject_type IS NULL)
);
CREATE FUNCTION authz.commerce_evidence_subject_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.domain_key NOT IN ('market_catalog','pricing','fx') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  RAISE EXCEPTION 'immutable_commerce_evidence' USING ERRCODE='23514';
 END IF;
 IF NOT COALESCE((
  (NEW.domain_key='market_catalog' AND NEW.commerce_subject_type='market'
   AND EXISTS(SELECT 1 FROM rpt.catalog_market m WHERE m.tenant_id=NEW.tenant_id AND m.market_id=NEW.subject_id))
  OR (NEW.domain_key='market_catalog' AND NEW.commerce_subject_type='market_product'
   AND EXISTS(SELECT 1 FROM rpt.market_product m WHERE m.tenant_id=NEW.tenant_id AND m.id=NEW.subject_id))
  OR (NEW.domain_key='pricing' AND NEW.commerce_subject_type='price_list'
   AND EXISTS(SELECT 1 FROM rpt.price_list p WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.subject_id
    AND (NOT (NEW.facts ? 'listKey') OR p.stable_key=NEW.facts->>'listKey')))
  OR (NEW.domain_key='fx' AND NEW.commerce_subject_type='market'
   AND EXISTS(SELECT 1 FROM rpt.catalog_market m WHERE m.tenant_id=NEW.tenant_id AND m.market_id=NEW.subject_id))
 ),false) THEN RAISE EXCEPTION 'invalid_commerce_evidence_subject' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_evidence_subject_guard BEFORE INSERT OR UPDATE ON rpt.source_observation
 FOR EACH ROW EXECUTE FUNCTION authz.commerce_evidence_subject_guard();

CREATE FUNCTION authz.commerce_receipt(p_operation text,p_key text,p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r authz.idempotency_receipt%ROWTYPE;
BEGIN
 IF NOT authz.session_valid() OR p_operation NOT IN ('catalog.v1','pricing.v1')
  OR length(p_key) NOT BETWEEN 8 AND 128
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||'/'||p_operation||'/'||p_key,0));
 SELECT * INTO r FROM authz.idempotency_receipt WHERE tenant_id=authz.tenant_id()
 AND operation=p_operation AND key=p_key;
 IF FOUND THEN
  IF r.actor_id<>authz.actor_id() OR r.request_hash<>p_hash
  THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN r.response;
 END IF;
 INSERT INTO authz.idempotency_receipt(tenant_id,operation,key,actor_id,request_hash)
 VALUES(authz.tenant_id(),p_operation,p_key,authz.actor_id(),p_hash);
 RETURN NULL;
END $$;
CREATE FUNCTION authz.commerce_finish(p_operation text,p_key text,p_response jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR p_operation NOT IN ('catalog.v1','pricing.v1')
  OR pg_column_size(p_response)>2048
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 UPDATE authz.idempotency_receipt SET response=p_response WHERE tenant_id=authz.tenant_id()
 AND operation=p_operation AND key=p_key AND actor_id=authz.actor_id() AND response IS NULL;
END $$;

ALTER TABLE rpt.catalog_currency ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.catalog_market ENABLE ROW LEVEL SECURITY;
ALTER TABLE authz.operational_market_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE authz.admin_market_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.market_product ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.market_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.price_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.price_list_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.exchange_rate ENABLE ROW LEVEL SECURITY;
CREATE POLICY catalog_currency_read ON rpt.catalog_currency FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND (authz.tenant_allowed(tenant_id,'catalog','read','CONFIDENTIAL')
 OR (authz.session_valid() AND authz.capable(authz.actor_id(),'market_admin','manage','CONFIDENTIAL')
 AND authz.capable(authz.actor_id(),'market_admin','global','CONFIDENTIAL'))));
CREATE POLICY catalog_currency_register ON rpt.catalog_currency FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND created_by=authz.actor_id()
 AND authz.capable(authz.actor_id(),'market_admin','manage','CONFIDENTIAL')
 AND authz.capable(authz.actor_id(),'market_admin','global','CONFIDENTIAL'));
CREATE POLICY catalog_currency_update ON rpt.catalog_currency FOR UPDATE TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.capable(authz.actor_id(),'market_admin','manage','CONFIDENTIAL')
 AND authz.capable(authz.actor_id(),'market_admin','global','CONFIDENTIAL'))
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.capable(authz.actor_id(),'market_admin','manage','CONFIDENTIAL')
 AND authz.capable(authz.actor_id(),'market_admin','global','CONFIDENTIAL'));
CREATE POLICY catalog_market_read ON rpt.catalog_market FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.market_authorized(market_id,'catalog','read'));
CREATE POLICY catalog_market_create ON rpt.catalog_market FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND status='draft'
 AND authz.capable(authz.actor_id(),'catalog','create','CONFIDENTIAL')
 AND authz.capable(authz.actor_id(),'market_admin','manage','CONFIDENTIAL')
 AND authz.capable(authz.actor_id(),'market_admin','global','CONFIDENTIAL'));
CREATE POLICY catalog_market_update ON rpt.catalog_market FOR UPDATE TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.market_authorized(market_id,'catalog','update')
 AND authz.market_admin_scope(market_id,'manage'))
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.market_authorized(market_id,'catalog','update')
 AND authz.market_admin_scope(market_id,'manage'));
CREATE POLICY catalog_base_market_create ON rpt.market FOR INSERT TO rpt_runtime
 WITH CHECK(authz.tenant_allowed(tenant_id,'catalog','create','CONFIDENTIAL')
 AND authz.capable(authz.actor_id(),'market_admin','manage','CONFIDENTIAL')
 AND authz.capable(authz.actor_id(),'market_admin','global','CONFIDENTIAL')
 AND code ~ '^[A-Z]{2}$');
CREATE POLICY catalog_base_market_read ON rpt.market FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND (authz.market_authorized(id,'catalog','read')
 OR (authz.session_valid() AND authz.capable(authz.actor_id(),'catalog','create','CONFIDENTIAL')
 AND authz.capable(authz.actor_id(),'market_admin','manage','CONFIDENTIAL')
 AND authz.capable(authz.actor_id(),'market_admin','global','CONFIDENTIAL'))));
CREATE POLICY operational_assignment_read ON authz.operational_market_assignment FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.session_valid()
 AND (user_id=authz.actor_id() OR authz.market_admin_scope(market_id,'read')));
CREATE POLICY operational_assignment_insert ON authz.operational_market_assignment FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND user_id<>authz.actor_id()
 AND assigned_by=authz.actor_id() AND authz.market_admin_scope(market_id,'manage'));
CREATE POLICY operational_assignment_close ON authz.operational_market_assignment FOR UPDATE TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND user_id<>authz.actor_id() AND authz.market_admin_scope(market_id,'manage'))
 WITH CHECK(tenant_id=authz.tenant_id() AND user_id<>authz.actor_id() AND authz.market_admin_scope(market_id,'manage'));
CREATE POLICY admin_market_scope_read ON authz.admin_market_scope FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.session_valid()
 AND (user_id=authz.actor_id() OR authz.market_admin_scope(market_id,'read')));
CREATE POLICY admin_market_scope_insert ON authz.admin_market_scope FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND granted_by=authz.actor_id()
 AND authz.capable(authz.actor_id(),'market_admin','manage','CONFIDENTIAL')
 AND authz.capable(authz.actor_id(),'market_admin','global','CONFIDENTIAL'));
CREATE POLICY admin_market_scope_revoke ON authz.admin_market_scope FOR UPDATE TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.capable(authz.actor_id(),'market_admin','manage','CONFIDENTIAL')
 AND authz.capable(authz.actor_id(),'market_admin','global','CONFIDENTIAL'))
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.capable(authz.actor_id(),'market_admin','manage','CONFIDENTIAL')
 AND authz.capable(authz.actor_id(),'market_admin','global','CONFIDENTIAL'));
CREATE POLICY market_product_read ON rpt.market_product FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.catalog_allowed(id,'read'));
CREATE POLICY market_product_create ON rpt.market_product FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND owner_id=authz.actor_id()
 AND authz.market_authorized(market_id,'catalog','create')
 AND authz.product_allowed(node_id,'update'));
CREATE POLICY market_product_update ON rpt.market_product FOR UPDATE TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.catalog_allowed(id,'update'))
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.catalog_allowed(id,'update'));
CREATE POLICY market_availability_read ON rpt.market_availability FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.catalog_allowed(market_product_id,'read'));
CREATE POLICY market_availability_create ON rpt.market_availability FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id()
 AND authz.catalog_allowed(market_product_id,'update'));
CREATE POLICY price_list_read ON rpt.price_list FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.pricing_allowed(id,'read'));
CREATE POLICY price_list_create ON rpt.price_list FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND owner_id=authz.actor_id() AND status='draft'
 AND authz.pricing_workspace_right(workspace_id,'create')
 AND authz.market_authorized(market_id,'pricing','create'));
CREATE POLICY price_list_update ON rpt.price_list FOR UPDATE TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.pricing_allowed(id,'update'))
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.pricing_allowed(id,'update'));
CREATE POLICY price_entry_read ON rpt.price_list_entry FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.pricing_allowed(price_list_id,'read')
 AND authz.catalog_allowed(market_product_id,'read'));
CREATE POLICY price_entry_create ON rpt.price_list_entry FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id()
 AND authz.pricing_allowed(price_list_id,'update') AND authz.catalog_allowed(market_product_id,'read'));
CREATE POLICY price_entry_supersede ON rpt.price_list_entry FOR UPDATE TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.pricing_allowed(price_list_id,'update')
 AND authz.catalog_allowed(market_product_id,'read'))
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.pricing_allowed(price_list_id,'update')
 AND authz.catalog_allowed(market_product_id,'read'));
CREATE POLICY exchange_rate_read ON rpt.exchange_rate FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.market_authorized(market_id,'pricing','read'));
CREATE POLICY exchange_rate_create ON rpt.exchange_rate FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id()
 AND authz.market_admin_scope(market_id,'manage')
 AND authz.market_authorized(market_id,'pricing','create'));
CREATE POLICY exchange_rate_retire ON rpt.exchange_rate FOR UPDATE TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.market_admin_scope(market_id,'manage')
 AND authz.market_authorized(market_id,'pricing','update'))
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.market_admin_scope(market_id,'manage')
 AND authz.market_authorized(market_id,'pricing','update'));

-- Existing permissive Trust policies OR together. Exclude BOTH new domains
-- before adding their scoped policies; otherwise trust.read could see prices.
DROP POLICY IF EXISTS trust_read ON rpt.source_observation;
DROP POLICY IF EXISTS trust_legacy_insert ON rpt.source_observation;
DROP POLICY IF EXISTS trust_legacy_update ON rpt.source_observation;
CREATE POLICY trust_read ON rpt.source_observation FOR SELECT TO rpt_runtime
 USING(domain_key NOT IN ('product_master','market_catalog','pricing','fx')
 AND authz.tenant_allowed(tenant_id,'trust','read','OFFICIAL_COMPENSATION'));
CREATE POLICY trust_legacy_insert ON rpt.source_observation FOR INSERT TO rpt_runtime
 WITH CHECK(domain_key NOT IN ('product_master','market_catalog','pricing','fx')
 AND authz.tenant_allowed(tenant_id,'trust','approve','OFFICIAL_COMPENSATION'));
CREATE POLICY trust_legacy_update ON rpt.source_observation FOR UPDATE TO rpt_runtime
 USING(domain_key NOT IN ('product_master','market_catalog','pricing','fx')
 AND authz.tenant_allowed(tenant_id,'trust','approve','OFFICIAL_COMPENSATION'))
 WITH CHECK(domain_key NOT IN ('product_master','market_catalog','pricing','fx')
 AND authz.tenant_allowed(tenant_id,'trust','approve','OFFICIAL_COMPENSATION'));
CREATE POLICY catalog_source_read ON rpt.source_observation FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND domain_key='market_catalog'
 AND ((commerce_subject_type='market' AND authz.market_admin_scope(subject_id,'read'))
 OR (commerce_subject_type='market_product' AND authz.catalog_allowed(subject_id,'read'))));
CREATE POLICY catalog_source_create ON rpt.source_observation FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND domain_key='market_catalog'
 AND actor_id=authz.actor_id() AND ((commerce_subject_type='market_product'
 AND authz.catalog_allowed(subject_id,'update')) OR (commerce_subject_type='market'
 AND authz.market_admin_scope(subject_id,'manage'))));
CREATE POLICY pricing_source_read ON rpt.source_observation FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND domain_key='pricing' AND commerce_subject_type='price_list'
 AND authz.pricing_allowed(subject_id,'read'));
CREATE POLICY pricing_source_create ON rpt.source_observation FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND domain_key='pricing' AND commerce_subject_type='price_list'
 AND actor_id=authz.actor_id() AND (authz.pricing_allowed(subject_id,'update')
 OR (facts ? 'listKey' AND authz.pricing_allowed(subject_id,'create'))));
CREATE POLICY fx_source_read ON rpt.source_observation FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND domain_key='fx' AND commerce_subject_type='market'
 AND authz.market_authorized(subject_id,'pricing','read'));
CREATE POLICY fx_source_create ON rpt.source_observation FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND domain_key='fx' AND commerce_subject_type='market' AND actor_id=authz.actor_id()
 AND authz.market_admin_scope(subject_id,'manage')
 AND authz.market_authorized(subject_id,'pricing','create'));

GRANT SELECT,INSERT,UPDATE ON rpt.catalog_currency TO rpt_runtime;
GRANT SELECT,INSERT ON rpt.market TO rpt_runtime;
GRANT SELECT,INSERT,UPDATE ON rpt.catalog_market,rpt.market_product,rpt.price_list TO rpt_runtime;
GRANT SELECT,INSERT ON rpt.market_availability TO rpt_runtime;
GRANT SELECT,INSERT,UPDATE ON rpt.price_list_entry TO rpt_runtime;
GRANT SELECT,INSERT,UPDATE ON rpt.exchange_rate TO rpt_runtime;
GRANT SELECT,INSERT,UPDATE ON authz.operational_market_assignment,authz.admin_market_scope TO rpt_runtime;
REVOKE ALL ON FUNCTION authz.pricing_workspace_right(uuid,text),authz.pricing_allowed(uuid,text),authz.catalog_allowed(uuid,text),
 authz.commerce_source_right(text,text,text),authz.commerce_receipt(text,text,text),authz.commerce_finish(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.pricing_workspace_right(uuid,text),authz.pricing_allowed(uuid,text),authz.catalog_allowed(uuid,text),
 authz.commerce_source_right(text,text,text),authz.commerce_receipt(text,text,text),authz.commerce_finish(text,text,jsonb) TO rpt_runtime;
REVOKE ALL ON FUNCTION authz.market_admin_scope(uuid,text),authz.market_authorized(uuid,text,text),authz.operational_market(),authz.market_user_exists(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.market_admin_scope(uuid,text),authz.market_authorized(uuid,text,text),authz.operational_market(),authz.market_user_exists(uuid) TO rpt_runtime;
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE ON rpt.catalog_currency FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE ON rpt.catalog_market FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE ON authz.operational_market_assignment FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE ON authz.admin_market_scope FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE ON rpt.market_product FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.market_availability FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE ON rpt.price_list FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE ON rpt.price_list_entry FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE ON rpt.exchange_rate FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['market_availability'] LOOP
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON rpt.%I FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable()',tbl);
 END LOOP;
END $$;
