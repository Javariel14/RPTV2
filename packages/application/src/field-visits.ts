import type { Client } from 'pg';
import {
  FoundationError,
  type FieldVisitCreate,
  type FieldVisitDetail,
  type FieldVisitItem,
  type FieldVisitList,
  type FieldVisitListQuery,
  type FieldVisitMutation,
  type FieldVisitMutationResult,
} from '@rpt/contracts';
import type { AuthContext } from '@rpt/persistence';

async function can(client: Client, sql: string, values: unknown[]) {
  return (await client.query<{ allowed: boolean }>(sql, values)).rows[0]?.allowed === true;
}

async function receipt(client: Client, key: string, hash: string) {
  return (
    await client.query<{ value: FieldVisitMutationResult | null }>(
      'SELECT authz.visit_receipt($1,$2) AS value',
      [key, hash],
    )
  ).rows[0]?.value;
}

async function finish(client: Client, key: string, value: FieldVisitMutationResult) {
  await client.query('SELECT authz.visit_finish($1,$2)', [key, value]);
  return value;
}

async function addEvent(
  client: Client,
  context: AuthContext,
  visitId: string,
  action: string,
  payload: Record<string, unknown> = {},
) {
  await client.query(
    `INSERT INTO rpt.field_visit_event(tenant_id,id,visit_id,actor_id,action,request_id,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      context.tenantId,
      crypto.randomUUID(),
      visitId,
      context.actorId,
      action,
      context.requestId,
      payload,
    ],
  );
}

async function addLocation(
  client: Client,
  context: AuthContext,
  visitId: string,
  phase: 'check_in' | 'check_out',
  location: NonNullable<Extract<FieldVisitMutation['command'], { type: 'check_in' }>['location']>,
) {
  await client.query(
    `INSERT INTO rpt.field_visit_location(
       tenant_id,id,visit_id,actor_id,phase,latitude,longitude,accuracy_meters,
       source,purpose,consent_context)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'device_explicit',$9,'explicit_visit_action')`,
    [
      context.tenantId,
      crypto.randomUUID(),
      visitId,
      context.actorId,
      phase,
      location.latitude,
      location.longitude,
      location.accuracyMeters,
      phase === 'check_in' ? 'visit_check_in' : 'visit_check_out',
    ],
  );
}

export async function createFieldVisit(
  client: Client,
  context: AuthContext,
  input: FieldVisitCreate,
  key: string,
  hash: string,
) {
  if (
    !(await can(
      client,
      "SELECT authz.visit_workspace_right($1,'create','CONFIDENTIAL') AS allowed",
      [input.workspaceId],
    )) ||
    !(await can(client, 'SELECT authz.visit_context_allowed($1,$2) AS allowed', [
      input.personId,
      input.opportunityId,
    ]))
  )
    throw new FoundationError('FORBIDDEN');
  const previous = await receipt(client, key, hash);
  if (previous) return previous;

  let scheduledAt = input.scheduledAt;
  let personId = input.personId;
  let opportunityId = input.opportunityId;
  if (input.agendaItemId) {
    const agenda = (
      await client.query<{
        workspace_id: string;
        person_id: string | null;
        opportunity_id: string | null;
        starts_at: Date;
      }>(
        `SELECT workspace_id,person_id,opportunity_id,starts_at
         FROM rpt.agenda_item WHERE id=$1 AND type='appointment' AND status='scheduled'`,
        [input.agendaItemId],
      )
    ).rows[0];
    if (!agenda) throw new FoundationError('NOT_FOUND');
    if (
      agenda.workspace_id !== input.workspaceId ||
      (personId && agenda.person_id && personId !== agenda.person_id) ||
      (opportunityId && agenda.opportunity_id && opportunityId !== agenda.opportunity_id)
    )
      throw new FoundationError('INVALID_REQUEST');
    scheduledAt = agenda.starts_at.toISOString();
    personId ??= agenda.person_id;
    opportunityId ??= agenda.opportunity_id;
  }
  if (!scheduledAt) throw new FoundationError('INVALID_REQUEST');
  if (
    !(await can(client, 'SELECT authz.visit_context_allowed($1,$2) AS allowed', [
      personId,
      opportunityId,
    ]))
  )
    throw new FoundationError('FORBIDDEN');

  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO rpt.field_visit(
       tenant_id,id,workspace_id,owner_id,agenda_item_id,person_id,opportunity_id,scheduled_at,purpose)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      context.tenantId,
      id,
      input.workspaceId,
      context.actorId,
      input.agendaItemId,
      personId,
      opportunityId,
      scheduledAt,
      input.purpose,
    ],
  );
  await addEvent(client, context, id, 'created', {
    linkedAgenda: input.agendaItemId !== null,
    hasPerson: personId !== null,
    hasOpportunity: opportunityId !== null,
  });
  return finish(client, key, { id, version: 1, status: 'planned' });
}

const visitProjection = `jsonb_build_object(
  'id',v.id,'workspaceId',v.workspace_id,'ownerId',v.owner_id,'status',v.status,
  'scheduledAt',v.scheduled_at,
  'agendaItemId',CASE WHEN v.agenda_item_id IS NOT NULL AND authz.agenda_allowed(v.agenda_item_id,'read') THEN v.agenda_item_id END,
  'personId',CASE WHEN v.person_id IS NOT NULL AND authz.allowed('person',v.person_id,'read','CONFIDENTIAL') THEN v.person_id END,
  'opportunityId',CASE WHEN v.opportunity_id IS NOT NULL AND authz.crm_allowed(v.opportunity_id,'read') THEN v.opportunity_id END,
  'purpose',v.purpose,'actualStart',v.actual_start,'actualEnd',v.actual_end,
  'outcome',v.outcome,'notes',v.notes,'version',v.version,
  'createdAt',v.created_at,'updatedAt',v.updated_at)`;

async function requireVisitReadCapability(client: Client) {
  if (
    !(await can(
      client,
      "SELECT authz.visit_enabled() AND authz.capable(authz.actor_id(),'field_visit','read','CONFIDENTIAL') AS allowed",
      [],
    ))
  )
    throw new FoundationError('FORBIDDEN');
}

export async function listFieldVisits(
  client: Client,
  query: FieldVisitListQuery,
): Promise<FieldVisitList> {
  await requireVisitReadCapability(client);
  const result = await client.query<{ value: FieldVisitItem }>(
    `SELECT ${visitProjection} AS value FROM rpt.field_visit v
     WHERE v.scheduled_at >= $1 AND v.scheduled_at < $2
       AND ($3::boolean=false OR v.owner_id=authz.actor_id())
       AND ($4::text IS NULL OR v.status=$4)
     ORDER BY v.scheduled_at,v.id LIMIT $5`,
    [query.from, query.to, query.owner === 'mine', query.status ?? null, query.limit + 1],
  );
  return {
    rows: result.rows.slice(0, query.limit).map((row) => row.value),
    truncated: result.rows.length > query.limit,
  };
}

export async function fieldVisitContext(client: Client) {
  await requireVisitReadCapability(client);
  const row = (
    await client.query<{ id: string }>(
      `SELECT w.id FROM rpt.crm_workspace w
     WHERE w.tenant_id=authz.tenant_id()
       AND authz.visit_workspace_right(w.id,'create','CONFIDENTIAL')
     ORDER BY w.id LIMIT 1`,
    )
  ).rows[0];
  return { workspaceId: row?.id ?? null };
}

export async function detailFieldVisit(client: Client, id: string): Promise<FieldVisitDetail> {
  await requireVisitReadCapability(client);
  const row = (
    await client.query<{ value: FieldVisitDetail }>(
      `SELECT ${visitProjection} || jsonb_build_object(
        'travel',CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
          'originLabel',a.origin_label,'destinationLabel',a.destination_label,
          'estimatedTravelMinutes',a.estimated_travel_minutes,
          'preparationMinutes',a.preparation_minutes) END,
        'locationEvidence',CASE WHEN authz.visit_location_allowed(v.id,'read') THEN coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'id',l.id,'phase',l.phase,'latitude',l.latitude::text,'longitude',l.longitude::text,
            'accuracyMeters',l.accuracy_meters::text,'capturedAt',l.captured_at,
            'source',l.source,'purpose',l.purpose,'consentContext',l.consent_context)
            ORDER BY l.captured_at,l.id)
          FROM rpt.field_visit_location l
          WHERE (l.tenant_id,l.visit_id)=(v.tenant_id,v.id)),'[]') ELSE '[]'::jsonb END,
        'history',coalesce((SELECT jsonb_agg(jsonb_build_object(
          'id',e.id,'action',e.action,'occurredAt',e.occurred_at,'payload',e.payload)
          ORDER BY e.occurred_at,e.id) FROM rpt.field_visit_event e
          WHERE (e.tenant_id,e.visit_id)=(v.tenant_id,v.id)),'[]')) AS value
       FROM rpt.field_visit v
       LEFT JOIN rpt.agenda_item a ON (a.tenant_id,a.id)=(v.tenant_id,v.agenda_item_id)
       WHERE v.id=$1 LIMIT 1`,
      [id],
    )
  ).rows[0]?.value;
  if (!row) throw new FoundationError('NOT_FOUND');
  return row;
}

export async function commandFieldVisit(
  client: Client,
  context: AuthContext,
  id: string,
  input: FieldVisitMutation,
  key: string,
  hash: string,
) {
  if (
    !(await can(
      client,
      "SELECT authz.visit_enabled() AND authz.capable(authz.actor_id(),'field_visit','update','CONFIDENTIAL') AS allowed",
      [],
    ))
  )
    throw new FoundationError('FORBIDDEN');
  const visit = (
    await client.query<{
      status: FieldVisitItem['status'];
      version: number;
      agenda_item_id: string | null;
      actual_start: Date | null;
    }>(
      'SELECT status,version,agenda_item_id,actual_start FROM rpt.field_visit WHERE id=$1 FOR UPDATE',
      [id],
    )
  ).rows[0];
  if (!visit) throw new FoundationError('NOT_FOUND');
  if (!(await can(client, "SELECT authz.visit_allowed($1,'update') AS allowed", [id])))
    throw new FoundationError('FORBIDDEN');
  const previous = await receipt(client, key, hash);
  if (previous) return previous;
  if (visit.version !== input.expectedVersion) throw new FoundationError('CONFLICT');
  const command = input.command;
  if (
    'location' in command &&
    command.location &&
    !(await can(client, "SELECT authz.visit_location_allowed($1,'update') AS allowed", [id]))
  )
    throw new FoundationError('FORBIDDEN');

  let status = visit.status;
  let action: string;
  let payload: Record<string, unknown> = {};
  if (command.type === 'update') {
    if (visit.status !== 'planned' || visit.agenda_item_id)
      throw new FoundationError('INVALID_REQUEST');
    await client.query(
      'UPDATE rpt.field_visit SET purpose=$2,scheduled_at=$3,version=version+1 WHERE id=$1',
      [id, command.purpose, command.scheduledAt],
    );
    action = 'updated';
  } else if (command.type === 'check_in') {
    if (visit.status !== 'planned') throw new FoundationError('INVALID_REQUEST');
    await client.query(
      "UPDATE rpt.field_visit SET status='in_progress',actual_start=clock_timestamp(),version=version+1 WHERE id=$1",
      [id],
    );
    if (command.location) await addLocation(client, context, id, 'check_in', command.location);
    status = 'in_progress';
    action = 'checked_in';
    payload = { locationCaptured: command.location !== null };
  } else if (command.type === 'check_out') {
    if (visit.status !== 'in_progress' || !visit.actual_start)
      throw new FoundationError('INVALID_REQUEST');
    await client.query(
      `UPDATE rpt.field_visit SET status='completed',actual_end=clock_timestamp(),outcome=$2,notes=$3,
       version=version+1 WHERE id=$1`,
      [id, command.outcome, command.notes],
    );
    if (command.location) await addLocation(client, context, id, 'check_out', command.location);
    status = 'completed';
    action = 'checked_out';
    payload = { locationCaptured: command.location !== null, outcomeRecorded: true };
  } else {
    if (visit.status !== 'planned') throw new FoundationError('INVALID_REQUEST');
    status = command.type === 'cancel' ? 'cancelled' : 'no_show';
    await client.query('UPDATE rpt.field_visit SET status=$2,version=version+1 WHERE id=$1', [
      id,
      status,
    ]);
    action = status;
  }
  await addEvent(client, context, id, action, payload);
  return finish(client, key, { id, version: visit.version + 1, status });
}
