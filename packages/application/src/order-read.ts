import { z } from 'zod';
import {
  FoundationError,
  orderDetailRead,
  orderHistoryItem,
  orderHistoryPage,
  orderHistoryQuery,
  orderListItem,
  orderListPage,
  orderListQuery,
  type ErrorCode,
  type Identity,
} from '@rpt/contracts';
import type { Client } from 'pg';
import type { AuthContext, Database } from '@rpt/persistence';
import {
  listOrders,
  orderExists,
  readOrder,
  readOrderHistory,
  readOrderLines,
  type OrderPageBoundary,
} from '@rpt/persistence/order-read';

const listCursor = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('orders'),
    createdAt: z.iso.datetime({ offset: true }),
    id: z.uuid(),
  })
  .strict();
const historyCursor = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('order-history'),
    sequence: z.number().int().positive(),
  })
  .strict();

function encodeCursor(value: object) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeCursor<T>(value: string, schema: z.ZodType<T>): T {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1)
      throw new Error('invalid base64url');
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(normalized + padding);
    const canonical = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    if (canonical !== value) throw new Error('non-canonical base64url');
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return schema.parse(JSON.parse(decoded) as unknown);
  } catch {
    throw new FoundationError('INVALID_REQUEST');
  }
}

export class OrderReadService {
  constructor(private readonly database: Database) {}

  async list(identity: Identity, requestId: string, input: unknown) {
    const query = orderListQuery.parse(input);
    const boundary: OrderPageBoundary | null = query.cursor
      ? decodeCursor(query.cursor, listCursor)
      : null;
    return this.execute(identity, requestId, async (client) => {
      const rows = await listOrders(client, query, boundary);
      const more = rows.length > query.limit;
      const items = rows.slice(0, query.limit).map((row) =>
        orderListItem.parse({
          schemaVersion: row.schemaVersion,
          id: row.id,
          businessOrderNumber: row.businessOrderNumber,
          workspaceId: row.workspaceId,
          marketId: row.marketId,
          quoteId: row.quoteId,
          quoteVersionId: row.quoteVersionId,
          acceptanceId: row.acceptanceId,
          currency: row.currency,
          status: row.status,
          lifecycleVersion: row.lifecycleVersion,
          createdAt: row.createdAt,
        }),
      );
      const last = items.at(-1);
      return orderListPage.parse({
        schemaVersion: 1,
        items,
        nextCursor:
          more && last
            ? encodeCursor({
                schemaVersion: 1,
                kind: 'orders',
                createdAt: last.createdAt,
                id: last.id,
              })
            : null,
      });
    });
  }

  detail(identity: Identity, requestId: string, id: string) {
    return this.execute(identity, requestId, async (client) => {
      const row = await readOrder(client, id);
      if (!row) throw new FoundationError('NOT_FOUND');
      const lines = (await readOrderLines(client, row.quoteVersionId)).map(
        ({ commercial, catalog, bundleComposition }) => ({
          commercial,
          catalog,
          bundleComposition,
        }),
      );
      return orderDetailRead.parse({ ...row, lines });
    });
  }

  async history(identity: Identity, requestId: string, id: string, input: unknown) {
    const query = orderHistoryQuery.parse(input);
    const cursor = query.cursor ? decodeCursor(query.cursor, historyCursor) : null;
    return this.execute(identity, requestId, async (client) => {
      if (!(await orderExists(client, id))) throw new FoundationError('NOT_FOUND');
      const rows = await readOrderHistory(client, id, cursor?.sequence ?? 0, query.limit);
      const more = rows.length > query.limit;
      const items = rows.slice(0, query.limit).map((row) => orderHistoryItem.parse(row));
      const last = items.at(-1);
      return orderHistoryPage.parse({
        schemaVersion: 1,
        items,
        nextCursor:
          more && last
            ? encodeCursor({ schemaVersion: 1, kind: 'order-history', sequence: last.sequence })
            : null,
      });
    });
  }

  private async execute<T>(
    identity: Identity,
    requestId: string,
    operation: (client: Client, context: AuthContext) => Promise<T>,
  ): Promise<T> {
    const result = await this.database.request<{ value: T } | { error: ErrorCode }>(
      identity,
      requestId,
      async (client, context) => {
        try {
          return { value: await operation(client, context) };
        } catch (error) {
          const pg = z.object({ code: z.string() }).safeParse(error);
          const code: ErrorCode =
            error instanceof FoundationError
              ? error.code
              : error instanceof z.ZodError || error instanceof SyntaxError
                ? 'INVALID_REQUEST'
                : pg.success && ['42501', 'P0002'].includes(pg.data.code)
                  ? 'NOT_FOUND'
                  : 'UNAVAILABLE';
          return { error: code };
        }
      },
      { isolation: 'repeatable_read' },
    );
    if ('error' in result) throw new FoundationError(result.error);
    return result.value;
  }
}
