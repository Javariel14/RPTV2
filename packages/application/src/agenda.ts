import type { Client } from 'pg';
import {
  FoundationError,
  type AgendaCreate,
  type AgendaDetail,
  type AgendaItem,
  type AgendaList,
  type AgendaListQuery,
  type AgendaMutation,
  type AgendaMutationResult,
} from '@rpt/contracts';
import type { AuthContext } from '@rpt/persistence';

async function receipt(client: Client, key: string, hash: string) {
  return (
    await client.query<{ value: AgendaMutationResult | null }>(
      'SELECT authz.agenda_receipt($1,$2) AS value',
      [key, hash],
    )
  ).rows[0]?.value;
}

async function finish(client: Client, key: string, value: AgendaMutationResult) {
  await client.query('SELECT authz.agenda_finish($1,$2)', [key, value]);
  return value;
}

async function can(client: Client, sql: string, values: unknown[]) {
  return (await client.query<{ allowed: boolean }>(sql, values)).rows[0]?.allowed === true;
}

async function recurrenceStarts(
  client: Client,
  anchor: string,
  timezone: string,
  recurrence: AgendaCreate['recurrence'],
) {
  if (!recurrence) return [anchor];
  const rows = await client.query<{ startsAt: string }>(
    recurrence.frequency === 'daily'
      ? `SELECT ((($1::timestamptz AT TIME ZONE $2)::date + n * $3::int)
           + ($1::timestamptz AT TIME ZONE $2)::time) AT TIME ZONE $2 AS "startsAt"
         FROM generate_series(0,50) n
         WHERE ((($1::timestamptz AT TIME ZONE $2)::date + n * $3::int)
           + ($1::timestamptz AT TIME ZONE $2)::time) AT TIME ZONE $2 <= $4::timestamptz
         ORDER BY n`
      : `WITH candidate AS (
           SELECT day::date local_day
           FROM generate_series(($1::timestamptz AT TIME ZONE $2)::date,
             ($4::timestamptz AT TIME ZONE $2)::date,interval '1 day') day
         )
         SELECT (local_day + ($1::timestamptz AT TIME ZONE $2)::time) AT TIME ZONE $2 AS "startsAt"
         FROM candidate
         WHERE extract(isodow FROM local_day)::int=ANY($5::int[])
           AND ((local_day-($1::timestamptz AT TIME ZONE $2)::date)/7)%$3::int=0
           AND (local_day + ($1::timestamptz AT TIME ZONE $2)::time) AT TIME ZONE $2 >= $1::timestamptz
           AND (local_day + ($1::timestamptz AT TIME ZONE $2)::time) AT TIME ZONE $2 <= $4::timestamptz
         ORDER BY local_day LIMIT 51`,
    recurrence.frequency === 'daily'
      ? [anchor, timezone, recurrence.interval, recurrence.until]
      : [anchor, timezone, recurrence.interval, recurrence.until, recurrence.weekdays],
  );
  if (!rows.rows.length || rows.rows.length > 50) throw new FoundationError('INVALID_REQUEST');
  return rows.rows.map((row) => new Date(row.startsAt).toISOString());
}

async function insertReminders(
  client: Client,
  context: AuthContext,
  itemId: string,
  anchor: string,
  minutes: number[],
  version: number,
) {
  for (const minute of [...new Set(minutes)].sort((a, b) => a - b))
    await client.query(
      `INSERT INTO rpt.agenda_reminder(tenant_id,id,item_id,reminder_at,dedupe_key)
       VALUES($1,$2,$3,$4::timestamptz-$5::int*interval '1 minute',$6)`,
      [
        context.tenantId,
        crypto.randomUUID(),
        itemId,
        anchor,
        minute,
        `${itemId}:${version}:${minute}`,
      ],
    );
}

