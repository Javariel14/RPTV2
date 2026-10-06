import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server.js';
import { FoundationError, type Identity } from '@rpt/contracts';
import { OrderReadService } from '@rpt/application';
import { createApi } from '../../apps/api/src/app.js';
import { GET } from '../../apps/web/app/api/orders/[[...path]]/route.js';
import { startPostgres } from '../helpers/postgres.js';
import { seedCrm } from '../helpers/crm-fixtures.js';
import { seedOrderReadWorkspace } from '../helpers/order-commercial.js';

void test(
  'E3C3A loopback BFF preserves canonical Order authorization',
  { timeout: 300_000 },
  async (t) => {
    const cluster = await startPostgres();
    const root = await cluster.migrate();
    const saved = {
      env: process.env.RPT_ENV,
      origin: process.env.RPT_LOCAL_API_ORIGIN,
      secret: process.env.RPT_LOCAL_BRIDGE_SECRET,
    };
    const server = createServer();
    try {
      const tenant = await seedCrm(root, 'order-bff-crm');
      const f = await seedOrderReadWorkspace(root, cluster.runtimeConfig(), tenant);
      const identities: Record<string, Identity> = {
        owner: tenant.identities.owner,
        creator: f.createOnly,
        revoked: f.revoked,
        empty: f.empty,
      };
      const api = createApi(
        f.foundation,
        {
          verify: async (token) => {
            const identity = identities[token];
            if (!identity) throw new FoundationError('UNAUTHENTICATED');
            return identity;
          },
        },
        undefined,
        new OrderReadService(f.db),
      );
      const secret = randomUUID();
      let forwarded = 0;
      let bridgeRequestId = '';
      server.on('request', (req, res) => {
        void (async () => {
          assert.equal(req.headers['x-rpt-bridge'], secret);
          assert.equal(req.method, 'GET');
          assert.equal(req.headers.authorization, undefined);
          assert.equal(req.headers['x-tenant-id'], undefined);
          assert.equal(req.headers['x-forwarded-host'], undefined);
          forwarded++;
          const token = String(req.headers.cookie ?? '').match(/^rpt\.crm-session=([^;]+)$/)?.[1];
          const response = await api.fetch(
            new Request(`http://127.0.0.1${req.url}`, {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
            }),
          );
          bridgeRequestId = response.headers.get('X-Request-Id')!;
          res.writeHead(response.status, {
            'Content-Type': 'application/json',
            'X-Request-Id': bridgeRequestId,
          });
          res.end(await response.text());
        })().catch(() => {
          res.writeHead(503).end();
        });
      });
      await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      process.env.RPT_ENV = 'local';
      process.env.RPT_LOCAL_API_ORIGIN = `http://127.0.0.1:${address.port}`;
      process.env.RPT_LOCAL_BRIDGE_SECRET = secret;
      const request = (path = '', query = '', actor = 'owner', method = 'GET') =>
        GET(
          new NextRequest(`http://127.0.0.1:3101/api/orders${path ? '/' + path : ''}${query}`, {
            method,
            headers: {
              Cookie: `rpt.crm-session=${actor}; unrelated=private`,
              Authorization: 'Bearer attacker',
              'X-Tenant-Id': f.foreign.a.tenant,
              'X-Forwarded-Host': 'attacker.invalid',
            },
          }),
          { params: Promise.resolve({ path: path ? path.split('/') : [] }) },
        );
      const publicError = async (response: Response) => {
        const body = (await response.json()) as { error: { code: string; retryable: boolean } };
        return { status: response.status, code: body.error.code, retryable: body.error.retryable };
      };
      await t.test(
        'real CRM tenant session reads canonical list, snapshot and history',
        async () => {
          const response = await request('', '?limit=10');
          assert.equal(response.status, 200);
          assert.equal(response.headers.get('X-Request-Id'), bridgeRequestId);
          assert.equal(response.headers.get('Cache-Control'), 'no-store');
          const page = (await response.json()) as {
            data: { items: { id: string }[]; nextCursor: string };
          };
          assert.equal(page.data.items.length, 10);
          assert.ok(page.data.nextCursor);
          const next = await request('', `?limit=10&cursor=${page.data.nextCursor}`);
          const tail = (await next.json()) as { data: { items: { id: string }[] } };
          assert.equal(tail.data.items.length, 2);
          assert.equal(new Set([...page.data.items, ...tail.data.items].map((x) => x.id)).size, 12);
          const detail = await request(f.orders[0]!.id);
          assert.equal(detail.status, 200);
          const snapshot = await detail.text();
          assert.ok(snapshot.includes('financing'));
          assert.ok(snapshot.includes('appliedAdjustments'));
          assert.equal(snapshot.includes(secret), false);
          assert.equal(snapshot.includes('Bearer'), false);
          assert.equal((await request(`${f.orders[0]!.id}/history`)).status, 200);
        },
      );
      await t.test('path, method and query denial occurs before forwarding', async () => {
        const before = forwarded;
        for (const path of [
          'session',
          'https://attacker.invalid',
          `${randomUUID()}/commands`,
          `${randomUUID()}/history/extra`,
        ])
          assert.equal((await request(path)).status, 404);
        for (const query of [
          '?unknown=1',
          '?__proto__=ignored',
          '?limit=10&limit=20',
          '?limit=101',
          '?limit=0',
          '?cursor=%25',
          '?status=paid',
          '?businessOrderNumber=ORD-1',
        ])
          assert.equal((await request('', query)).status, 422);
        assert.equal((await request(f.orders[0]!.id, '?limit=1')).status, 422);
        assert.equal((await request(`${f.orders[0]!.id}/history`, '?status=created')).status, 422);
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
          assert.equal((await request('', '', 'owner', method)).status, 405);
        assert.equal(forwarded, before);
        const tunneled = await GET(
          new NextRequest('http://127.0.0.1:3101/api/orders', {
            headers: { 'X-HTTP-Method-Override': 'POST' },
          }),
          { params: Promise.resolve({ path: [] }) },
        );
        assert.equal(tunneled.status, 422);
        assert.equal(forwarded, before);
        const malformed = await request('', '?cursor=A');
        assert.deepEqual(await publicError(malformed), {
          status: 422,
          code: 'INVALID_REQUEST',
          retryable: false,
        });
      });
      await t.test(
        'create-only, revoked and foreign identities cannot obtain ordinary reads',
        async () => {
          for (const actor of ['creator', 'revoked']) {
            const list = await request('', '', actor);
            assert.deepEqual(
              ((await list.json()) as { data: { items: unknown[] } }).data.items,
              [],
            );
            assert.equal((await request(f.orders[0]!.id, '', actor)).status, 404);
            assert.equal((await request(`${f.orders[0]!.id}/history`, '', actor)).status, 404);
          }
          for (const suffix of ['', '/history']) {
            assert.deepEqual(
              await publicError(await request(f.foreignOrder.id + suffix)),
              await publicError(await request(randomUUID() + suffix)),
            );
          }
          const foreignNumber = await request(
            '',
            `?businessOrderNumber=${f.foreignOrder.businessOrderNumber}`,
            'empty',
          );
          assert.deepEqual(
            ((await foreignNumber.json()) as { data: { items: unknown[] } }).data.items,
            [],
          );
          assert.equal((await request('', '', '')).status, 401);
        },
      );
      await t.test('revocation is rechecked on the next request', async () => {
        assert.equal((await request(f.orders[0]!.id)).status, 200);
        assert.equal((await request(`${f.orders[0]!.id}/history`, '?limit=1')).status, 200);
        await root.query(
          "UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND object_type='cpq_order' AND verb='read'",
          [tenant.tenant, tenant.users.owner],
        );
        assert.equal((await request(f.orders[0]!.id)).status, 404);
        assert.deepEqual(
          await publicError(await request(`${f.orders[0]!.id}/history`)),
          await publicError(await request(`${randomUUID()}/history`)),
        );
        assert.deepEqual(
          ((await (await request()).json()) as { data: { items: unknown[] } }).data.items,
          [],
        );
        assert.equal(
          (
            await root.query(
              'SELECT count(*)::integer AS n FROM rpt.cpq_order WHERE tenant_id=$1',
              [tenant.tenant],
            )
          ).rows[0].n,
          12,
        );
      });
      await t.test('environment and bridge failure are safe', async () => {
        process.env.RPT_ENV = 'production';
        assert.equal((await request()).status, 503);
        process.env.RPT_ENV = 'local';
        process.env.RPT_LOCAL_API_ORIGIN = 'https://attacker.invalid';
        assert.equal((await request()).status, 503);
        process.env.RPT_LOCAL_API_ORIGIN = 'http://127.0.0.1:1';
        const response = await request();
        assert.match(response.headers.get('X-Request-Id')!, /^[0-9a-f-]{36}$/);
        assert.deepEqual(await publicError(response), {
          status: 503,
          code: 'UNAVAILABLE',
          retryable: true,
        });
      });
    } finally {
      for (const [name, value] of Object.entries({
        RPT_ENV: saved.env,
        RPT_LOCAL_API_ORIGIN: saved.origin,
        RPT_LOCAL_BRIDGE_SECRET: saved.secret,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (server.listening) await new Promise<void>((ok) => server.close(() => ok()));
      await root.end();
      await cluster.stop();
    }
  },
);
