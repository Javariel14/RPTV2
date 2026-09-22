import type { NextRequest } from 'next/server';

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const noStore = { 'Cache-Control': 'no-store' };
  const origin = process.env.RPT_LOCAL_API_ORIGIN;
  const secret = process.env.RPT_LOCAL_BRIDGE_SECRET;
  if (
    !['local', 'test'].includes(process.env.RPT_ENV ?? '') ||
    !origin ||
    !secret ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)
  )
    return Response.json({ error: { code: 'UNAVAILABLE' } }, { status: 503, headers: noStore });
  if (request.method !== 'GET' && request.headers.get('origin') !== 'http://127.0.0.1:3101')
    return Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403, headers: noStore });
  const path = (await context.params).path.join('/');
  const entity = /^items\/[0-9a-f-]{36}(\/commands)?$/i.test(path);
  if (!['session', 'items'].includes(path) && !entity)
    return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404, headers: noStore });
  const headers = new Headers({ 'X-RPT-Bridge': secret, 'Content-Type': 'application/json' });
  headers.set('Cookie', request.headers.get('cookie') ?? '');
  if (request.headers.has('Idempotency-Key'))
    headers.set('Idempotency-Key', request.headers.get('Idempotency-Key')!);
  try {
    const body = request.method === 'POST' ? await request.text() : undefined;
    if (body && new TextEncoder().encode(body).length > 16_384)
      return new Response(null, { status: 413, headers: noStore });
    const response = await fetch(
      `${origin}/${path === 'session' ? 'session' : `v1/agenda/${path}`}${request.nextUrl.search}`,
      {
        method: request.method,
        headers,
        ...(body ? { body } : {}),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      },
    );
    const output = new Headers(noStore);
    for (const name of ['Content-Type', 'Set-Cookie', 'X-Request-Id']) {
      const value = response.headers.get(name);
      if (value) output.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers: output });
  } catch {
    return Response.json({ error: { code: 'UNAVAILABLE' } }, { status: 503, headers: noStore });
  }
}

export const GET = proxy;
export const POST = proxy;
