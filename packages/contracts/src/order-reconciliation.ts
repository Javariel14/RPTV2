import { z } from 'zod';

const sourceSystem = z.enum(['HYCITE', 'INCITE', 'DOCUCITE', 'RPT_USER', 'IMPORT', 'API']);
const authority = z.enum(['official', 'verified', 'authorized', 'import', 'manual']);
const externalId = z
  .string()
  .min(1)
  .max(160)
  .refine((v) => v.trim().length > 0);
const reason = z.string().trim().min(1).max(500);
const eventTimestamp = z.iso.datetime({ offset: true }).refine((value) => !/\.\d{7,}/.test(value));
export const orderReconciliationStatus = z.enum([
  'unmatched',
  'matched',
  'conflict',
  'pending_review',
  'resolved_official_wins',
  'resolved_local_verified',
  'ignored_with_reason',
]);
export const ingestExternalOrder = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.uuid(),
    marketId: z.uuid(),
    sourceSystem,
    externalId,
    sourceReference: z
      .string()
      .min(1)
      .max(500)
      .refine((v) => v.trim().length > 0),
    observedAt: eventTimestamp,
    effectiveAt: eventTimestamp,
    rawHash: z.string().regex(/^[a-f0-9]{64}$/),
    correlationId: z.uuid(),
    authorityLevel: authority,
  })
  .strict();
export const correlateExternalOrder = z
  .object({
    schemaVersion: z.literal(1),
    intakeId: z.uuid(),
    orderId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    reason,
  })
  .strict();
export const resolveExternalOrder = z
  .object({
    schemaVersion: z.literal(1),
    sourceSystem,
    externalId,
    expectedVersion: z.number().int().positive(),
    outcome: z.enum([
      'matched',
      'resolved_official_wins',
      'resolved_local_verified',
      'ignored_with_reason',
    ]),
    reason,
  })
  .strict();
export const orderReconciliationHistoryQuery = z
  .object({
    afterSequence: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
/** E3C1 domain vocabulary; transport maps it without exposing foreign object existence. */
export const orderReconciliationError = z.enum([
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'FORBIDDEN',
  'CONFLICT',
  'STALE_VERSION',
  'DUPLICATE',
  'INVALID_STATE',
  'EXTERNAL_PENDING',
  'EXTERNAL_CONFLICT',
  'TEMPORARY_FAILURE',
  'INTERNAL_ERROR',
]);
export const orderReconciliationHttpStatus = {
  VALIDATION_ERROR: 422,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  STALE_VERSION: 409,
  DUPLICATE: 409,
  INVALID_STATE: 409,
  EXTERNAL_PENDING: 409,
  EXTERNAL_CONFLICT: 409,
  TEMPORARY_FAILURE: 503,
  INTERNAL_ERROR: 500,
} as const;
export type OrderReconciliationErrorCode = z.infer<typeof orderReconciliationError>;
export class OrderReconciliationError extends Error {
  constructor(readonly code: OrderReconciliationErrorCode) {
    super(code);
    this.name = 'OrderReconciliationError';
  }
}
