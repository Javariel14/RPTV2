'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns3,
  FlaskConical,
  LayoutList,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
import { Button, Panel, State } from '@rpt/ui';
import { referenceContacts, type ReferenceContact, type Stage } from '@rpt/test-fixtures';
import { catalogs, type Locale } from './catalog';
import { crmCatalogs } from './crm-catalog';
import { crmRequest, useCrmData } from './use-crm-data';
import { CrmDrawer } from './crm-drawer';
import { CrmKanban } from './crm-kanban';
import { u4Labels } from './u4-catalog';
import type { CrmRow, CrmSavedView } from '@rpt/contracts';
type DisplayRow = Omit<ReferenceContact, 'stage' | 'source'> & {
  stage: ReferenceContact['stage'] | CrmRow['stage'];
  source: ReferenceContact['source'] | CrmRow['source'];
  nextAction?: string;
  updatedAt?: string;
  priority?: string;
};
type View = 'all' | 'mine' | 'due';
type Mode = 'table' | 'kanban';
type StateName =
  | 'ready'
  | 'loading'
  | 'empty'
  | 'permission'
  | '401'
  | '404'
  | '429'
  | '500'
  | '502'
  | '503'
  | '504'
  | 'offline'
  | 'degraded';
interface SavedView {
  label: string;
  query: string;
  stage: string;
  source: string;
  view: View;
  mode: Mode;
  compact: boolean;
  showSource: boolean;
  ascending: boolean;
}
const stages: Stage[] = ['new', 'appointment', 'demo', 'followup'];
export function ReferenceWorkspace({
  initialTheme = 'system',
  persistent = false,
}: {
  initialTheme?: string;
  persistent?: boolean;
}) {
  const [locale, setLocale] = useState<Locale>('es');
  const ct = crmCatalogs[locale];
  const t = { ...catalogs[locale], ...(persistent ? ct : {}) };
  const ut = u4Labels(locale) as Record<string, string>;
  const label = (value: string) => (t as Record<string, string>)[value] ?? ut[value] ?? value;
  const detailLabel = (value: string) =>
    value.startsWith('stage:') ? label(value.slice(6)) : (ut[value] ?? label(value));
  const [theme, setTheme] = useState(initialTheme);
  const [collapsed, setCollapsed] = useState(false);
  const [lab, setLab] = useState(false);
  const [localRows, setRows] = useState(() => (persistent ? [] : referenceContacts()));
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState('all');
  const [source, setSource] = useState('all');
  const [view, setView] = useState<View>('all');
  const [mode, setMode] = useState<Mode>('table');
  const [compact, setCompact] = useState(false);
  const [ascending, setAscending] = useState(true);
  const [showSource, setShowSource] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [detailId, setDetailId] = useState<string>();
  const [filterOpen, setFilterOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const [saved, setSaved] = useState<SavedView[]>([]);
  const [feedback, setFeedback] = useState('');
  const [localState, setState] = useState<StateName>('ready');
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState('all');
  const [priority, setPriority] = useState('all');
  const [activityFilter, setActivityFilter] = useState('all');
  const [visibility, setVisibility] = useState('private');
  const [recipients, setRecipients] = useState('');
  const [sessionCode, setSessionCode] = useState('');
  const [saving, setSaving] = useState(false);
  const saveAttempt = useRef<{ body: string; key: string } | null>(null);
  const [sort, setSort] = useState<'name' | 'updated' | 'due'>('name');
  const [extraColumns, setExtraColumns] = useState<string[]>(['owner', 'due']);
  const [saveError, setSaveError] = useState('');
  const config = {
    filters: {
      query,
      stage,
      source,
      owner: view === 'mine' ? 'mine' : 'all',
      activity: view === 'due' ? 'due' : activityFilter,
      status: statusFilter,
      priority,
    },
    sort,
    direction: ascending ? 'asc' : 'desc',
    columns: [...extraColumns, ...(showSource ? ['source'] : [])],
    density: compact ? 'compact' : 'comfortable',
    surface: mode,
  };
  const remote = useCrmData(persistent, JSON.stringify({ ...config, page }));
  const rows: DisplayRow[] = persistent
    ? (remote.snapshot?.data.rows ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        stage: r.stage,
        source: r.source,
        owner: r.ownerLabel === 'self' ? 'self' : 'delegated',
        due: r.nextAt ?? '',
        activity: 0,
        nextAction: r.nextAction,
        updatedAt: r.updatedAt,
        priority: r.priority,
      }))
    : localRows;
  const state: StateName = persistent
    ? remote.error
      ? remote.error.status === 403
        ? 'permission'
        : remote.error.status === 401
          ? '401'
          : (([404, 429, 500, 502, 503, 504].includes(remote.error.status)
              ? String(remote.error.status)
              : '503') as StateName)
      : remote.snapshot
        ? 'ready'
        : 'loading'
    : localState;
  const activeStages = persistent
    ? [
        'new',
        'contacted',
        'appointment',
        'demo',
        'proposal',
        'pending_approval',
        'won_simulated',
        'won',
        'lost',
      ]
    : stages;
  function applyRemoteView(saved: CrmSavedView) {
    const c = saved.config;
    setQuery(c.filters.query);
    setStage(c.filters.stage);
    setSource(c.filters.source);
    setView(c.filters.owner === 'mine' ? 'mine' : 'all');
    setActivityFilter(c.filters.activity);
    setStatusFilter(c.filters.status);
    setPriority(c.filters.priority);
    setMode(c.surface);
    setSort(c.sort);
    setExtraColumns(c.columns.filter((v) => v !== 'source'));
    setAscending(c.direction === 'asc');
    setCompact(c.density === 'compact');
    setShowSource(c.columns.includes('source'));
    setPage(0);
  }
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    try {
      const settings: unknown = JSON.parse(localStorage.getItem('rpt.preferences') ?? 'null');
      if (
        settings &&
        typeof settings === 'object' &&
        'collapsed' in settings &&
        typeof settings.collapsed === 'boolean'
      )
        setCollapsed(settings.collapsed);
    } catch {
      /* preferences are optional, never authentication */
    }
  }, []);
  function preference(nextTheme: string, nextCollapsed: boolean) {
    setTheme(nextTheme);
    setCollapsed(nextCollapsed);
    document.cookie = `rpt.theme=${nextTheme}; Path=/; SameSite=Lax; Max-Age=31536000`;
    try {
      localStorage.setItem('rpt.preferences', JSON.stringify({ collapsed: nextCollapsed }));
    } catch {
      /* storage unavailable */
    }
  }
  const filtered = useMemo(
    () =>
      persistent
        ? rows
        : rows
            .filter(
              (r) =>
                r.name.toLocaleLowerCase(locale).includes(query.toLocaleLowerCase(locale)) &&
                (stage === 'all' || r.stage === stage) &&
                (source === 'all' || r.source === source) &&
                (view !== 'mine' || r.owner === 'self') &&
                (view !== 'due' || r.stage === 'followup'),
            )
            .sort((a, b) => (ascending ? 1 : -1) * a.name.localeCompare(b.name, locale)),
    [rows, query, stage, source, view, ascending, locale, persistent],
  );
  const total = persistent ? (remote.snapshot?.data.total ?? 0) : filtered.length;
  const activeFilterCount = [
    query,
    stage !== 'all',
    source !== 'all',
    statusFilter !== 'all',
    priority !== 'all',
    activityFilter !== 'all',
    view !== 'all',
  ].filter(Boolean).length;
  const persistentEmpty = persistent && total === 0 && activeFilterCount === 0;
  const maxPage = Math.max(0, Math.ceil(total / 20) - 1);
  const currentPage = persistent ? page : Math.min(page, maxPage);
  const pageRows = persistent ? rows : filtered.slice(currentPage * 20, currentPage * 20 + 20);
  const detail = rows.find((r) => r.id === detailId);
  const visible = ['ready', 'offline', 'degraded'].includes(state);
  const date = (value: string) =>
    value
      ? new Intl.DateTimeFormat(locale, {
          day: 'numeric',
          month: 'short',
          timeZone: 'America/Guayaquil',
        }).format(new Date(value))
      : '—';
  const nextAction = (r: DisplayRow) =>
    persistent
      ? label(r.nextAction ?? '—')
      : r.stage === 'appointment'
        ? t.confirm
        : r.stage === 'new'
          ? t.contact
          : t.follow;
  function clear() {
    setQuery('');
    setSource('all');
    setStage('all');
    setStatusFilter('all');
    setPriority('all');
    setActivityFilter('all');
    if (persistent) setView('all');
    setPage(0);
  }
  function activity(ids: string[]) {
    if (persistent) return;
    setRows((prev) =>
      prev.map((r) => (ids.includes(r.id) ? { ...r, activity: r.activity + 1 } : r)),
    );
    setFeedback(t.localEvent);
  }
  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  }
  function changeState(value: StateName) {
    setState(value);
    setDetailId(undefined);
    setSelected([]);
  }
  function addExample() {
    if (persistent) return;
    const generated = referenceContacts(rows.length + 1);
    const row = generated.at(-1);
    if (row) {
      setRows([...localRows, row]);
      changeState('ready');
      clear();
      setView('all');
      setDetailId(row.id);
    }
  }
  const filters = (
    <>
      <label>
        {t.stage}
        <select
          value={stage}
          onChange={(e) => {
            setStage(e.target.value);
            setPage(0);
          }}
        >
          <option value="all">{t.all}</option>
          {activeStages.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.source}
        <select
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setPage(0);
          }}
        >
          <option value="all">{t.all}</option>
          <option value="referral">{t.referral}</option>
          <option value="event">{t.event}</option>
          {persistent && (
            <>
              <option value="manual">{ct.manual}</option>
              <option value="import">{ct.import}</option>
            </>
          )}
        </select>
      </label>
      <Button variant="ghost" onClick={clear}>
        {t.clear}
      </Button>
    </>
  );
  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''} ${compact ? 'compact' : ''}`}>
      <a className="skip" href="#main">
        {t.workspace}
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
        <span className="section-label">{persistent ? 'CRM' : 'FOUNDATION'}</span>
        <nav aria-label={t.workspace}>
          <button
            className={!lab ? 'active' : ''}
            onClick={() => setLab(false)}
            title={t.reference}
          >
            <Users size={20} />
            <span>{t.reference}</span>
          </button>
          {!persistent && (
            <button className={lab ? 'active' : ''} onClick={() => setLab(true)} title={t.lab}>
              <FlaskConical size={20} />
              <span>{t.lab}</span>
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <p>
            JAVARIEL Corp<small>{persistent ? ct.reference : 'Foundation / 0.1.0'}</small>
          </p>
          <Button
            onClick={() => preference(theme, !collapsed)}
            aria-label={collapsed ? t.expand : t.collapse}
          >
            {collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          </Button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="scope">
            <span className="scope-dot" />
            {t.workspace}
            <span className="top-label"> / {persistent ? 'CRM' : 'Foundation'}</span>
          </div>
          <div className="preferences">
            <label>
              <span className="sr-only">{t.language}</span>
              <select
                aria-label={t.language}
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
              <span className="sr-only">{t.theme}</span>
              <select
                aria-label={t.theme}
                value={theme}
                onChange={(e) => preference(e.target.value, collapsed)}
              >
                <option value="system">{t.system}</option>
                <option value="light">{t.light}</option>
                <option value="dark">{t.dark}</option>
              </select>
            </label>
            <span className="avatar" role="img" aria-label={t.fixture}>
              FP
            </span>
          </div>
        </header>
        <main id="main">
          <div className="fixture-label">
            <FlaskConical size={16} />
            {t.fixture}
          </div>
          <header className="page-header">
            <div>
              <h1>{lab ? t.labTitle : t.title}</h1>
              <p>{lab ? t.labDetail : t.subtitle}</p>
            </div>
            {!lab && !persistent && (
              <Button variant="primary" onClick={addExample}>
                <Plus size={18} />
                {t.create}
              </Button>
            )}
          </header>
          {lab ? (
            <section className="lab">
              <h2>{t.state}</h2>
              <div className="lab-controls">
                <label>
                  {t.state}
                  <select value={state} onChange={(e) => changeState(e.target.value as StateName)}>
                    {(
                      [
                        'ready',
                        'loading',
                        'empty',
                        'permission',
                        '401',
                        '404',
                        '429',
                        '500',
                        '502',
                        '503',
                        '504',
                        'offline',
                        'degraded',
                      ] as StateName[]
                    ).map((s) => (
                      <option key={s} value={s}>
                        {s === 'ready' ? t.ready : s}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t.volume}
                  <select
                    value={rows.length}
                    onChange={(e) => {
                      setRows(referenceContacts(Number(e.target.value)));
                      setSelected([]);
                      setPage(0);
                    }}
                  >
                    {[0, 1, 20, 1000].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <Button variant="primary" onClick={() => setLab(false)}>
                  {t.reference}
                  <ArrowUpRight size={18} />
                </Button>
              </div>
              <h2>Button</h2>
              <div className="lab-controls">
                <Button variant="primary">{t.save}</Button>
                <Button>{t.close}</Button>
                <Button disabled>{t.loading}</Button>
              </div>
              <h2>{t.details}</h2>
              <p>{t.examplesOnly}</p>
              <Button onClick={() => setFilterOpen(true)}>{t.filters}</Button>
              <State title={t.permission} detail={t.permissionDetail} />
            </section>
          ) : (
            <>
              <div className="viewbar">
                <nav aria-label={t.saveView}>
                  {(['all', 'mine', 'due'] as View[]).map((v) => (
                    <button
                      key={v}
                      className={view === v ? 'selected-view' : ''}
                      aria-pressed={view === v}
                      onClick={() => {
                        setView(v);
                        setPage(0);
                        setSelected([]);
                      }}
                    >
                      {t[v]}
                      {v === 'all' && (
                        <span className="count">{persistent ? total : rows.length}</span>
                      )}
                    </button>
                  ))}
                  {persistent &&
                    remote.snapshot?.views.map((s) => (
                      <button key={s.id} onClick={() => applyRemoteView(s)}>
                        {s.name}
                      </button>
                    ))}
                  {saved.map((s, i) => (
                    <button
                      key={`${s.label}-${i}`}
                      onClick={() => {
                        setQuery(s.query);
                        setStage(s.stage);
                        setSource(s.source);
                        setView(s.view);
                        setMode(s.mode);
                        setCompact(s.compact);
                        setShowSource(s.showSource);
                        setAscending(s.ascending);
                        setPage(0);
                      }}
                    >
                      {s.label}
                    </button>
                  ))}
                </nav>
                <div className="mode-toggle" role="group" aria-label={t.workspace}>
                  <Button aria-pressed={mode === 'table'} onClick={() => setMode('table')}>
                    <LayoutList size={16} />
                    {t.table}
                  </Button>
                  <Button aria-pressed={mode === 'kanban'} onClick={() => setMode('kanban')}>
                    <Columns3 size={16} />
                    {t.kanban}
                  </Button>
                </div>
              </div>
              <div className="filterbar">
                <label className="search">
                  <span className="sr-only">{t.search}</span>
                  <Search size={18} />
                  <input
                    aria-label={t.search}
                    maxLength={100}
                    value={query}
                    placeholder={t.searchHint}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPage(0);
                    }}
                  />
                </label>
                <div className="desktop-filters">{filters}</div>
                <Button className="mobile-filters" onClick={() => setFilterOpen(true)}>
                  <SlidersHorizontal size={18} />
                  {t.filters}
                  {persistent && ` · ${activeFilterCount}`}
                </Button>
                {persistent && (
                  <Button className="crm-more-filters" onClick={() => setFilterOpen(true)}>
                    {t.filters} · {activeFilterCount}
                  </Button>
                )}
                <Button
                  className="save-view"
                  disabled={persistent && !remote.snapshot?.session.workspaceId}
                  onClick={() => {
                    setSaveError('');
                    setSaveOpen(true);
                  }}
                >
                  {t.saveView}
                </Button>
              </div>
              <div className="list-meta">
                <span>
                  <strong>{visible ? total : '—'}</strong> {t.records}
                </span>
                <div>
                  <label className="column-control">
                    <input
                      type="checkbox"
                      checked={showSource}
                      onChange={(e) => setShowSource(e.target.checked)}
                    />
                    {t.columns}
                  </label>
                  <label>
                    <span className="sr-only">{t.density}</span>
                    <select
                      aria-label={t.density}
                      value={compact ? 'compact' : 'comfortable'}
                      onChange={(e) => setCompact(e.target.value === 'compact')}
                    >
                      <option value="comfortable">{t.comfortable}</option>
                      <option value="compact">{t.compact}</option>
                    </select>
                  </label>
                </div>
              </div>
              {(state === 'offline' || state === 'degraded') && (
                <p className="banner" role="status">
                  {t[state]}
                </p>
              )}
              {!visible ? (
                state === 'loading' ? (
                  <section
                    aria-busy="true"
                    aria-live="polite"
                    aria-label={t.loading}
                    className="skeleton"
                  >
                    {Array.from({ length: 8 }, (_, i) => (
                      <div key={i} />
                    ))}
                  </section>
                ) : (
                  <State
                    role={state === 'empty' ? 'status' : 'alert'}
                    title={
                      state === 'permission'
                        ? t.permission
                        : state === 'empty'
                          ? t.empty
                          : state === '401'
                            ? t.status401
                            : state === '404'
                              ? label('notFound')
                              : state === '429'
                                ? t.status429
                                : t.error
                    }
                    detail={
                      state === 'permission'
                        ? t.permissionDetail
                        : state === '404'
                          ? label('notFound')
                          : state === 'empty'
                            ? t.emptyDetail
                            : t.errorDetail
                    }
                  >
                    {persistent && state === '401' ? (
                      <form
                        onSubmit={async (e) => {
                          e.preventDefault();
                          try {
                            await crmRequest('session', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ code: sessionCode }),
                            });
                            setSessionCode('');
                            setFeedback('');
                            remote.refresh();
                          } catch {
                            setFeedback(t.errorDetail);
                          }
                        }}
                      >
                        <label>
                          {ct.sessionCode}
                          <input
                            type="password"
                            autoComplete="off"
                            required
                            value={sessionCode}
                            onChange={(e) => setSessionCode(e.target.value)}
                          />
                        </label>
                        <Button type="submit">{ct.signIn}</Button>
                      </form>
                    ) : (
                      <Button
                        onClick={() => (persistent ? remote.refresh() : changeState('ready'))}
                      >
                        {t.retry}
                      </Button>
                    )}
                    {persistent && remote.error?.requestId && (
                      <small>{remote.error.requestId}</small>
                    )}
                  </State>
                )
              ) : !filtered.length ? (
                <State
                  title={
                    persistentEmpty ? t.empty : persistent || rows.length ? t.noResults : t.empty
                  }
                  detail={
                    persistentEmpty
                      ? t.emptyDetail
                      : persistent || rows.length
                        ? t.noResultsDetail
                        : t.emptyDetail
                  }
                >
                  <Button
                    onClick={
                      persistentEmpty
                        ? remote.refresh
                        : persistent || rows.length
                          ? clear
                          : addExample
                    }
                  >
                    {persistentEmpty ? t.retry : persistent || rows.length ? t.clear : t.create}
                  </Button>
                </State>
              ) : (
                <>
                  {mode === 'table' ? (
                    <>
                      <div className="data-surface">
                        <table>
                          <caption className="sr-only">{t.reference}</caption>
                          <thead>
                            <tr>
                              <th className="select-cell" scope="col">
                                <input
                                  type="checkbox"
                                  aria-label={t.select + ' ' + t.all}
                                  checked={
                                    pageRows.length > 0 &&
                                    pageRows.every((r) => selected.includes(r.id))
                                  }
                                  onChange={(e) =>
                                    setSelected(e.target.checked ? pageRows.map((r) => r.id) : [])
                                  }
                                />
                              </th>
                              <th
                                scope="col"
                                aria-sort={
                                  sort === 'name'
                                    ? ascending
                                      ? 'ascending'
                                      : 'descending'
                                    : 'none'
                                }
                              >
                                <button
                                  className="sort"
                                  onClick={() => {
                                    setSort('name');
                                    setAscending(!ascending);
                                    setPage(0);
                                  }}
                                >
                                  {t.name}
                                  {sort === 'name' &&
                                    (ascending ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
                                </button>
                              </th>
                              <th scope="col">{t.stage}</th>
                              <th scope="col">{t.next}</th>
                              {(!persistent || extraColumns.includes('due')) && (
                                <th
                                  scope="col"
                                  aria-sort={
                                    sort === 'due'
                                      ? ascending
                                        ? 'ascending'
                                        : 'descending'
                                      : 'none'
                                  }
                                >
                                  {t.when}
                                </th>
                              )}
                              {showSource && (
                                <th className="source-cell" scope="col">
                                  {t.source}
                                </th>
                              )}
                              {(!persistent || extraColumns.includes('owner')) && (
                                <th className="owner-cell" scope="col">
                                  {t.owner}
                                </th>
                              )}
                              {persistent && extraColumns.includes('activity') && (
                                <th
                                  scope="col"
                                  aria-sort={
                                    sort === 'updated'
                                      ? ascending
                                        ? 'ascending'
                                        : 'descending'
                                      : 'none'
                                  }
                                >
                                  {ct.updated}
                                </th>
                              )}
                              {persistent && extraColumns.includes('priority') && (
                                <th scope="col">{ct.priority}</th>
                              )}
                            </tr>
                          </thead>
                          <tbody>
                            {pageRows.map((r) => (
                              <tr
                                key={r.id}
                                className={selected.includes(r.id) ? 'row-selected' : ''}
                              >
                                <td>
                                  <input
                                    aria-label={`${t.select} ${r.name}`}
                                    type="checkbox"
                                    checked={selected.includes(r.id)}
                                    onChange={() => toggle(r.id)}
                                  />
                                </td>
                                <td>
                                  <button className="person" onClick={() => setDetailId(r.id)}>
                                    <span className="initials">
                                      {r.name
                                        .split(' ')
                                        .slice(0, 2)
                                        .map((s) => s[0])
                                        .join('')}
                                    </span>
                                    <span>{r.name}</span>
                                    <ChevronRight size={14} />
                                  </button>
                                </td>
                                <td>
                                  <span className={`badge stage-${r.stage}`}>{label(r.stage)}</span>
                                </td>
                                <td>{nextAction(r)}</td>
                                {(!persistent || extraColumns.includes('due')) && (
                                  <td className="data">{date(r.due)}</td>
                                )}
                                {showSource && (
                                  <td className="source-cell secondary">{label(r.source)}</td>
                                )}
                                {(!persistent || extraColumns.includes('owner')) && (
                                  <td className="owner-cell secondary">{t[r.owner]}</td>
                                )}
                                {persistent && extraColumns.includes('activity') && (
                                  <td>{date(r.updatedAt ?? '')}</td>
                                )}
                                {persistent && extraColumns.includes('priority') && (
                                  <td>{label(r.priority ?? '')}</td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="mobile-list">
                        {pageRows.map((r) => (
                          <article key={r.id}>
                            <button onClick={() => setDetailId(r.id)}>
                              <span>
                                <strong>{r.name}</strong>
                                <span className="mobile-status">{label(r.stage)}</span>
                                <span>
                                  {nextAction(r)} · {date(r.due)}
                                </span>
                              </span>
                              <ChevronRight size={20} />
                            </button>
                            <input
                              type="checkbox"
                              aria-label={`${t.select} ${r.name}`}
                              checked={selected.includes(r.id)}
                              onChange={() => toggle(r.id)}
                            />
                          </article>
                        ))}
                      </div>
                    </>
                  ) : persistent ? (
                    <CrmKanban
                      locale={locale}
                      config={JSON.stringify({ ...config, page: 0 })}
                      stages={remote.snapshot?.data.stages ?? []}
                      label={label}
                      onOpen={setDetailId}
                    />
                  ) : (
                    <div className="kanban">
                      {activeStages.map((s) => (
                        <section key={s}>
                          <h2>
                            {label(s)}{' '}
                            <span>
                              {persistent
                                ? (remote.snapshot?.data.stages.find((v) => v.stage === s)?.count ??
                                  0)
                                : pageRows.filter((r) => r.stage === s).length}
                            </span>
                          </h2>
                          {pageRows
                            .filter((r) => r.stage === s)
                            .map((r) => (
                              <button
                                className="kanban-item"
                                key={r.id}
                                onClick={() =>
                                  persistent ? setFeedback(ct.detailPending) : setDetailId(r.id)
                                }
                              >
                                <strong>{r.name}</strong>
                                <span>{nextAction(r)}</span>
                                <small>
                                  {date(r.due)}
                                  <ArrowUpRight size={16} />
                                </small>
                              </button>
                            ))}
                        </section>
                      ))}
                    </div>
                  )}
                  {(!persistent || mode === 'table') && (
                    <footer className="pagination">
                      <span>
                        {t.shown} {currentPage * 20 + 1}–{Math.min((currentPage + 1) * 20, total)}{' '}
                        {t.of} {total}
                      </span>
                      <div>
                        <Button
                          aria-label={t.prev}
                          disabled={currentPage === 0}
                          onClick={() => setPage(currentPage - 1)}
                        >
                          <ChevronLeft size={18} />
                        </Button>
                        <span>
                          {currentPage + 1} / {maxPage + 1}
                        </span>
                        <Button
                          aria-label={t.nextPage}
                          disabled={currentPage >= maxPage}
                          onClick={() => setPage(currentPage + 1)}
                        >
                          <ChevronRight size={18} />
                        </Button>
                      </div>
                    </footer>
                  )}
                </>
              )}
              {selected.length > 0 && visible && (
                <div className="bulk-bar">
                  <strong>
                    {selected.length} {t.selected}
                  </strong>
                  {!persistent && (
                    <Button onClick={() => activity(selected)}>
                      <Check size={16} />
                      {t.selectionAction}
                    </Button>
                  )}
                  <Button onClick={() => setSelected([])}>{t.selectionClear}</Button>
                </div>
              )}
            </>
          )}
          <p className="feedback" role="status">
            {feedback}
          </p>
          <footer className="legal-note">{t.sourceLabel} · America/Guayaquil</footer>
        </main>
      </div>
      <nav className="mobile-nav" aria-label={t.workspace}>
        <button onClick={() => setLab(false)} aria-current={!lab ? 'page' : undefined}>
          <Users size={20} />
          {t.reference}
        </button>
        {!persistent && (
          <button onClick={() => setLab(true)} aria-current={lab ? 'page' : undefined}>
            <FlaskConical size={20} />
            {t.lab}
          </button>
        )}
      </nav>
      {persistent && detailId && (
        <CrmDrawer
          locale={locale}
          key={detailId}
          id={detailId}
          label={detailLabel}
          onClose={() => setDetailId(undefined)}
          onChanged={remote.refresh}
        />
      )}
      {detail && visible && !persistent && (
        <Panel title={detail.name} closeLabel={t.close} onClose={() => setDetailId(undefined)}>
          <span className={`badge stage-${detail.stage}`}>{label(detail.stage)}</span>
          <p className="secondary">{t.examplesOnly}</p>
          <section className="next-action">
            <span>{t.next}</span>
            <h3>{nextAction(detail)}</h3>
            <p>{date(detail.due)} · America/Guayaquil</p>
            <Button variant="primary" onClick={() => activity([detail.id])}>
              <Check size={18} />
              {t.record}
            </Button>
          </section>
          <h3>{t.details}</h3>
          <dl>
            <dt>{t.owner}</dt>
            <dd>{t[detail.owner]}</dd>
            <dt>{t.source}</dt>
            <dd>{label(detail.source)}</dd>
            <dt>{t.activity}</dt>
            <dd>{detail.activity}</dd>
          </dl>
          <h3>{t.timeline}</h3>
          <p>{t.notes}</p>
          <p className="timeline-event">
            {detail.activity} · {t.localEvent}
          </p>
          <small>{t.sourceLabel}</small>
        </Panel>
      )}
      {filterOpen && (
        <Panel
          title={t.filters}
          kind="sheet"
          closeLabel={t.close}
          onClose={() => setFilterOpen(false)}
        >
          <div className="filter-fields">
            {filters}
            {persistent && (
              <>
                <label>
                  {ct.status}
                  <select
                    value={statusFilter}
                    onChange={(e) => {
                      setStatusFilter(e.target.value);
                      setPage(0);
                    }}
                  >
                    {['all', 'open', 'closed'].map((v) => (
                      <option key={v} value={v}>
                        {label(v)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {ct.priority}
                  <select
                    value={priority}
                    onChange={(e) => {
                      setPriority(e.target.value);
                      setPage(0);
                    }}
                  >
                    {['all', 'normal', 'high'].map((v) => (
                      <option key={v} value={v}>
                        {label(v)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t.activity}
                  <select
                    value={view === 'due' ? 'due' : activityFilter}
                    onChange={(e) => {
                      setActivityFilter(e.target.value);
                      if (view === 'due') setView('all');
                      setPage(0);
                    }}
                  >
                    {['all', 'due', 'inactive'].map((v) => (
                      <option key={v} value={v}>
                        {label(v)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {ct.sort}
                  <select
                    value={sort}
                    onChange={(e) => {
                      setSort(e.target.value as typeof sort);
                      setPage(0);
                    }}
                  >
                    <option value="name">{t.name}</option>
                    <option value="updated">{ct.updated}</option>
                    <option value="due">{t.when}</option>
                  </select>
                </label>
                <label>
                  {ct.direction}
                  <select
                    value={ascending ? 'asc' : 'desc'}
                    onChange={(e) => {
                      setAscending(e.target.value === 'asc');
                      setPage(0);
                    }}
                  >
                    <option value="asc">{ct.asc}</option>
                    <option value="desc">{ct.desc}</option>
                  </select>
                </label>
                <fieldset>
                  <legend>{ct.visibleColumns}</legend>
                  {['owner', 'due', 'activity', 'priority'].map((v) => (
                    <label key={v} className="column-control">
                      <input
                        type="checkbox"
                        checked={extraColumns.includes(v)}
                        onChange={(e) =>
                          setExtraColumns((prev) =>
                            e.target.checked ? [...prev, v] : prev.filter((c) => c !== v),
                          )
                        }
                      />
                      {v === 'due' ? t.when : v === 'activity' ? ct.updated : label(v)}
                    </label>
                  ))}
                </fieldset>
              </>
            )}
            <Button variant="primary" onClick={() => setFilterOpen(false)}>
              {t.close}
            </Button>
          </div>
        </Panel>
      )}
      {saveOpen && (
        <Panel
          title={t.saveView}
          kind="dialog"
          closeLabel={t.close}
          onClose={() => setSaveOpen(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!viewName.trim()) return;
              if (persistent) {
                if (saving) return;
                setSaving(true);
                setSaveError('');
                try {
                  const workspaceId = remote.snapshot?.session.workspaceId;
                  if (!workspaceId) throw new Error('Session refresh required');
                  const body = JSON.stringify({
                    schemaVersion: 1,
                    workspaceId,
                    name: viewName.trim(),
                    visibility,
                    recipients:
                      visibility === 'shared'
                        ? recipients
                            .split(',')
                            .map((v) => v.trim())
                            .filter(Boolean)
                        : [],
                    config,
                  });
                  if (saveAttempt.current?.body !== body)
                    saveAttempt.current = { body, key: crypto.randomUUID() };
                  await crmRequest('views', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Idempotency-Key': saveAttempt.current.key,
                    },
                    body,
                  });
                  saveAttempt.current = null;
                  setSaveOpen(false);
                  setViewName('');
                  setFeedback(t.saved);
                  remote.refresh();
                } catch {
                  setSaveError(t.errorDetail);
                } finally {
                  setSaving(false);
                }
                return;
              }
              setSaved([
                ...saved,
                {
                  label: viewName.trim(),
                  query,
                  stage,
                  source,
                  view,
                  mode,
                  compact,
                  showSource,
                  ascending,
                },
              ]);
              setSaveOpen(false);
              setViewName('');
              setFeedback(t.saved);
            }}
          >
            <label>
              {t.viewName}
              <input
                value={viewName}
                onChange={(e) => setViewName(e.target.value)}
                required
                maxLength={40}
              />
            </label>
            <p>{persistent ? ct.noPermissions : t.privateView}</p>
            {persistent && remote.snapshot?.session.canShareView && (
              <>
                <label>
                  {ct.visibility}
                  <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                    {['private', 'team', 'shared'].map((v) => (
                      <option key={v} value={v}>
                        {label(v)}
                      </option>
                    ))}
                  </select>
                </label>
                {visibility === 'shared' && (
                  <label>
                    {ct.recipients}
                    <input
                      required
                      value={recipients}
                      onChange={(e) => setRecipients(e.target.value)}
                    />
                  </label>
                )}
              </>
            )}
            {saveError && <p role="alert">{saveError}</p>}
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? t.loading : t.save}
            </Button>
          </form>
        </Panel>
      )}
    </div>
  );
}
