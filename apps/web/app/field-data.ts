'use client';
import { useCallback, useEffect, useState } from 'react';
import type { FieldVisitList } from '@rpt/contracts';

export class FieldHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code = 'UNAVAILABLE',
  ) {
    super(code);
  }
}

export async function fieldRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/field/${path}`, { ...init, cache: 'no-store' });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { code?: string };
  };
  if (!response.ok) throw new FieldHttpError(response.status, payload.error?.code);
  return payload.data as T;
}

export function useFieldData(config: string) {
  const [data, setData] = useState<FieldVisitList>();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<FieldHttpError>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined);
    setError(undefined);
    void Promise.all([
      fieldRequest<FieldVisitList>(`visits?config=${encodeURIComponent(config)}`, {
        signal: controller.signal,
      }),
      fieldRequest<{ workspaceId: string | null }>('context', { signal: controller.signal }),
    ])
      .then(([list, context]) => {
        if (!controller.signal.aborted) {
          setData(list);
          setWorkspaceId(context.workspaceId);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof FieldHttpError ? reason : new FieldHttpError(503));
      });
    return () => controller.abort();
  }, [config, revision]);
  return { data, workspaceId, error, refresh };
}
