import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const web = await fetch('http://127.0.0.1:3102/', { signal: AbortSignal.timeout(20_000) });
const html = await web.text();
assert.equal(web.status, 200);
assert(html.includes('CRM Comercial'));
const api = await fetch('http://127.0.0.1:8791/health', { signal: AbortSignal.timeout(10_000) });
const error: unknown = await api.json();
assert.equal(api.status, 503);
assert.equal(api.headers.get('cache-control'), 'no-store');
await writeFile(
  'work/runtime-evidence.json',
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      web: { runtime: 'workerd/OpenNext', status: web.status, fixtureReference: true },
      api: { runtime: 'workerd', status: api.status, configurationFailClosed: true, error },
      deployed: false,
    },
    null,
    2,
  ),
);
console.log(
  'PASS local workerd: OpenNext reference HTTP 200; unapproved API HTTP 503/no-store. No deployment.',
);
