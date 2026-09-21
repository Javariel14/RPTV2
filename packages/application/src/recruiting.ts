import type { Client } from 'pg';
import type { z } from 'zod';
import {
  FoundationError,
  type RecruitmentProfileDetail,
  type RecruitmentProfileList,
  type RecruitingContext,
  type RecruitingCreate,
  type recruitingListQuery,
  type recruitingMutation,
} from '@rpt/contracts';
import type { AuthContext } from '@rpt/persistence';

async function receipt(client: Client, key: string, hash: string) {
  return (
    await client.query<{ value: { id: string; version: number } | null }>(
      'SELECT authz.recruiting_receipt($1,$2) AS value',
      [key, hash],
    )
  ).rows[0]?.value;
}

async function finish(client: Client, key: string, value: { id: string; version: number }) {
  await client.query('SELECT authz.recruiting_finish($1,$2)', [key, value]);
  return value;
}

export async function recruitingContext(client: Client): Promise<RecruitingContext> {
  const result = await client.query<{ value: RecruitingContext }>(
    'SELECT authz.recruiting_ui_context() AS value',
  );
  const value = result.rows[0]?.value;
  if (!value?.workspace) throw new FoundationError('FORBIDDEN');
  return value;
}

export async function createRecruitmentProfile(
  client: Client,
  context: AuthContext,
  input: RecruitingCreate,
  key: string,
  hash: string,
) {
  const canCreate = (
    await client.query<{ allowed: boolean }>(
      "SELECT authz.recruiting_workspace_right($1,'create') AS allowed",
      [input.workspaceId],
    )
  ).rows[0]?.allowed;
  if (!canCreate) throw new FoundationError('FORBIDDEN');
  const previous = await receipt(client, key, hash);
  if (previous) return previous;

  let personId: string;
  if (input.person.mode === 'existing') {
    const person = await client.query<{ id: string }>('SELECT id FROM rpt.person WHERE id=$1', [
      input.person.id,
    ]);
    if (!person.rowCount) throw new FoundationError('NOT_FOUND');
    personId = input.person.id;
  } else {
    personId = crypto.randomUUID();
    await client.query(
      `INSERT INTO rpt.person(tenant_id,id,workspace_id,owner_id,display_name,lifecycle)
       VALUES($1,$2,$3,$4,$5,'candidate')`,
      [context.tenantId, personId, input.workspaceId, context.actorId, input.person.displayName],
    );
    if (input.person.email || input.person.phone)
      await client.query(
        'INSERT INTO rpt.person_pii(tenant_id,person_id,email,phone) VALUES($1,$2,$3,$4)',
        [context.tenantId, personId, input.person.email || null, input.person.phone || null],
      );
  }

  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO rpt.recruitment_profile(tenant_id,id,person_id,workspace_id,owner_id,source,priority)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      context.tenantId,
      id,
      personId,
      input.workspaceId,
      context.actorId,
      input.source,
      input.priority,
    ],
  );
  await client.query(
    `INSERT INTO rpt.recruitment_event(tenant_id,id,profile_id,actor_id,action,request_id,payload)
     VALUES($1,$2,$3,$4,'profile.created',$5,$6)`,
    [
      context.tenantId,
      crypto.randomUUID(),
      id,
      context.actorId,
      context.requestId,
      { source: input.source },
    ],
  );
  return finish(client, key, { id, version: 1 });
}

