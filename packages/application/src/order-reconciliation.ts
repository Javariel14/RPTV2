import { z } from 'zod';
import type { Client } from 'pg';
import {
  OrderReconciliationError,
  idempotencyKey,
  ingestExternalOrder,
  correlateExternalOrder,
  resolveExternalOrder,
  orderReconciliationHistoryQuery,
  type Identity,
  type OrderReconciliationErrorCode,
} from '@rpt/contracts';
import type { Database, AuthContext } from '@rpt/persistence';
import {
  ingestOrder,
  correlateOrder,
  resolveOrder,
  getOrderReconciliation,
  orderReconciliationHistory,
} from '@rpt/persistence/order-reconciliation';

/** Adapter-neutral evidence/correlation only. Never writes Quote, Order, or lifecycle snapshots. */
export class OrderReconciliationService {
  constructor(private readonly database: Database) {}
  private async execute<T>(
    identity: Identity,
    request: string,
    operation: (c: Client, a: AuthContext) => Promise<T>,
  ): Promise<T> {
    const result = await this.database.request<
      { value: T } | { error: OrderReconciliationErrorCode }
    >(identity, request, async (c, a) => {
      await c.query('SAVEPOINT order_reconciliation_operation');
      try {
        const value = await operation(c, a);
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        return { value };
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT order_reconciliation_operation');
        const pg = z.object({ code: z.string(), message: z.string().optional() }).safeParse(e);
        const error: OrderReconciliationErrorCode =
          e instanceof OrderReconciliationError
            ? e.code
            : e instanceof z.ZodError
              ? 'VALIDATION_ERROR'
              : pg.success && pg.data.code === '40001'
                ? 'STALE_VERSION'
                : pg.success && pg.data.message === 'conflicting_external_duplicate'
                  ? 'EXTERNAL_CONFLICT'
                  : pg.success && pg.data.message === 'already_resolved'
                    ? 'INVALID_STATE'
                    : pg.success &&
                        ['official_source_not_verified', 'external_source_pending'].includes(
                          pg.data.message ?? '',
                        )
                      ? 'EXTERNAL_PENDING'
                      : pg.success && pg.data.code === '23505'
                        ? 'CONFLICT'
                        : pg.success && ['23514', '23503', '22P02'].includes(pg.data.code)
                          ? 'VALIDATION_ERROR'
                          : pg.success && ['42501', 'P0002'].includes(pg.data.code)
                            ? 'NOT_FOUND'
                            : pg.success && ['40P01', '57014'].includes(pg.data.code)
                              ? 'TEMPORARY_FAILURE'
                              : 'INTERNAL_ERROR';
        return { error };
      }
    });
    if ('error' in result) throw new OrderReconciliationError(result.error);
    return result.value;
  }
  ingestExternalOrderObservation(identity: Identity, request: string, key: string, input: unknown) {
    return this.execute(identity, request, async (c) =>
      ingestOrder(c, ingestExternalOrder.parse(input), idempotencyKey.parse(key)),
    );
  }
  correlateExternalOrderObservation(
    identity: Identity,
    request: string,
    key: string,
    input: unknown,
  ) {
    return this.execute(identity, request, async (c) =>
      correlateOrder(c, correlateExternalOrder.parse(input), idempotencyKey.parse(key)),
    );
  }
  resolveOrderReconciliation(identity: Identity, request: string, key: string, input: unknown) {
    return this.execute(identity, request, async (c) =>
      resolveOrder(c, resolveExternalOrder.parse(input), idempotencyKey.parse(key)),
    );
  }
  getOrderReconciliation(
    identity: Identity,
    request: string,
    sourceSystem: string,
    externalId: string,
  ) {
    return this.execute(identity, request, async (c) => {
      const source = ingestExternalOrder.shape.sourceSystem.parse(sourceSystem);
      const external = ingestExternalOrder.shape.externalId.parse(externalId);
      const value = await getOrderReconciliation(c, source, external);
      if (!value) throw new OrderReconciliationError('NOT_FOUND');
      return value;
    });
  }
  listOrderReconciliationHistory(
    identity: Identity,
    request: string,
    sourceSystem: string,
    externalId: string,
    input: unknown = {},
  ) {
    return this.execute(identity, request, async (c) => {
      const source = ingestExternalOrder.shape.sourceSystem.parse(sourceSystem);
      const external = ingestExternalOrder.shape.externalId.parse(externalId);
      const query = orderReconciliationHistoryQuery.parse(input);
      if (!(await getOrderReconciliation(c, source, external)))
        throw new OrderReconciliationError('NOT_FOUND');
      return orderReconciliationHistory(c, source, external, query);
    });
  }
}
