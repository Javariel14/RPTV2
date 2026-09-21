import { z } from 'zod';

export const crmStage = z.enum([
  'new',
  'contacted',
  'appointment',
  'demo',
  'proposal',
  'pending_approval',
  'won_simulated',
  'won',
  'lost',
]);
export type CrmStage = z.infer<typeof crmStage>;
export const crmSource = z.enum(['referral', 'event', 'manual', 'import']);
const name = z.string().trim().min(1).max(200);
const dateTime = z.iso.datetime({ offset: true });
export const crmFilters = z
  .object({
    query: z.string().max(100).default(''),
    owner: z.enum(['all', 'mine']).default('mine'),
    stage: z.union([crmStage, z.literal('all')]).default('all'),
    source: z.union([crmSource, z.literal('all')]).default('all'),
    status: z.enum(['all', 'open', 'closed']).default('all'),
    activity: z.enum(['all', 'due', 'inactive']).default('all'),
    priority: z.enum(['all', 'normal', 'high']).default('all'),
  })
  .strict();
export const crmViewConfig = z
  .object({
    filters: crmFilters,
    sort: z.enum(['name', 'updated', 'due']).default('name'),
    direction: z.enum(['asc', 'desc']).default('asc'),
    columns: z
      .array(z.enum(['owner', 'source', 'activity', 'due', 'priority']))
      .max(5)
      .default(['owner', 'due', 'source']),
    density: z.enum(['comfortable', 'compact']).default('comfortable'),
    surface: z.enum(['table', 'kanban']).default('table'),
  })
  .strict();
export type CrmViewConfig = z.infer<typeof crmViewConfig>;
export const crmListQuery = crmViewConfig.extend({
  page: z.number().int().min(0).max(10000).default(0),
});
export const crmCreate = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.uuid(),
    person: z.discriminatedUnion('mode', [
      z
        .object({
          mode: z.literal('new'),
          name,
          email: z.union([z.email().max(254), z.literal('')]).default(''),
          phone: z
            .string()
            .max(32)
            .regex(/^[+0-9 ()-]*$/)
            .default(''),
        })
        .strict(),
      z.object({ mode: z.literal('existing'), id: z.uuid() }).strict(),
    ]),
    title: name,
    source: crmSource,
    priority: z.enum(['normal', 'high']).default('normal'),
  })
  .strict();
