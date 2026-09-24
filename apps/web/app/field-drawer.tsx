'use client';
import { useEffect, useRef, useState } from 'react';
import type {
  FieldVisitDetail,
  FieldVisitMutation,
  FieldVisitMutationResult,
} from '@rpt/contracts';
import { Button, Panel } from '@rpt/ui';
import { localInput, zonedInstant } from './agenda-time';
import type { fieldCatalogs } from './field-catalog';
import { FieldHttpError, fieldRequest } from './field-data';

type Label = (key: keyof typeof fieldCatalogs.es) => string;
type Command = FieldVisitMutation['command'];
type Location = Extract<Command, { type: 'check_in' }>['location'];

export function FieldDrawer({
  id,
  locale,
  label,
  onClose,
  onChanged,
}: {
  id: string;
  locale: string;
  label: Label;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<FieldVisitDetail>();
  const [status, setStatus] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [revision, setRevision] = useState(0);
  const [capture, setCapture] = useState(false);
  const [locationWarning, setLocationWarning] = useState(false);
  const [locationRestricted, setLocationRestricted] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [purpose, setPurpose] = useState('');
  const [scheduled, setScheduled] = useState('');
  const [confirming, setConfirming] = useState(false);
  const attempt = useRef<{ body: string; key: string } | undefined>(undefined);
  const inFlight = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setStatus(0);
    setDetail(undefined);
    setSaved(false);
    void fieldRequest<FieldVisitDetail>(id, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        setDetail(value);
        setPurpose(value.purpose);
        setScheduled(
          localInput(value.scheduledAt, Intl.DateTimeFormat().resolvedOptions().timeZone),
        );
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setStatus(reason instanceof FieldHttpError ? reason.status : 503);
      });
    return () => controller.abort();
  }, [id, revision]);

  async function optionalLocation(): Promise<Location> {
    if (!capture || !navigator.geolocation) return null;
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          timeout: 8000,
          maximumAge: 0,
        }),
      );
      return {
        latitude: Number(position.coords.latitude.toFixed(6)),
        longitude: Number(position.coords.longitude.toFixed(6)),
        accuracyMeters: Number(position.coords.accuracy.toFixed(2)),
        source: 'device_explicit',
        consentContext: 'explicit_visit_action',
      };
    } catch {
      setLocationWarning(true);
      return null;
    }
  }
  async function command(value: Command, alreadyLocked = false) {
    if (!detail || (inFlight.current && !alreadyLocked)) return;
    inFlight.current = true;
    setBusy(true);
    setSaved(false);
    setStatus(0);
    setLocationRestricted(false);
    try {
      const body = JSON.stringify({
        schemaVersion: 1,
        expectedVersion: detail.version,
        command: value,
      });
      if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
      await fieldRequest<FieldVisitMutationResult>(`${id}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.current.key },
        body,
      });
      attempt.current = undefined;
      const updated = await fieldRequest<FieldVisitDetail>(id);
      setDetail(updated);
      setScheduled(
        localInput(updated.scheduledAt, Intl.DateTimeFormat().resolvedOptions().timeZone),
      );
      setSaved(true);
      setConfirming(false);
      setCapture(false);
      onChanged();
    } catch (reason) {
      const next = reason instanceof FieldHttpError ? reason.status : 503;
      setStatus(next);
      if (next < 500) attempt.current = undefined;
      if (next === 403 && 'location' in value && value.location) {
        setCapture(false);
        try {
          setDetail(await fieldRequest<FieldVisitDetail>(id));
          setLocationRestricted(true);
          setStatus(0);
        } catch {
          setDetail(undefined);
        }
      } else if (next === 403 || next === 404) setDetail(undefined);
      if (next === 409) {
        try {
          setDetail(await fieldRequest<FieldVisitDetail>(id));
        } catch {
          setDetail(undefined);
        }
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function act(type: 'check_in' | 'check_out') {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const location = await optionalLocation();
    if (type === 'check_in') await command({ type, location }, true);
    else await command({ type, outcome, notes: notes || null, location }, true);
  }
  const date = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(value),
        )
      : '—';
  const error =
    status === 403
      ? 'forbidden'
      : status === 404
        ? 'notFound'
        : status === 409
          ? 'conflict'
          : [400, 422].includes(status)
            ? 'invalid'
            : 'unavailable';
  return (
    <Panel title={detail?.purpose ?? label('detail')} closeLabel={label('close')} onClose={onClose}>
      <div className="field-detail">
        {status > 0 && (
          <div className="banner" role="alert">
            <p>{label(error)}</p>
            <Button onClick={() => setRevision((value) => value + 1)}>{label('retry')}</Button>
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
              <span className={`field-status ${detail.status}`}>{label(detail.status)}</span>
            </div>
            <dl>
              <dt>{label('schedule')}</dt>
              <dd>{date(detail.scheduledAt)}</dd>
              <dt>{label('owner')}</dt>
              <dd>{detail.ownerId}</dd>
              <dt>{label('actualStart')}</dt>
              <dd>{date(detail.actualStart)}</dd>
              <dt>{label('actualEnd')}</dt>
              <dd>{date(detail.actualEnd)}</dd>
              {detail.agendaItemId && (
                <>
                  <dt>{label('appointment')}</dt>
                  <dd>
                    <a href="/agenda">{label('openAgenda')}</a>
                  </dd>
                </>
              )}
              {detail.personId && (
                <>
                  <dt>{label('person')}</dt>
                  <dd>{detail.personId}</dd>
                </>
              )}
              {detail.opportunityId && (
                <>
                  <dt>{label('opportunity')}</dt>
                  <dd>
                    <a href="/crm/commercial">{label('commercial')}</a>
                  </dd>
                </>
              )}
              {detail.outcome && (
                <>
                  <dt>{label('outcome')}</dt>
                  <dd>{detail.outcome}</dd>
                </>
              )}
              {detail.notes && (
                <>
                  <dt>{label('notes')}</dt>
                  <dd>{detail.notes}</dd>
                </>
              )}
            </dl>
            {detail.travel && (
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
            )}
            {detail.status === 'planned' && (
              <div className="field-actions">
                <div className="field-action-primary">
                  <Button variant="primary" disabled={busy} onClick={() => void act('check_in')}>
                    {label('checkIn')}
                  </Button>
                </div>
                <p className="source-note">{label('locationPurpose')}</p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={capture}
                    onChange={(e) => setCapture(e.target.checked)}
                  />
                  {label('captureLocation')}
                </label>
                {locationWarning && <p role="status">{label('locationDenied')}</p>}
                {locationRestricted && <p role="alert">{label('locationRestricted')}</p>}
                {!detail.agendaItemId && (
                  <form
                    className="agenda-create"
                    onSubmit={(e) => {
                      e.preventDefault();
                      try {
                        void command({
                          type: 'update',
                          purpose,
                          scheduledAt: zonedInstant(
                            scheduled,
                            Intl.DateTimeFormat().resolvedOptions().timeZone,
                          ),
                        });
                      } catch {
                        setStatus(422);
                      }
                    }}
                  >
                    <label>
                      {label('purpose')}
                      <input
                        value={purpose}
                        maxLength={500}
                        required
                        onChange={(e) => setPurpose(e.target.value)}
                      />
                    </label>
                    <label>
                      {label('schedule')}
                      <input
                        type="datetime-local"
                        value={scheduled}
                        required
                        onChange={(e) => setScheduled(e.target.value)}
                      />
                    </label>
                    <Button type="submit" disabled={busy}>
                      {label('save')}
                    </Button>
                  </form>
                )}
                <div className="button-row">
                  <Button disabled={busy} onClick={() => void command({ type: 'cancel' })}>
                    {label('cancel')}
                  </Button>
                  <Button disabled={busy} onClick={() => void command({ type: 'no_show' })}>
                    {label('noShow')}
                  </Button>
                </div>
              </div>
            )}
            {detail.status === 'in_progress' && (
              <form
                className="field-actions"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (confirming) void act('check_out');
                  else setConfirming(true);
                }}
              >
                <label>
                  {label('outcome')}
                  <input
                    value={outcome}
                    maxLength={200}
                    required
                    onChange={(e) => setOutcome(e.target.value)}
                  />
                </label>
                <label>
                  {label('notes')}
                  <textarea
                    value={notes}
                    maxLength={1000}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </label>
                <p className="source-note">{label('locationPurpose')}</p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={capture}
                    onChange={(e) => setCapture(e.target.checked)}
                  />
                  {label('captureLocation')}
                </label>
                {locationWarning && <p role="status">{label('locationDenied')}</p>}
                {locationRestricted && <p role="alert">{label('locationRestricted')}</p>}
                <Button variant="primary" type="submit" disabled={busy}>
                  {confirming ? label('confirmClose') : label('checkOut')}
                </Button>
              </form>
            )}
            {detail.locationEvidence.length > 0 && (
              <section>
                <h3>{label('location')}</h3>
                <ul>
                  {detail.locationEvidence.map((e) => (
                    <li key={e.id}>
                      {label(e.phase === 'check_in' ? 'checkIn' : 'checkOut')} ·{' '}
                      {date(e.capturedAt)} · {e.latitude}, {e.longitude}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section>
              <h3>{label('history')}</h3>
              <ol className="agenda-history">
                {detail.history.map((e) => (
                  <li key={e.id}>
                    <strong>
                      {e.action === 'created' ||
                      e.action === 'updated' ||
                      e.action === 'checked_in' ||
                      e.action === 'checked_out' ||
                      e.action === 'cancelled' ||
                      e.action === 'no_show'
                        ? label(e.action)
                        : label('history')}
                    </strong>
                    <span>{date(e.occurredAt)}</span>
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
