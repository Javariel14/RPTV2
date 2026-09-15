SET LOCAL ROLE rpt_owner;

-- Read-only projection of the existing manual source boundary, not a new grant.
CREATE FUNCTION authz.crm_manual_authority() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT authz.crm_enabled() AND EXISTS (
   SELECT 1 FROM authz.source_authority a
   WHERE a.tenant_id=authz.tenant_id() AND a.user_id=authz.actor_id()
   AND a.source_system='MANUAL_RECONCILIATION' AND a.domain_key='order_simulation'
   AND a.authority_level='manual' AND a.revoked_at IS NULL
 )
$$;
REVOKE ALL ON FUNCTION authz.crm_manual_authority() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.crm_manual_authority() TO rpt_runtime;
