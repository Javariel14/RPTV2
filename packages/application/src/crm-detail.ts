import type { Client } from 'pg';
import type { z } from 'zod';
import {
  FoundationError,
  type CrmDetail,
  type CrmIntelligence,
  type CrmRow,
  type crmMutation,
} from '@rpt/contracts';
import type { AuthContext } from '@rpt/persistence';
import { deriveCrmIntelligence, type CrmIntelligenceSignals } from './crm-intelligence.js';

type BaseCrmRow = Omit<CrmRow, keyof CrmIntelligence>;
type SignalDetail = Omit<CrmDetail, 'row'> & {
  row: BaseCrmRow;
  intelligenceSignals: CrmIntelligenceSignals;
};

// Every projection is read as rpt_runtime through existing RLS. No owner/service role.
export async function detailCrm(client: Client, id: string): Promise<CrmDetail> {
  const result = await client.query<{ value: SignalDetail }>(
    `
    SELECT jsonb_build_object('row',jsonb_build_object(
      'id',o.id,'personId',p.id,'title',o.title,'name',p.display_name,'personVersion',p.version,
      'ownerId',o.owner_id,'ownerLabel',CASE WHEN o.owner_id=authz.actor_id() THEN 'self' ELSE 'delegated' END,
      'stage',o.stage,'source',o.source,'priority',o.priority,'nextAction',o.next_action,'nextAt',o.next_at,
      'updatedAt',o.updated_at,'version',o.version,'canUpdate',authz.crm_allowed(o.id,'update'),
      'canContact',authz.allowed('person',p.id,'read','RESTRICTED_PII')),
      'contact',(SELECT jsonb_build_object('email',email,'phone',phone) FROM rpt.person_pii WHERE tenant_id=o.tenant_id AND person_id=p.id),
      'referrer',(SELECT jsonb_build_object('id',rp.id,'name',rp.display_name) FROM rpt.person rp WHERE rp.id=o.referrer_person_id),
      'collaborators',authz.crm_collaborators(o.id),
      'activities',coalesce((SELECT jsonb_agg(x) FROM (SELECT id,kind,occurred_at AS "occurredAt",actor_id AS "actorId",summary,source,request_id AS "requestId" FROM rpt.crm_activity WHERE opportunity_id=o.id ORDER BY occurred_at DESC,id LIMIT 100) x),'[]'),
      'appointments',coalesce((SELECT jsonb_agg(x) FROM (SELECT id,starts_at AS "startsAt",timezone,channel FROM rpt.appointment WHERE opportunity_id=o.id ORDER BY starts_at DESC,id LIMIT 100) x),'[]'),
      'demos',coalesce((SELECT jsonb_agg(x) FROM (SELECT id,outcome,occurred_at AS "occurredAt" FROM rpt.demo_visit WHERE opportunity_id=o.id ORDER BY occurred_at DESC,id LIMIT 100) x),'[]'),
      'quotes',coalesce((SELECT jsonb_agg(x) FROM (SELECT id,product,amount::text,currency,revision FROM rpt.quote_version WHERE opportunity_id=o.id ORDER BY revision DESC LIMIT 100) x),'[]'),
      'order',(SELECT jsonb_build_object('id',id,'status',status,'simulatedStatus',simulated_status,'observationId',observation_id) FROM rpt.commercial_order WHERE opportunity_id=o.id),
      'entries',coalesce((SELECT jsonb_agg(x) FROM (SELECT id,kind,body AS text,due_at AS "dueAt",completed_at AS "completedAt" FROM rpt.crm_entry WHERE opportunity_id=o.id ORDER BY created_at DESC,id LIMIT 100) x),'[]'),
      'timeline',coalesce((SELECT jsonb_agg(x) FROM (
        SELECT id,action,occurred_at AS "occurredAt",source,authority,request_id AS "requestId",actor_id AS "actorId",null::text AS summary
        FROM rpt.crm_event WHERE opportunity_id=o.id
        UNION ALL
        SELECT id,kind AS action,occurred_at,source,'manual' AS authority,request_id,actor_id,summary
        FROM rpt.crm_activity WHERE opportunity_id=o.id
        ORDER BY "occurredAt" DESC,id LIMIT 100
      ) x),'[]'),
      'intelligenceSignals',jsonb_build_object(
        'opportunityId',o.id,'stage',o.stage,'nextAction',o.next_action,'nextAt',o.next_at,
        'updatedAt',o.updated_at,'asOf',statement_timestamp(),
        'lastActivityAt',greatest(
          (SELECT max(occurred_at) FROM rpt.crm_activity WHERE opportunity_id=o.id),
          (SELECT max(occurred_at) FROM rpt.crm_event WHERE opportunity_id=o.id),
          (SELECT max(occurred_at) FROM rpt.demo_visit WHERE opportunity_id=o.id)),
        'overdueTaskCount',(SELECT count(*)::int FROM rpt.crm_entry WHERE opportunity_id=o.id AND kind='task' AND completed_at IS NULL AND due_at<statement_timestamp()),
        'overdueTaskId',(SELECT id FROM rpt.crm_entry WHERE opportunity_id=o.id AND kind='task' AND completed_at IS NULL AND due_at<statement_timestamp() ORDER BY due_at,id LIMIT 1),
        'pendingObjectionCount',(SELECT count(*)::int FROM rpt.crm_entry WHERE opportunity_id=o.id AND kind='objection'),
        'pendingCommitmentCount',(SELECT count(*)::int FROM rpt.crm_entry WHERE opportunity_id=o.id AND kind='commitment'),
        'futureAppointmentAt',(SELECT starts_at FROM rpt.appointment WHERE opportunity_id=o.id AND starts_at>=statement_timestamp() ORDER BY starts_at,id LIMIT 1),
        'futureAppointmentId',(SELECT id FROM rpt.appointment WHERE opportunity_id=o.id AND starts_at>=statement_timestamp() ORDER BY starts_at,id LIMIT 1),
        'orderSimulatedStatus',(SELECT simulated_status FROM rpt.commercial_order WHERE opportunity_id=o.id)),
      'permissions',jsonb_build_object(
        'schedule',authz.crm_child(o.id,'appointment','create'), 'demo',authz.crm_child(o.id,'demo','create'),
        'quote',authz.crm_child(o.id,'quote','create'),
        'order',authz.crm_child(o.id,'order','create') AND authz.crm_child(o.id,'order','update'),
        'reconcile',authz.crm_child(o.id,'reconciliation','approve') AND authz.crm_child(o.id,'order','update') AND authz.crm_manual_authority(),
        'postsale',authz.crm_child(o.id,'order','update'), 'notes',authz.crm_child(o.id,'entry','create'),
        'completeTask',authz.crm_child(o.id,'entry','update'),
        'editPerson',authz.crm_allowed(o.id,'update') AND authz.allowed('person',p.id,'update','CONFIDENTIAL'),
        'editContact',authz.crm_allowed(o.id,'update') AND authz.allowed('person',p.id,'read','RESTRICTED_PII') AND authz.allowed('person',p.id,'update','RESTRICTED_PII'),
        'manageCollaborators',authz.crm_allowed(o.id,'share'),
        'recordActivity',authz.crm_child(o.id,'activity','create'),
        'setReferral',authz.crm_allowed(o.id,'update'))) AS value
    FROM rpt.opportunity o JOIN rpt.person p ON (p.tenant_id,p.id)=(o.tenant_id,o.person_id)
    WHERE o.id=$1`,
    [id],
  );
  const raw = result.rows[0]?.value;
  if (!raw) throw new FoundationError('NOT_FOUND');
  const { intelligenceSignals, ...detail } = raw;
  return {
    ...detail,
    row: { ...detail.row, ...deriveCrmIntelligence(intelligenceSignals) },
  };
}

