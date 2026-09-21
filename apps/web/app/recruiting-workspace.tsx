'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Columns3,
  FlaskConical,
  LayoutList,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  SlidersHorizontal,
  UserSearch,
  Users,
} from 'lucide-react';
import type { RecruitmentProfileRow, RecruitingStage } from '@rpt/contracts/recruiting';
import { Button, Panel, State } from '@rpt/ui';
import { type Locale } from './catalog';
import { recruitingCatalogs } from './recruiting-catalog';
import { RecruitingDrawer } from './recruiting-drawer';
import { RecruitingKanban, recruitingStages } from './recruiting-kanban';
import { RecruitingHttpError, recruitingRequest, useRecruitingData } from './use-recruiting-data';

const sources = ['manual', 'import', 'referral', 'event', 'telemarketing'];
const substatuses = [
  'data_validated',
  'first_contact_pending',
  'contacted',
  'no_answer',
  'interest_qualified',
  'interview_scheduled',
  'confirmed',
  'no_show',
  'attended',
  'evaluation_pending',
  'evaluated',
  'nurture',
  'not_interested',
  'onboarding_started',
  'training_pending',
  'activated',
  'withdrawn',
];

export function RecruitingWorkspace({ initialTheme = 'system' }: { initialTheme?: string }) {
  const [locale, setLocale] = useState<Locale>('es');
  const t = recruitingCatalogs[locale];
  const label = (key: string) => t[key] ?? key.replaceAll('_', ' ');
  const [theme, setTheme] = useState(initialTheme);
  const [collapsed, setCollapsed] = useState(false);
  const [mode, setMode] = useState<'table' | 'kanban'>('table');
  const [view, setView] = useState<'all' | 'mine' | 'due'>('all');
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState('all');
  const [source, setSource] = useState('all');
  const [substatus, setSubstatus] = useState('all');
  const [priority, setPriority] = useState('all');
  const [activity, setActivity] = useState('all');
  const [page, setPage] = useState(0);
  const [detailId, setDetailId] = useState<string>();
  const [filterOpen, setFilterOpen] = useState(false);
  const [sessionCode, setSessionCode] = useState('');
  const [feedback, setFeedback] = useState('');
  const [kanbanRevision, setKanbanRevision] = useState(0);
  const configObject = useMemo(
    () => ({
      query,
      owner: view === 'mine' ? 'mine' : 'all',
      stage,
      source,
      substatus,
      priority,
      activity: view === 'due' ? 'due' : activity,
      page,
    }),
    [query, view, stage, source, substatus, priority, activity, page],
  );
  const config = useMemo(() => JSON.stringify(configObject), [configObject]);
  const remote = useRecruitingData(config);
  const rows = remote.snapshot?.data.rows ?? [];
  const total = remote.snapshot?.data.total ?? 0;
  const maxPage = Math.max(0, Math.ceil(total / 20) - 1);
  const hasFilters = Boolean(
    query ||
    stage !== 'all' ||
    source !== 'all' ||
    substatus !== 'all' ||
    priority !== 'all' ||
    activity !== 'all' ||
    view !== 'all',
  );
  const status = remote.error?.status ?? (remote.snapshot ? 200 : 0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    try {
      const settings = JSON.parse(localStorage.getItem('rpt.preferences') ?? '{}') as {
        collapsed?: unknown;
      };
      if (typeof settings.collapsed === 'boolean') setCollapsed(settings.collapsed);
    } catch {
      /* preferences are optional */
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
  function clear() {
    setQuery('');
    setStage('all');
    setSource('all');
    setSubstatus('all');
    setPriority('all');
    setActivity('all');
    setView('all');
    setPage(0);
  }
  function changed() {
    remote.refresh();
    setKanbanRevision((value) => value + 1);
  }
  function drawerChanged() {
    // The drawer re-fetches its own aggregate after every command. Delay the
    // parent list refresh until close so rapid, valid follow-up actions cannot
    // fan out redundant list queries.
    setKanbanRevision((value) => value + 1);
  }
  async function advance(row: RecruitmentProfileRow, next: RecruitingStage) {
    setFeedback('');
    try {
      await recruitingRequest(`profiles/${row.id}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          schemaVersion: 1,
          expectedVersion: row.version,
          command: { type: 'stage', stage: next },
        }),
      });
      setFeedback(label('success'));
      changed();
    } catch (reason) {
      const code = reason instanceof RecruitingHttpError ? reason.status : 503;
      setFeedback(
        code === 409 ? label('conflict') : code === 403 ? label('forbidden') : label('unavailable'),
      );
      changed();
    }
  }
  const date = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: 'medium',
          timeZone: 'America/Guayaquil',
        }).format(new Date(value))
      : '—';
  const filters = (
    <>
      <label>
        {label('owner')}
        <select
          value={view}
          onChange={(event) => {
            setView(event.target.value as 'all' | 'mine' | 'due');
            setPage(0);
          }}
        >
          <option value="all">{label('all')}</option>
          <option value="mine">{label('mine')}</option>
          <option value="due">{label('due')}</option>
        </select>
      </label>
      <label>
        {label('stage')}
        <select
          value={stage}
          onChange={(event) => {
            setStage(event.target.value);
            setPage(0);
          }}
        >
          <option value="all">{label('all')}</option>
          {recruitingStages.map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {label('source')}
        <select
          value={source}
          onChange={(event) => {
            setSource(event.target.value);
            setPage(0);
          }}
        >
          <option value="all">{label('all')}</option>
          {sources.map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {label('priority')}
        <select
          value={priority}
          onChange={(event) => {
            setPriority(event.target.value);
            setPage(0);
          }}
        >
          <option value="all">{label('all')}</option>
          {['A', 'B', 'C'].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <label>
        {label('substatus')}
        <select
          value={substatus}
          onChange={(event) => {
            setSubstatus(event.target.value);
            setPage(0);
          }}
        >
          <option value="all">{label('all')}</option>
          {substatuses.map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {label('activity')}
        <select
          value={activity}
          onChange={(event) => {
            setActivity(event.target.value);
            setPage(0);
          }}
        >
          <option value="all">{label('all')}</option>
          <option value="due">{label('due')}</option>
          <option value="upcoming">{label('upcoming')}</option>
          <option value="none">{label('none')}</option>
        </select>
      </label>
      <Button variant="ghost" onClick={clear}>
        {label('clear')}
      </Button>
    </>
  );

  return (
    <div className={`shell recruiting-shell ${collapsed ? 'collapsed' : ''}`}>
      <a className="skip" href="#main">
        {label('workspace')}
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
        <span className="section-label">CRM</span>
        <nav aria-label="CRM">
          <a href="/crm/commercial">
            <Users size={20} />
            <span>{label('commercial')}</span>
          </a>
          <a className="active" href="/crm/recruiting" aria-current="page">
            <UserSearch size={20} />
            <span>{label('recruiting')}</span>
          </a>
        </nav>
        <div className="sidebar-bottom">
          <p>
            JAVARIEL Corp<small>{label('recruiting')}</small>
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
            <span className="top-label"> / {label('recruiting')}</span>
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
              RC
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
          </header>
          <div className="viewbar">
            <nav aria-label={label('owner')}>
              {(['all', 'mine', 'due'] as const).map((value) => (
                <button
                  key={value}
                  className={view === value ? 'selected-view' : ''}
                  aria-pressed={view === value}
                  onClick={() => {
                    setView(value);
                    setPage(0);
                  }}
                >
                  {label(value)}
                  {value === 'all' && <span className="count">{total}</span>}
                </button>
              ))}
            </nav>
            <div className="mode-toggle" role="group" aria-label={label('workspace')}>
              <Button aria-pressed={mode === 'table'} onClick={() => setMode('table')}>
                <LayoutList size={16} />
                {label('list')}
              </Button>
              <Button aria-pressed={mode === 'kanban'} onClick={() => setMode('kanban')}>
                <Columns3 size={16} />
                {label('kanban')}
              </Button>
            </div>
          </div>
          <div className="filterbar">
            <label className="search">
              <span className="sr-only">{label('search')}</span>
              <Search size={18} />
              <input
                aria-label={label('search')}
                maxLength={100}
                value={query}
                placeholder={label('search')}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </label>
            <div className="desktop-filters recruiting-filters">{filters}</div>
            <Button className="mobile-filters" onClick={() => setFilterOpen(true)}>
              <SlidersHorizontal size={18} />
              {label('filters')}
            </Button>
          </div>
          <div className="list-meta">
            <span>
              <strong>{status === 200 ? total : '—'}</strong> {label('records')}
            </span>
            <span>{label('sourceNote')}</span>
          </div>
          <p className="feedback" role="status" aria-live="polite">
            {feedback}
          </p>
          {status === 0 ? (
            <section className="skeleton" aria-busy="true" aria-label={label('loading')}>
              {Array.from({ length: 8 }, (_, index) => (
                <div key={index} />
              ))}
            </section>
          ) : status !== 200 ? (
            <State
              role="alert"
              title={
                status === 401
                  ? label('unauthenticated')
                  : status === 403
                    ? label('forbidden')
                    : label('unavailable')
              }
              detail={status === 403 ? label('forbiddenDetail') : label('unavailable')}
            >
              {status === 401 ? (
                <form
                  className="session-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void recruitingRequest('session', {
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
          ) : total === 0 ? (
            <State
              title={hasFilters ? label('noResults') : label('empty')}
              detail={hasFilters ? label('noResults') : label('empty')}
            >
              <Button onClick={hasFilters ? clear : remote.refresh}>
                {hasFilters ? label('clear') : label('retry')}
              </Button>
            </State>
          ) : mode === 'kanban' && remote.snapshot ? (
            <RecruitingKanban
              config={{ ...configObject, page: 0, stage: 'all' }}
              workspaceId={remote.snapshot.context.workspace.id}
              revision={kanbanRevision}
              label={label}
              onOpen={setDetailId}
              onAdvance={(row, next) => {
                void advance(row, next);
              }}
            />
          ) : (
            <RecruitingList rows={rows} label={label} date={date} onOpen={setDetailId} />
          )}
          {status === 200 && mode === 'table' && total > 0 && (
            <nav className="pagination" aria-label="Pagination">
              <span>
                {page + 1} / {maxPage + 1}
              </span>
              <div>
                <Button
                  aria-label={label('previous')}
                  disabled={page === 0}
                  onClick={() => setPage((value) => value - 1)}
                >
                  <ChevronLeft size={18} />
                </Button>
                <Button
                  aria-label={label('nextPage')}
                  disabled={page >= maxPage}
                  onClick={() => setPage((value) => value + 1)}
                >
                  <ChevronRight size={18} />
                </Button>
              </div>
            </nav>
          )}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="CRM">
        <button
          aria-current={mode === 'table' ? 'page' : undefined}
          onClick={() => setMode('table')}
        >
          <LayoutList size={20} />
          {label('list')}
        </button>
        <button
          aria-current={mode === 'kanban' ? 'page' : undefined}
          onClick={() => setMode('kanban')}
        >
          <Columns3 size={20} />
          {label('kanban')}
        </button>
      </nav>
      {filterOpen && (
        <Panel
          kind="sheet"
          title={label('filters')}
          closeLabel={label('close')}
          onClose={() => setFilterOpen(false)}
        >
          <div className="filter-fields">{filters}</div>
        </Panel>
      )}
      {detailId && remote.snapshot && (
        <RecruitingDrawer
          id={detailId}
          context={remote.snapshot.context}
          label={label}
          locale={locale}
          onClose={() => {
            setDetailId(undefined);
            remote.refresh();
          }}
          onChanged={drawerChanged}
        />
      )}
    </div>
  );
}

function RecruitingList({
  rows,
  label,
  date,
  onOpen,
}: {
  rows: RecruitmentProfileRow[];
  label: (key: string) => string;
  date: (value: string | null) => string;
  onOpen: (id: string) => void;
}) {
  return (
    <>
      <div className="data-surface">
        <table>
          <caption className="sr-only">{label('title')}</caption>
          <thead>
            <tr>
              <th scope="col">{label('person')}</th>
              <th scope="col">{label('owner')}</th>
              <th scope="col">{label('source')}</th>
              <th scope="col">{label('stage')}</th>
              <th scope="col">{label('substatus')}</th>
              <th scope="col">{label('priority')}</th>
              <th scope="col">{label('next')}</th>
              <th scope="col">{label('updated')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <button
                    className="person"
                    data-focus-return={row.id}
                    onClick={() => onOpen(row.id)}
                  >
                    <span className="initials">
                      {row.displayName
                        .split(' ')
                        .slice(0, 2)
                        .map((part) => part[0])
                        .join('')}
                    </span>
                    <span>{row.displayName}</span>
                    <ChevronRight size={14} />
                  </button>
                </td>
                <td>{label(row.ownerLabel)}</td>
                <td>{label(row.source)}</td>
                <td>
                  <span className={`badge stage-${row.stage}`}>{label(row.stage)}</span>
                </td>
                <td>{row.substatus ? label(row.substatus) : '—'}</td>
                <td>
                  <strong>{row.priority ?? '—'}</strong>
                </td>
                <td>
                  {row.nextAction ?? '—'}
                  <small className="data secondary"> {date(row.nextAt)}</small>
                </td>
                <td className="data">{date(row.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mobile-list">
        {rows.map((row) => (
          <article key={row.id}>
            <button data-focus-return={row.id} onClick={() => onOpen(row.id)}>
              <span>
                <strong>{row.displayName}</strong>
                <span>
                  {label(row.stage)} · {label('priority')} {row.priority ?? '—'}
                </span>
                <span>
                  {row.nextAction ?? label('none')} · {date(row.nextAt)}
                </span>
              </span>
              <ChevronRight size={20} />
            </button>
          </article>
        ))}
      </div>
    </>
  );
}
