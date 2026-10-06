import { z } from 'zod';
import { orderHistoryQuery, orderListQuery, errorStatus, type ErrorCode } from '@rpt/contracts';
import type { NextRequest } from 'next/server';

/** Local/test adapter. Identity is supplied only by the server session bridge. */
export async function GET(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const requestId = crypto.randomUUID();
  const headers = {
    'Cache-Control': 'no-store',
    'X-Request-Id': requestId,
    'X-Content-Type-Options': 'nosniff',
  };
  const failure = (code: ErrorCode, status: number = errorStatus[code]) =>
    Response.json(
      { schemaVersion: 1, error: { code, requestId, retryable: code === 'UNAVAILABLE' } },
      { status, headers },
    );
  const origin = process.env.RPT_LOCAL_API_ORIGIN;
  const secret = process.env.RPT_LOCAL_BRIDGE_SECRET;
  if (
    !['local', 'test'].includes(process.env.RPT_ENV ?? '') ||
    !origin ||
    !secret ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)
  )
    return failure('UNAVAILABLE');
  if (request.method !== 'GET') return failure('INVALID_REQUEST', 405);
  if (request.body !== null || request.headers.has('x-http-method-override'))
    return failure('INVALID_REQUEST');
  const path = (await context.params).path ?? [];
  if (
    path.length > 2 ||
    (path.length > 0 && !z.uuid().safeParse(path[0]).success) ||
    (path.length === 2 && path[1] !== 'history')
  )
    return failure('NOT_FOUND');
  const query: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of request.nextUrl.searchParams) {
    if (Object.hasOwn(query, key)) return failure('INVALID_REQUEST');
    query[key] = value;
  }
  if (
    path.length === 0
      ? !orderListQuery.safeParse(query).success
      : path.length === 2
        ? !orderHistoryQuery.safeParse(query).success
        : Object.keys(query).length > 0
  )
    return failure('INVALID_REQUEST');
  // Only this cookie is needed. No browser Authorization or authority headers cross the bridge.
  const session = request.cookies.get('rpt.crm-session')?.value;
  const upstreamHeaders = new Headers({ 'X-RPT-Bridge': secret });
  if (session) upstreamHeaders.set('Cookie', `rpt.crm-session=${session}`);
  try {
    const response = await fetch(
      `${origin}/v1/orders${path.length ? '/' + path.join('/') : ''}${request.nextUrl.search}`,
      {
        method: 'GET',
        headers: upstreamHeaders,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      },
    );
    const output = new Headers(headers);
    for (const name of ['Content-Type', 'X-Request-Id']) {
      const value = response.headers.get(name);
      if (value) output.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers: output });
  } catch {
    return failure('UNAVAILABLE');
  }
}
