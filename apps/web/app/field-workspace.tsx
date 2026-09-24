'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  ChevronRight,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  SlidersHorizontal,
  UserSearch,
  Users,
} from 'lucide-react';
import type { FieldVisitItem, FieldVisitMutationResult } from '@rpt/contracts';
import { Button, Panel, State } from '@rpt/ui';
import type { Locale } from './catalog';
import { fieldCatalogs } from './field-catalog';
import { FieldHttpError, fieldRequest, useFieldData } from './field-data';
import { FieldDrawer } from './field-drawer';
import { localInput, zonedInstant } from './agenda-time';

const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export function FieldWorkspace({ initialTheme = 'system' }: { initialTheme?: string }) {
  const [locale, setLocale] = useState<Locale>('es');
  const t = fieldCatalogs[locale];
  const label = (key: keyof typeof t) => t[key];
  const [theme, setTheme] = useState(initialTheme);
  const [collapsed, setCollapsed] = useState(false);
  const [mode, setMode] = useState<'today' | 'upcoming'>('today');
  const [anchor, setAnchor] = useState(today());
  const [mine, setMine] = useState(true);
  const [status, setStatus] = useState('all');
  const [filters, setFilters] = useState(false);
  const [detailId, setDetailId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState('');
  const [feedback, setFeedback] = useState('');
  const [timezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const range = useMemo(() => {
    const start = new Date(`${anchor}T00:00:00Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + (mode === 'today' ? 1 : 31));
    return {
      from: zonedInstant(`${anchor}T00:00`, timezone),
      to: zonedInstant(`${end.toISOString().slice(0, 10)}T00:00`, timezone),
    };
  }, [anchor, mode, timezone]);
  const config = useMemo(
    () =>
      JSON.stringify({
        ...range,
        ...(mine ? { owner: 'mine' } : {}),
        ...(status !== 'all' ? { status } : {}),
        limit: 200,
      }),
    [range, mine, status],
  );
  const remote = useFieldData(config);
  const rows = remote.data?.rows ?? [];
  const httpStatus = remote.error?.status ?? (remote.data ? 200 : 0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    try {
      const value = JSON.parse(localStorage.getItem('rpt.preferences') ?? '{}') as {
        collapsed?: unknown;
      };
      if (typeof value.collapsed === 'boolean') setCollapsed(value.collapsed);
    } catch {
      /* optional preference */
    }
  }, []);
  function preference(nextTheme: string, nextCollapsed: boolean) {
    setTheme(nextTheme);
    setCollapsed(nextCollapsed);
    document.cookie = `rpt.theme=${nextTheme}; Path=/; SameSite=Lax; Max-Age=31536000`;
    try {
      localStorage.setItem('rpt.preferences', JSON.stringify({ collapsed: nextCollapsed }));
    } catch {
      /* optional preference */
    }
  }
  const filterFields = (
    <>
      <label>
        {label('mine')}
        <select value={mine ? 'mine' : 'all'} onChange={(e) => setMine(e.target.value === 'mine')}>
          <option value="mine">{label('mine')}</option>
          <option value="all">{label('all')}</option>
        </select>
      </label>
      <label>
        {label('status')}
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">{label('all')}</option>
          {(['planned', 'in_progress', 'completed', 'cancelled', 'no_show'] as const).map(
            (value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ),
          )}
        </select>
      </label>
      <Button
        variant="ghost"
        onClick={() => {
          setMine(true);
          setStatus('all');
        }}
      >
        {label('clear')}
      </Button>
    </>
  );
  return (
    <div className={`shell agenda-shell ${collapsed ? 'collapsed' : ''}`}>
      <a className="skip" href="#main">
        {label('field')}
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <img src="/rpt-symbol-color.svg" alt="" width="40" height="32" />
          </span>
          <span className="brand-word">
            RPT<small>PERFORMANCE TRACKER</small>
          </span>
        </div>
        <div className="sidebar-rule" />
        <span className="section-label">RPT</span>
        <nav aria-label="RPT">
          <a href="/crm/commercial">
            <Users size={20} />
            <span>{label('commercial')}</span>
          </a>
          <a href="/crm/recruiting">
            <UserSearch size={20} />
            <span>{label('recruiting')}</span>
          </a>
          <a href="/agenda">
            <CalendarDays size={20} />
            <span>{label('agenda')}</span>
          </a>
          <a className="active" href="/field" aria-current="page">
            <MapPin size={20} />
            <span>{label('field')}</span>
          </a>
        </nav>
        <div className="sidebar-bottom">
          <p>
            JAVARIEL Corp<small>{label('field')}</small>
          </p>
          <Button
            onClick={() => preference(theme, !collapsed)}
            aria-label={collapsed ? label('expand') : label('collapse')}
          >
            {collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          </Button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="scope">
            <span className="scope-dot" />
            {label('workspace')}
            <span className="top-label"> / {label('field')}</span>
          </div>
          <div className="preferences">
            <label>
              <span className="sr-only">{label('locale')}</span>
              <select
                aria-label={label('locale')}
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
              >
                <option value="es">ES</option>
                <option value="en">EN</option>
                <option value="fr">FR</option>
                <option value="pt">PT</option>
              </select>
            </label>
            <label>
              <span className="sr-only">{label('theme')}</span>
              <select
                aria-label={label('theme')}
                value={theme}
                onChange={(e) => preference(e.target.value, collapsed)}
              >
                <option value="system">{label('system')}</option>
                <option value="light">{label('light')}</option>
                <option value="dark">{label('dark')}</option>
              </select>
            </label>
            <span className="avatar" aria-label={label('connected')}>
              FS
            </span>
          </div>
        </header>
        <main id="main">
          <div className="fixture-label">
            <MapPin size={16} />
            {label('synthetic')}
          </div>
          <header className="page-header">
            <div>
              <h1>{label('title')}</h1>
              <p>{label('subtitle')}</p>
            </div>
            {remote.workspaceId && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={18} />
                {label('create')}
              </Button>
            )}
          </header>
          <div className="agenda-toolbar">
            <div className="agenda-views" role="group" aria-label={label('field')}>
              {(['today', 'upcoming'] as const).map((value) => (
                <Button
                  key={value}
                  aria-pressed={mode === value}
                  onClick={() => {
                    setMode(value);
                    if (value === 'today') setAnchor(today());
                  }}
                >
                  {label(value)}
                </Button>
              ))}
            </div>
            <label>
              {label('date')}
              <input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} />
            </label>
          </div>
          <div className="filterbar">
            <div className="desktop-filters agenda-filters">{filterFields}</div>
            <Button className="mobile-filters" onClick={() => setFilters(true)}>
              <SlidersHorizontal size={18} />
              {label('filters')}
            </Button>
          </div>
          <div className="list-meta">
            <span>
              <strong>{httpStatus === 200 ? rows.length : '—'}</strong> {label('records')}
            </span>
          </div>
          <p className="feedback" role="status" aria-live="polite">
            {feedback}
          </p>
          {httpStatus === 0 ? (
            <section className="skeleton" aria-busy="true" aria-label={label('loading')}>
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} />
              ))}
            </section>
          ) : httpStatus !== 200 ? (
            <State
              role="alert"
              title={
                httpStatus === 401
                  ? label('sessionCode')
                  : httpStatus === 403
                    ? label('forbidden')
                    : label('unavailable')
              }
              detail={httpStatus === 403 ? label('forbiddenDetail') : label('unavailable')}
            >
              {httpStatus === 401 ? (
                <form
                  className="session-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void fieldRequest('session', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ code }),
                    })
                      .then(() => {
                        setCode('');
                        remote.refresh();
                      })
                      .catch(() => setFeedback(label('unavailable')));
                  }}
                >
                  <label>
                    {label('sessionCode')}
                    <input
                      data-testid="field-session-code"
                      type="password"
                      autoComplete="off"
                      required
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                  </label>
                  <Button data-testid="field-session-submit" type="submit" variant="primary">
                    {label('signIn')}
                  </Button>
                </form>
              ) : (
                <Button onClick={remote.refresh}>{label('retry')}</Button>
              )}
            </State>
          ) : rows.length === 0 ? (
            <State
              title={status !== 'all' || !mine ? label('noResults') : label('empty')}
              detail={status !== 'all' || !mine ? label('noResults') : label('empty')}
            />
          ) : (
            <div className="agenda-list field-list" role="list">
              {rows.map((row) => (
                <VisitRow
                  key={row.id}
                  item={row}
                  locale={locale}
                  label={label}
                  open={setDetailId}
                />
              ))}
            </div>
          )}
        </main>
      </div>
      <nav className="mobile-nav" aria-label={label('field')}>
        <button
          onClick={() => {
            setMode('today');
            setAnchor(today());
          }}
          aria-current={mode === 'today' ? 'page' : undefined}
        >
          <MapPin size={20} />
          {label('today')}
        </button>
        <button
          onClick={() => setMode('upcoming')}
          aria-current={mode === 'upcoming' ? 'page' : undefined}
        >
          <CalendarDays size={20} />
          {label('upcoming')}
        </button>
        <button onClick={() => setCreating(true)} disabled={!remote.workspaceId}>
          <Plus size={20} />
          {label('create')}
        </button>
      </nav>
      {filters && (
        <Panel
          kind="sheet"
          title={label('filters')}
          closeLabel={label('close')}
          onClose={() => setFilters(false)}
        >
          <div className="filter-fields">{filterFields}</div>
        </Panel>
      )}
      {creating && remote.workspaceId && (
        <CreateVisit
          workspaceId={remote.workspaceId}
          label={label}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setFeedback(label('success'));
            remote.refresh();
            setDetailId(id);
          }}
        />
      )}
      {detailId && (
        <FieldDrawer
          id={detailId}
          locale={locale}
          label={label}
          onClose={() => setDetailId(undefined)}
          onChanged={remote.refresh}
        />
      )}
    </div>
  );
}

function VisitRow({
  item,
  locale,
  label,
  open,
}: {
  item: FieldVisitItem;
  locale: string;
  label: (key: keyof typeof fieldCatalogs.es) => string;
  open: (id: string) => void;
}) {
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(item.scheduledAt),
  );
  return (
    <article role="listitem">
      <button data-focus-return={item.id} onClick={() => open(item.id)}>
        <span className={`field-status ${item.status}`}>{label(item.status)}</span>
        <span className="agenda-item-main">
          <strong>{item.purpose}</strong>
          <span>{date}</span>
          <span>
            {label('status')}: {label(item.status)}
          </span>
        </span>
        <ChevronRight size={18} />
      </button>
    </article>
  );
}

function CreateVisit({
  workspaceId,
  label,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  label: (key: keyof typeof fieldCatalogs.es) => string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [scheduled, setScheduled] = useState(() =>
    localInput(new Date(Date.now() + 3_600_000).toISOString(), timezone),
  );
  return (
    <Panel kind="dialog" title={label('create')} closeLabel={label('close')} onClose={onClose}>
      <form
        className="agenda-create"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          const data = new FormData(e.currentTarget);
          let instant: string;
          try {
            instant = zonedInstant(scheduled, timezone);
          } catch {
            setError(label('invalidTime'));
            setBusy(false);
            return;
          }
          void fieldRequest<FieldVisitMutationResult>('visits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
            body: JSON.stringify({
              schemaVersion: 1,
              workspaceId,
              agendaItemId: data.get('appointment') || null,
              personId: null,
              opportunityId: null,
              scheduledAt: data.get('appointment') ? null : instant,
              purpose: data.get('purpose'),
            }),
          })
            .then((result) => onCreated(result.id))
            .catch((reason: unknown) =>
              setError(
                reason instanceof FieldHttpError && reason.status === 403
                  ? label('forbidden')
                  : label('invalid'),
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        {error && (
          <p role="alert" className="banner">
            {error}
          </p>
        )}
        <label>
          {label('purpose')}
          <input name="purpose" required maxLength={500} />
        </label>
        <label>
          {label('appointment')}
          <input name="appointment" type="text" autoComplete="off" />
        </label>
        <label>
          {label('schedule')}
          <input
            type="datetime-local"
            required
            value={scheduled}
            onChange={(e) => setScheduled(e.target.value)}
          />
        </label>
        <label>
          {label('timezone')}
          <input
            required
            maxLength={64}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
        </label>
        <Button variant="primary" type="submit" disabled={busy}>
          {label('create')}
        </Button>
      </form>
    </Panel>
  );
}
