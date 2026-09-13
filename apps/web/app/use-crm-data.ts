'use client';
import { useCallback, useEffect, useState } from 'react';
import type { CrmList, CrmSavedView, CrmSession } from '@rpt/contracts';

export class CrmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly requestId = '',
  ) {
    super(`CRM ${status}`);
  }
}
export async function crmRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/crm/${path}`, { ...init, cache: 'no-store' });
  if (!response.ok)
    throw new CrmHttpError(response.status, response.headers.get('X-Request-Id') ?? '');
  if (response.status === 204) return undefined as T;
  return ((await response.json()) as { data: T }).data;
}
export function useCrmData(enabled: boolean, config: string) {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    data: CrmList;
    session: CrmSession;
    views: CrmSavedView[];
  } | null>(null);
  const [error, setError] = useState<{ key: string; status: number; requestId: string } | null>(
    null,
  );
  const key = `${config}/${revision}`;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const init = { signal: controller.signal };
    void Promise.all([
      crmRequest<CrmSession>('context', init),
      crmRequest<CrmList>(`opportunities?config=${encodeURIComponent(config)}`, init),
      crmRequest<CrmSavedView[]>('views', init),
    ])
      .then(([session, data, views]) => {
        if (!controller.signal.aborted) {
          setSnapshot({ key, data, session, views });
          setError(null);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setSnapshot(null);
          setError({
            key,
            status: failure instanceof CrmHttpError ? failure.status : 503,
            requestId: failure instanceof CrmHttpError ? failure.requestId : '',
          });
        }
      });
    return () => controller.abort();
  }, [enabled, config, key]);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(refresh, 30000);
    const focus = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [enabled, refresh]);
  return {
    snapshot: snapshot?.key === key ? snapshot : null,
    error: error?.key === key ? error : null,
    refresh,
  };
}
