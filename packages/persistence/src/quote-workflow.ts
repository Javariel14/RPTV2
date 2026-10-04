import type { Client } from 'pg';
import type { AuthContext } from './index.js';
import type { z } from 'zod';
import type { quoteWorkflowEvidence } from '@rpt/contracts';
import { quote, quoteVersion, quoteLines } from './cpq.js';
export type WorkflowTable =
  'quote_approval_request' | 'quote_approval_decision' | 'quote_acceptance' | 'cpq_order';
export async function workflowRight(c: Client, id: string, domain: string, verb: string) {
  return (
    (
      await c.query<{ allowed: boolean }>(
        'SELECT authz.quote_workflow_right($1,$2,$3) AS allowed',
        [id, domain, verb],
      )
    ).rows[0]?.allowed === true
  );
}
export async function workflowReceipt(c: Client, operation: string, key: string, hash: string) {
  return (
    (
      await c.query<{
        value: { id: string; businessOrderNumber?: string } | null;
      }>('SELECT authz.quote_workflow_receipt($1,$2,$3) AS value', [operation, key, hash])
    ).rows[0]?.value ?? null
  );
}
export async function workflowFinish(
  c: Client,
  operation: string,
  key: string,
  result: string | { id: string; businessOrderNumber: string },
): Promise<{ id: string; businessOrderNumber?: string }> {
  const value = typeof result === 'string' ? { id: result } : result;
  await c.query('SELECT authz.quote_workflow_finish($1,$2,$3)', [operation, key, value]);
  return value;
}
export type OrderCreationReceipt = { id: string; businessOrderNumber?: string };
export async function orderCreationReceipt(
  c: Client,
  key: string,
  hash: string,
  quoteVersionId: string,
  acceptanceId: string,
  expectedVersion: number,
): Promise<OrderCreationReceipt | null> {
  const supported = (
    await c.query<{ present: boolean }>(
      "SELECT to_regprocedure('authz.order_creation_receipt(text,text,uuid,uuid,integer)') IS NOT NULL AS present",
    )
  ).rows[0]?.present;
  if (!supported) return workflowReceipt(c, 'order', key, hash);
  return (
    (
      await c.query<{ value: OrderCreationReceipt | null }>(
        'SELECT authz.order_creation_receipt($1,$2,$3,$4,$5) AS value',
        [key, hash, quoteVersionId, acceptanceId, expectedVersion],
      )
    ).rows[0]?.value ?? null
  );
}
export async function orderCreationFinish(
  c: Client,
  key: string,
  orderId: string,
): Promise<OrderCreationReceipt> {
  const supported = (
    await c.query<{ present: boolean }>(
      "SELECT to_regprocedure('authz.order_creation_finish(text,uuid)') IS NOT NULL AS present",
    )
  ).rows[0]?.present;
  if (!supported) return workflowFinish(c, 'order', key, orderId);
  const value = (
    await c.query<{ value: OrderCreationReceipt }>(
      'SELECT authz.order_creation_finish($1,$2) AS value',
      [key, orderId],
    )
  ).rows[0]?.value;
  if (!value) throw new Error('missing authoritative Order receipt');
  return value;
}
export async function workflowArtifact(c: Client, table: WorkflowTable, id: string) {
  // Only internal literal table choices, never request-supplied identifiers.
  const tables = {
    quote_approval_request: 'rpt.quote_approval_request',
    quote_approval_decision: 'rpt.quote_approval_decision',
    quote_acceptance: 'rpt.quote_acceptance',
    cpq_order: 'rpt.cpq_order',
  } as const;
  return (
    await c.query<{ id: string; quote_id: string; quote_version_id: string }>(
      'SELECT * FROM ' + tables[table] + ' WHERE id=$1',
      [id],
    )
  ).rows[0];
}
export async function insertApprovalRequest(
  c: Client,
  a: AuthContext,
  version: string,
  reason: string,
) {
  const id = crypto.randomUUID();
  await c.query(
    'INSERT INTO rpt.quote_approval_request(tenant_id,id,quote_version_id,reason) VALUES($1,$2,$3,$4)',
    [a.tenantId, id, version, reason],
  );
  return id;
}
export async function insertApprovalDecision(
  c: Client,
  a: AuthContext,
  version: string,
  request: string,
  decision: string,
  reason: string,
) {
  const id = crypto.randomUUID();
  await c.query(
    'INSERT INTO rpt.quote_approval_decision(tenant_id,id,quote_version_id,approval_request_id,decision,reason) VALUES($1,$2,$3,$4,$5,$6)',
    [a.tenantId, id, version, request, decision, reason],
  );
  return id;
}
export async function approvalDetail(c: Client, id: string) {
  return (
    await c.query<{
      id: string;
      quote_id: string;
      quote_version_id: string;
      decision: 'approved' | 'rejected' | null;
      current: boolean;
    }>(
      `SELECT r.*,d.decision,d.created_by AS decided_by,d.created_at AS decided_at,d.authority_policy_version,
 (q.current_version_number=r.version_number AND q.status='draft') AS current
 FROM rpt.quote_approval_request r JOIN rpt.cpq_quote q ON q.tenant_id=r.tenant_id AND q.id=r.quote_id
 LEFT JOIN rpt.quote_approval_decision d ON d.tenant_id=r.tenant_id AND d.approval_request_id=r.id WHERE r.id=$1`,
      [id],
    )
  ).rows[0];
}
export async function insertAcceptance(
  c: Client,
  a: AuthContext,
  version: string,
  method: string,
  note: string,
) {
  const v = await quoteVersion(c, version);
  if (!v) return undefined;
  const q = await quote(c, v.quote_id, true);
  if (!q) return undefined;
  const publication = (
    await c.query<{ id: string }>(
      'SELECT id FROM rpt.quote_publication WHERE quote_version_id=$1',
      [version],
    )
  ).rows[0];
  if (!publication) return undefined;
  const id = crypto.randomUUID();
  await c.query(
    'INSERT INTO rpt.quote_acceptance(tenant_id,id,quote_version_id,publication_id,person_id,method,note) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [a.tenantId, id, version, publication.id, q.person_id, method, note],
  );
  return id;
}
export async function insertOrder(c: Client, a: AuthContext, version: string, acceptance: string) {
  const v = await quoteVersion(c, version);
  if (!v) return undefined;
  const q = await quote(c, v.quote_id, true);
  if (!q) return undefined;
  const previous = (
    await c.query<{ id: string; business_order_number: string | null }>(
      `SELECT id,to_jsonb(o)->>'business_order_number' AS business_order_number
 FROM rpt.cpq_order o WHERE quote_version_id=$1`,
      [version],
    )
  ).rows[0];
  if (previous) return previous.id;
  const id = crypto.randomUUID();
  await c.query(
    `INSERT INTO rpt.cpq_order(tenant_id,id,quote_version_id,acceptance_id,person_id,currency,commercial_snapshot)
 VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [a.tenantId, id, version, acceptance, q.person_id, v.currency, v.output_snapshot],
  );
  return id;
}
export async function orderDetail(c: Client, id: string) {
  const order = await workflowArtifact(c, 'cpq_order', id);
  if (!order) return undefined;
  return { order, lines: await quoteLines(c, order.quote_version_id) };
}
export async function appendWorkflowEvidence(
  c: Client,
  a: AuthContext,
  input: z.infer<typeof quoteWorkflowEvidence>,
  hash: string,
) {
  const e = input.evidence,
    id = crypto.randomUUID();
  await c.query(
    `INSERT INTO rpt.source_observation(tenant_id,id,source_system,domain_key,workflow_subject_type,subject_id,external_id,source_reference,observed_at,effective_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id,facts)
 VALUES($1,$2,$3,'quote_workflow',$4,$5,$6,$7,$8,$8,$9,$10,$11,'matched',$12,$13)`,
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
