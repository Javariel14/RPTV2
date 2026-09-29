import type { Client } from 'pg';
import type { z } from 'zod';
import type { AuthContext } from './index.js';
import type {
  orderCancel,
  orderReplace,
  orderCommercialHistoryQuery,
  orderCommercialEvidence,
} from '@rpt/contracts';
export async function orderCommercialState(c: Client, id: string) {
  return (
    await c.query<{
      tenant_id: string;
      order_id: string;
      workspace_id: string;
      market_id: string;
      status: 'created' | 'cancelled' | 'superseded';
      version: number;
      last_event_id: string;
    }>('SELECT * FROM rpt.order_commercial_state WHERE order_id=$1', [id])
  ).rows[0];
}
export async function orderCommercialHistory(
  c: Client,
  id: string,
  query: z.infer<typeof orderCommercialHistoryQuery>,
) {
  const rows = (
    await c.query(
      'SELECT * FROM rpt.order_commercial_event WHERE order_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3',
      [id, query.afterSequence, query.limit + 1],
    )
  ).rows;
  const more = rows.length > query.limit;
  const events = rows.slice(0, query.limit);
  return { events, nextAfterSequence: more ? (events.at(-1)?.sequence as number) : null };
}
export async function cancelOrder(c: Client, input: z.infer<typeof orderCancel>, key: string) {
  return (
    await c.query<{ value: unknown }>('SELECT authz.cancel_order($1,$2,$3,$4) AS value', [
      input.orderId,
      input.expectedVersion,
      key,
      input.reason,
    ])
  ).rows[0]?.value;
}
export async function replaceOrder(c: Client, input: z.infer<typeof orderReplace>, key: string) {
  return (
    await c.query<{ value: unknown }>('SELECT authz.replace_order($1,$2,$3,$4,$5,$6) AS value', [
      input.orderId,
      input.successorOrderId,
      input.expectedVersion,
      input.successorExpectedVersion,
      key,
      input.reason,
    ])
  ).rows[0]?.value;
}
export async function appendOrderCommercialEvidence(
  c: Client,
  a: AuthContext,
  input: z.infer<typeof orderCommercialEvidence>,
  hash: string,
) {
  const e = input.evidence,
    id = crypto.randomUUID();
  await c.query(
    `INSERT INTO rpt.source_observation(tenant_id,id,source_system,domain_key,order_commercial_subject_type,subject_id,external_id,source_reference,observed_at,effective_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id,facts)
 VALUES($1,$2,$3,'order_commercial',$4,$5,$6,$7,$8,$8,$9,$10,$11,'matched',$12,$13)`,
    [
      a.tenantId,
      id,
      e.sourceSystem,
      input.subjectType,
      input.subjectId,
      e.externalId,
      e.sourceReference,
      e.observedAt,
      e.authorityLevel,
      hash,
      crypto.randomUUID(),
      a.actorId,
      { sourceLiteral: e.sourceLiteral, evidenceLevel: e.evidenceLevel },
    ],
  );
  return { id };
}
