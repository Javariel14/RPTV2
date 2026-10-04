import { z } from 'zod';
import type { Client } from 'pg';
import {
  FoundationError,
  idempotencyKey,
  uuid,
  quoteApprovalRequest,
  quoteApprovalDecision,
  quoteAcceptanceRecord,
  orderFromAcceptedQuote,
  quoteWorkflowEvidence,
  type Identity,
  type ErrorCode,
} from '@rpt/contracts';
import { canonicalCommercial, quoteApprovalState } from '@rpt/domain';
import type { Database, AuthContext } from '@rpt/persistence';
import { quote, quoteVersion, quotePermission } from '@rpt/persistence/cpq';
import {
  workflowRight,
  workflowReceipt,
  workflowFinish,
  orderCreationReceipt,
  orderCreationFinish,
  insertApprovalRequest,
  insertApprovalDecision,
  approvalDetail,
  insertAcceptance,
  insertOrder,
  workflowArtifact,
  orderDetail,
  appendWorkflowEvidence,
} from '@rpt/persistence/quote-workflow';
async function digest(value: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalCommercial(value))),
    ),
    (v) => v.toString(16).padStart(2, '0'),
  ).join('');
}
/** Workflow only. No calculation, pricing resolution or signing is performed here. */
export class QuoteWorkflowService {
  constructor(private readonly database: Database) {}
  private async execute<T>(
    identity: Identity,
    request: string,
    id: string,
    operation: (c: Client, a: AuthContext) => Promise<T>,
  ): Promise<T> {
    const result = await this.database.request<{ value: T } | { error: ErrorCode }>(
      identity,
      request,
      async (c, a) => {
        await c.query('SAVEPOINT quote_workflow_operation');
        try {
          const value = await operation(c, a);
          await c.query('SET CONSTRAINTS ALL IMMEDIATE');
          await c.query('SELECT authz.quote_decision($1,$2,$3)', [id, 'cpq.transition', 'success']);
          return { value };
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT quote_workflow_operation');
          const pg = z.object({ code: z.string() }).safeParse(e);
          const error: ErrorCode =
            e instanceof FoundationError
              ? e.code
              : e instanceof z.ZodError
                ? 'INVALID_REQUEST'
                : pg.success && ['23505', '40001', '40P01'].includes(pg.data.code)
                  ? 'CONFLICT'
                  : pg.success && ['23514', '23503', '22P02'].includes(pg.data.code)
                    ? 'INVALID_REQUEST'
                    : pg.success && pg.data.code === '42501'
                      ? 'NOT_FOUND'
                      : 'UNAVAILABLE';
          await c.query('SELECT authz.quote_decision($1,$2,$3)', [
            id,
            'cpq.transition',
            error === 'NOT_FOUND' ? 'deny' : 'failure',
          ]);
          return { error };
        }
      },
    );
    if ('error' in result) throw new FoundationError(result.error);
    return result.value;
  }
  private async context(c: Client, versionId: string, domain: string, verb: string) {
    const v = await quoteVersion(c, versionId);
    if (!v) throw new FoundationError('NOT_FOUND');
    const q = await quote(c, v.quote_id, true);
    if (
      !q ||
      !(domain === 'cpq_quote'
        ? await quotePermission(c, q.id, verb)
        : await workflowRight(c, q.id, domain, verb))
    )
      throw new FoundationError('NOT_FOUND');
    return { q, v };
  }
  requestQuoteApproval(identity: Identity, request: string, key: string, input: unknown) {
    return this.execute(identity, request, crypto.randomUUID(), async (c, a) => {
      const command = quoteApprovalRequest.parse(input);
      idempotencyKey.parse(key);
      const { q } = await this.context(c, command.quoteVersionId, 'quote_approval', 'request');
      const old = await workflowReceipt(c, 'request', key, await digest(command));
      if (old) return old;
      if (q.version !== command.expectedVersion) throw new FoundationError('CONFLICT');
      return workflowFinish(
        c,
        'request',
        key,
        await insertApprovalRequest(c, a, command.quoteVersionId, command.reason),
      );
    });
  }
  decideQuoteApproval(identity: Identity, request: string, key: string, input: unknown) {
    return this.execute(identity, request, crypto.randomUUID(), async (c, a) => {
      const command = quoteApprovalDecision.parse(input);
      idempotencyKey.parse(key);
      const { q } = await this.context(c, command.quoteVersionId, 'quote_approval', 'decide');
      const old = await workflowReceipt(c, 'decide', key, await digest(command));
      if (old) return old;
      if (q.version !== command.expectedVersion) throw new FoundationError('CONFLICT');
      return workflowFinish(
        c,
        'decide',
        key,
        await insertApprovalDecision(
          c,
          a,
          command.quoteVersionId,
          command.approvalRequestId,
          command.decision,
          command.reason,
        ),
      );
    });
  }
  getQuoteApproval(identity: Identity, request: string, id: string) {
    return this.execute(identity, request, id, async (c) => {
      uuid.parse(id);
      const row = await approvalDetail(c, id);
      if (!row) throw new FoundationError('NOT_FOUND');
      return { ...row, ...quoteApprovalState(row.decision, row.current) };
    });
  }
  recordQuoteAcceptance(identity: Identity, request: string, key: string, input: unknown) {
    return this.execute(identity, request, crypto.randomUUID(), async (c, a) => {
      const command = quoteAcceptanceRecord.parse(input);
      idempotencyKey.parse(key);
      const { q } = await this.context(c, command.quoteVersionId, 'cpq_quote', 'accept');
      const old = await workflowReceipt(c, 'accept', key, await digest(command));
      if (old) return old;
      if (q.version !== command.expectedVersion) throw new FoundationError('CONFLICT');
      const id = await insertAcceptance(c, a, command.quoteVersionId, command.method, command.note);
      if (!id) throw new FoundationError('NOT_FOUND');
      return workflowFinish(c, 'accept', key, id);
    });
  }
  getQuoteAcceptance(identity: Identity, request: string, id: string) {
    return this.execute(identity, request, id, async (c) => {
      uuid.parse(id);
      const value = await workflowArtifact(c, 'quote_acceptance', id);
      if (!value) throw new FoundationError('NOT_FOUND');
      return value;
    });
  }
  createOrderFromAcceptedQuote(identity: Identity, request: string, key: string, input: unknown) {
    return this.execute(identity, request, crypto.randomUUID(), async (c, a) => {
      const command = orderFromAcceptedQuote.parse(input);
      idempotencyKey.parse(key);
      const { q } = await this.context(c, command.quoteVersionId, 'cpq_order', 'create');
      const acceptance = await workflowArtifact(c, 'quote_acceptance', command.acceptanceId);
      if (!acceptance || acceptance.quote_version_id !== command.quoteVersionId)
        throw new FoundationError('NOT_FOUND');
      const old = await orderCreationReceipt(
        c,
        key,
        await digest(command),
        command.quoteVersionId,
        command.acceptanceId,
        command.expectedVersion,
      );
      if (old) return old;
      if (q.version !== command.expectedVersion) throw new FoundationError('CONFLICT');
      const id = await insertOrder(c, a, command.quoteVersionId, command.acceptanceId);
      if (!id) throw new FoundationError('NOT_FOUND');
      return orderCreationFinish(c, key, id);
    });
  }
  getOrder(identity: Identity, request: string, id: string) {
    return this.execute(identity, request, id, async (c) => {
      uuid.parse(id);
      const value = await orderDetail(c, id);
      if (!value) throw new FoundationError('NOT_FOUND');
      return value;
    });
  }
  appendWorkflowEvidence(identity: Identity, request: string, input: unknown) {
    return this.execute(identity, request, crypto.randomUUID(), async (c, a) => {
      const command = quoteWorkflowEvidence.parse(input);
      return appendWorkflowEvidence(c, a, command, await digest(command.evidence));
    });
  }
}
