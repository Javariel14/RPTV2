import { z } from 'zod';
const raw = z.url().parse(process.env.RPT_STAGING_API_URL);
const url = new URL(raw);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
  throw new Error('Approved HTTPS staging origin required');
const health = await fetch(new URL('/health', url), {
  redirect: 'error',
  signal: AbortSignal.timeout(10_000),
});
if (health.status !== 200 || !health.headers.get('cache-control')?.includes('no-store'))
  throw new Error('Staging liveness/security headers failed');
const denied = await fetch(new URL('/v1/persons/00000000-0000-4000-8000-000000000000', url), {
  redirect: 'error',
  signal: AbortSignal.timeout(10_000),
});
if (denied.status !== 401) throw new Error('Staging unauthenticated boundary failed');
console.log(
  'PASS staging liveness and unauthenticated boundary; not an authenticated tenant acceptance test.',
);
