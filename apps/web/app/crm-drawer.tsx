'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { crmCommand, type CrmDetail } from '@rpt/contracts/crm';
import { Button, Panel } from '@rpt/ui';
import { CrmHttpError, crmRequest } from './use-crm-data';

export function CrmDrawer({
  id,
  label,
  onClose,
  onChanged,
  locale,
}: {
  id: string;
  label: (key: string) => string;
  onClose: () => void;
  onChanged: () => void;
  locale: string;
}) {
  const [revision, setRevision] = useState(0),
    [detail, setDetail] = useState<CrmDetail | null>(null),
    [status, setStatus] = useState(0),
    [busy, setBusy] = useState(false),
    [action, setAction] = useState(''),
    [saved, setSaved] = useState(false);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const refresh = useCallback((clear = true) => {
    if (clear) {
      setDetail(null);
      setStatus(0);
    }
    setRevision((n) => n + 1);
  }, []);
  async function sendAttempt() {
    const pending = attempt.current;
    if (!pending || busy) return;
    setBusy(true);
    setSaved(false);
    try {
      await crmRequest(`opportunities/${id}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
        body: pending.body,
      });
      attempt.current = null;
      setAction('');
      setSaved(true);
      onChanged();
      refresh();
    } catch (error) {
      const code = error instanceof CrmHttpError ? error.status : 503;
      setStatus(code);
      if (code !== 400 && code !== 409) setDetail(null);
      if (code < 500) attempt.current = null;
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void crmRequest<CrmDetail>(`opportunities/${id}`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          setDetail(value);
          setStatus(0);
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          setDetail(null);
          setStatus(e instanceof CrmHttpError ? e.status : 503);
        }
      });
    return () => controller.abort();
  }, [id, revision]);
  useEffect(() => {
    // Revalidate on return; discard projections if the fresh request is denied.
    const focus = () => {
      if (document.visibilityState === 'visible' && !busy && !attempt.current) refresh(false);
    };
    const timer = setInterval(() => {
      if (!busy && !attempt.current) refresh(false);
    }, 30000);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [refresh, busy]);
  const p = detail?.permissions,
    stage = detail?.row.stage;
  const options =
    detail && p
      ? [
          ...(detail.row.canUpdate && !['won', 'won_simulated', 'lost'].includes(stage!)
            ? ['stage']
            : []),
          ...(p.schedule && ['new', 'contacted'].includes(stage!) ? ['appointment'] : []),
          ...(p.demo && stage === 'appointment' ? ['demo'] : []),
          ...(p.quote && ['demo', 'proposal'].includes(stage!) && !detail.order ? ['quote'] : []),
          ...(p.order && stage === 'proposal' && !detail.order ? ['submit_order'] : []),
          ...(p.reconcile &&
          stage === 'pending_approval' &&
          ['company_processing', 'conflict'].includes(detail.order?.simulatedStatus ?? '')
            ? ['reconcile_mock']
            : []),
          ...(p.postsale && detail.order?.simulatedStatus === 'approved' ? ['delivery'] : []),
          ...(p.postsale &&
          ['delivered', 'curation_pending'].includes(detail.order?.simulatedStatus ?? '')
            ? ['curation']
            : []),
          ...(p.notes ? ['entry'] : []),
          ...(p.completeTask && detail.entries.some((e) => e.kind === 'task' && !e.completedAt)
            ? ['complete_task']
            : []),
          ...(p.editPerson ? ['edit_person'] : []),
          ...(p.editContact ? ['edit_contact'] : []),
          ...(p.manageCollaborators ? ['add_collaborator'] : []),
          ...(p.manageCollaborators && detail.collaborators.length > 0
            ? ['remove_collaborator']
            : []),
          ...(p.recordActivity ? ['activity'] : []),
          ...(p.setReferral && detail.row.source === 'referral' ? ['set_referral'] : []),
        ]
      : [];
  const selected = options.includes(action) ? action : (options[0] ?? '');
  const input = (name: string, type = 'text', value = '', required = true) => (
    <label>
      {label(name)}
      <input
        name={name}
        type={type}
        defaultValue={value}
        readOnly={name === 'timezone'}
        required={required}
        maxLength={
          name === 'email'
            ? 254
            : name === 'phone'
              ? 32
              : name === 'currency'
                ? 3
                : name === 'text'
                  ? 1000
                  : 200
        }
      />
    </label>
  );
  const select = (name: string, values: string[]) => (
    <label>
      {label(name)}
      <select name={name} aria-label={label(name)}>
        {values.map((value) => (
          <option key={value} value={value}>
            {label(value)}
          </option>
        ))}
      </select>
    </label>
  );
  const message =
    status === 409
      ? label('conflictHelp')
      : status === 400 || status === 422
        ? label('invalid')
        : [401, 403, 404].includes(status)
          ? label('notFound')
          : label('errorDetail');
  return (
    <Panel
      title={detail?.row.name ?? label('detail')}
      closeLabel={label('close')}
      onClose={onClose}
    >
      <div className="crm-detail">
        <p className="source-note">{label('simulation')}</p>
        {status !== 0 && (
          <div role="alert">
            <p>{message}</p>
            <Button
              disabled={busy}
              onClick={() => {
                if (status >= 500 && attempt.current) {
                  void sendAttempt();
                  return;
                }
                attempt.current = null;
                refresh();
              }}
            >
              {label('retry')}
            </Button>
          </div>
        )}
        {!detail && status === 0 && <p role="status">{label('loading')}</p>}
        {saved && <p role="status">{label('saved')}</p>}
        {detail && (
          <>
            <p>
              {detail.row.title} · <strong>{label(`stage:${detail.row.stage}`)}</strong>
            </p>
            <p>
              {label(detail.row.nextAction)}{' '}
              {detail.row.nextAt && new Date(detail.row.nextAt).toLocaleString(locale)}
            </p>
            <section className="crm-intelligence" aria-label={label('relationshipHealth')}>
              <p className="secondary">{label('rptRecommendation')}</p>
              <dl>
                <dt>{label('relationshipHealth')}</dt>
                <dd>
                  <span className={`health health-${detail.row.relationshipHealth}`}>
                    {label(detail.row.relationshipHealth)}
                  </span>
                </dd>
                <dt>{label('operationalScore')}</dt>
                <dd>{detail.row.operationalScore}/100</dd>
                <dt>{label('nextBestAction')}</dt>
                <dd>{label(detail.row.nextBestAction.type)}</dd>
              </dl>
              <h3>{label('mainReasons')}</h3>
              <ul>
                {detail.row.relationshipHealthReasons.slice(0, 3).map((reason) => (
                  <li key={reason}>{label(reason)}</li>
                ))}
                <li>{label(detail.row.nextBestActionReason)}</li>
              </ul>
            </section>
            {options.length > 0 && (
              <section>
                <h3>{label('actions')}</h3>
                <label>
                  {label('actions')}
                  <select
                    aria-label={label('actions')}
                    value={selected}
                    disabled={busy}
                    onChange={(e) => {
                      setAction(e.target.value);
                      setStatus(0);
                      setSaved(false);
                    }}
                  >
                    {options.map((value) => (
                      <option key={value} value={value}>
                        {label(value)}
                      </option>
                    ))}
                  </select>
                </label>
                <form
                  key={`${selected}/${detail.row.version}`}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (busy || status === 409) return;
                    const fields: Record<string, string> = {};
                    new FormData(e.currentTarget).forEach((value, key) => {
                      if (typeof value === 'string') fields[key] = value;
                    });
                    delete fields.confirm;
                    if (selected === 'appointment')
                      fields.startsAt = new Date(String(fields.startsAt)).toISOString();
                    if (selected === 'activity')
                      fields.occurredAt = new Date(String(fields.occurredAt)).toISOString();
                    if (selected === 'add_collaborator')
                      fields.until = new Date(String(fields.until)).toISOString();
                    if (selected === 'entry') {
                      fields.dueAt =
                        fields.kind === 'task' && fields.dueAt
                          ? new Date(String(fields.dueAt)).toISOString()
                          : '';
                    }
                    const raw = {
                      type: selected,
                      ...fields,
                      ...(selected === 'entry' ? { dueAt: fields.dueAt || null } : {}),
                      ...(selected === 'edit_person'
                        ? { personVersion: detail.row.personVersion }
                        : {}),
                    };
                    const parsed = crmCommand.safeParse(raw);
                    if (!parsed.success) {
                      setStatus(400);
                      return;
                    }
                    const body = JSON.stringify({
                      schemaVersion: 1,
                      expectedVersion: detail.row.version,
                      command: parsed.data,
                    });
                    if (attempt.current?.body !== body)
                      attempt.current = { body, key: crypto.randomUUID() };
                    await sendAttempt();
                  }}
                >
                  {selected === 'stage' &&
                    select('stage', stage === 'new' ? ['contacted', 'lost'] : ['lost'])}
                  {selected === 'appointment' && (
                    <>
                      {input('startsAt', 'datetime-local')}
                      {input('timezone', 'text', Intl.DateTimeFormat().resolvedOptions().timeZone)}
                      {select('channel', ['visit', 'phone', 'video'])}
                    </>
                  )}
                  {selected === 'demo' &&
                    select('outcome', [
                      'customer_agreed',
                      'purchase_intent_confirmed',
                      'quote_requested',
                      'order_started',
                      'followup_required',
                      'no_sale',
                      'referral_generated',
                      'recruitment_interest',
                      'other',
                    ])}
                  {selected === 'quote' && (
                    <>
                      {input('product')}
                      {input('amount', 'text', '0.00')}
                      {input('currency', 'text', 'USD')}
                    </>
                  )}
                  {selected === 'reconcile_mock' &&
                    select('result', ['approved', 'conflict', 'rejected_or_cancelled'])}
                  {selected === 'entry' && (
                    <>
                      {select('kind', ['note', 'task', 'objection', 'commitment'])}
                      <label>
                        {label('text')}
                        <textarea name="text" required maxLength={1000} />
                      </label>
                      {input('dueAt', 'datetime-local', '', false)}
                    </>
                  )}
                  {selected === 'complete_task' && (
                    <label>
                      {label('task')}
                      <select name="entryId">
                        {detail.entries
                          .filter((e) => e.kind === 'task' && !e.completedAt)
                          .map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.text}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  {selected === 'edit_person' && input('displayName', 'text', detail.row.name)}
                  {selected === 'edit_contact' && (
                    <>
                      {input('email', 'email', detail.contact?.email ?? '', false)}
                      {input('phone', 'tel', detail.contact?.phone ?? '', false)}
                    </>
                  )}
                  {selected === 'add_collaborator' && (
                    <>
                      {input('userId')}
                      {select('access', ['read', 'update'])}
                      {input('until', 'datetime-local')}
                    </>
                  )}
                  {selected === 'remove_collaborator' && (
                    <label>
                      {label('collaborators')}
                      <select name="userId">
                        {detail.collaborators.map((collaborator) => (
                          <option key={collaborator.userId} value={collaborator.userId}>
                            {collaborator.userId} · {label(collaborator.access)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {selected === 'activity' && (
                    <>
                      {select('kind', ['call', 'message'])}
                      {input('occurredAt', 'datetime-local')}
                      <label>
                        {label('summary')}
                        <textarea name="summary" required maxLength={1000} />
                      </label>
                    </>
                  )}
                  {selected === 'set_referral' && input('referrerPersonId')}
                  {['submit_order', 'reconcile_mock', 'delivery', 'curation', 'stage'].includes(
                    selected,
                  ) && (
                    <label className="check">
                      <input type="checkbox" name="confirm" required />
                      {label('confirm')}
                    </label>
                  )}
                  <Button type="submit" variant="primary" disabled={busy || status === 409}>
                    {busy ? label('loading') : label('save')}
                  </Button>
                </form>
              </section>
            )}
            <section>
              <h3>{label('edit_contact')}</h3>
              {detail.row.canContact && detail.contact ? (
                <>
                  <p>
                    {label('email')}: {detail.contact.email ?? '—'}
                  </p>
                  <p>
                    {label('phone')}: {detail.contact.phone ?? '—'}
                  </p>
                </>
              ) : (
                <p>{label('noContact')}</p>
              )}
            </section>
            {detail.order && (
              <section>
                <h3>{label('submit_order')}</h3>
                <p>{label(detail.order.simulatedStatus ?? detail.order.status)}</p>
              </section>
            )}
            <section>
              <h3>{label('collaborators')}</h3>
              {detail.collaborators.length === 0 ? (
                <p>{label('noData')}</p>
              ) : (
                detail.collaborators.map((collaborator) => (
                  <p key={collaborator.userId}>
                    {collaborator.userId} · {label(collaborator.access)} ·{' '}
                    <time dateTime={collaborator.until}>
                      {new Date(collaborator.until).toLocaleString(locale)}
                    </time>
                  </p>
                ))
              )}
            </section>
            {detail.row.source === 'referral' && (
              <section>
                <h3>{label('referrer')}</h3>
                <p>{detail.referrer?.name ?? label('noData')}</p>
              </section>
            )}
            <section>
              <h3>{label('history')}</h3>
              <p>{label('recent')}</p>
              {detail.entries.length +
                detail.appointments.length +
                detail.demos.length +
                detail.quotes.length +
                detail.timeline.length ===
                0 && <p>{label('noData')}</p>}
              {detail.appointments.map((a) => (
                <p key={a.id}>
                  {label('appointment')} ·{' '}
                  {new Date(a.startsAt).toLocaleString(locale, { timeZone: a.timezone })} ·{' '}
                  {a.timezone} · {label(a.channel)}
                </p>
              ))}
              {detail.demos.map((d) => (
                <p key={d.id}>
                  {label('demo')} · {label(d.outcome)}
                </p>
              ))}
              {detail.quotes.map((q) => (
                <p key={q.id}>
                  {label('quote')} #{q.revision} · {q.product} · {q.amount} {q.currency}
                </p>
              ))}
              {detail.entries.map((e) => (
                <p key={e.id}>
                  {label(e.kind)} · {e.text} {e.dueAt && new Date(e.dueAt).toLocaleString(locale)}{' '}
                  {e.completedAt && '✓'}
                </p>
              ))}
              <ol>
                {detail.timeline.map((event) => (
                  <li key={event.id}>
                    {label(event.action)} · {label(event.source)} · {label(event.authority)}
                    {event.summary && <> · {event.summary}</>}
                    <br />
                    <time dateTime={event.occurredAt}>
                      {new Date(event.occurredAt).toLocaleString(locale)}
                    </time>
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
