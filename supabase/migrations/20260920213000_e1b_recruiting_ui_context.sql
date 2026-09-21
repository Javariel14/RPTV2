SET LOCAL ROLE rpt_owner;

CREATE FUNCTION authz.recruiting_ui_context() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH workspace AS (
   SELECT w.id,w.name,w.tenant_id
   FROM rpt.crm_workspace w
   WHERE w.tenant_id=authz.tenant_id() AND w.kind='recruitment'
     AND authz.recruiting_workspace_right(w.id,'read')
   ORDER BY w.name,w.id LIMIT 1
 ), owners AS (
   SELECT DISTINCT p.user_id AS id,
     CASE WHEN p.user_id=authz.actor_id() THEN 'self' ELSE 'authorized' END AS label
   FROM authz.workspace_permission p
   JOIN workspace w ON (w.tenant_id,w.id)=(p.tenant_id,p.workspace_id)
   JOIN authz.tenant t ON t.id=p.tenant_id
   WHERE p.object_type='recruitment_profile' AND p.verb='read'
     AND p.field_class='CONFIDENTIAL' AND p.policy_version=t.policy_version
     AND p.revoked_at IS NULL
     AND tstzrange(p.effective_from,p.effective_to,'[)') @> statement_timestamp()
     AND authz.capable(p.user_id,'recruitment_profile','update','CONFIDENTIAL')
     AND EXISTS(SELECT 1 FROM authz.workspace_permission u
       WHERE (u.tenant_id,u.workspace_id,u.user_id)=(p.tenant_id,p.workspace_id,p.user_id)
       AND u.object_type='recruitment_profile' AND u.verb='update'
       AND u.field_class='CONFIDENTIAL' AND u.policy_version=t.policy_version
       AND u.revoked_at IS NULL
       AND tstzrange(u.effective_from,u.effective_to,'[)') @> statement_timestamp())
 )
 SELECT jsonb_build_object(
   'actorId',authz.actor_id(),
   'workspace',(SELECT jsonb_build_object('id',id,'name',name) FROM workspace),
   'owners',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'label',label) ORDER BY label,id) FROM owners),'[]'::jsonb)
 )
$$;
REVOKE ALL ON FUNCTION authz.recruiting_ui_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.recruiting_ui_context() TO rpt_runtime;

CREATE OR REPLACE FUNCTION authz.record_decision(p_object uuid,p_action text,p_result text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT authz.session_valid() OR p_action NOT IN ('person.read','person.update','metric.append','grant.create','grant.revoke','privacy.purge','network.stats','crm.context','crm.list','crm.detail','crm.onboard','crm.create','crm.command','crm.view','crm.metrics','crm.grant','recruiting.context','recruiting.list','recruiting.detail','recruiting.create','recruiting.command') OR p_result NOT IN ('allow','deny','success','failure')
 THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO rpt.audit_event(tenant_id,actor_id,action,object_type,object_id,scope,policy_version,request_id,result,reason_code)
 VALUES(authz.tenant_id(),authz.actor_id(),p_action,'permission_decision',p_object,'request',(SELECT policy_version FROM authz.tenant WHERE id=authz.tenant_id()),nullif(current_setting('rpt.request_id',true),'')::uuid,p_result,'server_policy');
END $$;