async function addEvent(
  client: Client,
  context: AuthContext,
  itemId: string,
  action: string,
  payload: Record<string, unknown>,
) {
  await client.query(
    `INSERT INTO rpt.agenda_event(tenant_id,id,item_id,actor_id,action,request_id,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      context.tenantId,
      crypto.randomUUID(),
      itemId,
      context.actorId,
      action,
      context.requestId,
      payload,
    ],
  );
}

export async function createAgendaItem(
  client: Client,
  context: AuthContext,
  input: AgendaCreate,
  key: string,
  hash: string,
) {
  if (
    !(await can(client, "SELECT authz.agenda_workspace_right($1,'create') AS allowed", [
      input.workspaceId,
    ])) ||
    !(await can(client, 'SELECT authz.agenda_context_allowed($1,$2,$3) AS allowed', [
      input.personId,
      input.opportunityId,
      input.recruitmentProfileId,
    ]))
  )
    throw new FoundationError('FORBIDDEN');
  const previous = await receipt(client, key, hash);
  if (previous) return previous;

  const anchor = input.type === 'appointment' ? input.startsAt : input.dueAt;
  const starts = await recurrenceStarts(client, anchor, input.timezone, input.recurrence);
  const duration =
    input.type === 'appointment' ? Date.parse(input.endsAt) - Date.parse(input.startsAt) : 0;
  const seriesId = input.recurrence ? crypto.randomUUID() : null;
  const createdIds: string[] = [];
  for (const [occurrenceIndex, occurrence] of starts.entries()) {
    const id = seriesId && occurrenceIndex === 0 ? seriesId : crypto.randomUUID();
    const endsAt =
      input.type === 'appointment'
        ? new Date(Date.parse(occurrence) + duration).toISOString()
        : null;
    const dueAt = input.type === 'task' ? occurrence : null;
    await client.query(
      `INSERT INTO rpt.agenda_item(
        tenant_id,id,workspace_id,owner_id,type,title,summary,starts_at,ends_at,due_at,timezone,status,
        confirmation_state,priority,source,person_id,opportunity_id,recruitment_profile_id,series_id,
        occurrence_index,recurrence_rule,reminder_minutes,origin_label,destination_label,
        estimated_travel_minutes,preparation_minutes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [
        context.tenantId,
        id,
        input.workspaceId,
        context.actorId,
        input.type,
        input.title,
        input.summary,
        input.type === 'appointment' ? occurrence : null,
        endsAt,
        dueAt,
        input.timezone,
        input.type === 'appointment' ? 'scheduled' : 'open',
        input.type === 'appointment' ? 'pending' : null,
        input.type === 'task' ? input.priority : 'normal',
        input.source,
        input.personId,
        input.opportunityId,
        input.recruitmentProfileId,
        seriesId,
        occurrenceIndex,
        input.recurrence,
        [...new Set(input.reminderMinutesBefore)].sort((a, b) => a - b),
        input.travel.originLabel,
        input.travel.destinationLabel,
        input.travel.estimatedTravelMinutes,
        input.travel.preparationMinutes,
      ],
    );
    await insertReminders(client, context, id, occurrence, input.reminderMinutesBefore, 1);
    await addEvent(client, context, id, 'created', {
      type: input.type,
      source: input.source,
      seriesId,
      occurrenceIndex,
    });
    createdIds.push(id);
  }
  return finish(client, key, { id: createdIds[0]!, version: 1, createdIds });
}