export async function listRecruitmentProfiles(
  client: Client,
  input: z.infer<typeof recruitingListQuery>,
): Promise<RecruitmentProfileList> {
  const canRead = (
    await client.query<{ allowed: boolean }>(
      "SELECT authz.recruiting_workspace_right($1,'read') AS allowed",
      [input.workspaceId],
    )
  ).rows[0]?.allowed;
  if (!canRead) throw new FoundationError('FORBIDDEN');
  const result = await client.query<{ value: RecruitmentProfileList }>(
    `WITH permitted AS MATERIALIZED (
       SELECT r.id,r.person_id AS "personId",r.workspace_id AS "workspaceId",r.owner_id AS "ownerId",
         p.display_name AS "displayName",r.stage,r.substatus,r.priority,r.source,r.version,
         CASE WHEN r.owner_id=authz.actor_id() THEN 'self' ELSE 'authorized' END AS "ownerLabel",
         f.body AS "nextAction",f.due_at AS "nextAt",
         r.created_at AS "createdAt",r.updated_at AS "updatedAt"
       FROM rpt.recruitment_profile r JOIN rpt.person p ON (p.tenant_id,p.id)=(r.tenant_id,r.person_id)
       LEFT JOIN LATERAL (
         SELECT body,due_at FROM rpt.recruitment_followup
         WHERE profile_id=r.id AND completed_at IS NULL ORDER BY due_at,id LIMIT 1
       ) f ON true
       WHERE r.workspace_id=$1 AND ($2='' OR p.display_name ILIKE '%'||$2||'%')
         AND ($3='all' OR r.owner_id=authz.actor_id())
         AND ($4='all' OR r.stage::text=$4) AND ($5='all' OR r.source::text=$5)
         AND ($6='all' OR r.substatus::text=$6) AND ($7='all' OR r.priority::text=$7)
         AND ($8='all' OR ($8='due' AND f.due_at<=now()) OR ($8='upcoming' AND f.due_at>now())
           OR ($8='none' AND f.due_at IS NULL))
     ), page_rows AS MATERIALIZED (
       SELECT * FROM permitted ORDER BY "updatedAt" DESC,id LIMIT 20 OFFSET $9
     ), projected AS (
       SELECT r.*,authz.recruiting_allowed(r.id,'update') AS "canUpdate",
         authz.recruiting_workspace_right(r."workspaceId",'reassign') AS "canReassign",
         authz.allowed('person',r."personId",'read','RESTRICTED_PII') AS "canContact"
       FROM page_rows r
     )
     SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(r ORDER BY "updatedAt" DESC,id) FROM projected r),'[]'::jsonb),
       'total',(SELECT count(*) FROM permitted),'pageSize',20,
       'stages',coalesce((SELECT jsonb_agg(jsonb_build_object('stage',stage,'count',count) ORDER BY stage)
         FROM (SELECT stage,count(*) count FROM permitted GROUP BY stage) counts),'[]'::jsonb)) AS value`,
    [
      input.workspaceId,
      input.query,
      input.owner,
      input.stage,
      input.source,
      input.substatus,
      input.priority,
      input.activity,
      input.page * 20,
    ],
  );
  return result.rows[0]!.value;
}

