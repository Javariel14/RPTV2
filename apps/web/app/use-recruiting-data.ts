'use client';
import { useCallback, useEffect, useState } from 'react';
import type { RecruitmentProfileList, RecruitingContext } from '@rpt/contracts/recruiting';

export class RecruitingHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
  ) {
    super(code);
  }
}

export async function recruitingRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/recruiting/${path}`, { ...init, cache: 'no-store' });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { code?: string; requestId?: string };
  };
  if (!response.ok)
    throw new RecruitingHttpError(
      response.status,
      payload.error?.code ?? 'UNAVAILABLE',
      payload.error?.requestId,
    );
  return payload.data as T;
}

export function useRecruitingData(config: string) {
  const [snapshot, setSnapshot] = useState<{
    context: RecruitingContext;
    data: RecruitmentProfileList;
  }>();
  const [error, setError] = useState<RecruitingHttpError>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const context = await recruitingRequest<RecruitingContext>('context', {
            signal: controller.signal,
          });
          const parsed = JSON.parse(config) as Record<string, unknown>;
          const data = await recruitingRequest<RecruitmentProfileList>(
            `profiles?config=${encodeURIComponent(JSON.stringify({ ...parsed, workspaceId: context.workspace.id }))}`,
            { signal: controller.signal },
          );
          setSnapshot({ context, data });
          setError(undefined);
        } catch (reason) {
          if (!controller.signal.aborted)
            setError(
              reason instanceof RecruitingHttpError
                ? reason
                : new RecruitingHttpError(503, 'UNAVAILABLE'),
            );
        }
      })();
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [config, revision]);
  return { snapshot, error, refresh };
}
