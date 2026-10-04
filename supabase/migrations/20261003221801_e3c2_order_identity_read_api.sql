SET LOCAL ROLE rpt_owner;

-- E3C2: tenant-local, immutable, business-readable identity for canonical Orders.
-- UUID remains the relational identity and authorization boundary.
LOCK TABLE rpt.cpq_order IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE rpt.cpq_order ADD COLUMN business_order_number text;

-- Private allocator state. Runtime receives no table privileges or policies.
CREATE TABLE authz.order_number_counter (
 tenant_id uuid PRIMARY KEY REFERENCES authz.tenant(id),
 allocator_id uuid NOT NULL UNIQUE
);
ALTER TABLE authz.order_number_counter ENABLE ROW LEVEL SECURITY;

-- The existing immutable-history trigger correctly protects Orders during runtime.
-- The controlled forward migration temporarily disables only that trigger to backfill
-- existing rows deterministically from their immutable creation ordering.
ALTER TABLE rpt.cpq_order DISABLE TRIGGER immutable_history;
WITH numbered AS (
 SELECT tenant_id,id,row_number() OVER(PARTITION BY tenant_id ORDER BY created_at,id) AS value
 FROM rpt.cpq_order
)
UPDATE rpt.cpq_order o
SET business_order_number='ORD-'||lpad(n.value::text,10,'0')
FROM numbered n
WHERE o.tenant_id=n.tenant_id AND o.id=n.id;
ALTER TABLE rpt.cpq_order ENABLE TRIGGER immutable_history;

ALTER TABLE rpt.cpq_order
 ALTER COLUMN business_order_number SET NOT NULL,
 ADD CONSTRAINT cpq_order_business_number_format
  CHECK(business_order_number ~ '^ORD-[0-9]{10}$'),
 ADD CONSTRAINT cpq_order_business_number_tenant_unique
  UNIQUE(tenant_id,business_order_number);

-- Order receipts created before E3C2 did not persist enough request context to
-- prove that their caller-controlled response belongs to the exact conversion.
-- Preserve that evidence unchanged and fail closed on replay. New receipts bind
-- the immutable version, acceptance and expected quote version explicitly.
ALTER TABLE authz.idempotency_receipt
 ADD COLUMN order_quote_version_id uuid,
 ADD COLUMN order_acceptance_id uuid,
 ADD COLUMN order_expected_version integer,
 ADD CONSTRAINT idempotency_receipt_order_context_shape CHECK(
  (operation='quote_workflow.order' AND (
    (order_quote_version_id IS NULL AND order_acceptance_id IS NULL AND order_expected_version IS NULL)
    OR
    (order_quote_version_id IS NOT NULL AND order_acceptance_id IS NOT NULL AND order_expected_version>0)
  ))
  OR
  (operation<>'quote_workflow.order' AND order_quote_version_id IS NULL
   AND order_acceptance_id IS NULL AND order_expected_version IS NULL)
 ),
 ADD CONSTRAINT idempotency_receipt_order_version_fk
  FOREIGN KEY(tenant_id,order_quote_version_id)
  REFERENCES rpt.cpq_quote_version(tenant_id,id),
 ADD CONSTRAINT idempotency_receipt_order_acceptance_fk
  FOREIGN KEY(tenant_id,order_acceptance_id,order_quote_version_id)
  REFERENCES rpt.quote_acceptance(tenant_id,id,quote_version_id);