export async function detailRecruitmentProfile(
  client: Client,
  id: string,
): Promise<RecruitmentProfileDetail> {
  const result = await client.query<{ value: RecruitmentProfileDetail }>(
    `SELECT jsonb_build_object(
      'row',jsonb_build_object('id',r.id,'personId',r.person_id,'workspaceId',r.workspace_id,
        'ownerId',r.owner_id,'displayName',p.display_name,'stage',r.stage,'substatus',r.substatus,
        'priority',r.priority,'source',r.source,'version',r.version,'createdAt',r.created_at,'updatedAt',r.updated_at,
        'canUpdate',authz.recruiting_allowed(r.id,'update'),
        'canReassign',authz.recruiting_workspace_right(r.workspace_id,'reassign'),
        'canContact',authz.allowed('person',p.id,'read','RESTRICTED_PII'),
        'ownerLabel',CASE WHEN r.owner_id=authz.actor_id() THEN 'self' ELSE 'authorized' END,
        'nextAction',(SELECT body FROM rpt.recruitment_followup WHERE profile_id=r.id AND completed_at IS NULL ORDER BY due_at,id LIMIT 1),
        'nextAt',(SELECT due_at FROM rpt.recruitment_followup WHERE profile_id=r.id AND completed_at IS NULL ORDER BY due_at,id LIMIT 1)),
      'contact',(SELECT jsonb_build_object('email',email,'phone',phone) FROM rpt.person_pii WHERE person_id=p.id),
      'permissions',jsonb_build_object(
        'appointment',authz.recruiting_child(r.id,'recruitment_appointment','create'),
        'interview',authz.recruiting_child(r.id,'recruitment_interview','create'),
        'followup',authz.recruiting_child(r.id,'recruitment_followup','create'),
        'completeFollowup',authz.recruiting_child(r.id,'recruitment_followup','update'),
        'hook',authz.recruiting_child(r.id,'recruitment_hook','create')),
      'appointments',coalesce((SELECT jsonb_agg(x) FROM (SELECT id,starts_at AS "startsAt",timezone,channel FROM rpt.recruitment_appointment WHERE profile_id=r.id ORDER BY starts_at DESC,id) x),'[]'::jsonb),
      'interviews',coalesce((SELECT jsonb_agg(x) FROM (SELECT id,occurred_at AS "occurredAt",outcome,notes FROM rpt.recruitment_interview WHERE profile_id=r.id ORDER BY occurred_at DESC,id) x),'[]'::jsonb),
      'followups',coalesce((SELECT jsonb_agg(x) FROM (SELECT id,due_at AS "dueAt",body AS text,completed_at AS "completedAt" FROM rpt.recruitment_followup WHERE profile_id=r.id ORDER BY due_at,id) x),'[]'::jsonb),
      'hooks',coalesce((SELECT jsonb_agg(x) FROM (SELECT id,kind,reference,created_at AS "createdAt" FROM rpt.recruitment_hook WHERE profile_id=r.id ORDER BY created_at,id) x),'[]'::jsonb),
      'timeline',coalesce((SELECT jsonb_agg(x) FROM (SELECT id,action,source,authority,request_id AS "requestId",occurred_at AS "occurredAt" FROM rpt.recruitment_event WHERE profile_id=r.id ORDER BY occurred_at DESC,id) x),'[]'::jsonb)
    ) AS value
    FROM rpt.recruitment_profile r JOIN rpt.person p ON (p.tenant_id,p.id)=(r.tenant_id,r.person_id)
    WHERE r.id=$1`,
    [id],
  );
  const value = result.rows[0]?.value;
  if (!value) throw new FoundationError('NOT_FOUND');
  return value;
}

