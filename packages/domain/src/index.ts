export const verbs = [
  'read',
  'create',
  'update',
  'delete',
  'reassign',
  'export',
  'share',
  'download',
  'listen',
  'view_transcript',
  'send_message',
  'approve',
  'impersonate',
  'manage_integration',
  'publish_policy',
] as const;
export type Verb = (typeof verbs)[number];
export type DataClass =
  | 'PUBLIC'
  | 'INTERNAL'
  | 'CONFIDENTIAL'
  | 'RESTRICTED_PII'
  | 'OFFICIAL_COMPENSATION'
  | 'SECURITY_AUDIT';
export type Lifecycle =
  'referral' | 'prospect' | 'customer' | 'candidate' | 'advisor' | 'distributor' | 'collaborator';
export type IntegrationName =
  'HYCITE' | 'INCITE' | 'DOCUCITE' | 'WHATSAPP' | 'CALENDAR' | 'AI' | 'STT';
export type IntegrationResult<T> =
  { status: 'OK'; data: T } | { status: 'PENDING_OFFICIAL_ACCESS'; source: IntegrationName };
export interface ExternalSourceAdapter {
  readonly source: IntegrationName;
  sync(cursor?: string): Promise<IntegrationResult<readonly SourceRecord[]>>;
}
export interface SourceRecord {
  sourceId: string;
  observedAt: string;
  hash: string;
  authority: 'official' | 'verified' | 'inference';
}
export interface HyCiteOfficialAdapter extends ExternalSourceAdapter {
  readonly source: 'HYCITE';
}
export interface InciteAdapter extends ExternalSourceAdapter {
  readonly source: 'INCITE';
}
export interface DocuCiteAdapter extends ExternalSourceAdapter {
  readonly source: 'DOCUCITE';
}
export interface WhatsAppAdapter {
  send(
    consentedRecipientRef: string,
    templateId: string,
  ): Promise<IntegrationResult<{ messageId: string }>>;
}
export interface CalendarAdapter {
  create(consentedCalendarRef: string): Promise<IntegrationResult<{ eventId: string }>>;
}
export interface AIProvider {
  infer(
    minimizedText: string,
  ): Promise<IntegrationResult<{ text: string; authority: 'inference' }>>;
}
export interface STTProvider {
  transcribe(
    consentedAudioRef: string,
  ): Promise<IntegrationResult<{ text: string; authority: 'inference' }>>;
}
export class PendingSource implements ExternalSourceAdapter {
  constructor(readonly source: IntegrationName) {}
  sync(): Promise<IntegrationResult<readonly SourceRecord[]>> {
    return Promise.resolve({ status: 'PENDING_OFFICIAL_ACCESS', source: this.source });
  }
}
export function isEffective(from: Date, to: Date | null, at: Date): boolean {
  return from <= at && (to === null || at < to);
}

export interface VersionedFlag {
  enabled: boolean;
  rolloutPercent: number;
  version: number;
  from: Date;
  to: Date | null;
  marketId: string | null;
}
/** Deterministic rollout; NOT authorization. Unknown/invalid policies fail closed. */
export function evaluateFlag(
  flags: readonly VersionedFlag[],
  marketId: string,
  bucket: number,
  at: Date,
): boolean {
  if (!Number.isInteger(bucket) || bucket < 0 || bucket > 99) return false;
  const candidates = flags.filter(
    (f) => (f.marketId === null || f.marketId === marketId) && isEffective(f.from, f.to, at),
  );
  candidates.sort(
    (a, b) => Number(b.marketId !== null) - Number(a.marketId !== null) || b.version - a.version,
  );
  const chosen = candidates[0];
  return (
    chosen !== undefined &&
    chosen.enabled &&
    chosen.rolloutPercent >= 0 &&
    chosen.rolloutPercent <= 100 &&
    bucket < chosen.rolloutPercent
  );
}
export * from './commercial-calculator.js';
export { Exact } from './commercial-decimal.js';
