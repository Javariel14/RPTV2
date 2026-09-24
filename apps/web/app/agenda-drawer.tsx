'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgendaDetail, AgendaMutation } from '@rpt/contracts';
import { Button, Panel } from '@rpt/ui';
import { localInput, zonedInstant } from './agenda-time';
import { AgendaHttpError, agendaRequest } from './use-agenda-data';

export function AgendaDrawer({
  id,
  locale,
  label,
  onClose,
  onChanged,
}: {
  id: string;
  locale: string;
  label: (key: string) => string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<AgendaDetail>();
  const [status, setStatus] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [revision, setRevision] = useState(0);
  const attempt = useRef<{ body: string; key: string } | undefined>(undefined);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setStatus(0);
    void agendaRequest<AgendaDetail>(`items/${id}`, { signal: controller.signal })
      .then((value) => !controller.signal.aborted && setDetail(value))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setDetail(undefined);
          setStatus(reason instanceof AgendaHttpError ? reason.status : 503);
        }
      });
    return () => controller.abort();
  }, [id, revision]);

  async function command(value: AgendaMutation['command']) {
    if (!detail || busy) return;
    const body = JSON.stringify({
      schemaVersion: 1,
      expectedVersion: detail.version,
      command: value,
    });
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    setSaved(false);
    try {
      await agendaRequest(`items/${id}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.current.key },
        body,
      });
      attempt.current = undefined;
      setDetail(await agendaRequest<AgendaDetail>(`items/${id}`));
      setStatus(0);
      setSaved(true);
      onChanged();
    } catch (reason) {
      const next = reason instanceof AgendaHttpError ? reason.status : 503;
      setStatus(next);
      if (next < 500) attempt.current = undefined;
      if ([403, 404].includes(next)) setDetail(undefined);
      if (next === 409) refresh();
    } finally {
      setBusy(false);
    }
  }
  const date = (value: string | null, timezone?: string) =>
    value
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: timezone,
        }).format(new Date(value))
      : '—';
  const error =
    status === 403
      ? 'forbidden'
      : status === 404
        ? 'notFound'
        : status === 409
          ? 'conflict'
          : status === 400 || status === 422
            ? 'invalid'
            : 'unavailable';
  return (
    <Panel title={detail?.title ?? label('detail')} closeLabel={label('close')} onClose={onClose}>
      <div className="agenda-detail">
        {status > 0 && (
          <div className="banner" role="alert">
            <p>{label(error)}</p>
            <Button onClick={refresh}>{label('retry')}</Button>
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
            <div className="agenda-detail-summary">
              <span className={`agenda-type ${detail.type}`}>{label(detail.type)}</span>
              <span className="badge">{label(detail.status)}</span>
              {detail.confirmationState && <span>{label(detail.confirmationState)}</span>}
            </div>
            <dl>
              <dt>{detail.type === 'appointment' ? label('startsAt') : label('dueAt')}</dt>
              <dd>{date(detail.startsAt ?? detail.dueAt, detail.timezone)}</dd>
              {detail.endsAt && (
                <>
                  <dt>{label('endsAt')}</dt>
                  <dd>{date(detail.endsAt, detail.timezone)}</dd>
                </>
              )}
              <dt>{label('timezone')}</dt>
              <dd>{detail.timezone}</dd>
              <dt>{label('source')}</dt>
              <dd>{label(detail.source)}</dd>
              <dt>{label('owner')}</dt>
              <dd>{label('mine')}</dd>
              <dt>{label('linkedContext')}</dt>
              <dd>
                {detail.opportunityId || detail.recruitmentProfileId || detail.personId
                  ? label(detail.source)
                  : label(detail.source === 'manual' ? 'manual' : 'restrictedContext')}
              </dd>
              <dt>{label('recurrence')}</dt>
              <dd>
                {detail.recurrence
                  ? `${label(detail.recurrence.frequency)} · ${label('occurrence')} ${detail.occurrenceIndex + 1}`
                  : label('none')}
              </dd>
            </dl>
            {detail.summary && <p>{detail.summary}</p>}
            {!detail.mutable ? (
              <p className="source-note">{label('readonly')}</p>
            ) : (
              <AgendaActions detail={detail} busy={busy} label={label} command={command} />
            )}
            <section>
              <h3>{label('reminders')}</h3>
              <p className="source-note">{label('internalOnly')}</p>
              <ul>
                {detail.reminders.map((item) => (
                  <li key={item.id}>
                    {date(item.reminderAt, detail.timezone)} · {label(item.status)}
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3>{label('travel')}</h3>
              <dl>
                <dt>{label('origin')}</dt>
                <dd>{detail.travel.originLabel ?? '—'}</dd>
                <dt>{label('destination')}</dt>
                <dd>{detail.travel.destinationLabel ?? '—'}</dd>
                <dt>{label('travelMinutes')}</dt>
                <dd>{detail.travel.estimatedTravelMinutes ?? '—'}</dd>
                <dt>{label('preparationMinutes')}</dt>
                <dd>{detail.travel.preparationMinutes ?? '—'}</dd>
              </dl>
            </section>
            <section>
              <h3>{label('history')}</h3>
              <ol className="agenda-history">
                {detail.history.map((item) => (
                  <li key={item.id}>
                    <strong>{label(item.action)}</strong>
                    <span>{date(item.occurredAt, detail.timezone)}</span>
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}
      </div>
    </Panel>
  );
}

function AgendaActions({
  detail,
  busy,
  label,
  command,
}: {
  detail: AgendaDetail;
  busy: boolean;
  label: (key: string) => string;
  command: (value: AgendaMutation['command']) => Promise<void>;
}) {
  const anchor = detail.startsAt ?? detail.dueAt!;
  const [starts, setStarts] = useState(localInput(anchor, detail.timezone));
  const duration =
    detail.endsAt && detail.startsAt
      ? Date.parse(detail.endsAt) - Date.parse(detail.startsAt)
      : 3_600_000;
  const [ends, setEnds] = useState(
    localInput(new Date(Date.parse(anchor) + duration).toISOString(), detail.timezone),
  );
  const [timezone, setTimezone] = useState(detail.timezone);
  const [reminders, setReminders] = useState(detail.reminderMinutesBefore.map(String));
  const sendTime = () => {
    try {
      return detail.type === 'appointment'
        ? command({
            type: 'reschedule',
            startsAt: zonedInstant(starts, timezone),
            endsAt: zonedInstant(ends, timezone),
            timezone,
          })
        : command({
            type: 'update_task',
            dueAt: zonedInstant(starts, timezone),
            timezone,
            priority: detail.priority,
          });
    } catch {
      return Promise.resolve();
    }
  };
  return (
    <section className="agenda-actions" aria-label={label('save')}>
      {detail.type === 'appointment' && detail.status === 'scheduled' && (
        <div className="button-row">
          {detail.confirmationState === 'pending' && (
            <>
              <Button disabled={busy} onClick={() => void command({ type: 'confirm' })}>
                {label('confirm')}
              </Button>
              <Button disabled={busy} onClick={() => void command({ type: 'decline' })}>
                {label('decline')}
              </Button>
            </>
          )}
          <Button disabled={busy} onClick={() => void command({ type: 'cancel' })}>
            {label('cancel')}
          </Button>
        </div>
      )}
      {detail.type === 'task' && detail.status === 'open' && (
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => void command({ type: 'complete' })}
        >
          {label('complete')}
        </Button>
      )}
      {((detail.type === 'appointment' && detail.status === 'scheduled') ||
        (detail.type === 'task' && detail.status === 'open')) && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void sendTime();
          }}
        >
          <h3>{detail.type === 'appointment' ? label('reschedule') : label('save')}</h3>
          <label>
            {detail.type === 'appointment' ? label('startsAt') : label('dueAt')}
            <input
              type="datetime-local"
              required
              value={starts}
              onChange={(event) => setStarts(event.target.value)}
            />
          </label>
          {detail.type === 'appointment' && (
            <label>
              {label('endsAt')}
              <input
                type="datetime-local"
                required
                value={ends}
                onChange={(event) => setEnds(event.target.value)}
              />
            </label>
          )}
          <label>
            {label('timezone')}
            <input
              required
              maxLength={64}
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </label>
          <Button type="submit" variant="primary" disabled={busy}>
            {label('save')}
          </Button>
        </form>
      )}
      <fieldset>
        <legend>{label('reminders')}</legend>
        {[15, 60, 1440].map((minute) => (
          <label className="check" key={minute}>
            <input
              type="checkbox"
              checked={reminders.includes(String(minute))}
              onChange={(event) =>
                setReminders(
                  event.target.checked
                    ? [...reminders, String(minute)]
                    : reminders.filter((value) => value !== String(minute)),
                )
              }
            />
            {label(`reminder${minute}`)}
          </label>
        ))}
        <Button
          disabled={busy}
          onClick={() =>
            void command({ type: 'set_reminders', reminderMinutesBefore: reminders.map(Number) })
          }
        >
          {label('save')}
        </Button>
      </fieldset>
    </section>
  );
}