export type CrmCreate = z.infer<typeof crmCreate>;
const strictCommand = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
export const crmCommand = z.discriminatedUnion('type', [
  strictCommand({ type: z.literal('stage'), stage: crmStage }),
  strictCommand({
    type: z.literal('appointment'),
    startsAt: dateTime,
    timezone: z.string().max(64),
    channel: z.enum(['visit', 'phone', 'video']),
  }),
  strictCommand({
    type: z.literal('demo'),
    outcome: z.enum([
      'customer_agreed',
      'purchase_intent_confirmed',
      'quote_requested',
      'order_started',
      'followup_required',
      'no_sale',
      'referral_generated',
      'recruitment_interest',
      'other',
    ]),
  }),
  strictCommand({
    type: z.literal('quote'),
    product: name,
    amount: z.string().regex(/^\d{1,9}\.\d{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
  strictCommand({ type: z.literal('submit_order') }),
  strictCommand({
    type: z.literal('reconcile_mock'),
    result: z.enum(['approved', 'conflict', 'rejected_or_cancelled']),
  }),
  strictCommand({ type: z.literal('delivery') }),
  strictCommand({ type: z.literal('curation') }),
  strictCommand({
    type: z.literal('entry'),
    kind: z.enum(['note', 'task', 'objection', 'commitment']),
    text: z.string().trim().min(1).max(1000),
    dueAt: dateTime.nullable().default(null),
  }),
  strictCommand({ type: z.literal('complete_task'), entryId: z.uuid() }),
  strictCommand({
    type: z.literal('edit_person'),
    displayName: name,
    personVersion: z.number().int().positive(),
  }),
  strictCommand({
    type: z.literal('edit_contact'),
    email: z.union([z.email().max(254), z.literal('')]),
    phone: z
      .string()
      .max(32)
      .regex(/^[+0-9 ()-]*$/),
  }),
  strictCommand({
    type: z.literal('add_collaborator'),
    userId: z.uuid(),
    access: z.enum(['read', 'update']),
    until: dateTime,
  }),
  strictCommand({ type: z.literal('remove_collaborator'), userId: z.uuid() }),
  strictCommand({
    type: z.literal('activity'),
    kind: z.enum(['call', 'message']),
    occurredAt: dateTime,
    summary: z.string().trim().min(1).max(1000),
  }),
  strictCommand({ type: z.literal('set_referral'), referrerPersonId: z.uuid() }),
]);
export type CrmCommand = z.infer<typeof crmCommand>;
export const crmMutation = z
  .object({
    schemaVersion: z.literal(1),
    expectedVersion: z.number().int().positive(),
    command: crmCommand,
  })
  .strict();
export const crmSaveView = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.uuid(),
    name: z.string().trim().min(1).max(60),
    visibility: z.enum(['private', 'team', 'shared']),
    recipients: z.array(z.uuid()).max(20).default([]),
    config: crmViewConfig,
  })
  .strict();

export interface CrmRow {
  id: string;
  personId: string;
  title: string;
  name: string;
  personVersion: number;
  ownerId: string;
  ownerLabel: string;
  stage: CrmStage;
  source: z.infer<typeof crmSource>;
  priority: 'normal' | 'high';
  nextAction: string;
  nextAt: string | null;
  updatedAt: string;
  version: number;
  canUpdate: boolean;
  canContact: boolean;
}
export interface CrmSession {
  actorId: string;
  tenantLabel: string;
  role: 'advisor' | 'assistant' | 'network' | 'restricted';
  workspaceId: string | null;
  advisorId: string | null;
  advisorCode: string | null;
  canCreate: boolean;
  canList: boolean;
  canShareView: boolean;
  canReconcile: boolean;
  timezone: string;
  simulation: true;
}
export interface CrmDetail {
  row: CrmRow;
  contact: { email: string | null; phone: string | null } | null;
  referrer: { id: string; name: string } | null;
  collaborators: { userId: string; access: 'read' | 'update'; until: string }[];
  activities: {
    id: string;
    kind: 'call' | 'message';
    occurredAt: string;
    actorId: string;
    summary: string;
    source: 'RPT_USER';
    requestId: string;
  }[];
  appointments: { id: string; startsAt: string; timezone: string; channel: string }[];
  demos: { id: string; outcome: string; occurredAt: string }[];
  quotes: { id: string; product: string; amount: string; currency: string; revision: number }[];
  order: {
    id: string;
    status: string;
    simulatedStatus: string | null;
    observationId: string | null;
  } | null;
  entries: {
    id: string;
    kind: string;
    text: string;
    dueAt: string | null;
    completedAt: string | null;
  }[];
  timeline: {
    id: string;
    action: string;
    occurredAt: string;
    source: string;
    authority: string;
    requestId: string;
    actorId: string;
    summary: string | null;
  }[];
  permissions: {
    order: boolean;
    completeTask: boolean;
    schedule: boolean;
    demo: boolean;
    quote: boolean;
    reconcile: boolean;
    postsale: boolean;
    notes: boolean;
    editPerson: boolean;
    editContact: boolean;
    manageCollaborators: boolean;
    recordActivity: boolean;
    setReferral: boolean;
  };
}
export interface CrmSavedView {
  id: string;
  name: string;
  visibility: 'private' | 'team' | 'shared';
  config: CrmViewConfig;
  ownerId: string;
}
export interface CrmList {
  rows: CrmRow[];
  total: number;
  pageSize: number;
  stages: { stage: CrmStage; count: number }[];
}
