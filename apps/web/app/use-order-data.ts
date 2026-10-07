'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';

export class OrderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId = '',
  ) {
    super(code);
  }
}
export async function orderRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/orders${path}`, {
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  });
  const requestId = response.headers.get('X-Request-Id') ?? '';
  if (!response.ok) {
    // Never render upstream body text. Only the allowlisted status drives public microcopy.
    throw new OrderHttpError(
      response.status,
      response.status === 422
        ? 'INVALID_REQUEST'
        : response.status === 401
          ? 'UNAUTHENTICATED'
          : response.status === 404
            ? 'NOT_FOUND'
            : response.status === 403
              ? 'FORBIDDEN'
              : 'UNAVAILABLE',
      requestId,
    );
  }
  const payload = (await response.json()) as { schemaVersion?: unknown; data?: unknown };
  const result = schema.safeParse(payload.data);
  if (payload.schemaVersion !== 1 || !result.success)
    throw new OrderHttpError(503, 'UNAVAILABLE', requestId);
  return result.data;
}
export const protectedOrderDenial = (error: OrderHttpError) =>
  [401, 403, 404].includes(error.status);
export function useOrderData<T>(path: string, schema: z.ZodType<T>, retainOnRefresh = false) {
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{ key: string; path: string; data: T }>();
  const [error, setError] = useState<{ key: string; error: OrderHttpError }>();
  const activePath = useRef(path);
  activePath.current = path;
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const denied = useRef<string | null>(null);
  const key = `${path}/${revision}`;
  const activeKey = useRef(key);
  activeKey.current = key;
  const refresh = useCallback(() => {
    generation.current++;
    request.current?.abort();
    denied.current = null;
    setRevision((n) => n + 1);
  }, []);
  const invalidate = useCallback(
    (reason: OrderHttpError) => {
      if (activePath.current !== path || !protectedOrderDenial(reason)) return;
      generation.current++;
      request.current?.abort();
      denied.current = path;
      setSnapshot(undefined);
      setError({ key: activeKey.current, error: reason });
    },
    [path],
  );
  useEffect(() => {
    if (denied.current === path) return;
    const controller = new AbortController();
    request.current = controller;
    const current = ++generation.current;
    const valid = () => !controller.signal.aborted && generation.current === current;
    void orderRequest(path, schema, controller.signal)
      .then((data) => {
        if (valid()) {
          setSnapshot({ key, path, data });
          setError(undefined);
        }
      })
      .catch((reason: unknown) => {
        if (valid()) {
          const failure =
            reason instanceof OrderHttpError ? reason : new OrderHttpError(503, 'UNAVAILABLE');
          if (protectedOrderDenial(failure)) invalidate(failure);
          else if (!retainOnRefresh) setSnapshot(undefined);
          setError({
            key,
            error: failure,
          });
        }
      });
    return () => {
      controller.abort();
      if (activePath.current !== path && denied.current === path) denied.current = null;
    };
  }, [key, path, schema, retainOnRefresh, invalidate]);
  useEffect(() => {
    const focus = () => {
      if (document.visibilityState === 'visible' && denied.current !== activePath.current)
        refresh();
    };
    const timer = window.setInterval(focus, 30_000);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [refresh]);
  return {
    data:
      snapshot?.path === path && (retainOnRefresh || snapshot.key === key)
        ? snapshot.data
        : undefined,
    dataVersion: snapshot?.key,
    error: error?.key === key ? error.error : undefined,
    refresh,
    invalidate,
  };
}
export async function startOrderSession(code: string) {
  const response = await fetch('/api/crm/session', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) throw new OrderHttpError(response.status, 'UNAUTHENTICATED');
}
