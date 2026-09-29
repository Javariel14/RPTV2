SET LOCAL ROLE rpt_owner;
-- Hold canonical writes until bootstrap and the initialization trigger commit together.
LOCK TABLE rpt.cpq_order IN SHARE ROW EXCLUSIVE MODE;
-- The accepted cpq_order remains immutable. These are commercial, not payment/company states.
-- ECMAScript String.prototype.trim() WhiteSpace + LineTerminator code points.
-- Explicit characters make business validation independent of LC_CTYPE/collation.
CREATE FUNCTION authz.order_commercial_reason_valid(p_reason text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT coalesce(length(btrim(p_reason,
  chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
  chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||
  chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||
  chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279)
 )) BETWEEN 1 AND 500,false)
$$;
REVOKE ALL ON FUNCTION authz.order_commercial_reason_valid(text) FROM PUBLIC;
CREATE TABLE rpt.order_commercial_event (
 tenant_id uuid NOT NULL, id uuid NOT NULL, order_id uuid NOT NULL,
 workspace_id uuid NOT NULL, market_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0),
 operation text NOT NULL CHECK(operation IN ('initialized','technical_bootstrap','cancel','replace')),
 previous_state text, resulting_state text NOT NULL CHECK(resulting_state IN ('created','cancelled','superseded')),
 successor_order_id uuid, reason text NOT NULL,
 actor_id uuid, request_id uuid, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,order_id,sequence),
 UNIQUE(tenant_id,order_id,id,sequence,resulting_state), UNIQUE(tenant_id,order_id,id,successor_order_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES rpt.cpq_order,
 FOREIGN KEY(tenant_id,successor_order_id) REFERENCES rpt.cpq_order,
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace,
 FOREIGN KEY(tenant_id,market_id) REFERENCES rpt.market,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES authz.user_account,
 CHECK(CASE WHEN operation IN ('cancel','replace') THEN authz.order_commercial_reason_valid(reason)
 ELSE length(btrim(reason)) BETWEEN 1 AND 500 END),
 CHECK((operation IN ('initialized','technical_bootstrap') AND sequence=1 AND previous_state IS NULL AND resulting_state='created' AND successor_order_id IS NULL)
 OR (operation='cancel' AND sequence=2 AND previous_state IS NOT NULL AND previous_state='created' AND resulting_state='cancelled' AND successor_order_id IS NULL)
 OR (operation='replace' AND sequence=2 AND previous_state IS NOT NULL AND previous_state='created' AND resulting_state='superseded' AND successor_order_id IS NOT NULL AND successor_order_id<>order_id)),
 CHECK((operation='technical_bootstrap' AND actor_id IS NULL AND request_id IS NULL)
 OR (operation<>'technical_bootstrap' AND actor_id IS NOT NULL AND request_id IS NOT NULL))
);
CREATE TABLE rpt.order_commercial_state (
 tenant_id uuid NOT NULL, order_id uuid NOT NULL, workspace_id uuid NOT NULL, market_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('created','cancelled','superseded')),
 version integer NOT NULL CHECK(version>0), last_event_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,order_id), FOREIGN KEY(tenant_id,order_id) REFERENCES rpt.cpq_order,
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace, FOREIGN KEY(tenant_id,market_id) REFERENCES rpt.market,
 FOREIGN KEY(tenant_id,order_id,last_event_id,version,status)
 REFERENCES rpt.order_commercial_event(tenant_id,order_id,id,sequence,resulting_state)
);
CREATE TABLE rpt.order_replacement (
 tenant_id uuid NOT NULL, id uuid NOT NULL, original_order_id uuid NOT NULL, successor_order_id uuid NOT NULL,
 workspace_id uuid NOT NULL, market_id uuid NOT NULL, event_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,original_order_id), UNIQUE(tenant_id,successor_order_id),
 CHECK(original_order_id<>successor_order_id),
 FOREIGN KEY(tenant_id,original_order_id) REFERENCES rpt.cpq_order,
 FOREIGN KEY(tenant_id,successor_order_id) REFERENCES rpt.cpq_order,
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES rpt.crm_workspace, FOREIGN KEY(tenant_id,market_id) REFERENCES rpt.market,
 FOREIGN KEY(tenant_id,original_order_id,event_id,successor_order_id)
 REFERENCES rpt.order_commercial_event(tenant_id,order_id,id,successor_order_id)
);
-- All tables have RLS. Only constrained functions write; no runtime DML grant or write policy.
ALTER TABLE rpt.order_commercial_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.order_commercial_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpt.order_replacement ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION authz.order_commercial_right(p_order uuid,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p_verb IN ('read','create','cancel','replace') AND EXISTS(
 SELECT 1 FROM rpt.cpq_order o WHERE o.tenant_id=authz.tenant_id() AND o.id=p_order
 AND authz.quote_workflow_right(o.quote_id,'cpq_order','read')
 AND authz.quote_workflow_right(o.quote_id,'cpq_order',p_verb))
$$;
REVOKE ALL ON FUNCTION authz.order_commercial_right(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.order_commercial_right(uuid,text) TO rpt_runtime;
CREATE POLICY order_commercial_read ON rpt.order_commercial_state FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.order_commercial_right(order_id,'read'));
CREATE POLICY order_commercial_read ON rpt.order_commercial_event FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.order_commercial_right(order_id,'read'));
CREATE POLICY order_replacement_read ON rpt.order_replacement FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND authz.order_commercial_right(original_order_id,'read') AND authz.order_commercial_right(successor_order_id,'read'));
GRANT SELECT ON rpt.order_commercial_state,rpt.order_commercial_event,rpt.order_replacement TO rpt_runtime;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON rpt.order_commercial_event FOR EACH ROW EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON rpt.order_commercial_event FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON rpt.order_replacement FOR EACH ROW EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON rpt.order_replacement FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER no_delete BEFORE DELETE ON rpt.order_commercial_state FOR EACH ROW EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON rpt.order_commercial_state FOR EACH STATEMENT EXECUTE FUNCTION authz.immutable();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.order_commercial_event FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE ON rpt.order_commercial_state FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE TRIGGER audit_change AFTER INSERT ON rpt.order_replacement FOR EACH ROW EXECUTE FUNCTION authz.audit_change();
CREATE FUNCTION authz.order_commercial_projection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' AND ((NEW.tenant_id,NEW.order_id,NEW.workspace_id,NEW.market_id) IS DISTINCT FROM
 (OLD.tenant_id,OLD.order_id,OLD.workspace_id,OLD.market_id) OR OLD.status<>'created'
 OR NEW.status NOT IN ('cancelled','superseded') OR NEW.version<>OLD.version+1)
 THEN RAISE EXCEPTION 'invalid_order_transition' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND (NEW.status<>'created' OR NEW.version<>1)
 THEN RAISE EXCEPTION 'invalid_order_initialization' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION authz.order_commercial_projection_guard() FROM PUBLIC;