const agendaSources = `WITH i AS (
 SELECT n.*,true AS native FROM rpt.agenda_item n
 UNION ALL
 SELECT a.tenant_id,a.id,o.workspace_id,o.owner_id,'appointment'::text,'Commercial appointment'::text,NULL::text,
   a.starts_at,NULL::timestamptz,NULL::timestamptz,a.timezone,'scheduled'::text,NULL::text,'normal'::text,
   'commercial_crm'::text,o.person_id,a.opportunity_id,NULL::uuid,NULL::uuid,0,NULL::jsonb,ARRAY[]::integer[],
   NULL::text,NULL::text,NULL::integer,NULL::integer,1,a.created_at,a.created_at,false
 FROM rpt.appointment a JOIN rpt.opportunity o ON (o.tenant_id,o.id)=(a.tenant_id,a.opportunity_id)
 UNION ALL
 SELECT e.tenant_id,e.id,o.workspace_id,o.owner_id,'task'::text,'Commercial task'::text,NULL::text,
   NULL::timestamptz,NULL::timestamptz,e.due_at,authz.workspace_timezone(o.workspace_id),
   CASE WHEN e.completed_at IS NULL THEN 'open' ELSE 'completed' END,NULL::text,'normal'::text,
   'commercial_crm'::text,o.person_id,e.opportunity_id,NULL::uuid,NULL::uuid,0,NULL::jsonb,ARRAY[]::integer[],
   NULL::text,NULL::text,NULL::integer,NULL::integer,1,e.created_at,coalesce(e.completed_at,e.created_at),false
 FROM rpt.crm_entry e JOIN rpt.opportunity o ON (o.tenant_id,o.id)=(e.tenant_id,e.opportunity_id)
 WHERE e.kind='task' AND e.due_at IS NOT NULL
 UNION ALL
 SELECT a.tenant_id,a.id,r.workspace_id,r.owner_id,'appointment'::text,'Recruiting appointment'::text,NULL::text,
   a.starts_at,NULL::timestamptz,NULL::timestamptz,a.timezone,'scheduled'::text,NULL::text,'normal'::text,
   'recruiting_crm'::text,r.person_id,NULL::uuid,a.profile_id,NULL::uuid,0,NULL::jsonb,ARRAY[]::integer[],
   NULL::text,NULL::text,NULL::integer,NULL::integer,1,a.created_at,a.created_at,false
 FROM rpt.recruitment_appointment a JOIN rpt.recruitment_profile r ON (r.tenant_id,r.id)=(a.tenant_id,a.profile_id)
 UNION ALL
 SELECT f.tenant_id,f.id,r.workspace_id,r.owner_id,'task'::text,'Recruiting followup'::text,NULL::text,
   NULL::timestamptz,NULL::timestamptz,f.due_at,authz.workspace_timezone(r.workspace_id),
   CASE WHEN f.completed_at IS NULL THEN 'open' ELSE 'completed' END,NULL::text,'normal'::text,
   'recruiting_crm'::text,r.person_id,NULL::uuid,f.profile_id,NULL::uuid,0,NULL::jsonb,ARRAY[]::integer[],
   NULL::text,NULL::text,NULL::integer,NULL::integer,1,f.created_at,coalesce(f.completed_at,f.created_at),false
 FROM rpt.recruitment_followup f JOIN rpt.recruitment_profile r ON (r.tenant_id,r.id)=(f.tenant_id,f.profile_id)
)`;

const itemProjection = `jsonb_build_object(
 'id',i.id,'workspaceId',i.workspace_id,'ownerId',i.owner_id,'type',i.type,'title',i.title,'summary',i.summary,
 'startsAt',i.starts_at,'endsAt',i.ends_at,'dueAt',i.due_at,'timezone',i.timezone,'status',i.status,
 'confirmationState',i.confirmation_state,'priority',i.priority,'source',i.source,'mutable',i.native,
 'personId',CASE WHEN i.person_id IS NOT NULL AND authz.allowed('person',i.person_id,'read','CONFIDENTIAL') THEN i.person_id END,
 'opportunityId',CASE WHEN i.opportunity_id IS NOT NULL AND authz.crm_allowed(i.opportunity_id,'read') THEN i.opportunity_id END,
 'recruitmentProfileId',CASE WHEN i.recruitment_profile_id IS NOT NULL AND authz.recruiting_allowed(i.recruitment_profile_id,'read') THEN i.recruitment_profile_id END,
 'seriesId',i.series_id,'occurrenceIndex',i.occurrence_index,'recurrence',i.recurrence_rule,
 'reminderMinutesBefore',i.reminder_minutes,
 'travel',jsonb_build_object('originLabel',i.origin_label,'destinationLabel',i.destination_label,
   'estimatedTravelMinutes',i.estimated_travel_minutes,'preparationMinutes',i.preparation_minutes),
 'version',i.version,'createdAt',i.created_at,'updatedAt',i.updated_at)`;

