SET LOCAL ROLE rpt_owner;

-- One tenant-local identity tree. A root is market-independent, not cross-tenant.
CREATE TABLE rpt.product_node (
 tenant_id uuid NOT NULL REFERENCES authz.tenant, id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('product','model','variant')),
 parent_id uuid, root_id uuid NOT NULL, workspace_id uuid NOT NULL, owner_id uuid NOT NULL,
 stable_key text NOT NULL CHECK(stable_key ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 lifecycle text CHECK(lifecycle IN ('draft','active','discontinued')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,parent_id) REFERENCES rpt.product_node,
 FOREIGN KEY(tenant_id,root_id) REFERENCES rpt.product_node DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,owner_id) REFERENCES authz.user_account,
 CHECK((kind='product' AND parent_id IS NULL AND root_id=id AND lifecycle IS NOT NULL)
    OR (kind='model' AND parent_id IS NOT NULL AND root_id<>id AND lifecycle IS NOT NULL)
    OR (kind='variant' AND parent_id IS NOT NULL AND root_id<>id AND lifecycle IS NULL))
);
CREATE UNIQUE INDEX product_root_key ON rpt.product_node(tenant_id,stable_key) WHERE kind='product';
CREATE UNIQUE INDEX product_child_key ON rpt.product_node(tenant_id,parent_id,kind,stable_key) WHERE parent_id IS NOT NULL;
CREATE INDEX product_tree_idx ON rpt.product_node(tenant_id,root_id,kind,id);

