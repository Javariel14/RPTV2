SET LOCAL ROLE rpt_owner;

-- Same policy predicates as the initial CRM migration, with a cached point-lookup
-- plan instead of repeatedly planning the nested SQL permission expression.
-- No new access paths, role grants, or RLS bypass for the runtime role.
CREATE OR REPLACE FUNCTION authz.crm_allowed(p_id uuid,p_verb text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE person uuid;
BEGIN
 IF NOT authz.crm_enabled() OR NOT authz.allowed('opportunity',p_id,p_verb,'CONFIDENTIAL') THEN
   RETURN false;
 END IF;
 SELECT o.person_id INTO person FROM rpt.opportunity o
 JOIN rpt.person p ON (p.tenant_id,p.id)=(o.tenant_id,o.person_id)
 WHERE o.tenant_id=authz.tenant_id() AND o.id=p_id AND p.deleted_at IS NULL;
 IF person IS NULL THEN RETURN false; END IF;
 RETURN authz.allowed('person',person,'read','CONFIDENTIAL');
END $$;
