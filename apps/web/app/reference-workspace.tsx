'use client';
import { useEffect, useMemo, useState } from 'react';
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
export function ReferenceWorkspace({ initialTheme = 'system' }: { initialTheme?: string }) {
  const [locale, setLocale] = useState<Locale>('es');
  const t = catalogs[locale];
  const [theme, setTheme] = useState(initialTheme);
  const [collapsed, setCollapsed] = useState(false);
  const [lab, setLab] = useState(false);
  const [rows, setRows] = useState(referenceContacts);
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
  const [state, setState] = useState<StateName>('ready');
  const [page, setPage] = useState(0);
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
      rows
        .filter(
          (r) =>
            r.name.toLocaleLowerCase(locale).includes(query.toLocaleLowerCase(locale)) &&
            (stage === 'all' || r.stage === stage) &&
            (source === 'all' || r.source === source) &&
            (view !== 'mine' || r.owner === 'self') &&
            (view !== 'due' || r.stage === 'followup'),
        )
        .sort((a, b) => (ascending ? 1 : -1) * a.name.localeCompare(b.name, locale)),
    [rows, query, stage, source, view, ascending, locale],
  );
  const maxPage = Math.max(0, Math.ceil(filtered.length / 20) - 1);
  const currentPage = Math.min(page, maxPage);
  const pageRows = filtered.slice(currentPage * 20, currentPage * 20 + 20);
  const detail = rows.find((r) => r.id === detailId);
  const visible = ['ready', 'offline', 'degraded'].includes(state);
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      timeZone: 'America/Guayaquil',
    }).format(new Date(value));
  const nextAction = (r: ReferenceContact) =>
    r.stage === 'appointment' ? t.confirm : r.stage === 'new' ? t.contact : t.follow;
  function clear() {
    setQuery('');
    setSource('all');
    setStage('all');
    setPage(0);
  }
  function activity(ids: string[]) {
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
    const generated = referenceContacts(rows.length + 1);
    const row = generated.at(-1);
    if (row) {
      setRows([...rows, row]);
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
          {stages.map((s) => (
            <option key={s} value={s}>
              {t[s]}
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
        <span className="section-label">FOUNDATION</span>
        <nav aria-label={t.workspace}>
          <button
            className={!lab ? 'active' : ''}
            onClick={() => setLab(false)}
            title={t.reference}
          >
            <Users size={20} />
            <span>{t.reference}</span>
          </button>
          <button className={lab ? 'active' : ''} onClick={() => setLab(true)} title={t.lab}>
            <FlaskConical size={20} />
            <span>{t.lab}</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <p>
            JAVARIEL Corp<small>Foundation / 0.1.0</small>
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
            <span className="top-label"> / Foundation</span>
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
            <span className="avatar" role="img" aria-label="Fixture">
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
            {!lab && (
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
                      {v === 'all' && <span className="count">{rows.length}</span>}
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
                <div className="mode-toggle">
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
                </Button>
                <Button className="save-view" onClick={() => setSaveOpen(true)}>
                  {t.saveView}
                </Button>
              </div>
              <div className="list-meta">
                <span>
                  <strong>{visible ? filtered.length : '—'}</strong> {t.records}
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
                  <section aria-busy="true" aria-label={t.loading} className="skeleton">
                    {Array.from({ length: 8 }, (_, i) => (
                      <div key={i} />
                    ))}
                  </section>
                ) : (
                  <State
                    title={
                      state === 'permission'
                        ? t.permission
                        : state === 'empty'
                          ? t.empty
                          : state === '401'
                            ? t.status401
                            : state === '429'
                              ? t.status429
                              : t.error
                    }
                    detail={
                      state === 'permission'
                        ? t.permissionDetail
                        : state === 'empty'
                          ? t.emptyDetail
                          : t.errorDetail
                    }
                  >
                    <Button onClick={() => changeState('ready')}>{t.retry}</Button>
                  </State>
                )
              ) : !filtered.length ? (
                <State
                  title={rows.length ? t.noResults : t.empty}
                  detail={rows.length ? t.noResultsDetail : t.emptyDetail}
                >
                  <Button onClick={rows.length ? clear : addExample}>
                    {rows.length ? t.clear : t.create}
                  </Button>
                </State>
              ) : (
                <>
                  {mode === 'table' ? (
                    <>
                      <div className="data-surface">
                        <table>
                          <thead>
                            <tr>
                              <th className="select-cell">
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
                              <th>
                                <button className="sort" onClick={() => setAscending(!ascending)}>
                                  {t.name}
                                  {ascending ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
                                </button>
                              </th>
                              <th>{t.stage}</th>
                              <th>{t.next}</th>
                              <th>{t.when}</th>
                              {showSource && <th className="source-cell">{t.source}</th>}
                              <th className="owner-cell">{t.owner}</th>
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
                                  <span className={`badge stage-${r.stage}`}>{t[r.stage]}</span>
                                </td>
                                <td>{nextAction(r)}</td>
                                <td className="data">{date(r.due)}</td>
                                {showSource && (
                                  <td className="source-cell secondary">{t[r.source]}</td>
                                )}
                                <td className="owner-cell secondary">{t[r.owner]}</td>
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
                                <span className="mobile-status">{t[r.stage]}</span>
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
                  ) : (
                    <div className="kanban">
                      {stages.map((s) => (
                        <section key={s}>
                          <h2>
                            {t[s]} <span>{pageRows.filter((r) => r.stage === s).length}</span>
                          </h2>
                          {pageRows
                            .filter((r) => r.stage === s)
                            .map((r) => (
                              <button
                                className="kanban-item"
                                key={r.id}
                                onClick={() => setDetailId(r.id)}
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
                  <footer className="pagination">
                    <span>
                      {t.shown} {currentPage * 20 + 1}–
                      {Math.min((currentPage + 1) * 20, filtered.length)} {t.of} {filtered.length}
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
                </>
              )}
              {selected.length > 0 && visible && (
                <div className="bulk-bar">
                  <strong>
                    {selected.length} {t.selected}
                  </strong>
                  <Button onClick={() => activity(selected)}>
                    <Check size={16} />
                    {t.selectionAction}
                  </Button>
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
        <button onClick={() => setLab(true)} aria-current={lab ? 'page' : undefined}>
          <FlaskConical size={20} />
          {t.lab}
        </button>
      </nav>
      {detail && visible && (
        <Panel title={detail.name} closeLabel={t.close} onClose={() => setDetailId(undefined)}>
          <span className={`badge stage-${detail.stage}`}>{t[detail.stage]}</span>
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
            <dd>{t[detail.source]}</dd>
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
            onSubmit={(e) => {
              e.preventDefault();
              if (!viewName.trim()) return;
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
            <p>{t.privateView}</p>
            <Button type="submit" variant="primary">
              {t.save}
            </Button>
          </form>
        </Panel>
      )}
    </div>
  );
}
