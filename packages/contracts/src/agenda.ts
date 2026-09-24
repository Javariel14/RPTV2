import { z } from 'zod';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const timezone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, 'invalid timezone');
const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/@|\+?\d[\d\s().-]{6,}\d/.test(value), 'contact PII is not allowed');

export const agendaRecurrence = z
  .object({
    frequency: z.enum(['daily', 'weekly']),
    interval: z.number().int().min(1).max(4).default(1),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    until: instant,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.frequency === 'daily' && value.weekdays.length)
      context.addIssue({
        code: 'custom',
        path: ['weekdays'],
        message: 'daily recurrence has no weekdays',
      });
    if (value.frequency === 'weekly' && value.weekdays.length === 0)
      context.addIssue({
        code: 'custom',
        path: ['weekdays'],
        message: 'weekly recurrence needs weekdays',
      });
  });

const links = {
  personId: uuid.nullable().default(null),
  opportunityId: uuid.nullable().default(null),
  recruitmentProfileId: uuid.nullable().default(null),
};
const travel = z
  .object({
    originLabel: safeText(200).nullable().default(null),
    destinationLabel: safeText(300).nullable().default(null),
    estimatedTravelMinutes: z.number().int().min(0).max(1440).nullable().default(null),
    preparationMinutes: z.number().int().min(0).max(1440).nullable().default(null),
  })
  .strict()
  .default({
    originLabel: null,
    destinationLabel: null,
    estimatedTravelMinutes: null,
    preparationMinutes: null,
  });
const reminders = z.array(z.number().int().min(0).max(43_200)).max(4).default([]);

export const agendaCreate = z
  .discriminatedUnion('type', [
    z
      .object({
        schemaVersion: z.literal(1),
        type: z.literal('appointment'),
        workspaceId: uuid,
        title: safeText(200),
        summary: safeText(1000).nullable().default(null),
        startsAt: instant,
        endsAt: instant,
        timezone,
        source: z.enum(['manual', 'commercial_crm', 'recruiting_crm']),
        ...links,
        recurrence: agendaRecurrence.nullable().default(null),
        reminderMinutesBefore: reminders,
        travel,
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(1),
        type: z.literal('task'),
        workspaceId: uuid,
        title: safeText(200),
        summary: safeText(1000).nullable().default(null),
        dueAt: instant,
        timezone,
        priority: z.enum(['low', 'normal', 'high']),
        source: z.enum(['manual', 'commercial_crm', 'recruiting_crm']),
        ...links,
        recurrence: agendaRecurrence.nullable().default(null),
        reminderMinutesBefore: reminders,
        travel,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.opportunityId && value.recruitmentProfileId)
      context.addIssue({ code: 'custom', message: 'incompatible linked contexts' });
    const anchor = value.type === 'appointment' ? value.startsAt : value.dueAt;
    if (value.type === 'appointment' && Date.parse(value.endsAt) <= Date.parse(value.startsAt))
      context.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'endsAt must follow startsAt',
      });
    if (value.recurrence && Date.parse(value.recurrence.until) < Date.parse(anchor))
      context.addIssue({
        code: 'custom',
        path: ['recurrence', 'until'],
        message: 'until precedes first occurrence',
      });
  });
export type AgendaCreate = z.infer<typeof agendaCreate>;

export const agendaListQuery = z
  .object({
    from: instant,
    to: instant,
    owner: z.enum(['mine']).optional(),
    type: z.enum(['appointment', 'task']).optional(),
    status: z.enum(['scheduled', 'open', 'completed', 'cancelled']).optional(),
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
export type AgendaListQuery = z.infer<typeof agendaListQuery>;

const command = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('update'), title: safeText(200), summary: safeText(1000).nullable() })
    .strict(),
  z
    .object({
      type: z.literal('update_task'),
      dueAt: instant,
      timezone,
      priority: z.enum(['low', 'normal', 'high']),
    })
    .strict(),
  z
    .object({ type: z.literal('reschedule'), startsAt: instant, endsAt: instant, timezone })
    .strict(),
  z.object({ type: z.literal('confirm') }).strict(),
  z.object({ type: z.literal('decline') }).strict(),
  z.object({ type: z.literal('cancel') }).strict(),
  z.object({ type: z.literal('complete') }).strict(),
  z.object({ type: z.literal('set_reminders'), reminderMinutesBefore: reminders }).strict(),
]);
export const agendaMutation = z
  .object({ schemaVersion: z.literal(1), expectedVersion: z.number().int().positive(), command })
  .strict()
  .superRefine((value, context) => {
    if (
      value.command.type === 'reschedule' &&
      Date.parse(value.command.endsAt) <= Date.parse(value.command.startsAt)
    )
      context.addIssue({
        code: 'custom',
        path: ['command', 'endsAt'],
        message: 'endsAt must follow startsAt',
      });
  });
export type AgendaMutation = z.infer<typeof agendaMutation>;

export interface AgendaItem {
  id: string;
  workspaceId: string;
  ownerId: string;
  type: 'appointment' | 'task';
  title: string;
  summary: string | null;
  startsAt: string | null;
  endsAt: string | null;
  dueAt: string | null;
  timezone: string;
  status: 'scheduled' | 'open' | 'completed' | 'cancelled';
  confirmationState: 'pending' | 'confirmed' | 'declined' | 'cancelled' | null;
  priority: 'low' | 'normal' | 'high';
  source: 'manual' | 'commercial_crm' | 'recruiting_crm';
  mutable: boolean;
  personId: string | null;
  opportunityId: string | null;
  recruitmentProfileId: string | null;
  seriesId: string | null;
  occurrenceIndex: number;
  recurrence: z.infer<typeof agendaRecurrence> | null;
  reminderMinutesBefore: number[];
  travel: {
    originLabel: string | null;
    destinationLabel: string | null;
    estimatedTravelMinutes: number | null;
    preparationMinutes: number | null;
  };
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgendaDetail extends AgendaItem {
  reminders: Array<{
    id: string;
    reminderAt: string;
    channel: 'internal';
    status: 'scheduled' | 'cancelled' | 'delivered' | 'failed';
  }>;
  history: Array<{
    id: string;
    action: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }>;
}

export interface AgendaList {
  rows: AgendaItem[];
  truncated: boolean;
}

export interface AgendaMutationResult {
  id: string;
  version: number;
  createdIds?: string[];
}
