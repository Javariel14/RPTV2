import type { Client } from 'pg';
import type { z } from 'zod';
import type {
  ingestExternalOrder,
  correlateExternalOrder,
  resolveExternalOrder,
  orderReconciliationHistoryQuery,
} from '@rpt/contracts';

export async function ingestOrder(
  c: Client,
  input: z.infer<typeof ingestExternalOrder>,
  key: string,
) {
  return (
    await c.query<{ value: unknown }>(
      'SELECT authz.ingest_external_order($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS value',
      [
        input.workspaceId,
        input.marketId,
        input.sourceSystem,
        input.externalId,
        input.sourceReference,
        input.observedAt,
        input.effectiveAt,
        input.rawHash,
        input.correlationId,
        input.authorityLevel,
        key,
      ],
    )
  ).rows[0]?.value;
}
export async function correlateOrder(
  c: Client,
  input: z.infer<typeof correlateExternalOrder>,
  key: string,
) {
  return (
    await c.query<{ value: unknown }>(
      'SELECT authz.correlate_external_order($1,$2,$3,$4,$5) AS value',
      [input.intakeId, input.orderId, input.expectedVersion, input.reason, key],
    )
  ).rows[0]?.value;
}
export async function resolveOrder(
  c: Client,
  input: z.infer<typeof resolveExternalOrder>,
  key: string,
) {
  return (
    await c.query<{ value: unknown }>(
      'SELECT authz.resolve_external_order($1,$2,$3,$4,$5,$6) AS value',
      [
        input.sourceSystem,
        input.externalId,
        input.expectedVersion,
        input.outcome,
        input.reason,
        key,
      ],
    )
  ).rows[0]?.value;
}
export async function getOrderReconciliation(c: Client, source: string, external: string) {
  return (
    await c.query(
      'SELECT * FROM rpt.order_reconciliation_state WHERE source_system=$1 AND external_id=$2',
      [source, external],
    )
  ).rows[0] as unknown;
}
export async function orderReconciliationHistory(
  c: Client,
  source: string,
  external: string,
  query: z.infer<typeof orderReconciliationHistoryQuery>,
) {
  const rows = (
    await c.query(
      'SELECT * FROM rpt.order_reconciliation_event WHERE source_system=$1 AND external_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4',
      [source, external, query.afterSequence, query.limit + 1],
    )
  ).rows;
  return {
    events: rows.slice(0, query.limit),
    nextAfterSequence:
      rows.length > query.limit ? (rows[query.limit - 1]?.sequence as number) : null,
  };
}
