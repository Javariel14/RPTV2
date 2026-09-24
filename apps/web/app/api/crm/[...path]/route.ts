import type { NextRequest } from 'next/server';

/** Local/test BFF only. Production remains closed until its release/auth integration. */
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
  // Next dev normalizes nextUrl to localhost. Compare against the lab's explicit
  // browser origin, never an attacker-controlled Host/X-Forwarded-Host header.
  if (request.method !== 'GET' && request.headers.get('origin') !== 'http://127.0.0.1:3101')
    return Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403, headers: noStore });
  const path = (await context.params).path.join('/');
  const entityPath =
    /^opportunities\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/commands)?$/i.test(
      path,
    );
  const importPath = ['imports/preview', 'imports/confirm'].includes(path);
  if (
    !['session', 'context', 'opportunities', 'views'].includes(path) &&
    !entityPath &&
    !importPath
  )
    return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404, headers: noStore });
  const headers = new Headers({ 'X-RPT-Bridge': secret });
  headers.set('Content-Type', request.headers.get('content-type') ?? 'application/json');
  headers.set('Cookie', request.headers.get('cookie') ?? '');
  if (request.headers.has('Idempotency-Key'))
    headers.set('Idempotency-Key', request.headers.get('Idempotency-Key')!);
  try {
    const body = request.method === 'POST' ? await request.arrayBuffer() : undefined;
    if (body && body.byteLength > (importPath ? 640 * 1024 : 16_384))
      return new Response(null, { status: 413, headers: noStore });
    const response = await fetch(
      `${origin}/${path === 'session' ? 'session' : `v1/crm/${path}`}${request.nextUrl.search}`,
      {
        method: request.method,
        headers,
        ...(body ? { body } : {}),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(importPath ? 30000 : 15000),
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
