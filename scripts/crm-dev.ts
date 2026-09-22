import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { FoundationService } from '@rpt/application';
import { PostgresDatabase } from '@rpt/persistence';
import { JwtIdentityVerifier } from '@rpt/policy';
import { createApi } from '../apps/api/src/app.js';
import { startPostgres } from '../tests/helpers/postgres.js';
import { seedCrm } from '../tests/helpers/crm-fixtures.js';
import { seedRecruiting } from '../tests/helpers/recruiting-fixtures.js';

// An isolated synthetic, on-disk PostgreSQL lab. Never launches a remote release.
const cluster = await startPostgres();
const root = await cluster.migrate();
const fixture = await seedCrm(root, 'crm-local');
await seedRecruiting(root, fixture);
await root.query(
  "INSERT INTO rpt.feature_flag(tenant_id,id,key,policy_version,enabled,rollout_percent,effective_from) VALUES($1,$2,'agenda_tasks_core',1,true,100,'2020-01-01')",
  [fixture.tenant, randomUUID()],
);
for (const verb of ['read', 'create', 'update', 'share']) {
  await root.query(
    "INSERT INTO authz.role_capability VALUES($1,'owner','agenda_item',$2,'CONFIDENTIAL',false,1)",
    [fixture.tenant, verb],
  );
  await root.query(
    `INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
     VALUES($1,$2,$3,$4,'agenda_item',$5,'CONFIDENTIAL',1)`,
    [fixture.tenant, randomUUID(), fixture.workspace, fixture.users.owner, verb],
  );
}
const agendaItems = [
  { type: 'appointment', title: 'Revisión comercial sintética', day: 0, hour: 15 },
  { type: 'task', title: 'Preparar seguimiento sintético', day: 0, hour: 18 },
  { type: 'appointment', title: 'Sesión de planificación sintética', day: 2, hour: 16 },
] as const;
const service = new FoundationService(new PostgresDatabase(cluster.runtimeConfig()));
for (const item of agendaItems) {
  const start = new Date();
  start.setUTCHours(item.hour, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() + item.day);
  const common = {
    schemaVersion: 1 as const,
    workspaceId: fixture.workspace,
    title: item.title,
    summary: 'Dato sintético para QA local',
    timezone: 'America/Guayaquil',
    source: 'manual' as const,
    personId: null,
    opportunityId: null,
    recruitmentProfileId: null,
    recurrence: null,
    reminderMinutesBefore: [15],
    travel: {
      originLabel: 'Oficina sintética',
      destinationLabel: 'Destino sintético',
      estimatedTravelMinutes: 20,
      preparationMinutes: 10,
    },
  };
  await service.createAgendaItem(
    fixture.identities.owner,
    randomUUID(),
    item.type === 'appointment'
      ? {
          ...common,
          type: 'appointment',
          startsAt: start.toISOString(),
          endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
        }
      : { ...common, type: 'task', dueAt: start.toISOString(), priority: 'normal' },
    `agenda-local-${item.type}-${item.day}`,
  );
}
// The local bridge is not ready until PostgreSQL has statistics for the complete
// synthetic CRM/Recruiting/Agenda dataset. This prevents first-run query-plan
// drift after state-changing E2E scenarios without weakening runtime timeouts.
await root.query('ANALYZE');
await root.end();
const key = await generateKeyPair('ES256');
const jwk = await exportJWK(key.publicKey);
const identity = fixture.identities.owner;
const api = createApi(
  service,
  new JwtIdentityVerifier(
    identity.iss,
    'authenticated',
    createLocalJWKSet({ keys: [{ ...jwk, kid: 'local' }] }),
  ),
);
const loginCode = process.env.RPT_CRM_TEST_CODE ?? randomBytes(18).toString('base64url');
const bridgeSecret = randomBytes(32).toString('hex');
const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const server = createServer((req, res) => {
  void (async () => {
    res.setHeader('Cache-Control', 'no-store');
    if (!equal(String(req.headers['x-rpt-bridge'] ?? ''), bridgeSecret)) {
      res.writeHead(403).end();
      return;
    }
    if (req.url === '/ready' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200).end('{"ready":true}');
      return;
    }
    const importPath = ['/v1/crm/imports/preview', '/v1/crm/imports/confirm'].includes(
      req.url ?? '',
    );
    const bodyLimit = importPath ? 640 * 1024 : 16_384;
    const chunks: Buffer[] = [];
    let bodySize = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bodySize += bytes.byteLength;
      if (bodySize > bodyLimit) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(bytes);
    }
    const body = Buffer.concat(chunks, bodySize);
    if (req.url === '/session' && req.method === 'POST') {
      let code: unknown;
      try {
        code = (JSON.parse(body.toString('utf8')) as { code?: unknown }).code;
      } catch {
        /* Invalid login */
      }
      if (typeof code !== 'string' || !equal(code, loginCode)) {
        res.writeHead(401).end();
        return;
      }
      const token = await new SignJWT({ session_id: identity.session_id, aal: identity.aal })
        .setProtectedHeader({ alg: 'ES256', kid: 'local' })
        .setIssuer(identity.iss)
        .setSubject(identity.sub)
        .setAudience('authenticated')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(key.privateKey);
      res.setHeader(
        'Set-Cookie',
        `rpt.crm-session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
      );
      res.writeHead(204).end();
      return;
    }
    const token = String(req.headers.cookie ?? '')
      .split('; ')
      .find((v) => v.startsWith('rpt.crm-session='))
      ?.slice(16);
    const headers = new Headers();
    headers.set('Content-Type', String(req.headers['content-type'] ?? 'application/json'));
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (req.headers['idempotency-key'])
      headers.set('Idempotency-Key', String(req.headers['idempotency-key']));
    const response = await api.fetch(
      new Request(`http://127.0.0.1${req.url}`, {
        method: req.method ?? 'GET',
        headers,
        ...(body.byteLength ? { body: new Uint8Array(body) } : {}),
      }),
    );
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    res.writeHead(response.status, responseHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
  })().catch(() => {
    if (!res.headersSent) res.writeHead(503);
    res.end();
  });
});
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Local API unavailable');
const next = spawn(
  process.execPath,
  [resolve('node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', '3101'],
  {
    cwd: resolve('apps/web'),
    windowsHide: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      RPT_ENV: 'local',
      RPT_LOCAL_API_ORIGIN: `http://127.0.0.1:${address.port}`,
      RPT_LOCAL_BRIDGE_SECRET: bridgeSecret,
    },
  },
);
console.log('CRM: http://127.0.0.1:3101/crm/commercial');
console.log('Recruiting: http://127.0.0.1:3101/crm/recruiting');
console.log('Agenda: http://127.0.0.1:3101/agenda');
console.log(`Código de sesión local (1 hora): ${loginCode}`);
console.log(
  'Datos sintéticos en PostgreSQL; conservados al recargar. Cada arranque crea un laboratorio aislado.',
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  next.kill();
  server.close();
  await cluster.stop();
}
process.once('SIGINT', () => {
  void stop();
});
process.once('SIGTERM', () => {
  void stop();
});
next.once('exit', () => {
  void stop();
});
