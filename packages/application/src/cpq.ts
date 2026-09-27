import { z } from 'zod';
import type { Client } from 'pg';
import {
  FoundationError,
  quoteCreate,
  quoteRevise,
  quoteTransition,
  quoteHistoryQuery,
  quoteEvidenceAppend,
  commercialCalculationResult,
  idempotencyKey,
  uuid,
  type Identity,
  type ErrorCode,
  type CommercialCalculationResult,
} from '@rpt/contracts';
import { canonicalCommercial, nextQuoteStatus } from '@rpt/domain';
import type { Database, AuthContext } from '@rpt/persistence';
import {
  quotePermission,
  quoteWorkspacePermission,
  quote,
  quoteVersion,
  quoteHistory,
  quoteLines,
  insertQuote,
  buildQuoteLines,
  insertQuoteVersion,
  transitionQuote,
  quoteReceipt,
  finishQuote,
  insertQuoteEvidence,
} from '@rpt/persistence/cpq';
import { CommercialCalculatorService } from './commercial-calculator.js';
import type { QuoteCalculationAttestor } from './cpq-attestation.js';

async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalCommercial(value)),
  );
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('');
}
export class QuoteService {
  constructor(
    private readonly database: Database,
    private readonly attestor: QuoteCalculationAttestor,
  ) {}
  private async execute<T>(
    identity: Identity,
    request: string,
    id: string,
    action: string,
    operation: (c: Client, a: AuthContext) => Promise<T>,
  ): Promise<T> {
    const result = await this.database.request<{ value: T } | { error: ErrorCode }>(
      identity,
      request,
      async (c, a) => {
        await c.query('SAVEPOINT cpq_operation');
        try {
          const value = await operation(c, a);
          // Run deferred completeness invariants inside the error-mapping savepoint.
          await c.query('SET CONSTRAINTS ALL IMMEDIATE');
          await c.query('SELECT authz.quote_decision($1,$2,$3)', [id, action, 'success']);
          return { value };
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT cpq_operation');
          const pg = z.object({ code: z.string() }).safeParse(e);
          const error: ErrorCode =
            e instanceof FoundationError
              ? e.code
              : e instanceof RangeError || e instanceof z.ZodError
                ? 'INVALID_REQUEST'
                : pg.success && ['23505', '23P01', '40001', '40P01'].includes(pg.data.code)
                  ? 'CONFLICT'
                  : pg.success && ['23514', '23503', '22P02', '22003'].includes(pg.data.code)
                    ? 'INVALID_REQUEST'
                    : pg.success && pg.data.code === '42501'
                      ? 'NOT_FOUND'
                      : 'UNAVAILABLE';
          await c.query('SELECT authz.quote_decision($1,$2,$3)', [
            id,
            action,
            ['FORBIDDEN', 'NOT_FOUND'].includes(error) ? 'deny' : 'failure',
          ]);
          return { error };
        }
      },
      { isolation: 'repeatable_read' },
    );
    if ('error' in result) throw new FoundationError(result.error);
    return result.value;
  }
  private async calculate(
    c: Client,
    a: AuthContext,
    identity: Identity,
    request: string,
    input: unknown,
  ) {
    const calculator = new CommercialCalculatorService({
      request: async (_identity, _request, operation) => operation(c, a),
    });
    return commercialCalculationResult.parse(
      await calculator.calculateCommercialOffer(identity, request, input),
    );
  }
  private async require(c: Client, id: string, verb: string) {
    if (!(await quotePermission(c, id, verb))) throw new FoundationError('NOT_FOUND');
  }
  private async snapshot(
    c: Client,
    a: AuthContext,
    id: string,
    input: Parameters<typeof insertQuoteVersion>[3],
    output: CommercialCalculationResult,
  ) {
    const q = await quote(c, id, true);
    if (!q) throw new FoundationError('NOT_FOUND');
    if (output.effectiveMarketId !== q.market_id) throw new FoundationError('FORBIDDEN');
    const lines = await buildQuoteLines(c, output);
    const attestation = await this.attestor.attest({
      schemaVersion: 1,
      tenantId: a.tenantId,
      actorId: a.actorId,
      quoteId: q.id,
      versionId: crypto.randomUUID(),
      versionNumber: q.current_version_number + 1,
      workspaceId: q.workspace_id,
      marketId: q.market_id,
      engineIdentity: 'E3B1/v1',
      input,
      result: output,
      lines,
    });
    return insertQuoteVersion(c, a, q, input, output, lines, attestation);
  }
  createQuote(identity: Identity, request: string, key: string, input: unknown) {
    return this.execute(identity, request, crypto.randomUUID(), 'cpq.create', async (c, a) => {
      const command = quoteCreate.parse(input);
      idempotencyKey.parse(key);
      // Resolve the market through the canonical authenticated E3B1 path, never from owner/client context.
      const output = await this.calculate(c, a, identity, request, command.calculation);
      if (
        !(await quoteWorkspacePermission(
          c,
          command.workspaceId,
          output.effectiveMarketId,
          'create',
        ))
      )
        throw new FoundationError('FORBIDDEN');
      const old = await quoteReceipt(c, key, await digest({ operation: 'create', command }));
      if (old) {
        await this.require(c, old.id, 'create');
        return old;
      }
      const id = crypto.randomUUID();
      await insertQuote(c, a, id, output.effectiveMarketId, command);
      return finishQuote(c, key, await this.snapshot(c, a, id, command.calculation, output));
    });
  }
  reviseQuote(identity: Identity, request: string, id: string, key: string, input: unknown) {
    return this.execute(identity, request, id, 'cpq.revise', async (c, a) => {
      uuid.parse(id);
      idempotencyKey.parse(key);
      const command = quoteRevise.parse(input);
      await this.require(c, id, 'revise');
      const old = await quoteReceipt(c, key, await digest({ operation: 'revise', id, command }));
      if (old) return old;
      const q = await quote(c, id, true);
      if (!q) throw new FoundationError('NOT_FOUND');
      if (q.version !== command.expectedVersion) throw new FoundationError('CONFLICT');
      if (!['draft', 'issued'].includes(q.status)) throw new FoundationError('INVALID_REQUEST');
      const output = await this.calculate(c, a, identity, request, command.calculation);
      return finishQuote(c, key, await this.snapshot(c, a, id, command.calculation, output));
    });
  }
  getQuote(identity: Identity, request: string, id: string) {
    return this.execute(identity, request, id, 'cpq.read', async (c) => {
      uuid.parse(id);
      await this.require(c, id, 'read');
      const q = await quote(c, id);
      if (!q) throw new FoundationError('NOT_FOUND');
      const versions = await quoteHistory(c, id, q.current_version_number - 1, 1);
      const current = versions[0];
      if (!current) throw new FoundationError('NOT_FOUND');
      return { quote: q, currentVersion: current, lines: await quoteLines(c, current.id) };
    });
  }
  getQuoteVersion(identity: Identity, request: string, id: string) {
    return this.execute(identity, request, id, 'cpq.read', async (c) => {
      uuid.parse(id);
      const v = await quoteVersion(c, id);
      if (!v) throw new FoundationError('NOT_FOUND');
      await this.require(c, v.quote_id, 'read');
      return { version: v, lines: await quoteLines(c, id) };
    });
  }
  listQuoteVersions(identity: Identity, request: string, id: string, input: unknown = {}) {
    return this.execute(identity, request, id, 'cpq.read', async (c) => {
      uuid.parse(id);
      const command = quoteHistoryQuery.parse(input);
      await this.require(c, id, 'read');
      const rows = await quoteHistory(c, id, command.afterVersion, command.limit + 1);
      const items = rows.slice(0, command.limit);
      return {
        items,
        nextAfterVersion: rows.length > command.limit ? items.at(-1)?.version_number : null,
      };
    });
  }
  transitionQuoteStatus(identity: Identity, request: string, id: string, input: unknown) {
    return this.execute(identity, request, id, 'cpq.transition', async (c) => {
      uuid.parse(id);
      const command = quoteTransition.parse(input);
      await this.require(c, id, command.action);
      const q = await quote(c, id, true);
      if (!q) throw new FoundationError('NOT_FOUND');
      if (q.version !== command.expectedVersion) throw new FoundationError('CONFLICT');
      return transitionQuote(
        c,
        id,
        nextQuoteStatus(q.status, command.action),
        command.expectedVersion,
      );
    });
  }
  appendQuoteEvidence(identity: Identity, request: string, input: unknown) {
    return this.execute(identity, request, crypto.randomUUID(), 'cpq.evidence', async (c, a) => {
      const command = quoteEvidenceAppend.parse(input);
      const id =
        command.subjectType === 'quote'
          ? command.subjectId
          : (await quoteVersion(c, command.subjectId))?.quote_id;
      if (!id) throw new FoundationError('NOT_FOUND');
      await this.require(c, id, 'revise');
      return insertQuoteEvidence(c, a, command, await digest(command.evidence));
    });
  }
}
