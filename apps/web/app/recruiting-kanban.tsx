'use client';
import { useEffect, useState } from 'react';
import type {
  RecruitmentProfileList,
  RecruitmentProfileRow,
  RecruitingStage,
} from '@rpt/contracts/recruiting';
import { Button } from '@rpt/ui';
import { recruitingRequest } from './use-recruiting-data';

export const recruitingStages: RecruitingStage[] = [
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

export function RecruitingKanban({
  config,
  workspaceId,
  revision,
  label,
  onOpen,
  onAdvance,
}: {
  config: Record<string, unknown>;
  workspaceId: string;
  revision: number;
  label: (key: string) => string;
  onOpen: (id: string) => void;
  onAdvance: (row: RecruitmentProfileRow, stage: RecruitingStage) => void;
}) {
  const [columns, setColumns] = useState<Record<string, RecruitmentProfileList>>({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    void Promise.all(
      recruitingStages.map(
        async (stage) =>
          [
            stage,
            await recruitingRequest<RecruitmentProfileList>(
              `profiles?config=${encodeURIComponent(JSON.stringify({ ...config, workspaceId, stage, page: 0 }))}`,
              { signal: controller.signal },
            ),
          ] as const,
      ),
    )
      .then((values) => {
        if (!controller.signal.aborted) {
          setColumns(Object.fromEntries(values));
          setLoading(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailed(true);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [config, workspaceId, revision]);
  if (failed) return <p role="alert">{label('unavailable')}</p>;
  return (
    <div className="kanban crm-kanban recruiting-kanban" aria-busy={loading}>
      {recruitingStages.map((stage, index) => {
        const column = columns[stage];
        return (
          <section key={stage} aria-labelledby={`recruiting-stage-${stage}`}>
            <h2 id={`recruiting-stage-${stage}`}>
              {label(stage)} <span>{column?.total ?? 0}</span>
            </h2>
            {loading && !column ? (
              <p className="kanban-skeleton">{label('loading')}</p>
            ) : (
              column?.rows.map((row) => (
                <article className="kanban-item" key={row.id}>
                  <button
                    className="kanban-open"
                    data-focus-return={row.id}
                    onClick={() => onOpen(row.id)}
                  >
                    <strong>{row.displayName}</strong>
                    <span>
                      {row.priority ?? '—'} · {label(row.substatus ?? row.source)}
                    </span>
                    <small>{row.nextAction ?? label('none')}</small>
                  </button>
                  {row.canUpdate && index < recruitingStages.length - 1 && (
                    <Button
                      className="kanban-advance"
                      onClick={() => onAdvance(row, recruitingStages[index + 1]!)}
                    >
                      {label('advance')}
                    </Button>
                  )}
                </article>
              ))
            )}
          </section>
        );
      })}
    </div>
  );
}
