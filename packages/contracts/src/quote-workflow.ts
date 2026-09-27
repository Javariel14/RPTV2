import { z } from 'zod';
import { commercialEvidenceAppend } from './commercial-calculator.js';
const context = z.object({
  schemaVersion: z.literal(1),
  quoteVersionId: z.uuid(),
  expectedVersion: z.number().int().positive(),
});
export const quoteApprovalRequest = context
  .extend({ reason: z.string().trim().min(1).max(500) })
  .strict();
export const quoteApprovalDecision = context
  .extend({
    approvalRequestId: z.uuid(),
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const quoteAcceptanceRecord = context
  .extend({
    method: z.enum([
      'administrative_record',
      'recorded_in_person',
      'recorded_phone',
      'recorded_written',
    ]),
    note: z.string().trim().min(1).max(500),
  })
  .strict();
export const orderFromAcceptedQuote = context.extend({ acceptanceId: z.uuid() }).strict();
export const quoteWorkflowEvidence = z
  .object({
    schemaVersion: z.literal(1),
    subjectType: z.enum(['approval_request', 'approval_decision', 'acceptance', 'order']),
    subjectId: z.uuid(),
    evidence: commercialEvidenceAppend.shape.evidence,
  })
  .strict();
