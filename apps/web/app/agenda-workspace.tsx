'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  List,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  SlidersHorizontal,
  UserSearch,
  Users,
} from 'lucide-react';
import type { AgendaCreate, AgendaItem } from '@rpt/contracts';
import { Button, Panel, State } from '@rpt/ui';
import { type Locale } from './catalog';
import { agendaCatalogs } from './agenda-catalog';
import { AgendaDrawer } from './agenda-drawer';
import { rangeFor, zonedInstant } from './agenda-time';
import { AgendaHttpError, agendaRequest, useAgendaData } from './use-agenda-data';

type View = 'today' | 'day' | 'week' | 'list';
const isoDay = (date = new Date()) => date.toISOString().slice(0, 10);

export function AgendaWorkspace({ initialTheme = 'system' }: { initialTheme?: string }) {
  const [locale, setLocale] = useState<Locale>('es');
  const t = agendaCatalogs[locale];
  const label = (key: string) => t[key] ?? key.replaceAll('_', ' ');
  const [theme, setTheme] = useState(initialTheme);
  const [collapsed, setCollapsed] = useState(false);
  const [view, setView] = useState<View>('today');
  const [anchor, setAnchor] = useState(isoDay());
  const [mine, setMine] = useState(true);
  const [type, setType] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [detailId, setDetailId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [filters, setFilters] = useState(false);
  const [sessionCode, setSessionCode] = useState('');
  const [feedback, setFeedback] = useState('');
  const [agendaTimezone, setAgendaTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const range = useMemo(
    () => rangeFor(anchor, view, agendaTimezone),
    [anchor, view, agendaTimezone],
  );
  const config = useMemo(
    () =>
      JSON.stringify({
        ...range,
        ...(mine ? { owner: 'mine' } : {}),
        ...(type !== 'all' ? { type } : {}),
        ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
        limit: 200,
      }),
    [range, mine, type, statusFilter],
  );
  const remote = useAgendaData(config);
  const items = remote.data?.rows ?? [];
  const httpStatus = remote.error?.status ?? (remote.data ? 200 : 0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    if (remote.timezone) setAgendaTimezone(remote.timezone);
  }, [remote.timezone]);
  useEffect(() => {
    try {
      const value = JSON.parse(localStorage.getItem('rpt.preferences') ?? '{}') as {
        collapsed?: unknown;
      };
      if (typeof value.collapsed === 'boolean') setCollapsed(value.collapsed);
    } catch {
      /* optional */
    }
  }, []);
  function preference(nextTheme: string, nextCollapsed: boolean) {
    setTheme(nextTheme);
    setCollapsed(nextCollapsed);
    document.cookie = `rpt.theme=${nextTheme}; Path=/; SameSite=Lax; Max-Age=31536000`;
    try {
      localStorage.setItem('rpt.preferences', JSON.stringify({ collapsed: nextCollapsed }));
    } catch {
      /* optional */
    }
  }
  function move(direction: number) {
    const date = new Date(`${anchor}T00:00:00Z`);
    date.setUTCDate(
      date.getUTCDate() + direction * (view === 'week' ? 7 : view === 'list' ? 31 : 1),
    );
    setAnchor(date.toISOString().slice(0, 10));
  }
  const filterFields = (
    <>
      <label>
        {label('mine')}
        <select
          value={mine ? 'mine' : 'all'}
          onChange={(event) => setMine(event.target.value === 'mine')}
        >
          <option value="mine">{label('mine')}</option>
          <option value="all">{label('all')}</option>
        </select>
      </label>
      <label>
        {label('type')}
        <select value={type} onChange={(event) => setType(event.target.value)}>
          <option value="all">{label('all')}</option>
          <option value="appointment">{label('appointment')}</option>
          <option value="task">{label('task')}</option>
        </select>
      </label>
      <label>
        {label('status')}
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="all">{label('all')}</option>
          {['scheduled', 'open', 'completed', 'cancelled'].map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </select>
      </label>
      <Button
        variant="ghost"
        onClick={() => {
          setMine(true);
          setType('all');
          setStatusFilter('all');
        }}
      >
        {label('clear')}
      </Button>
    </>
  );
  return (
    <div className={`shell agenda-shell ${collapsed ? 'collapsed' : ''}`}>
      <a className="skip" href="#main">
        {label('agenda')}
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
          <a className="active" href="/agenda" aria-current="page">
            <CalendarDays size={20} />
            <span>{label('agenda')}</span>
          </a>
        </nav>
        <div className="sidebar-bottom">
          <p>
            JAVARIEL Corp<small>{label('agenda')}</small>
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
            <span className="top-label"> / {label('agenda')}</span>
          </div>
          <div className="preferences">
            <label>
              <span className="sr-only">{label('locale')}</span>
              <select
                aria-label={label('locale')}
                value={locale}
                onChange={(event) => setLocale(event.target.value as Locale)}
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
                onChange={(event) => preference(event.target.value, collapsed)}
              >
                <option value="system">{label('system')}</option>
                <option value="light">{label('light')}</option>
                <option value="dark">{label('dark')}</option>
              </select>
            </label>
            <span className="avatar" aria-label={label('connected')}>
              AG
            </span>
          </div>
        </header>
        <main id="main">
          <div className="fixture-label">
            <FlaskConical size={16} />
            {label('connected')}
          </div>
          <header className="page-header">
            <div>
              <h1>{label('title')}</h1>
              <p>{label('subtitle')}</p>
            </div>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={18} />
              {label('create')}
            </Button>
          </header>
          <div className="agenda-toolbar">
            <div className="agenda-range">
              <Button aria-label={label('previous')} onClick={() => move(-1)}>
                <ChevronLeft size={18} />
              </Button>
              <label>
                <span className="sr-only">{label('date')}</span>
                <input
                  aria-label={label('date')}
                  type="date"
                  value={anchor}
                  onChange={(event) => setAnchor(event.target.value)}
                />
              </label>
              <Button aria-label={label('next')} onClick={() => move(1)}>
                <ChevronRight size={18} />
              </Button>
            </div>
            <div className="agenda-views" role="group" aria-label={label('agenda')}>
              {(['today', 'day', 'week', 'list'] as View[]).map((value) => (
                <Button
                  key={value}
                  aria-pressed={view === value}
                  onClick={() => {
                    setView(value);
                    if (value === 'today') setAnchor(isoDay());
                  }}
                >
                  {label(value)}
                </Button>
              ))}
            </div>
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
              <strong>{httpStatus === 200 ? items.length : '—'}</strong> {label('records')}
            </span>
            <span>
              {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
                new Date(range.from),
              )}{' '}
              –{' '}
              {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
                new Date(Date.parse(range.to) - 1),
              )}
            </span>
          </div>
          <p className="feedback" role="status" aria-live="polite">
            {feedback}
          </p>
          {httpStatus === 0 ? (
            <section className="skeleton" aria-busy="true" aria-label={label('loading')}>
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} />
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
                  onSubmit={(event) => {
                    event.preventDefault();
                    void agendaRequest('session', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ code: sessionCode }),
                    })
                      .then(() => {
                        setSessionCode('');
                        remote.refresh();
                      })
                      .catch(() => setFeedback(label('unavailable')));
                  }}
                >
                  <label>
                    {label('sessionCode')}
                    <input
                      type="password"
                      autoComplete="off"
                      required
                      value={sessionCode}
                      onChange={(event) => setSessionCode(event.target.value)}
                    />
                  </label>
                  <Button type="submit" variant="primary">
                    {label('signIn')}
                  </Button>
                </form>
              ) : (
                <Button onClick={remote.refresh}>{label('retry')}</Button>
              )}
            </State>
          ) : items.length === 0 ? (
            <State
              title={
                type !== 'all' || statusFilter !== 'all' || !mine
                  ? label('noResults')
                  : label('empty')
              }
              detail={
                type !== 'all' || statusFilter !== 'all' || !mine
                  ? label('noResults')
                  : label('empty')
              }
            >
              <Button onClick={remote.refresh}>{label('retry')}</Button>
            </State>
          ) : view === 'week' ? (
            <Week items={items} anchor={anchor} locale={locale} label={label} open={setDetailId} />
          ) : (
            <AgendaList items={items} locale={locale} label={label} open={setDetailId} />
          )}
        </main>
      </div>
      <nav className="mobile-nav" aria-label={label('agenda')}>
        <button
          aria-current={view === 'today' ? 'page' : undefined}
          onClick={() => {
            setView('today');
            setAnchor(isoDay());
          }}
        >
          <CalendarDays size={20} />
          {label('today')}
        </button>
        <button aria-current={view === 'list' ? 'page' : undefined} onClick={() => setView('list')}>
          <List size={20} />
          {label('list')}
        </button>
        <button onClick={() => setCreating(true)}>
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
        <CreateAgenda
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
        <AgendaDrawer
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

