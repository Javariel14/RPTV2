import { z } from 'zod';
import { commercialEvidenceAppend } from './commercial-calculator.js';
export const orderCommercialStatus = z.enum(['created', 'cancelled', 'superseded']);
const mutation = z.object({
  schemaVersion: z.literal(1),
  orderId: z.uuid(),
  expectedVersion: z.number().int().min(1).max(2147483646),
  reason: z.string().trim().min(1).max(500),
});
export const orderCancel = mutation.strict();
export const orderReplace = mutation
  .extend({
    successorOrderId: z.uuid(),
    successorExpectedVersion: z.number().int().min(1).max(2147483646),
  })
  .strict()
  .refine((v) => v.orderId !== v.successorOrderId, 'Distinct Orders required');
export const orderCommercialHistoryQuery = z
  .object({
    afterSequence: z.number().int().min(0).max(2147483647).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export const orderCommercialEvidence = z
  .object({
    schemaVersion: z.literal(1),
    subjectType: z.enum(['order', 'order_event', 'order_replacement']),
    subjectId: z.uuid(),
    evidence: commercialEvidenceAppend.shape.evidence,
  })
  .strict();
export const orderCommercialMutationResult = z
  .object({
    orderId: z.uuid(),
    eventId: z.uuid(),
    version: z.number().int().positive(),
    status: z.enum(['cancelled', 'superseded']),
    replacementId: z.uuid().nullable(),
  })
  .strict();
export type OrderCommercialStatus = z.infer<typeof orderCommercialStatus>;