-- The historical generic helpers remain for their original workflow operations,
-- but Order conversion now has an operation-specific authoritative boundary.
CREATE OR REPLACE FUNCTION authz.quote_workflow_receipt(p_operation text,p_key text,p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r authz.idempotency_receipt%ROWTYPE; domain text; verb text;
BEGIN
 IF p_operation='order' THEN
  RAISE EXCEPTION 'order_receipt_requires_authoritative_context' USING ERRCODE='42501';
 END IF;
 domain:=CASE WHEN p_operation IN ('request','decide') THEN 'quote_approval' ELSE 'cpq_quote' END;
 verb:=CASE p_operation WHEN 'request' THEN 'request' WHEN 'decide' THEN 'decide' WHEN 'accept' THEN 'accept' END;
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

CREATE OR REPLACE FUNCTION authz.quote_workflow_finish(p_operation text,p_key text,p_response jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR p_operation NOT IN ('request','decide','accept') OR pg_column_size(p_response)>2048
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 UPDATE authz.idempotency_receipt SET response=p_response WHERE tenant_id=authz.tenant_id()
 AND operation='quote_workflow.'||p_operation AND key=p_key AND actor_id=authz.actor_id() AND response IS NULL;
END $$;

CREATE FUNCTION authz.order_creation_receipt(
 p_key text,p_hash text,p_quote_version_id uuid,p_acceptance_id uuid,p_expected_version integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r authz.idempotency_receipt%ROWTYPE; quote_id uuid; current_version integer; authoritative jsonb;
BEGIN
 IF NOT authz.session_valid() OR p_key IS NULL OR length(p_key) NOT BETWEEN 8 AND 128
  OR p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$'
  OR p_quote_version_id IS NULL OR p_acceptance_id IS NULL
  OR p_expected_version IS NULL OR p_expected_version<1
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;

 SELECT q.id,q.version INTO quote_id,current_version
 FROM rpt.cpq_quote_version v
 JOIN rpt.cpq_quote q ON q.tenant_id=v.tenant_id AND q.id=v.quote_id
 JOIN rpt.quote_acceptance a ON a.tenant_id=v.tenant_id
  AND a.quote_version_id=v.id AND a.id=p_acceptance_id
 WHERE v.tenant_id=authz.tenant_id() AND v.id=p_quote_version_id
  AND q.status='accepted' AND authz.quote_publishable(v.id)
  AND authz.quote_workflow_right(q.id,'cpq_order','create');
 IF NOT FOUND THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;

 PERFORM pg_advisory_xact_lock(hashtextextended(
  authz.tenant_id()::text||'/quote_workflow.order/context/'||p_quote_version_id::text||'/'||p_acceptance_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(
  authz.tenant_id()::text||'/quote_workflow.order/'||p_key,0));

 SELECT * INTO r FROM authz.idempotency_receipt
 WHERE tenant_id=authz.tenant_id() AND operation='quote_workflow.order' AND key=p_key
 FOR UPDATE;
 IF FOUND THEN
  IF r.actor_id<>authz.actor_id() OR r.request_hash<>p_hash
   OR r.order_quote_version_id IS DISTINCT FROM p_quote_version_id
   OR r.order_acceptance_id IS DISTINCT FROM p_acceptance_id
   OR r.order_expected_version IS DISTINCT FROM p_expected_version
  THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
 ELSE
  INSERT INTO authz.idempotency_receipt(
   tenant_id,operation,key,actor_id,request_hash,
   order_quote_version_id,order_acceptance_id,order_expected_version
  ) VALUES(
   authz.tenant_id(),'quote_workflow.order',p_key,authz.actor_id(),p_hash,
   p_quote_version_id,p_acceptance_id,p_expected_version
  ) RETURNING * INTO r;
 END IF;

 SELECT jsonb_build_object('id',o.id,'businessOrderNumber',o.business_order_number)
 INTO authoritative
 FROM rpt.cpq_order o
 WHERE o.tenant_id=r.tenant_id AND o.quote_version_id=r.order_quote_version_id
  AND o.acceptance_id=r.order_acceptance_id AND o.created_by=r.actor_id;
 IF FOUND THEN
  IF r.response IS NOT NULL AND r.response IS DISTINCT FROM authoritative THEN
   RAISE EXCEPTION 'invalid_order_receipt' USING ERRCODE='23514';
  END IF;
  IF r.response IS NULL AND current_version<>p_expected_version THEN RETURN NULL; END IF;
  IF r.response IS NULL THEN
   UPDATE authz.idempotency_receipt SET response=authoritative
   WHERE tenant_id=r.tenant_id AND operation=r.operation AND key=r.key;
  END IF;
  RETURN authoritative;
 END IF;
 IF r.response IS NOT NULL THEN
  RAISE EXCEPTION 'invalid_order_receipt' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION authz.order_creation_finish(p_key text,p_order_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r authz.idempotency_receipt%ROWTYPE; quote_id uuid; authoritative jsonb;
BEGIN
 IF NOT authz.session_valid() OR p_key IS NULL OR length(p_key) NOT BETWEEN 8 AND 128
  OR p_order_id IS NULL THEN
  RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
  authz.tenant_id()::text||'/quote_workflow.order/'||p_key,0));
 SELECT * INTO r FROM authz.idempotency_receipt
 WHERE tenant_id=authz.tenant_id() AND operation='quote_workflow.order' AND key=p_key
 FOR UPDATE;
 IF NOT FOUND OR r.actor_id<>authz.actor_id() OR r.order_quote_version_id IS NULL
  OR r.order_acceptance_id IS NULL OR r.order_expected_version IS NULL
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;

 SELECT q.id INTO quote_id
 FROM rpt.cpq_quote_version v
 JOIN rpt.cpq_quote q ON q.tenant_id=v.tenant_id AND q.id=v.quote_id
 JOIN rpt.quote_acceptance a ON a.tenant_id=v.tenant_id
  AND a.quote_version_id=v.id AND a.id=r.order_acceptance_id
 WHERE v.tenant_id=r.tenant_id AND v.id=r.order_quote_version_id
  AND q.version=r.order_expected_version AND q.status='accepted'
  AND authz.quote_publishable(v.id)
  AND authz.quote_workflow_right(q.id,'cpq_order','create');
 IF NOT FOUND THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;

 SELECT jsonb_build_object('id',o.id,'businessOrderNumber',o.business_order_number)
 INTO authoritative
 FROM rpt.cpq_order o
 WHERE o.tenant_id=r.tenant_id AND o.id=p_order_id
  AND o.quote_version_id=r.order_quote_version_id
  AND o.acceptance_id=r.order_acceptance_id AND o.created_by=r.actor_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 IF r.response IS NOT NULL AND r.response IS DISTINCT FROM authoritative THEN
  RAISE EXCEPTION 'invalid_order_receipt' USING ERRCODE='23514';
 END IF;
 UPDATE authz.idempotency_receipt SET response=authoritative
 WHERE tenant_id=r.tenant_id AND operation=r.operation AND key=r.key AND response IS NULL;
 RETURN authoritative;
END $$;

REVOKE ALL ON FUNCTION authz.order_creation_receipt(text,text,uuid,uuid,integer),
 authz.order_creation_finish(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.order_creation_receipt(text,text,uuid,uuid,integer),
 authz.order_creation_finish(text,uuid) TO rpt_runtime;

CREATE INDEX cpq_order_read_page
 ON rpt.cpq_order(tenant_id,created_at DESC,id DESC);

DO $$
DECLARE tenant_row record; allocator_id uuid; sequence_name name; first_value bigint;
BEGIN
 FOR tenant_row IN
  SELECT t.id,count(o.id)::bigint AS assigned
  FROM authz.tenant t LEFT JOIN rpt.cpq_order o ON o.tenant_id=t.id
  GROUP BY t.id
 LOOP
  IF tenant_row.assigned>9999999999 THEN
   RAISE EXCEPTION 'order_number_namespace_exhausted' USING ERRCODE='22003';
  END IF;
  allocator_id:=extensions.gen_random_uuid();
  sequence_name:=('order_number_'||replace(allocator_id::text,'-',''))::name;
  first_value:=greatest(1,least(tenant_row.assigned+1,9999999999));
  EXECUTE format(
   'CREATE SEQUENCE authz.%I AS bigint MINVALUE 1 MAXVALUE 9999999999 START WITH %s NO CYCLE CACHE 1',
   sequence_name,first_value
  );
  IF tenant_row.assigned=9999999999 THEN
   PERFORM setval(format('authz.%I',sequence_name)::regclass,9999999999,true);
  END IF;
  INSERT INTO authz.order_number_counter VALUES(tenant_row.id,allocator_id);
 END LOOP;
END $$;

CREATE FUNCTION authz.initialize_order_number_counter() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE allocator_id uuid:=extensions.gen_random_uuid();
 sequence_name name:=('order_number_'||replace(allocator_id::text,'-',''))::name;
BEGIN
 EXECUTE format(
  'CREATE SEQUENCE authz.%I AS bigint MINVALUE 1 MAXVALUE 9999999999 START WITH 1 NO CYCLE CACHE 1',
  sequence_name
 );
 INSERT INTO authz.order_number_counter VALUES(NEW.id,allocator_id);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION authz.initialize_order_number_counter() FROM PUBLIC;
CREATE TRIGGER initialize_order_number_counter
 AFTER INSERT ON authz.tenant
 FOR EACH ROW EXECUTE FUNCTION authz.initialize_order_number_counter();

CREATE FUNCTION authz.assign_order_business_number() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE allocated bigint; allocator_id uuid; sequence_name name;
BEGIN
 IF NEW.business_order_number IS NOT NULL THEN
  RAISE EXCEPTION 'caller_order_number_forbidden' USING ERRCODE='42501';
 END IF;
 SELECT c.allocator_id INTO allocator_id
 FROM authz.order_number_counter c WHERE c.tenant_id=NEW.tenant_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'missing_order_number_counter' USING ERRCODE='23503';
 END IF;
 sequence_name:=('order_number_'||replace(allocator_id::text,'-',''))::name;
 allocated:=nextval(format('authz.%I',sequence_name)::regclass);
 IF allocated IS NULL OR allocated NOT BETWEEN 1 AND 9999999999 THEN
  RAISE EXCEPTION 'order_number_namespace_exhausted' USING ERRCODE='22003';
 END IF;
 NEW.business_order_number:='ORD-'||lpad(allocated::text,10,'0');
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION authz.assign_order_business_number() FROM PUBLIC;

-- Alphabetical trigger ordering intentionally runs the established workflow guard first.
CREATE TRIGGER zz_assign_business_order_number
 BEFORE INSERT ON rpt.cpq_order
 FOR EACH ROW EXECUTE FUNCTION authz.assign_order_business_number();
