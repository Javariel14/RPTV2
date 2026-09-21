import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { FoundationService } from '@rpt/application';
import { PostgresDatabase } from '@rpt/persistence';
import {
  FoundationError,
  crmListQuery,
  crmSaveView,
  crmViewConfig,
  crmCommand,
  type Identity,
} from '@rpt/contracts';
import { JwtIdentityVerifier } from '@rpt/policy';
import { createApi } from '../../apps/api/src/app.js';
import { startPostgres } from '../helpers/postgres.js';
import { seedCrm } from '../helpers/crm-fixtures.js';

await test('U3 real PostgreSQL + API continuity', { timeout: 240000 }, async (t) => {
  const cluster = await startPostgres();
  let root: Awaited<ReturnType<typeof cluster.migrate>> | undefined;
  try {
    root = await cluster.migrate();
    const admin = root;
    const a = await seedCrm(admin, 'crm-a'),
      b = await seedCrm(admin, 'crm-b', 2);
    const database = new PostgresDatabase(cluster.runtimeConfig());
    const service = new FoundationService(database);
    const query = crmListQuery.parse({ filters: {} });
    const all = { ...query, filters: { ...query.filters, owner: 'all' as const } };
    const list = (identity = a.identities.owner, input = all) =>
      service.listCrm(identity, randomUUID(), input);
    const command = crmSaveView.parse({
      schemaVersion: 1,
      workspaceId: a.workspace,
      name: 'High priority',
      visibility: 'private',
      config: crmViewConfig.parse({ filters: { priority: 'high' } }),
    });
    const key = await generateKeyPair('ES256');
    const jwk = await exportJWK(key.publicKey);
    const verifier = new JwtIdentityVerifier(
      a.identities.owner.iss,
      'authenticated',
      createLocalJWKSet({ keys: [{ ...jwk, kid: 'crm' }] }),
    );
    const api = createApi(service, verifier);
    const token = async (identity: Identity) =>
      new SignJWT({ session_id: identity.session_id, aal: identity.aal })
        .setProtectedHeader({ alg: 'ES256', kid: 'crm' })
        .setIssuer(identity.iss)
        .setSubject(identity.sub)
        .setAudience('authenticated')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(key.privateKey);
    const headers = {
      Authorization: `Bearer ${await token(a.identities.owner)}`,
      'Content-Type': 'application/json',
    };
    await t.test('existing CRM migration applies; runtime cannot bypass RLS', async () => {
      assert.equal(
        (await admin.query('SELECT count(*)::int AS n FROM public.foundation_migration')).rows[0]
          ?.n,
        10,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM pg_tables JOIN pg_class c ON c.oid=(quote_ident(schemaname)||'.'||quote_ident(tablename))::regclass WHERE schemaname IN ('rpt','authz') AND NOT c.relrowsecurity",
          )
        ).rows[0]?.n,
        0,
      );
      await assert.rejects(
        database.request(a.identities.owner, randomUUID(), (c) => c.query('SET ROLE rpt_owner')),
      );
      assert.equal(
        crmCommand.safeParse({ type: 'stage', stage: 'new', permissions: ['admin'] }).success,
        false,
      );
    });
    await t.test(
      'server pagination, every filter, deterministic sort, no PII projection',
      async () => {
        const first = await list();
        assert.equal(first.total, 45);
        assert.equal(first.rows.length, 20);
        const second = await list(a.identities.owner, { ...all, page: 1 });
        assert.equal(new Set([...first.rows, ...second.rows].map((r) => r.id)).size, 40);
        assert.equal((await list(a.identities.owner, { ...all, page: 2 })).rows.length, 5);
        assert.equal((await list(a.identities.owner, { ...all, page: 999 })).total, 45);
        assert.equal(
          first.stages.reduce((n, s) => n + s.count, 0),
          45,
        );
        for (const [field, value] of [
          ['query', 'Persona sintética 045'],
          ['owner', 'mine'],
          ['stage', 'contacted'],
          ['source', 'event'],
          ['status', 'closed'],
          ['activity', 'due'],
          ['priority', 'high'],
        ] as const) {
          const result = await list(a.identities.owner, {
            ...all,
            filters: { ...all.filters, [field]: value },
          });
          assert.ok(result.total > 0);
          if (field !== 'owner') assert.ok(result.total < 45);
        }
        assert.equal(
          (
            await list(a.identities.owner, {
              ...all,
              filters: { ...all.filters, activity: 'inactive' },
            })
          ).total,
          0,
        );
        const reverse = await list(a.identities.owner, { ...all, direction: 'desc' });
        assert.equal(reverse.rows[0]?.name, 'Persona sintética 045');
        for (const sort of ['updated', 'due'] as const)
          assert.equal((await list(a.identities.owner, { ...all, sort })).total, 45);
        assert.equal(
          (
            await list(a.identities.owner, {
              ...all,
              filters: { ...all.filters, query: "%' OR 1=1 --" },
            })
          ).total,
          0,
        );
        assert.equal(JSON.stringify(first).includes('email'), false);
        assert.equal(JSON.stringify(first).includes('phone'), false);
      },
    );
    await t.test(
      'deny sibling, Network and admin; cross-tenant rows/counts/views invisible',
      async () => {
        assert.equal((await list(a.identities.delegate)).total, 0);
        for (const identity of [a.identities.ancestor, a.identities.outsider])
          await assert.rejects(
            list(identity),
            (e) => e instanceof FoundationError && e.code === 'FORBIDDEN',
          );
        assert.equal((await list(b.identities.owner)).total, 2);
        await database.request(a.identities.owner, randomUUID(), async (c) => {
          assert.equal(
            (await c.query('SELECT * FROM rpt.opportunity WHERE tenant_id=$1', [b.tenant]))
              .rowCount,
            0,
          );
        });
        await assert.rejects(
          service.saveCrmView(
            a.identities.owner,
            randomUUID(),
            { ...command, workspaceId: b.workspace },
            randomUUID(),
          ),
          (e) => e instanceof FoundationError && e.code === 'FORBIDDEN',
        );
      },
    );
    let privateId = '';
    await t.test('views persist across service instances; idempotency and audit', async () => {
      const receipt = randomUUID();
      const [one, two] = await Promise.all(
        [1, 2].map(() => service.saveCrmView(a.identities.owner, randomUUID(), command, receipt)),
      );
      assert.deepEqual(one, two);
      privateId = one!.id;
      const fresh = new FoundationService(new PostgresDatabase(cluster.runtimeConfig()));
      assert.deepEqual(
        (await fresh.listCrmViews(a.identities.owner, randomUUID()))[0]?.config,
        command.config,
      );
      assert.equal((await fresh.listCrmViews(b.identities.owner, randomUUID())).length, 0);
      await assert.rejects(
        service.saveCrmView(
          a.identities.owner,
          randomUUID(),
          { ...command, name: 'Different' },
          receipt,
        ),
        (e) => e instanceof FoundationError && e.code === 'CONFLICT',
      );
      assert.ok(
        (
          await admin.query(
            "SELECT 1 FROM rpt.audit_event WHERE tenant_id=$1 AND action='crm.view' AND result='success'",
            [a.tenant],
          )
        ).rowCount! > 0,
      );
    });
    await t.test(
      'shared view never grants CRM access; exact grants, revocation and owner share policy checked again',
      async () => {
        await admin.query(
          `INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
        VALUES($1,$2,$3,$4,'opportunity','read','CONFIDENTIAL',1)`,
          [a.tenant, randomUUID(), a.workspace, a.users.delegate],
        );
        const grant = await service.createGrant(a.identities.owner, randomUUID(), {
          objectId: a.persons[0]!,
          granteeId: a.users.delegate,
          verb: 'read',
          field: 'CONFIDENTIAL',
          until: new Date(Date.now() + 600000).toISOString(),
          reason: 'synthetic U3 test',
        });
        assert.equal((await list(a.identities.delegate)).total, 1);
        const shared = await service.saveCrmView(
          a.identities.owner,
          randomUUID(),
          { ...command, visibility: 'shared', recipients: [a.users.delegate] },
          randomUUID(),
        );
        const team = await service.saveCrmView(
          a.identities.owner,
          randomUUID(),
          { ...command, visibility: 'team' },
          randomUUID(),
        );
        const views = await service.listCrmViews(a.identities.delegate, randomUUID());
        assert.deepEqual(new Set(views.map((v) => v.id)), new Set([shared.id, team.id]));
        assert.equal(
          views.some((v) => v.id === privateId),
          false,
        );
        assert.equal(
          (
            await list(a.identities.delegate, {
              ...all,
              ...command.config,
              filters: { ...command.config.filters, owner: 'all' },
            })
          ).total,
          1,
        );
        await assert.rejects(
          service.saveCrmView(
            a.identities.delegate,
            randomUUID(),
            { ...command, visibility: 'team' },
            randomUUID(),
          ),
          (e) => e instanceof FoundationError && e.code === 'FORBIDDEN',
        );
        await assert.rejects(
          service.saveCrmView(
            a.identities.owner,
            randomUUID(),
            { ...command, visibility: 'shared', recipients: [b.users.owner] },
            randomUUID(),
          ),
        );
        await admin.query(
          "UPDATE authz.workspace_permission SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND verb='share' AND object_type='opportunity'",
          [a.tenant, a.users.owner],
        );
        assert.equal((await service.listCrmViews(a.identities.delegate, randomUUID())).length, 0);
        await service.revokeGrant(a.identities.owner, randomUUID(), grant.id);
        assert.equal((await list(a.identities.delegate)).total, 0);
        assert.equal((await service.listCrmViews(a.identities.delegate, randomUUID())).length, 0);
      },
    );
    await t.test(
      'HTTP auth, validation, persistence, CSRF-independent bearer and revocation',
      async () => {
        assert.equal((await api.request('/v1/crm/opportunities')).status, 401);
        const url = '/v1/crm/opportunities?config=' + encodeURIComponent(JSON.stringify(all));
        const response = await api.request(url, { headers });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const result = (await response.json()) as { data: { total: number } };
        assert.equal(result.data.total, 45);
        assert.equal(
          (await api.request('/v1/crm/opportunities?config=%7B', { headers })).status,
          422,
        );
        assert.equal(
          (
            await api.request(
              '/v1/crm/opportunities?config=' +
                encodeURIComponent(JSON.stringify({ ...all, tenantId: b.tenant })),
              { headers },
            )
          ).status,
          422,
        );
        assert.equal(
          (
            await api.request('/v1/crm/views', {
              method: 'POST',
              headers: { ...headers, 'Idempotency-Key': randomUUID() },
              body: JSON.stringify({ ...command, name: 'API view' }),
            })
          ).status,
          201,
        );
        await admin.query(
          'UPDATE authz.session SET revoked_at=now() WHERE tenant_id=$1 AND id=$2',
          [a.tenant, a.identities.owner.session_id],
        );
        assert.equal((await api.request(url, { headers })).status, 401);
      },
    );
  } finally {
    await root?.end();
    await cluster.stop();
  }
});