CREATE TRIGGER projection_guard BEFORE INSERT OR UPDATE ON rpt.order_commercial_state FOR EACH ROW EXECUTE FUNCTION authz.order_commercial_projection_guard();
-- Relational context correctness also holds independently of the mutation helper.
CREATE FUNCTION authz.order_commercial_context_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE o rpt.cpq_order%ROWTYPE; n rpt.cpq_order%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='order_replacement' THEN
  SELECT * INTO o FROM rpt.cpq_order WHERE tenant_id=NEW.tenant_id AND id=NEW.original_order_id;
 ELSE
  SELECT * INTO o FROM rpt.cpq_order WHERE tenant_id=NEW.tenant_id AND id=NEW.order_id;
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'missing_source_order' USING ERRCODE='23503'; END IF;
 IF (o.workspace_id,o.market_id) IS DISTINCT FROM (NEW.workspace_id,NEW.market_id)
 THEN RAISE EXCEPTION 'order_scope_substitution' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='order_replacement' THEN
  SELECT * INTO n FROM rpt.cpq_order WHERE tenant_id=NEW.tenant_id AND id=NEW.successor_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing_successor_order' USING ERRCODE='23503'; END IF;
  IF (o.workspace_id,o.market_id,o.currency) IS DISTINCT FROM (n.workspace_id,n.market_id,n.currency)
  OR o.person_id IS NULL OR n.person_id IS NULL OR o.person_id<>n.person_id
  THEN RAISE EXCEPTION 'incompatible_order_replacement' USING ERRCODE='23514'; END IF;
  IF EXISTS(WITH RECURSIVE chain(id) AS (SELECT n.id UNION SELECT r.successor_order_id FROM rpt.order_replacement r JOIN chain c ON r.original_order_id=c.id WHERE r.tenant_id=NEW.tenant_id) SELECT 1 FROM chain WHERE id=o.id)
  THEN RAISE EXCEPTION 'replacement_cycle' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION authz.order_commercial_context_guard() FROM PUBLIC;
