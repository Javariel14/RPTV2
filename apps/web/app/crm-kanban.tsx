'use client';
import { useEffect, useState } from 'react';
import type { CrmList, CrmStage } from '@rpt/contracts';
import { crmListQuery } from '@rpt/contracts/crm';
import { Button } from '@rpt/ui';
import { crmRequest } from './use-crm-data';

export function CrmKanban({
  config,
  stages,
  label,
  onOpen,
  locale,
}: {
  config: string;
  stages: CrmList['stages'];
  label: (key: string) => string;
  onOpen: (id: string) => void;
  locale: string;
}) {
  const query = crmListQuery.parse(JSON.parse(config));
  const names: CrmStage[] = [
    'new',
    'contacted',
    'appointment',
    'demo',
    'proposal',
    'pending_approval',
    'won_simulated',
    'won',
    'lost',
  ];
  return (
    <div className="kanban crm-kanban" aria-label={label('kanban')}>
      {names
        .filter((stage) => query.filters.stage === 'all' || query.filters.stage === stage)
        .map((stage) => (
          <Column
            key={stage}
            config={config}
            stage={stage}
            count={stages.find((s) => s.stage === stage)?.count ?? 0}
            label={label}
            onOpen={onOpen}
            locale={locale}
          />
        ))}
    </div>
  );
}
function Column({
  config,
  stage,
  count,
  label,
  onOpen,
  locale,
}: {
  config: string;
  stage: CrmStage;
  count: number;
  label: (key: string) => string;
  onOpen: (id: string) => void;
  locale: string;
}) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ key: string; value: CrmList } | null>(null);
  const [failure, setFailure] = useState('');
  const [revision, setRevision] = useState(0);
  const key = `${config}/${stage}/${page}/${revision}`;
  useEffect(() => {
    // The parent snapshot already established empty stages under the same filters.
    // Avoid nine redundant permission scans on sparse boards.
    if (count === 0) return;
    const controller = new AbortController();
    const query = crmListQuery.parse(JSON.parse(config));
    void crmRequest<CrmList>(
      `opportunities?config=${encodeURIComponent(JSON.stringify({ ...query, page, filters: { ...query.filters, stage } }))}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setData({ key, value });
          setFailure('');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setData(null);
          setFailure(key);
        }
      });
    return () => controller.abort();
  }, [config, stage, page, key, count]);
  const current = data?.key === key ? data.value : null;
  return (
    <section aria-label={label(stage)} aria-live="polite">
      <h2>
        {label(stage)} <span>{current?.total ?? count}</span>
      </h2>
      {count === 0 ? (
        <p>{label('noData')}</p>
      ) : failure === key ? (
        <div role="alert">
          <p>{label('errorDetail')}</p>
          <Button onClick={() => setRevision((n) => n + 1)}>{label('retry')}</Button>
        </div>
      ) : !current ? (
        <p className="kanban-skeleton" role="status">
          {label('loading')}
        </p>
      ) : (
        <>
          {current.rows.length === 0 && <p>{label('noData')}</p>}
          {current.rows.map((row) => (
            <button className="kanban-item" key={row.id} onClick={() => onOpen(row.id)}>
              <strong>{row.name}</strong>
              <span>{row.title}</span>
              <span>{label(row.nextAction)}</span>
              <small>
                {row.nextAt ? new Date(row.nextAt).toLocaleDateString(locale) : '—'} ·{' '}
                {label(row.priority)}
              </small>
            </button>
          ))}
          {current.total > 20 && (
            <nav aria-label={`${label('page')} ${label(stage)}`}>
              <Button disabled={page === 0} onClick={() => setPage((n) => n - 1)}>
                {label('prev')}
              </Button>
              <span>
                {page + 1}/{Math.ceil(current.total / 20)}
              </span>
              <Button
                disabled={(page + 1) * 20 >= current.total}
                onClick={() => setPage((n) => n + 1)}
              >
                {label('nextPage')}
              </Button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
