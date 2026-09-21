import { z } from 'zod';

const name = z.string().trim().min(1).max(200);
const dateTime = z.iso.datetime({ offset: true });

export const recruitingStage = z.enum([
  'new',
  'initial_contact',
  'qualified',
  'interview_to_schedule',
  'interview_scheduled',
  'interviewed',
  'evaluation',
  'followup_decision',
  'onboarding',
  'activated',
]);
export type RecruitingStage = z.infer<typeof recruitingStage>;

export const recruitingSubstatus = z.enum([
  'data_validated',
  'duplicate_suspected',
  'first_contact_pending',
  'contacted',
  'no_answer',
  'invalid_number',
  'message_sent',
  'interest_qualified',
  'interview_proposed',
  'interview_scheduled',
  'confirmation_pending',
  'confirmed',
  'no_response',
  'reschedule_requested',
  'rescheduled',
  'cancelled',
  'no_show',
  'attended',
  'evaluation_pending',
  'evaluated',
  'nurture',
  'not_interested',
  'registration_started',
  'onboarding_started',
  'training_pending',
  'activated',
  'withdrawn',
]);
export type RecruitingSubstatus = z.infer<typeof recruitingSubstatus>;
export const recruitingPriority = z.enum(['A', 'B', 'C']);
export const recruitingSource = z.enum(['manual', 'import', 'referral', 'event', 'telemarketing']);

export const recruitingCreate = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.uuid(),
    person: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('existing'), id: z.uuid() }).strict(),
      z
        .object({
          mode: z.literal('new'),
          displayName: name,
          email: z.union([z.email().max(254), z.literal('')]).default(''),
          phone: z
            .string()
            .max(32)
            .regex(/^[+0-9 ()-]*$/)
            .default(''),
        })
        .strict(),
    ]),
    source: recruitingSource,
    priority: recruitingPriority.nullable().default(null),
  })
  .strict();
export type RecruitingCreate = z.infer<typeof recruitingCreate>;

export const recruitingListQuery = z
  .object({
    workspaceId: z.uuid(),
    owner: z.enum(['all', 'mine']).default('mine'),
    stage: z.union([recruitingStage, z.literal('all')]).default('all'),
    priority: z.union([recruitingPriority, z.literal('all')]).default('all'),
    page: z.number().int().min(0).max(10000).default(0),
  })
  .strict();

const strictCommand = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
export const recruitingCommand = z.discriminatedUnion('type', [
  strictCommand({ type: z.literal('stage'), stage: recruitingStage }),
  strictCommand({ type: z.literal('substatus'), substatus: recruitingSubstatus.nullable() }),
  strictCommand({ type: z.literal('priority'), priority: recruitingPriority }),
  strictCommand({ type: z.literal('reassign_owner'), ownerId: z.uuid() }),
  strictCommand({
    type: z.literal('appointment'),
    startsAt: dateTime,
    timezone: z.string().trim().min(1).max(64),
    channel: z.enum(['in_person', 'phone', 'video']),
  }),
  strictCommand({
    type: z.literal('interview'),
    occurredAt: dateTime,
    outcome: z.enum(['attended', 'no_show', 'cancelled', 'rescheduled']),
    notes: z.string().trim().max(1000).default(''),
  }),
  strictCommand({
    type: z.literal('followup'),
    dueAt: dateTime,
    text: z.string().trim().min(1).max(1000),
  }),
  strictCommand({ type: z.literal('complete_followup'), followupId: z.uuid() }),
  strictCommand({
    type: z.literal('hook'),
    kind: z.enum(['training', 'onboarding']),
    reference: z.string().trim().max(200).nullable().default(null),
  }),
]);
export type RecruitingCommand = z.infer<typeof recruitingCommand>;
export const recruitingMutation = z
  .object({
    schemaVersion: z.literal(1),
    expectedVersion: z.number().int().positive(),
    command: recruitingCommand,
  })
  .strict();

export interface RecruitmentProfileRow {
  id: string;
  personId: string;
  workspaceId: string;
  ownerId: string;
  displayName: string;
  stage: RecruitingStage;
  substatus: RecruitingSubstatus | null;
  priority: z.infer<typeof recruitingPriority> | null;
  source: z.infer<typeof recruitingSource>;
  version: number;
  createdAt: string;
  updatedAt: string;
  canUpdate: boolean;
  canReassign: boolean;
  canContact: boolean;
}

export interface RecruitmentProfileDetail {
  row: RecruitmentProfileRow;
  contact: { email: string | null; phone: string | null } | null;
  appointments: Array<{ id: string; startsAt: string; timezone: string; channel: string }>;
  interviews: Array<{ id: string; occurredAt: string; outcome: string; notes: string }>;
  followups: Array<{ id: string; dueAt: string; text: string; completedAt: string | null }>;
  hooks: Array<{ id: string; kind: string; reference: string | null; createdAt: string }>;
  timeline: Array<{
    id: string;
    action: string;
    source: string;
    authority: string;
    requestId: string;
    occurredAt: string;
  }>;
}

export interface RecruitmentProfileList {
  rows: RecruitmentProfileRow[];
  total: number;
  pageSize: number;
}