CREATE TRIGGER context_guard BEFORE INSERT ON rpt.order_commercial_state FOR EACH ROW EXECUTE FUNCTION authz.order_commercial_context_guard();
CREATE TRIGGER context_guard BEFORE INSERT ON rpt.order_commercial_event FOR EACH ROW EXECUTE FUNCTION authz.order_commercial_context_guard();
CREATE TRIGGER context_guard BEFORE INSERT ON rpt.order_replacement FOR EACH ROW EXECUTE FUNCTION authz.order_commercial_context_guard();
-- Existing Orders get a technical record at migration time, not invented historical business evidence.
INSERT INTO rpt.order_commercial_event(tenant_id,id,order_id,workspace_id,market_id,sequence,operation,resulting_state,reason)
 SELECT tenant_id,gen_random_uuid(),id,workspace_id,market_id,1,'technical_bootstrap','created','E3B4 technical lifecycle bootstrap; historical business actor/time not asserted' FROM rpt.cpq_order;
INSERT INTO rpt.order_commercial_state
 SELECT tenant_id,order_id,workspace_id,market_id,'created',1,id FROM rpt.order_commercial_event WHERE operation='technical_bootstrap';
CREATE FUNCTION authz.order_commercial_initialize() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e uuid:=gen_random_uuid();
BEGIN
 INSERT INTO rpt.order_commercial_event(tenant_id,id,order_id,workspace_id,market_id,sequence,operation,resulting_state,reason,actor_id,request_id)
 VALUES(NEW.tenant_id,e,NEW.id,NEW.workspace_id,NEW.market_id,1,'initialized','created','Canonical accepted Order creation',NEW.created_by,NEW.request_id);
 INSERT INTO rpt.order_commercial_state VALUES(NEW.tenant_id,NEW.id,NEW.workspace_id,NEW.market_id,'created',1,e);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION authz.order_commercial_initialize() FROM PUBLIC;
CREATE TRIGGER commercial_initialize AFTER INSERT ON rpt.cpq_order FOR EACH ROW EXECUTE FUNCTION authz.order_commercial_initialize();