CREATE FUNCTION authz.product_workspace_right(p_workspace uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND authz.capable(authz.actor_id(),'product',p_verb,'CONFIDENTIAL')
 AND EXISTS(SELECT 1 FROM authz.workspace_permission w JOIN authz.tenant t ON t.id=w.tenant_id
 WHERE w.tenant_id=authz.tenant_id() AND w.workspace_id=p_workspace AND w.user_id=authz.actor_id()
 AND w.object_type='product' AND w.verb=p_verb AND w.field_class='CONFIDENTIAL'
 AND w.policy_version=t.policy_version AND w.revoked_at IS NULL
 AND tstzrange(w.effective_from,w.effective_to,'[)') @> statement_timestamp())
$$;
CREATE FUNCTION authz.product_allowed(p_node uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM rpt.product_node n WHERE n.tenant_id=authz.tenant_id() AND n.id=p_node
 AND authz.allowed('product',n.root_id,p_verb,'CONFIDENTIAL'))
$$;
CREATE FUNCTION authz.product_source_right(p_system text,p_authority text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND EXISTS(SELECT 1 FROM authz.source_authority a
 WHERE a.tenant_id=authz.tenant_id() AND a.user_id=authz.actor_id()
 AND a.source_system=p_system AND a.domain_key='product_master'
 AND a.authority_level=p_authority AND a.revoked_at IS NULL)
$$;
CREATE FUNCTION authz.product_ownership_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.kind='product' THEN
  INSERT INTO authz.object_access(tenant_id,object_type,object_id,workspace_id,owner_id)
  VALUES(NEW.tenant_id,'product',NEW.id,NEW.workspace_id,NEW.owner_id);
  INSERT INTO authz.ownership_history(tenant_id,object_type,object_id,workspace_id,owner_id)
  VALUES(NEW.tenant_id,'product',NEW.id,NEW.workspace_id,NEW.owner_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER product_ownership_sync AFTER INSERT ON rpt.product_node
FOR EACH ROW EXECUTE FUNCTION authz.product_ownership_sync();
CREATE FUNCTION authz.product_node_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE parent_row rpt.product_node%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.tenant_id,NEW.id,NEW.kind,NEW.parent_id,NEW.root_id,NEW.workspace_id,NEW.owner_id,
      NEW.stable_key,NEW.name,NEW.created_at) IS DISTINCT FROM
     (OLD.tenant_id,OLD.id,OLD.kind,OLD.parent_id,OLD.root_id,OLD.workspace_id,OLD.owner_id,
      OLD.stable_key,OLD.name,OLD.created_at) OR NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'immutable_product_identity' USING ERRCODE='23514'; END IF;
  IF NEW.kind='variant' OR NOT authz.product_allowed(NEW.id,'update')
  THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
  NEW.updated_at=clock_timestamp(); RETURN NEW;
 END IF;
 IF NEW.version<>1 THEN RAISE EXCEPTION 'invalid_version' USING ERRCODE='23514'; END IF;
 IF NEW.kind='product' THEN
  IF NEW.owner_id<>authz.actor_id() OR NOT authz.product_workspace_right(NEW.workspace_id,'create')
  THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 ELSE
  SELECT * INTO parent_row FROM rpt.product_node WHERE tenant_id=NEW.tenant_id AND id=NEW.parent_id;
  IF NOT FOUND OR (NEW.kind='model' AND parent_row.kind<>'product')
   OR (NEW.kind='variant' AND parent_row.kind<>'model')
   OR parent_row.root_id<>NEW.root_id OR parent_row.workspace_id<>NEW.workspace_id
   OR parent_row.owner_id<>NEW.owner_id OR NOT authz.product_allowed(NEW.root_id,'update')
  THEN RAISE EXCEPTION 'invalid_product_parent' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER product_node_guard BEFORE INSERT OR UPDATE ON rpt.product_node
FOR EACH ROW EXECUTE FUNCTION authz.product_node_guard();

CREATE TABLE rpt.product_taxon_group (
 tenant_id uuid NOT NULL REFERENCES authz.tenant, id uuid NOT NULL DEFAULT gen_random_uuid(),
 slug text NOT NULL CHECK(slug ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,slug), UNIQUE(tenant_id,id)
);
CREATE FUNCTION authz.seed_product_taxon_groups() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE group_slug text;
BEGIN
 FOREACH group_slug IN ARRAY ARRAY['category','subcategory','family','material','technology','function','compatibility','care','status','evidence','unit'] LOOP
  INSERT INTO rpt.product_taxon_group(tenant_id,slug,label) VALUES(NEW.id,group_slug,group_slug);
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER seed_product_taxon_groups AFTER INSERT ON authz.tenant
FOR EACH ROW EXECUTE FUNCTION authz.seed_product_taxon_groups();
INSERT INTO rpt.product_taxon_group(tenant_id,slug,label)
SELECT t.id,g.slug,g.slug FROM authz.tenant t
CROSS JOIN unnest(ARRAY['category','subcategory','family','material','technology','function','compatibility','care','status','evidence','unit']) AS g(slug);
CREATE TABLE rpt.product_taxon (
 tenant_id uuid NOT NULL REFERENCES authz.tenant, id uuid NOT NULL DEFAULT gen_random_uuid(),
 group_key text NOT NULL,
 slug text NOT NULL CHECK(slug ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,group_key,slug), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,group_key) REFERENCES rpt.product_taxon_group
);
CREATE TABLE rpt.product_taxon_assignment (
 tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
 node_id uuid NOT NULL, group_key text NOT NULL, slug text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,node_id,group_key,slug), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,node_id) REFERENCES rpt.product_node,
 FOREIGN KEY(tenant_id,group_key,slug) REFERENCES rpt.product_taxon
);
CREATE TABLE rpt.product_code (
 tenant_id uuid NOT NULL, id uuid NOT NULL, node_id uuid NOT NULL,
 code_kind text NOT NULL CHECK(code_kind IN ('sku','model','market','source')),
 scope_kind text NOT NULL CHECK(scope_kind IN ('tenant','market','source')),
 scope_key text NOT NULL CHECK(scope_key ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
 code text NOT NULL CHECK(length(code) BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,scope_kind,scope_key,code_kind,code),
 FOREIGN KEY(tenant_id,node_id) REFERENCES rpt.product_node,
 CHECK(scope_kind<>'tenant' OR scope_key='global')
);
-- Numeric is exact. A normalized value is absent for pending/name-only evidence.
CREATE TABLE rpt.product_fact (
 tenant_id uuid NOT NULL, id uuid NOT NULL, node_id uuid NOT NULL,
 fact_kind text NOT NULL CHECK(fact_kind IN ('material','composition','construction','technology','function','capacity','dimension','compatibility','care','certification','disclosure')),
 value_kind text NOT NULL CHECK(value_kind IN ('text','decimal','taxon')),
 value_text text, value_decimal numeric(18,6), unit_group text, unit_slug text,
 taxon_group text, taxon_slug text,
 source_literal text NOT NULL CHECK(length(source_literal) BETWEEN 1 AND 1000),
 source_scope_kind text NOT NULL CHECK(source_scope_kind IN ('tenant','market','source')),
 source_scope_key text NOT NULL CHECK(length(source_scope_key) BETWEEN 1 AND 80),
 evidence_level text NOT NULL CHECK(evidence_level IN ('exact_primary','component_primary','equivalent_market','disclosure_by_code','name_only','pending')),
 observation_id uuid NOT NULL, previous_fact_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,previous_fact_id),
 FOREIGN KEY(tenant_id,node_id) REFERENCES rpt.product_node,
 FOREIGN KEY(tenant_id,observation_id) REFERENCES rpt.source_observation,
 FOREIGN KEY(tenant_id,previous_fact_id) REFERENCES rpt.product_fact,
 FOREIGN KEY(tenant_id,unit_group,unit_slug) REFERENCES rpt.product_taxon(tenant_id,group_key,slug),
 FOREIGN KEY(tenant_id,taxon_group,taxon_slug) REFERENCES rpt.product_taxon(tenant_id,group_key,slug),
 CHECK((unit_group IS NULL AND unit_slug IS NULL) OR (unit_group='unit' AND unit_slug IS NOT NULL)),
 CHECK((taxon_group IS NULL AND taxon_slug IS NULL) OR (taxon_group IS NOT NULL AND taxon_group<>'unit' AND taxon_slug IS NOT NULL)),
 CHECK(value_kind<>'taxon' OR taxon_group=fact_kind),
 CHECK((evidence_level IN ('pending','name_only') AND value_text IS NULL AND value_decimal IS NULL AND taxon_group IS NULL AND unit_group IS NULL)
    OR (evidence_level NOT IN ('pending','name_only') AND
      ((value_kind='text' AND value_text IS NOT NULL AND value_decimal IS NULL AND taxon_group IS NULL AND unit_group IS NULL)
       OR (value_kind='decimal' AND value_text IS NULL AND value_decimal IS NOT NULL AND unit_group='unit' AND taxon_group IS NULL)
       OR (value_kind='taxon' AND value_text IS NULL AND value_decimal IS NULL AND taxon_group IS NOT NULL AND unit_group IS NULL))))
);
CREATE INDEX product_fact_node_idx ON rpt.product_fact(tenant_id,node_id,created_at,id);
CREATE TABLE rpt.product_relation (
 tenant_id uuid NOT NULL, id uuid NOT NULL, from_node_id uuid NOT NULL, to_node_id uuid NOT NULL,
 relation_kind text NOT NULL CHECK(relation_kind IN ('contains','component_of','accessory_for','compatible_with','replacement_for','supersedes','equivalent_to','related_to')),
 observation_id uuid NOT NULL,
 evidence_level text NOT NULL CHECK(evidence_level IN ('exact_primary','component_primary','equivalent_market','disclosure_by_code')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,from_node_id,to_node_id,relation_kind),
 FOREIGN KEY(tenant_id,from_node_id) REFERENCES rpt.product_node,
 FOREIGN KEY(tenant_id,to_node_id) REFERENCES rpt.product_node,
 FOREIGN KEY(tenant_id,observation_id) REFERENCES rpt.source_observation,
 CHECK(from_node_id<>to_node_id)
);

