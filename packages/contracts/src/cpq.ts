import { z } from 'zod';
import {
  commercialCalculationRequest,
  commercialCalculationResult,
  commercialEvidenceAppend,
} from './commercial-calculator.js';

export const quoteStatus = z.enum([
  'draft',
  'issued',
  'accepted',
  'rejected',
  'expired',
  'cancelled',
]);
export const quoteCreate = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.uuid(),
    personId: z.uuid().nullable().default(null),
    validUntil: z.iso.datetime({ offset: true }).nullable().default(null),
    calculation: commercialCalculationRequest,
  })
  .strict();
export const quoteRevise = z
  .object({
    schemaVersion: z.literal(1),
    expectedVersion: z.number().int().positive(),
    calculation: commercialCalculationRequest,
  })
  .strict();
export const quoteTransition = z
  .object({
    schemaVersion: z.literal(1),
    expectedVersion: z.number().int().positive(),
    action: z.enum(['issue', 'accept', 'reject', 'expire', 'cancel']),
  })
  .strict();
export const quoteHistoryQuery = z
  .object({
    afterVersion: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export const quoteEvidenceAppend = z
  .object({
    schemaVersion: z.literal(1),
    subjectType: z.enum(['quote', 'quote_version']),
    subjectId: z.uuid(),
    evidence: commercialEvidenceAppend.shape.evidence,
  })
  .strict();
const node = z
  .object({
    id: z.uuid(),
    kind: z.enum(['product', 'model', 'variant']),
    stableKey: z.string(),
    name: z.string(),
  })
  .strict();
export const quoteCatalogSnapshot = z
  .object({
    marketProductId: z.uuid(),
    marketId: z.uuid(),
    nodeId: z.uuid(),
    displayName: z.string(),
    commercialCode: z.string(),
    path: z.array(node).min(1).max(3),
  })
  .strict();
export const quoteLineSnapshot = z
  .object({
    commercial: commercialCalculationResult.shape.lines.element,
    catalog: quoteCatalogSnapshot,
    source: z
      .object({
        observationId: z.uuid(),
        sourceLiteral: z.string(),
        sourceReference: z.string(),
        observedAt: z.iso.datetime({ offset: true }),
        authorityLevel: z.string(),
      })
      .strict(),
    bundleComposition: z
      .array(z.object({ catalog: quoteCatalogSnapshot, quantity: z.string() }).strict())
      .max(50),
  })
  .strict();
export type QuoteCreate = z.infer<typeof quoteCreate>;
export type QuoteLineSnapshot = z.infer<typeof quoteLineSnapshot>;