export async function commandCrm(
  client: Client,
  context: AuthContext,
  id: string,
  input: z.infer<typeof crmMutation>,
  key: string,
  hash: string,
) {
  // Serialize same-key retries before locking the aggregate (consistent lock order).
  // Receipt contents are never returned before fresh object + action authorization.
  const previous = (
    await client.query<{ value: { id: string; version: number } | null }>(
      'SELECT authz.crm_receipt($1,$2) AS value',
      [key, hash],
    )
  ).rows[0]?.value;
  const locked = await client.query('SELECT id FROM rpt.opportunity WHERE id=$1 FOR UPDATE', [id]);
  if (!locked.rowCount) throw new FoundationError('NOT_FOUND');
  const detail = await detailCrm(client, id);
  const c = input.command,
    p = detail.permissions,
    row = detail.row;
  const allowed =
    c.type === 'stage'
      ? row.canUpdate
      : c.type === 'appointment'
        ? p.schedule
        : c.type === 'demo'
          ? p.demo
          : c.type === 'quote'
            ? p.quote
            : c.type === 'submit_order'
              ? p.order
              : c.type === 'reconcile_mock'
                ? p.reconcile
                : c.type === 'delivery' || c.type === 'curation'
                  ? p.postsale
                  : c.type === 'entry'
                    ? p.notes
                    : c.type === 'complete_task'
                      ? p.completeTask
                      : c.type === 'edit_person'
                        ? p.editPerson
                        : c.type === 'edit_contact'
                          ? p.editContact
                          : c.type === 'add_collaborator' || c.type === 'remove_collaborator'
                            ? p.manageCollaborators
                            : c.type === 'activity'
                              ? p.recordActivity
                              : p.setReferral;
  if (!row.canUpdate || !allowed) throw new FoundationError('NOT_FOUND');
  if (previous) return previous;
  if (row.version !== input.expectedVersion) throw new FoundationError('CONFLICT');
  const tenant = context.tenantId;
  let stage = row.stage,
    next = row.nextAction,
    due = row.nextAt,
    referrer = detail.referrer?.id ?? null;
  let observation: string | null = null;
  const invalid = () => {
    throw new FoundationError('INVALID_REQUEST');
  };
  switch (c.type) {
    case 'stage':
      // Evidence-driven milestones are reached only by their corresponding command.
      if (!['contacted', 'lost'].includes(c.stage)) invalid();
      stage = c.stage;
      next = c.stage === 'lost' ? 'none' : 'schedule';
      due = null;
      break;
    case 'appointment':
      if (!['new', 'contacted'].includes(stage)) invalid();
      if (
        !(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1', [c.timezone]))
          .rowCount
      )
        invalid();
      await client.query(
        'INSERT INTO rpt.appointment(tenant_id,id,opportunity_id,starts_at,timezone,channel) VALUES($1,$2,$3,$4,$5,$6)',
        [tenant, crypto.randomUUID(), id, c.startsAt, c.timezone, c.channel],
      );
      stage = 'appointment';
      next = 'demo';
      due = c.startsAt;
      break;
    case 'demo': {
      if (stage !== 'appointment') invalid();
      const appointment = (
        await client.query<{ id: string }>(
          'SELECT id FROM rpt.appointment WHERE opportunity_id=$1 ORDER BY starts_at DESC,id LIMIT 1',
          [id],
        )
      ).rows[0];
      if (!appointment) invalid();
      await client.query(
        'INSERT INTO rpt.demo_visit(tenant_id,id,opportunity_id,appointment_id,outcome) VALUES($1,$2,$3,$4,$5)',
        [tenant, crypto.randomUUID(), id, appointment!.id, c.outcome],
      );
      stage = 'demo';
      next = 'quote';
      due = null;
      break;
    }
    case 'quote':
      if (!['demo', 'proposal'].includes(stage) || detail.order || Number(c.amount) <= 0) invalid();
      await client.query(
        'INSERT INTO rpt.quote_version(tenant_id,id,opportunity_id,revision,product,amount,currency) SELECT $1,$2,$3,coalesce(max(revision),0)+1,$4,$5,$6 FROM rpt.quote_version WHERE opportunity_id=$3',
        [tenant, crypto.randomUUID(), id, c.product, c.amount, c.currency],
      );
      stage = 'proposal';
      next = 'submit_order';
      break;
    case 'submit_order': {
      if (stage !== 'proposal' || detail.order) invalid();
      const quote = (
        await client.query<{ id: string }>(
          'SELECT id FROM rpt.quote_version WHERE opportunity_id=$1 ORDER BY revision DESC LIMIT 1',
          [id],
        )
      ).rows[0];
      if (!quote) invalid();
      const order = crypto.randomUUID();
      await client.query(
        'INSERT INTO rpt.commercial_order(tenant_id,id,opportunity_id,quote_id) VALUES($1,$2,$3,$4)',
        [tenant, order, id, quote!.id],
      );
      await client.query(
        "UPDATE rpt.commercial_order SET status='submitted',simulated_status='company_processing' WHERE id=$1",
        [order],
      );
      stage = 'pending_approval';
      next = 'reconcile_mock';
      break;
    }
    case 'reconcile_mock': {
      if (
        stage !== 'pending_approval' ||
        !detail.order ||
        !['company_processing', 'conflict'].includes(detail.order.simulatedStatus ?? '')
      )
        invalid();
      observation = crypto.randomUUID();
      await client.query(
        `INSERT INTO rpt.source_observation(tenant_id,id,source_system,domain_key,subject_id,external_id,source_reference,observed_at,effective_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id,facts)
        VALUES($1,$2::uuid,'MANUAL_RECONCILIATION','order_simulation',$3,$2::uuid::text,'local-simulation',now(),now(),'manual',$4,$5,$6,$7,$8)`,
        [
          tenant,
          observation,
          id,
          hash,
          context.requestId,
          c.result === 'conflict' ? 'conflict' : 'matched',
          context.actorId,
          JSON.stringify({ orderId: detail.order!.id, result: c.result, simulation: true }),
        ],
      );
      await client.query(
        "INSERT INTO rpt.reconciliation_case(tenant_id,id,observation_id,state,reason_code,actor_id) VALUES($1,$2,$3,$4,'local_simulation',$5)",
        [
          tenant,
          crypto.randomUUID(),
          observation,
          c.result === 'conflict' ? 'conflict' : 'matched',
          context.actorId,
        ],
      );
      await client.query(
        'UPDATE rpt.commercial_order SET simulated_status=$2,observation_id=$3 WHERE id=$1',
        [detail.order!.id, c.result, observation],
      );
      if (c.result === 'approved') {
        stage = 'won_simulated';
        next = 'delivery';
      }
      break;
    }
    case 'delivery':
      if (detail.order?.simulatedStatus !== 'approved') invalid();
      await client.query(
        "UPDATE rpt.commercial_order SET simulated_status='delivered' WHERE opportunity_id=$1",
        [id],
      );
      next = 'curation';
      break;
    case 'curation':
      if (!['delivered', 'curation_pending'].includes(detail.order?.simulatedStatus ?? ''))
        invalid();
      if (detail.order?.simulatedStatus === 'delivered')
        await client.query(
          "UPDATE rpt.commercial_order SET simulated_status='curation_pending' WHERE opportunity_id=$1",
          [id],
        );
      await client.query(
        "UPDATE rpt.commercial_order SET simulated_status='cured' WHERE opportunity_id=$1",
        [id],
      );
      next = 'none';
      due = null;
      break;
    case 'entry':
      if (c.kind !== 'task' && c.dueAt !== null) invalid();
      await client.query(
        'INSERT INTO rpt.crm_entry(tenant_id,id,opportunity_id,kind,body,due_at,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [tenant, crypto.randomUUID(), id, c.kind, c.text, c.dueAt, context.actorId],
      );
      break;
    case 'complete_task':
      if (
        !(
          await client.query(
            "UPDATE rpt.crm_entry SET completed_at=now() WHERE opportunity_id=$1 AND id=$2 AND kind='task' AND completed_at IS NULL RETURNING id",
            [id, c.entryId],
          )
        ).rowCount
      )
        throw new FoundationError('NOT_FOUND');
      break;
    case 'edit_person':
      if (
        !(
          await client.query(
            'UPDATE rpt.person SET display_name=$2 WHERE id=$1 AND version=$3 RETURNING id',
            [row.personId, c.displayName, c.personVersion],
          )
        ).rowCount
      )
        throw new FoundationError('CONFLICT');
      break;
    case 'edit_contact':
      await client.query(
        'INSERT INTO rpt.person_pii(tenant_id,person_id,email,phone) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,person_id) DO UPDATE SET email=excluded.email,phone=excluded.phone',
        [tenant, row.personId, c.email || null, c.phone || null],
      );
      break;
    case 'add_collaborator':
      await client.query('SELECT authz.crm_add_collaborator($1,$2,$3,$4)', [
        id,
        c.userId,
        c.access,
        c.until,
      ]);
      break;
    case 'remove_collaborator':
      await client.query('SELECT authz.crm_remove_collaborator($1,$2)', [id, c.userId]);
      break;
    case 'activity':
      if (
        !(
          await client.query(
            "SELECT 1 WHERE $1::timestamptz<=statement_timestamp()+interval '5 minutes'",
            [c.occurredAt],
          )
        ).rowCount
      )
        invalid();
      await client.query(
        'INSERT INTO rpt.crm_activity(tenant_id,id,opportunity_id,kind,occurred_at,actor_id,summary,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          tenant,
          crypto.randomUUID(),
          id,
          c.kind,
          c.occurredAt,
          context.actorId,
          c.summary,
          context.requestId,
        ],
      );
      break;
    case 'set_referral':
      if (
        row.source !== 'referral' ||
        c.referrerPersonId === row.personId ||
        !(
          await client.query('SELECT 1 FROM rpt.person WHERE id=$1 AND deleted_at IS NULL', [
            c.referrerPersonId,
          ])
        ).rowCount
      )
        invalid();
      referrer = c.referrerPersonId;
      break;
  }
  const updated = await client.query<{ version: number }>(
    'UPDATE rpt.opportunity SET stage=$2,next_action=$3,next_at=$4,referrer_person_id=$5 WHERE id=$1 AND version=$6 RETURNING version',
    [id, stage, next, due, referrer, input.expectedVersion],
  );
  if (!updated.rowCount) throw new FoundationError('CONFLICT');
  await client.query(
    'INSERT INTO rpt.crm_event(tenant_id,id,opportunity_id,actor_id,action,source,request_id,observation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      tenant,
      crypto.randomUUID(),
      id,
      context.actorId,
      c.type === 'activity' ? c.kind : c.type,
      c.type === 'reconcile_mock' ? 'MANUAL_RECONCILIATION' : 'RPT_USER',
      context.requestId,
      observation,
    ],
  );
  const response = { id, version: updated.rows[0]!.version };
  await client.query('SELECT authz.crm_finish($1,$2)', [key, JSON.stringify(response)]);
  return response;
}
