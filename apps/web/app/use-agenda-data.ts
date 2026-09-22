'use client';
import { useCallback, useEffect, useState } from 'react';
import type { AgendaList, CrmSession } from '@rpt/contracts';

export class AgendaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code = 'UNAVAILABLE',
  ) {
    super(code);
  }
}

export async function agendaRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/agenda/${path}`, { ...init, cache: 'no-store' });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { code?: string };
  };
  if (!response.ok)
    throw new AgendaHttpError(response.status, payload.error?.code ?? 'UNAVAILABLE');
  return payload.data as T;
}

export function useAgendaData(config: string) {
  const [data, setData] = useState<AgendaList>();
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [timezone, setTimezone] = useState<string>();
  const [error, setError] = useState<AgendaHttpError>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined);
    const timer = window.setTimeout(() => {
      void Promise.all([
        agendaRequest<AgendaList>(`items?config=${encodeURIComponent(config)}`, {
          signal: controller.signal,
        }),
        fetch('/api/crm/context', { cache: 'no-store', signal: controller.signal }).then(
          async (response) => {
            if (!response.ok) throw new AgendaHttpError(response.status);
            return ((await response.json()) as { data: CrmSession }).data;
          },
        ),
      ])
        .then(([items, context]) => {
          if (!controller.signal.aborted) {
            setData(items);
            setWorkspaceId(context.workspaceId ?? undefined);
            setTimezone(context.timezone);
            setError(undefined);
          }
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted)
            setError(reason instanceof AgendaHttpError ? reason : new AgendaHttpError(503));
        });
    }, 100);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [config, revision]);
  return { data, workspaceId, timezone, error, refresh };
}