CREATE FUNCTION authz.product_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p_subject uuid; evidence_row rpt.source_observation%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='product_fact' THEN p_subject:=NEW.node_id;
 ELSIF TG_TABLE_NAME='product_relation' THEN p_subject:=NEW.from_node_id;
 END IF;
 SELECT * INTO evidence_row FROM rpt.source_observation o WHERE o.tenant_id=NEW.tenant_id
 AND o.id=NEW.observation_id AND o.subject_id=p_subject AND o.domain_key='product_master';
 IF NOT FOUND OR (evidence_row.facts->>'evidenceLevel') IS DISTINCT FROM NEW.evidence_level
 OR (NEW.evidence_level NOT IN ('pending','name_only')
  AND evidence_row.authority_level NOT IN ('official','verified'))
 THEN RAISE EXCEPTION 'evidence_subject_or_level_mismatch' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='product_fact' THEN
  IF (evidence_row.facts->>'sourceLiteral') IS DISTINCT FROM NEW.source_literal
   OR (evidence_row.facts->'sourceScope'->>'kind') IS DISTINCT FROM NEW.source_scope_kind
   OR (evidence_row.facts->'sourceScope'->>'key') IS DISTINCT FROM NEW.source_scope_key
  THEN RAISE EXCEPTION 'evidence_literal_or_scope_mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.previous_fact_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM rpt.product_fact f WHERE f.tenant_id=NEW.tenant_id AND f.id=NEW.previous_fact_id
   AND f.node_id=NEW.node_id AND f.fact_kind=NEW.fact_kind)
  THEN RAISE EXCEPTION 'invalid_fact_supersession' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER product_fact_evidence BEFORE INSERT ON rpt.product_fact FOR EACH ROW EXECUTE FUNCTION authz.product_evidence_guard();