export async function listAgendaItems(client: Client, query: AgendaListQuery): Promise<AgendaList> {
  if (
    !(await can(
      client,
      "SELECT authz.agenda_enabled() AND authz.capable(authz.actor_id(),'agenda_item','read','CONFIDENTIAL') AS allowed",
      [],
    ))
  )
    throw new FoundationError('FORBIDDEN');
  const result = await client.query<{ value: AgendaItem }>(
    `${agendaSources} SELECT ${itemProjection} AS value FROM i
     WHERE coalesce(i.starts_at,i.due_at)>=$1 AND coalesce(i.starts_at,i.due_at)<$2
       AND ($3::boolean=false OR i.owner_id=authz.actor_id())
       AND ($4::text IS NULL OR i.type=$4) AND ($5::text IS NULL OR i.status=$5)
     ORDER BY coalesce(i.starts_at,i.due_at),i.id LIMIT $6`,
    [
      query.from,
      query.to,
      query.owner === 'mine',
      query.type ?? null,
      query.status ?? null,
      query.limit + 1,
    ],
  );
  return {
    rows: result.rows.slice(0, query.limit).map((row) => row.value),
    truncated: result.rows.length > query.limit,
  };
}

export async function detailAgendaItem(client: Client, id: string): Promise<AgendaDetail> {
  if (
    !(await can(
      client,
      "SELECT authz.agenda_enabled() AND authz.capable(authz.actor_id(),'agenda_item','read','CONFIDENTIAL') AS allowed",
      [],
    ))
  )
    throw new FoundationError('FORBIDDEN');
  const row = (
    await client.query<{ value: AgendaDetail }>(
      `${agendaSources} SELECT ${itemProjection} || jsonb_build_object(
        'reminders',CASE WHEN i.native THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'reminderAt',r.reminder_at,'channel',r.channel,'status',r.status) ORDER BY r.reminder_at,r.id) FROM rpt.agenda_reminder r WHERE r.item_id=i.id),'[]') ELSE '[]'::jsonb END,
        'history',CASE WHEN i.native THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'action',e.action,'occurredAt',e.occurred_at,'payload',e.payload) ORDER BY e.occurred_at,e.id) FROM rpt.agenda_event e WHERE e.item_id=i.id),'[]') ELSE '[]'::jsonb END) AS value
       FROM i WHERE i.id=$1 LIMIT 1`,
      [id],
    )
  ).rows[0]?.value;
  if (!row) throw new FoundationError('NOT_FOUND');
  return row;
}

