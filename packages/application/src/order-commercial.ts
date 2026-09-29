import { z } from 'zod';
import type { Client } from 'pg';
import {
  FoundationError,
  idempotencyKey,
  uuid,
  orderCancel,
  orderReplace,
  orderCommercialHistoryQuery,
  orderCommercialEvidence,
  orderCommercialMutationResult,
  type Identity,
  type ErrorCode,
} from '@rpt/contracts';
import type { Database, AuthContext } from '@rpt/persistence';
import {
  orderCommercialState,
  orderCommercialHistory,
  cancelOrder,
  replaceOrder,
  appendOrderCommercialEvidence,
} from '@rpt/persistence/order-commercial';
import { canonicalCommercial } from '@rpt/domain';
/** Lifecycle orchestration only: no calculator, signer, or accepted-snapshot mutation. */
export class OrderCommercialService {
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
        await c.query('SAVEPOINT order_commercial_operation');
        try {
          const value = await operation(c, a);
          await c.query('SET CONSTRAINTS ALL IMMEDIATE');
          await c.query('SELECT authz.quote_decision($1,$2,$3)', [id, 'cpq.transition', 'success']);
          return { value };
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT order_commercial_operation');
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
                    : pg.success && ['42501', 'P0002'].includes(pg.data.code)
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
  cancelOrder(identity: Identity, request: string, key: string, input: unknown) {
    return this.execute(identity, request, crypto.randomUUID(), async (c) => {
      const command = orderCancel.parse(input);
      idempotencyKey.parse(key);
      return orderCommercialMutationResult.parse(await cancelOrder(c, command, key));
    });
  }
  replaceOrder(identity: Identity, request: string, key: string, input: unknown) {
    return this.execute(identity, request, crypto.randomUUID(), async (c) => {
      const command = orderReplace.parse(input);
      idempotencyKey.parse(key);
      return orderCommercialMutationResult.parse(await replaceOrder(c, command, key));
    });
  }
  getOrderCommercialState(identity: Identity, request: string, id: string) {
    return this.execute(identity, request, id, async (c) => {
      uuid.parse(id);
      const value = await orderCommercialState(c, id);
      if (!value) throw new FoundationError('NOT_FOUND');
      return value;
    });
  }
  listOrderCommercialHistory(identity: Identity, request: string, id: string, input: unknown = {}) {
    return this.execute(identity, request, id, async (c) => {
      uuid.parse(id);
      const query = orderCommercialHistoryQuery.parse(input);
      if (!(await orderCommercialState(c, id))) throw new FoundationError('NOT_FOUND');
      return orderCommercialHistory(c, id, query);
    });
  }
  appendOrderCommercialEvidence(identity: Identity, request: string, input: unknown) {
    return this.execute(identity, request, crypto.randomUUID(), async (c, a) => {
      const command = orderCommercialEvidence.parse(input);
      const bytes = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonicalCommercial(command.evidence)),
      );
      const hash = Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join(
        '',
      );
      return appendOrderCommercialEvidence(c, a, command, hash);
    });
  }
}
