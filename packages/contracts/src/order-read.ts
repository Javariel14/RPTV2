import { z } from 'zod';
import { commercialCalculationResult } from './commercial-calculator.js';
import { orderCommercialStatus } from './order-commercial.js';
import { quoteLineSnapshot } from './cpq.js';

export const businessOrderNumber = z.string().regex(/^ORD-[0-9]{10}$/);
export const orderReadCursor = z.string().regex(/^[A-Za-z0-9_-]{1,2048}$/);
const limit = z.coerce.number().int().min(1).max(100).default(50);

export const orderListQuery = z
  .object({
    workspaceId: z.uuid().optional(),
    marketId: z.uuid().optional(),
    status: orderCommercialStatus.optional(),
    businessOrderNumber: businessOrderNumber.optional(),
    cursor: orderReadCursor.optional(),
    limit,
  })
  .strict();

export const orderHistoryQuery = z.object({ cursor: orderReadCursor.optional(), limit }).strict();

export const orderListItem = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    businessOrderNumber,
    workspaceId: z.uuid(),
    marketId: z.uuid(),
    quoteId: z.uuid(),
    quoteVersionId: z.uuid(),
    acceptanceId: z.uuid(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    status: orderCommercialStatus,
    lifecycleVersion: z.number().int().positive(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const orderLineRead = quoteLineSnapshot
  .pick({ commercial: true, catalog: true, bundleComposition: true })
  .strict();

export const orderDetailRead = orderListItem
  .extend({
    calculationHash: z.string().regex(/^[a-f0-9]{64}$/),
    commercialSnapshot: commercialCalculationResult,
    lines: z.array(orderLineRead).min(1).max(250),
  })
  .strict();

export const orderHistoryItem = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    sequence: z.number().int().positive(),
    operation: z.enum(['initialized', 'technical_bootstrap', 'cancel', 'replace']),
    previousStatus: orderCommercialStatus.nullable(),
    status: orderCommercialStatus,
    reason: z.string().min(1).max(500),
    recordedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const orderListPage = z
  .object({
    schemaVersion: z.literal(1),
    items: z.array(orderListItem).max(100),
    nextCursor: orderReadCursor.nullable(),
  })
  .strict();

export const orderHistoryPage = z
  .object({
    schemaVersion: z.literal(1),
    items: z.array(orderHistoryItem).max(100),
    nextCursor: orderReadCursor.nullable(),
  })
  .strict();

export type OrderListQuery = z.infer<typeof orderListQuery>;
export type OrderHistoryQuery = z.infer<typeof orderHistoryQuery>;
export type OrderListItem = z.infer<typeof orderListItem>;
export type OrderDetailRead = z.infer<typeof orderDetailRead>;
export type OrderHistoryItem = z.infer<typeof orderHistoryItem>;