-- One private transaction boundary: identity, authorization, receipts, locks, event and projection.
CREATE FUNCTION authz.order_commercial_mutate(p_order uuid,p_successor uuid,p_expected integer,p_successor_expected integer,p_key text,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o rpt.cpq_order%ROWTYPE; n rpt.cpq_order%ROWTYPE; s rpt.order_commercial_state%ROWTYPE; ns rpt.order_commercial_state%ROWTYPE;
 r authz.idempotency_receipt%ROWTYPE; op text:=CASE WHEN p_successor IS NULL THEN 'cancel' ELSE 'replace' END;
 h text; e uuid:=gen_random_uuid(); replacement uuid; response jsonb;
BEGIN
 IF NOT authz.session_valid() OR NOT authz.order_commercial_right(p_order,op)
 OR (p_successor IS NOT NULL AND NOT authz.order_commercial_right(p_successor,'replace'))
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 IF p_expected IS NULL OR p_expected<1 OR NOT authz.order_commercial_reason_valid(p_reason)
 OR p_key IS NULL OR length(p_key) NOT BETWEEN 8 AND 128
 OR (p_successor IS NOT NULL AND (p_order=p_successor OR p_successor_expected IS NULL OR p_successor_expected<1))
 OR (p_successor IS NULL AND p_successor_expected IS NOT NULL)
 THEN RAISE EXCEPTION 'invalid_order_command' USING ERRCODE='23514'; END IF;
 h:=encode(extensions.digest(convert_to(jsonb_build_object('actor',authz.actor_id(),'operation',op,'order',p_order,'successor',p_successor,
 'expectedVersion',p_expected,'successorExpectedVersion',p_successor_expected,'reason',btrim(p_reason))::text,'UTF8'),'sha256'),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(authz.tenant_id()::text||'/order_commercial.'||op||'/'||p_key,0));
 SELECT * INTO r FROM authz.idempotency_receipt WHERE tenant_id=authz.tenant_id() AND operation='order_commercial.'||op AND key=p_key;
 IF FOUND THEN
  IF r.actor_id<>authz.actor_id() OR r.request_hash<>h OR r.response IS NULL
  THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN r.response;
 END IF;
 -- Deterministic ordering also serializes reciprocal and competing replacements.
 PERFORM 1 FROM rpt.order_commercial_state WHERE tenant_id=authz.tenant_id() AND order_id IN (p_order,p_successor) ORDER BY order_id FOR UPDATE;
 IF NOT authz.order_commercial_right(p_order,op) OR (p_successor IS NOT NULL AND NOT authz.order_commercial_right(p_successor,'replace'))
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT o FROM rpt.cpq_order WHERE tenant_id=authz.tenant_id() AND id=p_order;
 SELECT * INTO STRICT s FROM rpt.order_commercial_state WHERE tenant_id=o.tenant_id AND order_id=o.id;
 IF s.version<>p_expected OR s.status<>'created' THEN RAISE EXCEPTION 'stale_or_terminal_order' USING ERRCODE='40001'; END IF;
 IF p_successor IS NOT NULL THEN
  SELECT * INTO STRICT n FROM rpt.cpq_order WHERE tenant_id=o.tenant_id AND id=p_successor;
  SELECT * INTO STRICT ns FROM rpt.order_commercial_state WHERE tenant_id=o.tenant_id AND order_id=n.id;
  IF ns.version<>p_successor_expected OR ns.status<>'created' THEN RAISE EXCEPTION 'stale_or_terminal_successor' USING ERRCODE='40001'; END IF;
  IF (o.workspace_id,o.market_id,o.currency) IS DISTINCT FROM (n.workspace_id,n.market_id,n.currency)
  OR o.person_id IS NULL OR n.person_id IS NULL OR o.person_id<>n.person_id
  THEN RAISE EXCEPTION 'incompatible_order_replacement' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM rpt.order_replacement WHERE tenant_id=o.tenant_id AND (original_order_id=o.id OR successor_order_id=n.id))
  OR EXISTS(WITH RECURSIVE chain(id) AS (SELECT n.id UNION SELECT x.successor_order_id FROM rpt.order_replacement x JOIN chain c ON x.original_order_id=c.id WHERE x.tenant_id=o.tenant_id) SELECT 1 FROM chain WHERE id=o.id)
  THEN RAISE EXCEPTION 'replacement_conflict_or_cycle' USING ERRCODE='23505'; END IF;
  replacement:=gen_random_uuid();
 END IF;
 INSERT INTO rpt.order_commercial_event(tenant_id,id,order_id,workspace_id,market_id,sequence,operation,previous_state,resulting_state,successor_order_id,reason,actor_id,request_id)
 VALUES(o.tenant_id,e,o.id,o.workspace_id,o.market_id,s.version+1,op,'created',CASE op WHEN 'cancel' THEN 'cancelled' ELSE 'superseded' END,p_successor,btrim(p_reason),authz.actor_id(),nullif(current_setting('rpt.request_id',true),'')::uuid);
 IF replacement IS NOT NULL THEN
  INSERT INTO rpt.order_replacement VALUES(o.tenant_id,replacement,o.id,n.id,o.workspace_id,o.market_id,e);
 END IF;
 UPDATE rpt.order_commercial_state SET status=CASE op WHEN 'cancel' THEN 'cancelled' ELSE 'superseded' END,version=s.version+1,last_event_id=e WHERE tenant_id=o.tenant_id AND order_id=o.id;
 response:=jsonb_build_object('orderId',o.id,'eventId',e,'version',s.version+1,'status',CASE op WHEN 'cancel' THEN 'cancelled' ELSE 'superseded' END,'replacementId',replacement);
 INSERT INTO authz.idempotency_receipt(tenant_id,operation,key,actor_id,request_hash,response)
 VALUES(o.tenant_id,'order_commercial.'||op,p_key,authz.actor_id(),h,response);
 RETURN response;