CREATE TRIGGER product_relation_evidence BEFORE INSERT ON rpt.product_relation FOR EACH ROW EXECUTE FUNCTION authz.product_evidence_guard();

CREATE FUNCTION authz.product_receipt(p_key text,p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r authz.idempotency_receipt%ROWTYPE;
BEGIN
 IF NOT authz.session_valid() OR length(p_key) NOT BETWEEN 8 AND 128
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||'/product/'||p_key,0));
 SELECT * INTO r FROM authz.idempotency_receipt WHERE tenant_id=authz.tenant_id()
 AND operation='product.v1' AND key=p_key;
 IF FOUND THEN
  IF r.actor_id<>authz.actor_id() OR r.request_hash<>p_hash
  THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN r.response;
 END IF;
 INSERT INTO authz.idempotency_receipt(tenant_id,operation,key,actor_id,request_hash)
 VALUES(authz.tenant_id(),'product.v1',p_key,authz.actor_id(),p_hash);
 RETURN NULL;
END $$;
CREATE FUNCTION authz.product_finish(p_key text,p_response jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR pg_column_size(p_response)>2048
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 UPDATE authz.idempotency_receipt SET response=p_response WHERE tenant_id=authz.tenant_id()
 AND operation='product.v1' AND key=p_key AND actor_id=authz.actor_id() AND response IS NULL;
END $$;

ALTER TABLE rpt.product_node ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.product_taxon_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.product_taxon ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.product_taxon_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.product_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.product_fact ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.product_relation ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_read ON rpt.product_node FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.product_allowed(id,'read'));
CREATE POLICY product_create ON rpt.product_node FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND
  ((kind='product' AND owner_id=authz.actor_id() AND authz.product_workspace_right(workspace_id,'create'))
   OR (kind<>'product' AND authz.product_allowed(root_id,'update'))));
CREATE POLICY product_update ON rpt.product_node FOR UPDATE TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.product_allowed(id,'update'))
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.product_allowed(id,'update'));
CREATE POLICY taxon_group_read ON rpt.product_taxon_group FOR SELECT TO rpt_runtime
 USING(authz.tenant_allowed(tenant_id,'product','read','CONFIDENTIAL'));
CREATE POLICY taxon_group_create ON rpt.product_taxon_group FOR INSERT TO rpt_runtime
 WITH CHECK(authz.tenant_allowed(tenant_id,'product','create','CONFIDENTIAL'));
CREATE POLICY taxon_read ON rpt.product_taxon FOR SELECT TO rpt_runtime
 USING(authz.tenant_allowed(tenant_id,'product','read','CONFIDENTIAL'));
CREATE POLICY taxon_create ON rpt.product_taxon FOR INSERT TO rpt_runtime
 WITH CHECK(authz.tenant_allowed(tenant_id,'product','create','CONFIDENTIAL'));
