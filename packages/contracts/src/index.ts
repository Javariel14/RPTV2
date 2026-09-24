import { z } from 'zod';
export * from './crm.js';
export * from './recruiting.js';
export * from './agenda.js';
export * from './field-visits.js';
export const uuid = z.uuid();
export const identityClaims = z.object({
  iss: z.string().url(),
  sub: uuid,
  session_id: uuid,
  aal: z.enum(['aal1', 'aal2']),
});
export type Identity = z.infer<typeof identityClaims>;
export const personDto = z
  .object({
    id: uuid,
    displayName: z.string().max(200),
    lifecycle: z.enum([
      'referral',
      'prospect',
      'customer',
      'candidate',
      'advisor',
      'distributor',
      'collaborator',
    ]),
    version: z.number().int().positive(),
  })
  .strict();
export const personUpdate = z
  .object({
    schemaVersion: z.literal(1),
    displayName: z.string().trim().min(1).max(200),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export const activityCommand = z
  .object({
    schemaVersion: z.literal(1),
    subjectId: uuid,
    registrationId: uuid,
    marketId: uuid,
    metric: z.enum([
      'calls',
      'appointments',
      'demos',
      'recruiting',
      'training',
      'followups',
      'goals',
    ]),
    value: z.number().finite().min(-1e9).max(1e9),
    occurredAt: z.iso.datetime({ offset: true }),
    unit: z.string().regex(/^[a-z_]{1,20}$/),
    reversalOf: uuid.nullable().default(null),
  })
  .strict();
export type ActivityCommand = z.infer<typeof activityCommand>;
export const grantCommand = z
  .object({
    schemaVersion: z.literal(1),
    objectId: uuid,
    granteeId: uuid,
    verb: z.enum([
      'read',
      'update',
      'export',
      'download',
      'listen',
      'view_transcript',
      'send_message',
    ]),
    field: z.enum(['CONFIDENTIAL', 'RESTRICTED_PII']),
    until: z.iso.datetime({ offset: true }),
    reason: z.string().trim().min(1).max(200),
  })
  .strict();
export const idempotencyKey = z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);
export type ErrorCode =
  'UNAUTHENTICATED' | 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_REQUEST' | 'CONFLICT' | 'UNAVAILABLE';
export const errorStatus = {
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  INVALID_REQUEST: 422,
  CONFLICT: 409,
  UNAVAILABLE: 503,
} as const;
export interface ApiError {
  schemaVersion: 1;
  error: { code: ErrorCode; requestId: string; retryable: boolean };
}
export class FoundationError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = 'FoundationError';
  }
}