END $$;
REVOKE ALL ON FUNCTION authz.order_commercial_mutate(uuid,uuid,integer,integer,text,text) FROM PUBLIC;
CREATE FUNCTION authz.cancel_order(p_order uuid,p_expected integer,p_key text,p_reason text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT authz.order_commercial_mutate(p_order,NULL,p_expected,NULL,p_key,p_reason) $$;
CREATE FUNCTION authz.replace_order(p_order uuid,p_successor uuid,p_expected integer,p_successor_expected integer,p_key text,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_successor IS NULL THEN RAISE EXCEPTION 'successor_required' USING ERRCODE='23514'; END IF;
 RETURN authz.order_commercial_mutate(p_order,p_successor,p_expected,p_successor_expected,p_key,p_reason);
END $$;
REVOKE ALL ON FUNCTION authz.cancel_order(uuid,integer,text,text),authz.replace_order(uuid,uuid,integer,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.cancel_order(uuid,integer,text,text),authz.replace_order(uuid,uuid,integer,integer,text,text) TO rpt_runtime;

ALTER TABLE rpt.source_observation ADD COLUMN order_commercial_subject_type text;
ALTER TABLE rpt.source_observation ADD CONSTRAINT order_commercial_subject_type_check CHECK(
 (domain_key='order_commercial' AND order_commercial_subject_type IS NOT NULL AND order_commercial_subject_type IN ('order','order_event','order_replacement'))
 OR (domain_key<>'order_commercial' AND order_commercial_subject_type IS NULL));
CREATE FUNCTION authz.order_commercial_subject(p_id uuid,p_type text,p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE p_type
 WHEN 'order' THEN authz.order_commercial_right(p_id,CASE WHEN p_verb='read' THEN 'read' ELSE 'cancel' END)
 WHEN 'order_event' THEN EXISTS(SELECT 1 FROM rpt.order_commercial_event e WHERE e.tenant_id=authz.tenant_id() AND e.id=p_id
 AND authz.order_commercial_right(e.order_id,CASE WHEN p_verb='read' THEN 'read' WHEN e.operation='replace' THEN 'replace' WHEN e.operation='cancel' THEN 'cancel' ELSE 'create' END))
 WHEN 'order_replacement' THEN EXISTS(SELECT 1 FROM rpt.order_replacement r WHERE r.tenant_id=authz.tenant_id() AND r.id=p_id
 AND authz.order_commercial_right(r.original_order_id,CASE WHEN p_verb='read' THEN 'read' ELSE 'replace' END)
 AND authz.order_commercial_right(r.successor_order_id,CASE WHEN p_verb='read' THEN 'read' ELSE 'replace' END))
 ELSE false END
$$;
CREATE FUNCTION authz.order_commercial_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.domain_key='order_commercial' AND (NEW.tenant_id<>authz.tenant_id() OR NOT authz.order_commercial_subject(NEW.subject_id,NEW.order_commercial_subject_type,'append'))
 THEN RAISE EXCEPTION 'invalid_order_commercial_subject' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION authz.order_commercial_subject(uuid,text,text),authz.order_commercial_source_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.order_commercial_subject(uuid,text,text) TO rpt_runtime;
CREATE TRIGGER order_commercial_source_guard BEFORE INSERT ON rpt.source_observation FOR EACH ROW EXECUTE FUNCTION authz.order_commercial_source_guard();
CREATE POLICY order_commercial_source_boundary ON rpt.source_observation AS RESTRICTIVE FOR ALL TO rpt_runtime
 USING(domain_key<>'order_commercial' OR authz.order_commercial_subject(subject_id,order_commercial_subject_type,'read'))
 WITH CHECK(domain_key<>'order_commercial' OR authz.order_commercial_subject(subject_id,order_commercial_subject_type,'append'));
CREATE POLICY order_commercial_source_read ON rpt.source_observation FOR SELECT TO rpt_runtime
 USING(tenant_id=authz.tenant_id() AND domain_key='order_commercial' AND authz.order_commercial_subject(subject_id,order_commercial_subject_type,'read'));
CREATE FUNCTION authz.order_commercial_source_authority(p_system text,p_authority text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.session_valid() AND EXISTS(SELECT 1 FROM authz.source_authority a WHERE a.tenant_id=authz.tenant_id() AND a.user_id=authz.actor_id() AND a.domain_key='order_commercial' AND a.source_system=p_system AND a.authority_level=p_authority AND a.revoked_at IS NULL)
$$;
REVOKE ALL ON FUNCTION authz.order_commercial_source_authority(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.order_commercial_source_authority(text,text) TO rpt_runtime;
CREATE POLICY order_commercial_source_insert ON rpt.source_observation FOR INSERT TO rpt_runtime
 WITH CHECK(tenant_id=authz.tenant_id() AND actor_id=authz.actor_id() AND domain_key='order_commercial'
 AND authz.order_commercial_subject(subject_id,order_commercial_subject_type,'append')
 AND authz.order_commercial_source_authority(source_system,authority_level));