function AgendaList({
  items,
  locale,
  label,
  open,
}: {
  items: AgendaItem[];
  locale: string;
  label: (key: string) => string;
  open: (id: string) => void;
}) {
  const date = (item: AgendaItem) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: item.timezone,
    }).format(new Date(item.startsAt ?? item.dueAt!));
  return (
    <div className="agenda-list" role="list">
      {items.map((item) => (
        <article key={item.id} role="listitem">
          <button data-focus-return={item.id} onClick={() => open(item.id)}>
            <span className={`agenda-type ${item.type}`}>{label(item.type)}</span>
            <span className="agenda-item-main">
              <strong>{item.title}</strong>
              <span>
                {date(item)} · {item.timezone}
              </span>
              <span>
                {label(item.source)} · {label(item.confirmationState ?? item.status)}
              </span>
            </span>
            <ChevronRight size={18} />
          </button>
        </article>
      ))}
    </div>
  );
}

function Week({
  items,
  anchor,
  locale,
  label,
  open,
}: {
  items: AgendaItem[];
  anchor: string;
  locale: string;
  label: (key: string) => string;
  open: (id: string) => void;
}) {
  const start = new Date(`${anchor}T00:00:00Z`);
  const weekday = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - weekday + 1);
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() + index);
    return day;
  });
  return (
    <div className="agenda-week">
      {days.map((day) => {
        const key = day.toISOString().slice(0, 10);
        const rows = items.filter((item) => localInputDay(item) === key);
        return (
          <section key={key}>
            <header>
              <strong>
                {new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(day)}
              </strong>
              <span>{day.getUTCDate()}</span>
            </header>
            <div>
              {rows.map((item) => (
                <button
                  key={item.id}
                  data-focus-return={item.id}
                  className={item.type}
                  onClick={() => open(item.id)}
                >
                  <strong>{item.title}</strong>
                  <span>
                    {new Intl.DateTimeFormat(locale, {
                      hour: '2-digit',
                      minute: '2-digit',
                      timeZone: item.timezone,
                    }).format(new Date(item.startsAt ?? item.dueAt!))}
                  </span>
                  <small>{label(item.source)}</small>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
function localInputDay(item: AgendaItem) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: item.timezone,
  }).formatToParts(new Date(item.startsAt ?? item.dueAt!));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function CreateAgenda({
  workspaceId,
  label,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  label: (key: string) => string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [kind, setKind] = useState<'appointment' | 'task'>('appointment');
  const [error, setError] = useState('');
  const defaultStart = `${isoDay()}T10:00`;
  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const timezone = String(data.get('timezone'));
    const start = zonedInstant(String(data.get('start')), timezone);
    const end = zonedInstant(String(data.get('end')), timezone);
    const recurrence =
      data.get('recurrence') === 'none'
        ? null
        : {
            frequency: data.get('recurrence') as 'daily' | 'weekly',
            interval: 1,
            weekdays:
              data.get('recurrence') === 'weekly'
                ? [new Date(`${String(data.get('start')).slice(0, 10)}T00:00:00Z`).getUTCDay() || 7]
                : [],
            until: zonedInstant(`${String(data.get('until'))}T23:59`, timezone),
          };
    const common = {
      schemaVersion: 1 as const,
      workspaceId,
      title: String(data.get('title')),
      summary: String(data.get('summary')) || null,
      timezone,
      source: 'manual' as const,
      personId: null,
      opportunityId: null,
      recruitmentProfileId: null,
      recurrence,
      reminderMinutesBefore: data.getAll('reminder').map(Number),
      travel: {
        originLabel: String(data.get('origin')) || null,
        destinationLabel: String(data.get('destination')) || null,
        estimatedTravelMinutes: Number(data.get('travel')) || null,
        preparationMinutes: Number(data.get('preparation')) || null,
      },
    };
    const input: AgendaCreate =
      kind === 'appointment'
        ? { ...common, type: 'appointment', startsAt: start, endsAt: end }
        : {
            ...common,
            type: 'task',
            dueAt: start,
            priority: String(data.get('priority')) as 'low' | 'normal' | 'high',
          };
    try {
      const result = await agendaRequest<{ id: string }>('items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(input),
      });
      onCreated(result.id);
    } catch (reason) {
      setError(
        reason instanceof AgendaHttpError && reason.status === 403
          ? label('forbidden')
          : label('invalid'),
      );
    }
  }
  return (
    <Panel kind="dialog" title={label('create')} closeLabel={label('close')} onClose={onClose}>
      <form
        className="agenda-create"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(event.currentTarget).catch(() => setError(label('invalidTime')));
        }}
      >
        <div className="mode-toggle" role="group" aria-label={label('type')}>
          <Button aria-pressed={kind === 'appointment'} onClick={() => setKind('appointment')}>
            {label('appointment')}
          </Button>
          <Button aria-pressed={kind === 'task'} onClick={() => setKind('task')}>
            {label('task')}
          </Button>
        </div>
        {error && (
          <p role="alert" className="banner">
            {error}
          </p>
        )}
        <label>
          {label('titleField')}
          <input name="title" required maxLength={200} />
        </label>
        <label>
          {label('summary')}
          <textarea name="summary" maxLength={1000} />
        </label>
        <label>
          {kind === 'appointment' ? label('startsAt') : label('dueAt')}
          <input name="start" type="datetime-local" defaultValue={defaultStart} required />
        </label>
        {kind === 'appointment' ? (
          <label>
            {label('endsAt')}
            <input name="end" type="datetime-local" defaultValue={`${isoDay()}T11:00`} required />
          </label>
        ) : (
          <input name="end" type="hidden" value={`${isoDay()}T11:00`} />
        )}
        <label>
          {label('timezone')}
          <input name="timezone" defaultValue="America/Guayaquil" required maxLength={64} />
        </label>
        {kind === 'task' && (
          <label>
            {label('priority')}
            <select name="priority" defaultValue="normal">
              {['low', 'normal', 'high'].map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          {label('recurrence')}
          <select name="recurrence" defaultValue="none">
            <option value="none">{label('none')}</option>
            <option value="daily">{label('daily')}</option>
            <option value="weekly">{label('weekly')}</option>
          </select>
        </label>
        <label>
          {label('until')}
          <input
            name="until"
            type="date"
            defaultValue={isoDay(new Date(Date.now() + 7 * 86400000))}
          />
        </label>
        <fieldset>
          <legend>{label('reminders')}</legend>
          {[15, 60, 1440].map((minute) => (
            <label className="check" key={minute}>
              <input name="reminder" type="checkbox" value={minute} />
              {label(`reminder${minute}`)}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>{label('travel')}</legend>
          <label>
            {label('origin')}
            <input name="origin" maxLength={200} />
          </label>
          <label>
            {label('destination')}
            <input name="destination" maxLength={300} />
          </label>
          <label>
            {label('travelMinutes')}
            <input name="travel" type="number" min="0" max="1440" />
          </label>
          <label>
            {label('preparationMinutes')}
            <input name="preparation" type="number" min="0" max="1440" />
          </label>
        </fieldset>
        <Button type="submit" variant="primary">
          {kind === 'appointment' ? label('createAppointment') : label('createTask')}
        </Button>
      </form>
    </Panel>
  );
}