export async function commandAgendaItem(
  client: Client,
  context: AuthContext,
  id: string,
  input: AgendaMutation,
  key: string,
  hash: string,
) {
  const item = (
    await client.query<{
      id: string;
      type: 'appointment' | 'task';
      status: string;
      confirmation_state: string | null;
      starts_at: Date | null;
      due_at: Date | null;
      version: number;
    }>(
      'SELECT id,type,status,confirmation_state,starts_at,due_at,version FROM rpt.agenda_item WHERE id=$1 FOR UPDATE',
      [id],
    )
  ).rows[0];
  if (!item) throw new FoundationError('NOT_FOUND');
  if (!(await can(client, "SELECT authz.agenda_allowed($1,'update') AS allowed", [id])))
    throw new FoundationError('FORBIDDEN');
  const previous = await receipt(client, key, hash);
  if (previous) return previous;
  if (item.version !== input.expectedVersion) throw new FoundationError('CONFLICT');
  const nextVersion = item.version + 1;
  const command = input.command;
  let action: string;
  let payload: Record<string, unknown> = {};
  if (command.type === 'update') {
    if (item.status === 'completed' || item.status === 'cancelled')
      throw new FoundationError('INVALID_REQUEST');
    await client.query(
      'UPDATE rpt.agenda_item SET title=$2,summary=$3,version=version+1 WHERE id=$1',
      [id, command.title, command.summary],
    );
    action = 'updated';
  } else if (command.type === 'update_task') {
    if (item.type !== 'task' || item.status !== 'open')
      throw new FoundationError('INVALID_REQUEST');
    await client.query(
      'UPDATE rpt.agenda_item SET due_at=$2,timezone=$3,priority=$4,version=version+1 WHERE id=$1',
      [id, command.dueAt, command.timezone, command.priority],
    );
    await client.query(
      "UPDATE rpt.agenda_reminder SET status='cancelled',updated_at=statement_timestamp() WHERE item_id=$1 AND status='scheduled'",
      [id],
    );
    const minutes =
      (
        await client.query<{ reminder_minutes: number[] }>(
          'SELECT reminder_minutes FROM rpt.agenda_item WHERE id=$1',
          [id],
        )
      ).rows[0]?.reminder_minutes ?? [];
    await insertReminders(client, context, id, command.dueAt, minutes, nextVersion);
    action = 'updated';
    payload = { dueAt: command.dueAt, priority: command.priority };
  } else if (command.type === 'reschedule') {
    if (item.type !== 'appointment' || item.status !== 'scheduled')
      throw new FoundationError('INVALID_REQUEST');
    const previousStartsAt = item.starts_at?.toISOString();
    await client.query(
      `UPDATE rpt.agenda_item SET starts_at=$2,ends_at=$3,timezone=$4,version=version+1 WHERE id=$1`,
      [id, command.startsAt, command.endsAt, command.timezone],
    );
    await client.query(
      "UPDATE rpt.agenda_reminder SET status='cancelled',updated_at=statement_timestamp() WHERE item_id=$1 AND status='scheduled'",
      [id],
    );
    const minutes =
      (
        await client.query<{ reminder_minutes: number[] }>(
          'SELECT reminder_minutes FROM rpt.agenda_item WHERE id=$1',
          [id],
        )
      ).rows[0]?.reminder_minutes ?? [];
    await insertReminders(client, context, id, command.startsAt, minutes, nextVersion);
    action = 'rescheduled';
    payload = { previousStartsAt, startsAt: command.startsAt };
  } else if (command.type === 'confirm' || command.type === 'decline') {
    if (
      item.type !== 'appointment' ||
      item.status !== 'scheduled' ||
      item.confirmation_state === 'cancelled'
    )
      throw new FoundationError('INVALID_REQUEST');
    const confirmation = command.type === 'confirm' ? 'confirmed' : 'declined';
    await client.query(
      `UPDATE rpt.agenda_item SET confirmation_state=$2,status=CASE WHEN $2='declined' THEN 'cancelled' ELSE status END,version=version+1 WHERE id=$1`,
      [id, confirmation],
    );
    if (confirmation === 'declined')
      await client.query(
        "UPDATE rpt.agenda_reminder SET status='cancelled',updated_at=statement_timestamp() WHERE item_id=$1 AND status='scheduled'",
        [id],
      );
    action = command.type === 'confirm' ? 'confirmed' : 'declined';
  } else if (command.type === 'cancel') {
    if (item.type !== 'appointment' || item.status !== 'scheduled')
      throw new FoundationError('INVALID_REQUEST');
    await client.query(
      "UPDATE rpt.agenda_item SET status='cancelled',confirmation_state='cancelled',version=version+1 WHERE id=$1",
      [id],
    );
    await client.query(
      "UPDATE rpt.agenda_reminder SET status='cancelled',updated_at=statement_timestamp() WHERE item_id=$1 AND status='scheduled'",
      [id],
    );
    action = 'cancelled';
  } else if (command.type === 'complete') {
    if (item.type !== 'task' || item.status !== 'open')
      throw new FoundationError('INVALID_REQUEST');
    await client.query(
      "UPDATE rpt.agenda_item SET status='completed',version=version+1 WHERE id=$1",
      [id],
    );
    await client.query(
      "UPDATE rpt.agenda_reminder SET status='cancelled',updated_at=statement_timestamp() WHERE item_id=$1 AND status='scheduled'",
      [id],
    );
    action = 'completed';
  } else {
    if (item.status === 'completed' || item.status === 'cancelled')
      throw new FoundationError('INVALID_REQUEST');
    await client.query(
      'UPDATE rpt.agenda_item SET reminder_minutes=$2,version=version+1 WHERE id=$1',
      [id, [...new Set(command.reminderMinutesBefore)].sort((a, b) => a - b)],
    );
    await client.query(
      "UPDATE rpt.agenda_reminder SET status='cancelled',updated_at=statement_timestamp() WHERE item_id=$1 AND status='scheduled'",
      [id],
    );
    const anchor = item.type === 'appointment' ? item.starts_at : item.due_at;
    if (!anchor) throw new FoundationError('INVALID_REQUEST');
    await insertReminders(
      client,
      context,
      id,
      anchor.toISOString(),
      command.reminderMinutesBefore,
      nextVersion,
    );
    action = 'reminders_replaced';
  }
  await addEvent(client, context, id, action, payload);
  return finish(client, key, { id, version: nextVersion });
}
