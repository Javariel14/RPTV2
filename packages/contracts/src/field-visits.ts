import { z } from 'zod';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/@|\+?\d[\d\s().-]{6,}\d/.test(value), 'contact PII is not allowed');

export const visitLocation = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    accuracyMeters: z.number().finite().min(0).max(100_000).nullable().default(null),
    source: z.literal('device_explicit'),
    consentContext: z.literal('explicit_visit_action'),
  })
  .strict();

export const fieldVisitCreate = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: uuid,
    agendaItemId: uuid.nullable().default(null),
    personId: uuid.nullable().default(null),
    opportunityId: uuid.nullable().default(null),
    scheduledAt: instant.nullable().default(null),
    purpose: safeText(500),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.agendaItemId === null) === (value.scheduledAt === null))
      context.addIssue({
        code: 'custom',
        message: 'exactly one of agendaItemId or scheduledAt is required',
      });
  });
export type FieldVisitCreate = z.infer<typeof fieldVisitCreate>;

export const fieldVisitListQuery = z
  .object({
    from: instant,
    to: instant,
    owner: z.enum(['mine']).optional(),
    status: z.enum(['planned', 'in_progress', 'completed', 'cancelled', 'no_show']).optional(),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict()
  .superRefine((value, context) => {
    const span = Date.parse(value.to) - Date.parse(value.from);
    if (span <= 0 || span > 93 * 86_400_000)
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'range must be positive and at most 93 days',
      });
  });
export type FieldVisitListQuery = z.infer<typeof fieldVisitListQuery>;

const visitCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update'), purpose: safeText(500), scheduledAt: instant }).strict(),
  z
    .object({ type: z.literal('check_in'), location: visitLocation.nullable().default(null) })
    .strict(),
  z
    .object({
      type: z.literal('check_out'),
      outcome: safeText(200),
      notes: safeText(1000).nullable().default(null),
      location: visitLocation.nullable().default(null),
    })
    .strict(),
  z.object({ type: z.literal('cancel') }).strict(),
  z.object({ type: z.literal('no_show') }).strict(),
]);

export const fieldVisitMutation = z
  .object({
    schemaVersion: z.literal(1),
    expectedVersion: z.number().int().positive(),
    command: visitCommand,
  })
  .strict();
export type FieldVisitMutation = z.infer<typeof fieldVisitMutation>;

export interface FieldVisitItem {
  id: string;
  workspaceId: string;
  ownerId: string;
  status: 'planned' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';
  scheduledAt: string;
  agendaItemId: string | null;
  personId: string | null;
  opportunityId: string | null;
  purpose: string;
  actualStart: string | null;
  actualEnd: string | null;
  outcome: string | null;
  notes: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface FieldVisitDetail extends FieldVisitItem {
  travel: {
    originLabel: string | null;
    destinationLabel: string | null;
    estimatedTravelMinutes: number | null;
    preparationMinutes: number | null;
  } | null;
  locationEvidence: Array<{
    id: string;
    phase: 'check_in' | 'check_out';
    latitude: string;
    longitude: string;
    accuracyMeters: string | null;
    capturedAt: string;
    source: 'device_explicit';
    purpose: 'visit_check_in' | 'visit_check_out';
    consentContext: 'explicit_visit_action';
  }>;
  history: Array<{
    id: string;
    action: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }>;
}

export interface FieldVisitList {
  rows: FieldVisitItem[];
  truncated: boolean;
}

export interface FieldVisitMutationResult {
  id: string;
  version: number;
  status: FieldVisitItem['status'];
}