export async function commandRecruitmentProfile(
  client: Client,
  context: AuthContext,
  id: string,
  input: z.infer<typeof recruitingMutation>,
  key: string,
  hash: string,
) {
  const previous = await receipt(client, key, hash);
  const aggregate = (
    await client.query<{ id: string; version: number }>(
      'SELECT id,version FROM rpt.recruitment_profile WHERE id=$1 FOR UPDATE',
      [id],
    )
  ).rows[0];
  if (!aggregate) throw new FoundationError('NOT_FOUND');
  const command = input.command;
  const authorizationSql =
    command.type === 'reassign_owner'
      ? 'SELECT authz.recruiting_can_assign($1,$2) AS allowed'
      : command.type === 'appointment'
        ? "SELECT authz.recruiting_child($1,'recruitment_appointment','create') AS allowed"
        : command.type === 'interview'
          ? "SELECT authz.recruiting_child($1,'recruitment_interview','create') AS allowed"
          : command.type === 'followup'
            ? "SELECT authz.recruiting_child($1,'recruitment_followup','create') AS allowed"
            : command.type === 'complete_followup'
              ? "SELECT authz.recruiting_child($1,'recruitment_followup','update') AS allowed"
              : command.type === 'hook'
                ? "SELECT authz.recruiting_child($1,'recruitment_hook','create') AS allowed"
                : "SELECT authz.recruiting_allowed($1,'update') AS allowed";
  const authParams = command.type === 'reassign_owner' ? [id, command.ownerId] : [id];
  const allowed = (await client.query<{ allowed: boolean }>(authorizationSql, authParams)).rows[0]
    ?.allowed;
  if (!allowed) throw new FoundationError('FORBIDDEN');
  if (previous) return previous;
  if (aggregate.version !== input.expectedVersion) throw new FoundationError('CONFLICT');

  const childId = crypto.randomUUID();
  let action: string;
  let payload: Record<string, unknown>;
  if (command.type === 'stage') {
    await client.query(
      'UPDATE rpt.recruitment_profile SET stage=$2,version=version+1 WHERE id=$1',
      [id, command.stage],
    );
    action = 'stage.changed';
    payload = { stage: command.stage };
  } else if (command.type === 'substatus') {
    await client.query(
      'UPDATE rpt.recruitment_profile SET substatus=$2,version=version+1 WHERE id=$1',
      [id, command.substatus],
    );
    action = 'substatus.changed';
    payload = { substatus: command.substatus };
  } else if (command.type === 'priority') {
    await client.query(
      'UPDATE rpt.recruitment_profile SET priority=$2,version=version+1 WHERE id=$1',
      [id, command.priority],
    );
    action = 'priority.changed';
    payload = { priority: command.priority, meaning: 'operational_priority' };
  } else if (command.type === 'reassign_owner') {
    await client.query(
      'UPDATE rpt.recruitment_profile SET owner_id=$2,version=version+1 WHERE id=$1',
      [id, command.ownerId],
    );
    action = 'owner.reassigned';
    payload = { ownerId: command.ownerId };
  } else if (command.type === 'appointment') {
    await client.query(
      `INSERT INTO rpt.recruitment_appointment(tenant_id,id,profile_id,starts_at,timezone,channel,actor_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        context.tenantId,
        childId,
        id,
        command.startsAt,
        command.timezone,
        command.channel,
        context.actorId,
      ],
    );
    await client.query('UPDATE rpt.recruitment_profile SET version=version+1 WHERE id=$1', [id]);
    action = 'appointment.recorded';
    payload = { appointmentId: childId };
  } else if (command.type === 'interview') {
    await client.query(
      `INSERT INTO rpt.recruitment_interview(tenant_id,id,profile_id,occurred_at,outcome,notes,actor_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        context.tenantId,
        childId,
        id,
        command.occurredAt,
        command.outcome,
        command.notes,
        context.actorId,
      ],
    );
    await client.query('UPDATE rpt.recruitment_profile SET version=version+1 WHERE id=$1', [id]);
    action = 'interview.recorded';
    payload = { interviewId: childId, outcome: command.outcome };
  } else if (command.type === 'followup') {
    await client.query(
      `INSERT INTO rpt.recruitment_followup(tenant_id,id,profile_id,due_at,body,actor_id)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [context.tenantId, childId, id, command.dueAt, command.text, context.actorId],
    );
    await client.query('UPDATE rpt.recruitment_profile SET version=version+1 WHERE id=$1', [id]);
    action = 'followup.recorded';
    payload = { followupId: childId };
  } else if (command.type === 'complete_followup') {
    const done = await client.query(
      'UPDATE rpt.recruitment_followup SET completed_at=statement_timestamp() WHERE id=$1 AND profile_id=$2 AND completed_at IS NULL',
      [command.followupId, id],
    );
    if (!done.rowCount) throw new FoundationError('NOT_FOUND');
    await client.query('UPDATE rpt.recruitment_profile SET version=version+1 WHERE id=$1', [id]);
    action = 'followup.completed';
    payload = { followupId: command.followupId };
  } else {
    await client.query(
      `INSERT INTO rpt.recruitment_hook(tenant_id,id,profile_id,kind,reference,actor_id)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [context.tenantId, childId, id, command.kind, command.reference, context.actorId],
    );
    await client.query('UPDATE rpt.recruitment_profile SET version=version+1 WHERE id=$1', [id]);
    action = `${command.kind}.requested`;
    payload = { hookId: childId, reference: command.reference };
  }
  await client.query(
    `INSERT INTO rpt.recruitment_event(tenant_id,id,profile_id,actor_id,action,request_id,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      context.tenantId,
      crypto.randomUUID(),
      id,
      context.actorId,
      action,
      context.requestId,
      payload,
    ],
  );
  return finish(client, key, { id, version: aggregate.version + 1 });
}
