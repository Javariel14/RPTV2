import type { Client } from 'pg';
import type { z } from 'zod';
import {
  FoundationError,
  type CrmSession,
  type CrmList,
  type CrmSavedView,
  type crmListQuery,
  type crmSaveView,
} from '@rpt/contracts';
import type { AuthContext } from '@rpt/persistence';

export async function crmContext(client: Client): Promise<CrmSession> {
  const session = (
    await client.query<{ value: CrmSession | null }>('SELECT authz.crm_context() AS value')
  ).rows[0]?.value;
  if (!session) throw new FoundationError('FORBIDDEN');
  return session;
}

export async function listCrm(
  client: Client,
  input: z.infer<typeof crmListQuery>,
): Promise<CrmList> {
  const session = await crmContext(client);
  if (!session.canList) throw new FoundationError('FORBIDDEN');
  const f = input.filters;
  // Only allowlisted identifiers are interpolated. Values always use parameters.
  const sort = { name: 'name', updated: '"updatedAt"', due: '"nextAt"' }[input.sort];
  const direction = input.direction === 'asc' ? 'ASC' : 'DESC';
  // One statement gives the rows, totals and stage counts the same RLS snapshot.
  const result = await client.query<{ value: CrmList }>(
    `
    WITH people AS MATERIALIZED (
      SELECT tenant_id,id,display_name,version FROM rpt.person
    ), permitted AS MATERIALIZED (
      SELECT o.id,o.person_id AS "personId",o.title,p.display_name AS name,
        p.version AS "personVersion",o.owner_id AS "ownerId",
        CASE WHEN o.owner_id=authz.actor_id() THEN 'self' ELSE 'delegated' END AS "ownerLabel",
        o.stage,o.source,o.priority,o.next_action AS "nextAction",o.next_at AS "nextAt",
        o.updated_at AS "updatedAt",o.version
      FROM rpt.opportunity o JOIN people p ON (p.tenant_id,p.id)=(o.tenant_id,o.person_id)
      WHERE o.workspace_id=$1
        AND ($2='' OR position(lower($2) IN lower(p.display_name||' '||o.title))>0)
        AND ($3='all' OR o.owner_id=authz.actor_id())
        AND ($4='all' OR o.stage=$4) AND ($5='all' OR o.source=$5)
        AND ($6='all' OR ($6='closed')=(o.stage IN ('won','won_simulated','lost')))
        AND ($7='all' OR ($7='due' AND o.next_at<=statement_timestamp())
          OR ($7='inactive' AND o.updated_at<statement_timestamp()-interval '7 days'))
        AND ($8='all' OR o.priority=$8)
    ), page_rows AS MATERIALIZED (
      SELECT * FROM permitted ORDER BY ${sort} ${direction} NULLS LAST,id ASC LIMIT 20 OFFSET $9
    ), projected AS (
      SELECT r.*,authz.crm_allowed(r.id,'update') AS "canUpdate",
        authz.allowed('person',r."personId",'read','RESTRICTED_PII') AS "canContact"
      FROM page_rows r
    )
    SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(r ORDER BY ${sort} ${direction} NULLS LAST,id ASC) FROM projected r),'[]'::jsonb),
      'total',(SELECT count(*) FROM permitted),'pageSize',20,
      'stages',coalesce((SELECT jsonb_agg(s) FROM
        (SELECT stage,count(*)::int AS count FROM permitted GROUP BY stage ORDER BY stage) s),'[]'::jsonb)) AS value`,
    [
      session.workspaceId,
      f.query,
      f.owner,
      f.stage,
      f.source,
      f.status,
      f.activity,
      f.priority,
      input.page * 20,
    ],
  );
  return result.rows[0]!.value;
}

export async function listCrmViews(client: Client): Promise<CrmSavedView[]> {
  const session = await crmContext(client);
  if (!session.canList) throw new FoundationError('FORBIDDEN');
  return (
    await client.query<CrmSavedView>(
      'SELECT id,name,visibility,config,owner_id AS "ownerId" FROM rpt.saved_view WHERE workspace_id=$1 ORDER BY created_at,id',
      [session.workspaceId],
    )
  ).rows;
}

export async function saveCrmView(
  client: Client,
  context: AuthContext,
  input: z.infer<typeof crmSaveView>,
  key: string,
  hash: string,
): Promise<{ id: string }> {
  const session = await crmContext(client);
  if (
    !session.canList ||
    input.workspaceId !== session.workspaceId ||
    (input.visibility !== 'private' && !session.canShareView)
  )
    throw new FoundationError('FORBIDDEN');
  if (
    (input.visibility !== 'shared' && input.recipients.length > 0) ||
    (input.visibility === 'shared' && input.recipients.length === 0)
  )
    throw new FoundationError('INVALID_REQUEST');
  const previous = (
    await client.query<{ value: { id: string } | null }>(
      'SELECT authz.crm_receipt($1,$2) AS value',
      [key, hash],
    )
  ).rows[0]?.value;
  if (previous) return previous;
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO rpt.saved_view(tenant_id,id,owner_id,workspace_id,name,visibility,config)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      context.tenantId,
      id,
      context.actorId,
      input.workspaceId,
      input.name,
      input.visibility,
      input.config,
    ],
  );
  for (const recipient of new Set(input.recipients)) {
    await client.query('SELECT authz.crm_add_view_recipient($1,$2)', [id, recipient]);
  }
  await client.query('SELECT authz.crm_finish($1,$2)', [key, { id }]);
  return { id };
}
