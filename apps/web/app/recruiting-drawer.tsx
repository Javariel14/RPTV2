'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  recruitingMutation,
  type RecruitmentProfileDetail,
  type RecruitingContext,
  type RecruitingStage,
} from '@rpt/contracts/recruiting';
import { Button, Panel } from '@rpt/ui';
import { RecruitingHttpError, recruitingRequest } from './use-recruiting-data';

const stages: RecruitingStage[] = [
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
];
const substatuses = [
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
];

export function RecruitingDrawer({
  id,
  context,
  label,
  locale,
  onClose,
  onChanged,
}: {
  id: string;
  context: RecruitingContext;
  label: (key: string) => string;
  locale: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<RecruitmentProfileDetail>();
  const [status, setStatus] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [action, setAction] = useState('stage');
  const [revision, setRevision] = useState(0);
  const attempt = useRef<{ body: string; key: string } | undefined>(undefined);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setStatus(0);
    void recruitingRequest<RecruitmentProfileDetail>(`profiles/${id}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setDetail(value);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setDetail(undefined);
          setStatus(reason instanceof RecruitingHttpError ? reason.status : 503);
        }
      });
    return () => controller.abort();
  }, [id, revision]);

  useEffect(() => {
    const revalidate = () => {
      if (document.visibilityState === 'visible' && !busy) refresh();
    };
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    return () => {
      window.removeEventListener('focus', revalidate);
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, [busy, refresh]);

  async function send(body: string) {
    if (busy) return;
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    setSaved(false);
    try {
      await recruitingRequest(`profiles/${id}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.current.key },
        body: attempt.current.body,
      });
      attempt.current = undefined;
      const latest = await recruitingRequest<RecruitmentProfileDetail>(`profiles/${id}`);
      setDetail(latest);
      setStatus(0);
      setSaved(true);
      onChanged();
    } catch (reason) {
      const next = reason instanceof RecruitingHttpError ? reason.status : 503;
      setStatus(next);
      if (next < 500) attempt.current = undefined;
      if ([403, 404].includes(next)) setDetail(undefined);
      if (next === 409) {
        const latest = await recruitingRequest<RecruitmentProfileDetail>(`profiles/${id}`).catch(
          () => undefined,
        );
        if (latest) setDetail(latest);
      }
    } finally {
      setBusy(false);
    }
  }

  const permissions = detail?.permissions;
  const actions = detail
    ? [
        ...(detail.row.canUpdate && detail.row.stage !== 'activated'
          ? ['stage', 'substatus', 'priority']
          : []),
        ...(detail.row.canReassign && context.owners.length > 1 ? ['reassign_owner'] : []),
        ...(permissions?.appointment ? ['appointment'] : []),
        ...(permissions?.interview ? ['interview'] : []),
        ...(permissions?.followup ? ['followup'] : []),
        ...(permissions?.completeFollowup && detail.followups.some((item) => !item.completedAt)
          ? ['complete_followup']
          : []),
        ...(permissions?.hook ? ['hook'] : []),
      ]
    : [];
  const selected = actions.includes(action) ? action : (actions[0] ?? '');
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'America/Guayaquil',
    }).format(new Date(value));
  const message =
    status === 409
      ? label('conflict')
      : status === 422 || status === 400
        ? label('invalid')
        : status === 403
          ? label('forbidden')
          : status === 404
            ? label('notFound')
            : label('unavailable');

  return (
    <Panel
      title={detail?.row.displayName ?? label('detail')}
      closeLabel={label('close')}
      onClose={onClose}
    >
      <div className="crm-detail recruiting-detail">
        {status > 0 && (
          <div className="banner" role="alert">
            <p>{message}</p>
            <Button
              disabled={busy}
              onClick={() => {
                setStatus(0);
                refresh();
              }}
            >
              {label('retry')}
            </Button>
          </div>
        )}
        {!detail && status === 0 && (
          <p role="status" aria-busy="true">
            {label('loading')}
          </p>
        )}
        {saved && (
          <p className="success-message" role="status">
            {label('success')}
          </p>
        )}
        {detail && (
          <>
            <div className="recruiting-summary">
              <span className={`badge stage-${detail.row.stage}`}>{label(detail.row.stage)}</span>
              <strong>{detail.row.priority ?? '—'}</strong>
              <span>
                {label(detail.row.source)} · {label(detail.row.ownerLabel)}
              </span>
            </div>
            <p className="source-note">{label('operational')}</p>
            <dl>
              <dt>{label('substatus')}</dt>
              <dd>{detail.row.substatus ? label(detail.row.substatus) : '—'}</dd>
              <dt>{label('next')}</dt>
              <dd>{detail.row.nextAction ?? '—'}</dd>
              <dt>{label('updated')}</dt>
              <dd>{date(detail.row.updatedAt)}</dd>
              <dt>{label('source')}</dt>
              <dd>{label(detail.row.source)}</dd>
            </dl>
            <section>
              <h3>{label('contact')}</h3>
              {detail.row.canContact && detail.contact ? (
                <p>
                  {detail.contact.email ?? '—'} · {detail.contact.phone ?? '—'}
                </p>
              ) : (
                <p>{label('restricted')}</p>
              )}
            </section>
            {actions.length > 0 && (
              <section>
                <h3>{label('save')}</h3>
                <label>
                  <span className="sr-only">{label('save')}</span>
                  <select
                    value={selected}
                    aria-label={label('save')}
                    disabled={busy}
                    onChange={(event) => {
                      setAction(event.target.value);
                      setStatus(0);
                      setSaved(false);
                    }}
                  >
                    {actions.map((value) => (
                      <option key={value} value={value}>
                        {label(value)}
                      </option>
                    ))}
                  </select>
                </label>
                <form
                  key={`${selected}-${detail.row.version}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const fields: Record<string, FormDataEntryValue> = {};
                    new FormData(event.currentTarget).forEach((value, key) => {
                      fields[key] = value;
                    });
                    const normalizeDate = (value: FormDataEntryValue | undefined) =>
                      new Date(String(value)).toISOString();
                    const command =
                      selected === 'stage'
                        ? { type: 'stage', stage: String(fields.stage) }
                        : selected === 'substatus'
                          ? { type: 'substatus', substatus: String(fields.substatus) }
                          : selected === 'priority'
                            ? { type: 'priority', priority: String(fields.priority) }
                            : selected === 'reassign_owner'
                              ? { type: 'reassign_owner', ownerId: String(fields.ownerId) }
                              : selected === 'appointment'
                                ? {
                                    type: 'appointment',
                                    startsAt: normalizeDate(fields.startsAt),
                                    timezone: String(fields.timezone),
                                    channel: String(fields.channel),
                                  }
                                : selected === 'interview'
                                  ? {
                                      type: 'interview',
                                      occurredAt: normalizeDate(fields.occurredAt),
                                      outcome: String(fields.outcome),
                                      notes: String(fields.notes ?? ''),
                                    }
                                  : selected === 'followup'
                                    ? {
                                        type: 'followup',
                                        dueAt: normalizeDate(fields.dueAt),
                                        text: String(fields.text),
                                      }
                                    : selected === 'complete_followup'
                                      ? {
                                          type: 'complete_followup',
                                          followupId: String(fields.followupId),
                                        }
                                      : {
                                          type: 'hook',
                                          kind: String(fields.kind),
                                          reference: fields.reference
                                            ? String(fields.reference)
                                            : null,
                                        };
                    const parsed = recruitingMutation.safeParse({
                      schemaVersion: 1,
                      expectedVersion: detail.row.version,
                      command,
                    });
                    if (!parsed.success) {
                      setStatus(422);
                      return;
                    }
                    void send(JSON.stringify(parsed.data));
                  }}
                >
                  {selected === 'stage' && (
                    <label>
                      {label('stage')}
                      <select name="stage">
                        {stages
                          .slice(
                            stages.indexOf(detail.row.stage) + 1,
                            stages.indexOf(detail.row.stage) + 2,
                          )
                          .map((value) => (
                            <option key={value} value={value}>
                              {label(value)}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  {selected === 'substatus' && (
                    <label>
                      {label('substatus')}
                      <select
                        name="substatus"
                        defaultValue={detail.row.substatus ?? 'data_validated'}
                      >
                        {substatuses.map((value) => (
                          <option key={value} value={value}>
                            {label(value)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {selected === 'priority' && (
                    <label>
                      {label('priority')}
                      <select name="priority" defaultValue={detail.row.priority ?? 'B'}>
                        {['A', 'B', 'C'].map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {selected === 'reassign_owner' && (
                    <label>
                      {label('owner')}
                      <select name="ownerId" defaultValue={detail.row.ownerId}>
                        {context.owners.map((owner) => (
                          <option key={owner.id} value={owner.id}>
                            {label(owner.label)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {selected === 'appointment' && (
                    <>
                      <label>
                        {label('startsAt')}
                        <input name="startsAt" type="datetime-local" required />
                      </label>
                      <label>
                        {label('timezone')}
                        <input
                          name="timezone"
                          readOnly
                          value={Intl.DateTimeFormat().resolvedOptions().timeZone}
                        />
                      </label>
                      <label>
                        {label('channel')}
                        <select name="channel">
                          {['in_person', 'phone', 'video'].map((value) => (
                            <option key={value} value={value}>
                              {label(value)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                  {selected === 'interview' && (
                    <>
                      <label>
                        {label('occurredAt')}
                        <input name="occurredAt" type="datetime-local" required />
                      </label>
                      <label>
                        {label('outcome')}
                        <select name="outcome">
                          {['attended', 'no_show', 'cancelled', 'rescheduled'].map((value) => (
                            <option key={value} value={value}>
                              {label(value)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {label('notes')}
                        <textarea name="notes" maxLength={1000} />
                      </label>
                    </>
                  )}
                  {selected === 'followup' && (
                    <>
                      <label>
                        {label('dueAt')}
                        <input name="dueAt" type="datetime-local" required />
                      </label>
                      <label>
                        {label('text')}
                        <textarea name="text" required maxLength={1000} />
                      </label>
                    </>
                  )}
                  {selected === 'complete_followup' && (
                    <label>
                      {label('followups')}
                      <select name="followupId">
                        {detail.followups
                          .filter((item) => !item.completedAt)
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.text}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  {selected === 'hook' && (
                    <>
                      <label>
                        {label('kind')}
                        <select name="kind">
                          <option value="training">{label('training')}</option>
                          <option value="onboarding">{label('onboarding')}</option>
                        </select>
                      </label>
                      <label>
                        {label('reference')}
                        <input name="reference" maxLength={200} />
                      </label>
                    </>
                  )}
                  <Button type="submit" variant="primary" disabled={busy || status === 409}>
                    {busy ? label('loading') : label('save')}
                  </Button>
                </form>
              </section>
            )}
            <DetailGroup
              title={label('appointments')}
              empty={label('noItems')}
              items={detail.appointments.map(
                (item) => `${date(item.startsAt)} · ${label(item.channel)}`,
              )}
            />
            <DetailGroup
              title={label('interviews')}
              empty={label('noItems')}
              items={detail.interviews.map(
                (item) =>
                  `${date(item.occurredAt)} · ${label(item.outcome)}${item.notes ? ` · ${item.notes}` : ''}`,
              )}
            />
            <DetailGroup
              title={label('followups')}
              empty={label('noItems')}
              items={detail.followups.map(
                (item) => `${item.completedAt ? '✓ ' : ''}${item.text} · ${date(item.dueAt)}`,
              )}
            />
            <DetailGroup
              title={label('hooks')}
              empty={label('noItems')}
              items={detail.hooks.map(
                (item) => `${label(item.kind)}${item.reference ? ` · ${item.reference}` : ''}`,
              )}
            />
            <section>
              <h3>{label('timeline')}</h3>
              {detail.timeline.length === 0 ? (
                <p>{label('noItems')}</p>
              ) : (
                <ol>
                  {detail.timeline.map((item) => (
                    <li className="timeline-event" key={item.id}>
                      {label(item.action)}
                      <br />
                      <time dateTime={item.occurredAt}>{date(item.occurredAt)}</time>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </Panel>
  );
}

function DetailGroup({ title, empty, items }: { title: string; empty: string; items: string[] }) {
  return (
    <section>
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((item, index) => (
            <li key={`${item}-${index}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}
