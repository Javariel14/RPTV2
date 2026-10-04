import type { Client } from 'pg';
import type {
  OrderHistoryItem,
  OrderListItem,
  OrderListQuery,
  QuoteLineSnapshot,
} from '@rpt/contracts';
import { quoteLines } from './cpq.js';

export interface OrderPageBoundary {
  createdAt: string;
  id: string;
}

interface OrderRow {
  id: string;
  business_order_number: string;
  workspace_id: string;
  market_id: string;
  quote_id: string;
  quote_version_id: string;
  acceptance_id: string;
  currency: string;
  calculation_hash: string;
  commercial_snapshot: unknown;
  status: OrderListItem['status'];
  lifecycle_version: number;
  created_at: Date;
}

export interface OrderReadRow extends OrderListItem {
  calculationHash: string;
  commercialSnapshot: unknown;
  quoteVersionId: string;
}

function mapOrder(row: OrderRow): OrderReadRow {
  return {
    schemaVersion: 1,
    id: row.id,
    businessOrderNumber: row.business_order_number,
    workspaceId: row.workspace_id,
    marketId: row.market_id,
    quoteId: row.quote_id,
    quoteVersionId: row.quote_version_id,
    acceptanceId: row.acceptance_id,
    currency: row.currency,
    status: row.status,
    lifecycleVersion: row.lifecycle_version,
    createdAt: row.created_at.toISOString(),
    calculationHash: row.calculation_hash,
    commercialSnapshot: row.commercial_snapshot,
  };
}

const orderSelect = `SELECT o.id,o.business_order_number,o.workspace_id,o.market_id,o.quote_id,
 o.quote_version_id,o.acceptance_id,o.currency,o.calculation_hash,o.commercial_snapshot,
 s.status,s.version AS lifecycle_version,o.created_at
 FROM rpt.cpq_order o
 JOIN rpt.order_commercial_state s ON s.tenant_id=o.tenant_id AND s.order_id=o.id`;

export async function listOrders(
  client: Client,
  query: OrderListQuery,
  boundary: OrderPageBoundary | null,
) {
  const rows = (
    await client.query<OrderRow>(
      `${orderSelect}
 WHERE ($1::uuid IS NULL OR o.workspace_id=$1)
 AND ($2::uuid IS NULL OR o.market_id=$2)
 AND ($3::text IS NULL OR s.status=$3)
 AND ($4::text IS NULL OR o.business_order_number=$4)
 AND ($5::timestamptz IS NULL OR (o.created_at,o.id)<($5,$6::uuid))
 ORDER BY o.created_at DESC,o.id DESC LIMIT $7`,
      [
        query.workspaceId ?? null,
        query.marketId ?? null,
        query.status ?? null,
        query.businessOrderNumber ?? null,
        boundary?.createdAt ?? null,
        boundary?.id ?? null,
        query.limit + 1,
      ],
    )
  ).rows;
  return rows.map(mapOrder);
}

export async function readOrder(client: Client, id: string) {
  const row = (await client.query<OrderRow>(`${orderSelect} WHERE o.id=$1`, [id])).rows[0];
  return row ? mapOrder(row) : undefined;
}

export async function readOrderLines(client: Client, quoteVersionId: string) {
  return (await quoteLines(client, quoteVersionId)) as QuoteLineSnapshot[];
}

export async function orderExists(client: Client, id: string) {
  return (await client.query('SELECT 1 FROM rpt.cpq_order WHERE id=$1', [id])).rowCount === 1;
}

interface HistoryRow {
  id: string;
  sequence: number;
  operation: OrderHistoryItem['operation'];
  previous_state: OrderHistoryItem['previousStatus'];
  resulting_state: OrderHistoryItem['status'];
  reason: string;
  recorded_at: Date;
}

export async function readOrderHistory(
  client: Client,
  id: string,
  afterSequence: number,
  limit: number,
) {
  const rows = (
    await client.query<HistoryRow>(
      `SELECT id,sequence,operation,previous_state,resulting_state,reason,recorded_at
 FROM rpt.order_commercial_event
 WHERE order_id=$1 AND sequence>$2
 ORDER BY sequence,id LIMIT $3`,
      [id, afterSequence, limit + 1],
    )
  ).rows;
  return rows.map((row): OrderHistoryItem => ({
    schemaVersion: 1,
    id: row.id,
    sequence: row.sequence,
    operation: row.operation,
    previousStatus: row.previous_state,
    status: row.resulting_state,
    reason: row.reason,
    recordedAt: row.recorded_at.toISOString(),
  }));
}