CREATE POLICY assignment_read ON rpt.product_taxon_assignment FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.product_allowed(node_id,'read'));
CREATE POLICY assignment_create ON rpt.product_taxon_assignment FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.product_allowed(node_id,'update'));
CREATE POLICY code_read ON rpt.product_code FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.product_allowed(node_id,'read'));
CREATE POLICY code_create ON rpt.product_code FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.product_allowed(node_id,'update'));
CREATE POLICY fact_read ON rpt.product_fact FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.product_allowed(node_id,'read'));
CREATE POLICY fact_create ON rpt.product_fact FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.product_allowed(node_id,'update'));
CREATE POLICY relation_read ON rpt.product_relation FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.product_allowed(from_node_id,'read') AND authz.product_allowed(to_node_id,'read'));
CREATE POLICY relation_create ON rpt.product_relation FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND authz.product_allowed(from_node_id,'update') AND authz.product_allowed(to_node_id,'read'));
CREATE POLICY product_source_read ON rpt.source_observation FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND domain_key='product_master' AND authz.product_allowed(subject_id,'read'));
CREATE POLICY product_source_create ON rpt.source_observation FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND domain_key='product_master' AND actor_id=authz.actor_id()
 AND authz.product_allowed(subject_id,'update'));
-- Existing trust-wide policies must not turn product evidence into a tenant-wide read bypass.
DROP POLICY IF EXISTS trust_read ON rpt.source_observation;
DROP POLICY IF EXISTS trust_write ON rpt.source_observation;
DROP POLICY IF EXISTS trust_insert ON rpt.source_observation;
DROP POLICY IF EXISTS trust_update ON rpt.source_observation;
CREATE POLICY trust_read ON rpt.source_observation FOR SELECT TO rpt_runtime
 USING(domain_key<>'product_master' AND authz.tenant_allowed(tenant_id,'trust','read','OFFICIAL_COMPENSATION'));
CREATE POLICY trust_legacy_insert ON rpt.source_observation FOR INSERT TO rpt_runtime
 WITH CHECK(domain_key<>'product_master' AND authz.tenant_allowed(tenant_id,'trust','approve','OFFICIAL_COMPENSATION'));
CREATE POLICY trust_legacy_update ON rpt.source_observation FOR UPDATE TO rpt_runtime
 USING(domain_key<>'product_master' AND authz.tenant_allowed(tenant_id,'trust','approve','OFFICIAL_COMPENSATION'))
 WITH CHECK(domain_key<>'product_master' AND authz.tenant_allowed(tenant_id,'trust','approve','OFFICIAL_COMPENSATION'));

GRANT SELECT,INSERT,UPDATE ON rpt.product_node TO rpt_runtime;
GRANT SELECT,INSERT ON rpt.product_taxon_group,rpt.product_taxon,rpt.product_taxon_assignment,rpt.product_code,rpt.product_fact,rpt.product_relation TO rpt_runtime;
REVOKE ALL ON FUNCTION authz.product_workspace_right(uuid,text),authz.product_allowed(uuid,text),authz.product_source_right(text,text),
 authz.product_receipt(text,text),authz.product_finish(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.product_workspace_right(uuid,text),authz.product_allowed(uuid,text),authz.product_source_right(text,text),
 authz.product_receipt(text,text),authz.product_finish(text,jsonb) TO rpt_runtime;
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE ON rpt.product_node FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.product_taxon_group FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.product_taxon FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.product_taxon_assignment FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.product_code FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.product_fact FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.product_relation FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['product_taxon_group','product_taxon','product_taxon_assignment','product_code','product_fact','product_relation'] LOOP
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON rpt.%I FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable()',tbl);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION authz.record_decision(p_object uuid,p_action text,p_result text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR p_action NOT IN ('person.read','person.update','metric.append','grant.create','grant.revoke','privacy.purge','network.stats','crm.context','crm.list','crm.detail','crm.onboard','crm.create','crm.command','crm.view','crm.metrics','crm.grant','crm.import.preview','crm.import.confirm','recruiting.context','recruiting.list','recruiting.detail','recruiting.create','recruiting.command','agenda.list','agenda.detail','agenda.create','agenda.command','visit.list','visit.detail','visit.create','visit.command','product.list','product.detail','product.create','product.command') OR p_result NOT IN ('allow','deny','success','failure')
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO rpt.audit_event(tenant_id,actor_id,action,object_type,object_id,scope,policy_version,request_id,result,reason_code)
 VALUES(authz.tenant_id(),authz.actor_id(),p_action,'permission_decision',p_object,'request',(SELECT policy_version FROM authz.tenant WHERE id=authz.tenant_id()),nullif(current_setting('rpt.request_id',true),'')::uuid,p_result,'server_policy');
END $$;
