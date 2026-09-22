import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { z } from 'zod';
import { PostgresDatabase } from '@rpt/persistence';
import { FoundationService } from '@rpt/application';
import { FoundationError, activityCommand } from '@rpt/contracts';
import { JwtIdentityVerifier } from '@rpt/policy';
import { FoundationTelemetry } from '@rpt/telemetry';
import { createApi } from '../../apps/api/src/app.js';
import { startPostgres } from '../helpers/postgres.js';
import { seedTenant, fixtureTime } from '../helpers/fixtures.js';

await test('real PostgreSQL Foundation acceptance', { timeout: 240_000 }, async (t) => {
  const cluster = await startPostgres();
  let root: Awaited<ReturnType<typeof cluster.migrate>> | undefined;
  const logs: Readonly<Record<string, unknown>>[] = [];
  const telemetry = new FoundationTelemetry((record) => logs.push(record));
  try {
    root = await cluster.migrate();
    const admin = root;
    const a = await seedTenant(root, 'tenant-a'),
      b = await seedTenant(root, 'tenant-b');
    const db = new PostgresDatabase(cluster.runtimeConfig());
    const service = new FoundationService(db);
    const req = () => randomUUID();
    const key = await generateKeyPair('ES256');
    const jwk = await exportJWK(key.publicKey);
    const verifier = new JwtIdentityVerifier(
      a.identities.owner.iss,
      'authenticated',
      createLocalJWKSet({ keys: [{ ...jwk, kid: 'fixture' }] }),
    );
    const token = async (identity: typeof a.identities.owner) =>
      new SignJWT({
        session_id: identity.session_id,
        aal: identity.aal,
        user_metadata: { tenant_id: b.tenant, role: 'admin' },
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'fixture' })
        .setIssuer(identity.iss)
        .setSubject(identity.sub)
        .setAudience('authenticated')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(key.privateKey);
    const api = createApi(service, verifier, telemetry);
    const activity = activityCommand.parse({
      schemaVersion: 1,
      subjectId: a.person,
      registrationId: a.registrations[1],
      marketId: a.market,
      metric: 'calls',
      value: 3,
      occurredAt: fixtureTime,
      unit: 'count',
    });
    let originalId = '';
    await t.test(
      'forward migrations: all sensitive tables have RLS and runtime is not owner',
      async () => {
        assert.equal(
          (await admin.query('SELECT count(*)::int AS count FROM public.foundation_migration'))
            .rows[0]?.count,
          11,
        );
        const tables = await admin.query(
          "SELECT tablename FROM pg_tables JOIN pg_class c ON c.oid=(quote_ident(schemaname)||'.'||quote_ident(tablename))::regclass WHERE schemaname IN ('rpt','authz') AND NOT c.relrowsecurity",
        );
        assert.equal(tables.rowCount, 0);
        await assert.rejects(
          db.request(a.identities.owner, req(), (client) => client.query('SET ROLE rpt_owner')),
        );
        await assert.rejects(
          db.request(a.identities.owner, req(), (client) =>
            client.query('SELECT * FROM authz.user_account'),
          ),
        );
        await assert.rejects(
          new PostgresDatabase({ ...cluster.runtimeConfig(), user: 'postgres' }).request(
            a.identities.owner,
            req(),
            async () => true,
          ),
        );
      },
    );
    await t.test('1/2 A cannot read or mutate B, even without app filters', async () => {
      await db.request(a.identities.owner, req(), async (client) => {
        assert.equal(
          (await client.query('SELECT * FROM rpt.person WHERE id=$1', [b.person])).rowCount,
          0,
        );
        assert.equal(
          (
            await client.query("UPDATE rpt.person SET display_name='attacker' WHERE id=$1", [
              b.person,
            ])
          ).rowCount,
          0,
        );
        assert.equal(
          (await client.query('SELECT * FROM rpt.person_pii WHERE tenant_id=$1', [b.tenant]))
            .rowCount,
          0,
        );
      });
      await assert.rejects(
        db.request(a.identities.owner, req(), (client) =>
          client.query(
            "INSERT INTO rpt.person(tenant_id,id,workspace_id,owner_id,display_name) VALUES($1,$2,$3,$4,'attack')",
            [b.tenant, req(), b.workspace, a.users.owner],
          ),
        ),
      );
      assert.equal(
        (await service.readPerson(b.identities.owner, req(), b.person)).displayName,
        'Synthetic person',
      );
    });
    await t.test(
      '3/7 server BOLA: foreign/unknown IDs indistinguishable; metadata ignored',
      async () => {
        const bearer = await token(a.identities.owner);
        const foreign = await api.request(`/v1/persons/${b.person}`, {
          headers: { authorization: `Bearer ${bearer}`, 'x-tenant-id': b.tenant },
        });
        const absent = await api.request(`/v1/persons/${req()}`, {
          headers: { authorization: `Bearer ${bearer}` },
        });
        assert.equal(foreign.status, 404);
        assert.equal(absent.status, 404);
        const shape = z.object({ error: z.object({ code: z.string(), retryable: z.boolean() }) });
        assert.deepEqual(
          shape.parse(await foreign.json()).error,
          shape.parse(await absent.json()).error,
        );
        const own = await api.request(`/v1/persons/${a.person}`, {
          headers: { authorization: `Bearer ${bearer}` },
        });
        assert.equal(own.status, 200);
        assert.equal((await api.request(`/v1/persons/${a.person}`)).status, 401);
        assert.equal(
          (
            await api.request(`/v1/persons/${a.person}`, {
              headers: { authorization: `Bearer ${bearer.slice(0, -10)}bad-signature` },
            })
          ).status,
          401,
        );
        await assert.rejects(
          service.readPerson(a.identities.outsider, req(), a.person),
          (e: unknown) => e instanceof FoundationError && e.code === 'NOT_FOUND',
        );
      },
    );
    await t.test('13 concurrent retries produce one event; changed body conflicts', async () => {
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          service.appendActivity(a.identities.owner, req(), activity, 'fixture-original'),
        ),
      );
      originalId = results[0]!.id;
      assert.equal(new Set(results.map((r) => r.id)).size, 1);
      await assert.rejects(
        service.appendActivity(
          a.identities.owner,
          req(),
          { ...activity, value: 4 },
          'fixture-original',
        ),
        (e: unknown) => e instanceof FoundationError && e.code === 'CONFLICT',
      );
      assert.equal(
        (
          await admin.query(
            'SELECT count(*)::int AS count FROM rpt.metric_event_ledger WHERE tenant_id=$1',
            [a.tenant],
          )
        ).rows[0]?.count,
        1,
      );
    });
    await t.test(
      '4 Network statistics do not confer CRM, PII, or structural person access',
      async () => {
        const stats = await service.networkStatistics(
          a.identities.ancestor,
          req(),
          a.registrations[0],
          fixtureTime,
        );
        assert.deepEqual(stats, [{ metric: 'calls', total: '3.000000' }]);
        await db.request(a.identities.ancestor, req(), async (client) => {
          for (const table of [
            'person',
            'person_pii',
            'commercial_membership',
            'metric_event_ledger',
          ])
            assert.equal((await client.query(`SELECT * FROM rpt.${table}`)).rowCount, 0);
        });
        assert.deepEqual(
          await service.networkStatistics(
            a.identities.ancestor,
            req(),
            b.registrations[0],
            fixtureTime,
          ),
          [],
        );
      },
    );
    await t.test(
      '5 delegation is field/verb scoped, cannot redelegate; revocation immediate',
      async () => {
        const read = await service.createGrant(a.identities.owner, req(), {
          objectId: a.person,
          granteeId: a.users.delegate,
          verb: 'read',
          field: 'CONFIDENTIAL',
          until: new Date(Date.now() + 3600_000).toISOString(),
          reason: 'fixture',
        });
        assert.equal(
          (await service.readPerson(a.identities.delegate, req(), a.person)).id,
          a.person,
        );
        await db.request(a.identities.delegate, req(), async (client) => {
          assert.equal((await client.query('SELECT * FROM rpt.person_pii')).rowCount, 0);
          assert.equal(
            (
              await client.query(
                "SELECT authz.allowed('person',$1,'export','CONFIDENTIAL') AS ok",
                [a.person],
              )
            ).rows[0]?.ok,
            false,
          );
        });
        await assert.rejects(
          service.createGrant(a.identities.delegate, req(), {
            objectId: a.person,
            granteeId: a.users.outsider,
            verb: 'read',
            field: 'CONFIDENTIAL',
            until: new Date(Date.now() + 3600_000).toISOString(),
            reason: 'escalation',
          }),
        );
        await service.revokeGrant(a.identities.owner, req(), read.id);
        await assert.rejects(service.readPerson(a.identities.delegate, req(), a.person));
        const second = await service.createGrant(a.identities.owner, req(), {
          objectId: a.person,
          granteeId: a.users.delegate,
          verb: 'read',
          field: 'CONFIDENTIAL',
          until: new Date(Date.now() + 3600_000).toISOString(),
          reason: 'fixture grantor revocation',
        });
        await admin.query(
          'UPDATE authz.role_assignment SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2',
          [a.tenant, a.users.owner],
        );
        await assert.rejects(service.readPerson(a.identities.delegate, req(), a.person));
        await admin.query(
          'UPDATE authz.role_assignment SET revoked_at=NULL WHERE tenant_id=$1 AND user_id=$2',
          [a.tenant, a.users.owner],
        );
        await service.revokeGrant(a.identities.owner, req(), second.id);
      },
    );
    await t.test(
      '6 reparent is temporal, rejects cycles, does not transfer historic CRM',
      async () => {
        await db.request(a.identities.owner, req(), async (client) => {
          await client.query(
            "UPDATE rpt.network_parent SET effective_to='2026-09-02' WHERE id=$1",
            [a.edge],
          );
          await client.query(
            "INSERT INTO rpt.network_parent(tenant_id,id,market_id,child_id,parent_id,effective_from,source,reason) VALUES($1,$2,$3,$4,$5,'2026-09-02','FIXTURE','reparent')",
            [a.tenant, req(), a.market, a.registrations[1], a.registrations[2]],
          );
        });
        await assert.rejects(
          db.request(a.identities.owner, req(), (client) =>
            client.query(
              "INSERT INTO rpt.network_parent(tenant_id,id,market_id,child_id,parent_id,effective_from,source,reason) VALUES($1,$2,$3,$4,$5,'2026-09-02','FIXTURE','cycle')",
              [a.tenant, req(), a.market, a.registrations[2], a.registrations[1]],
            ),
          ),
        );
        assert.deepEqual(
          await service.networkStatistics(
            a.identities.ancestor,
            req(),
            a.registrations[0],
            fixtureTime,
          ),
          [{ metric: 'calls', total: '3.000000' }],
        );
        assert.deepEqual(
          await service.networkStatistics(
            a.identities.ancestor,
            req(),
            a.registrations[0],
            '2026-09-03T12:00:00Z',
          ),
          [],
        );
        await assert.rejects(service.readPerson(a.identities.ancestor, req(), a.person));
        await assert.rejects(
          db.request(a.identities.owner, req(), (client) =>
            client.query(
              "INSERT INTO rpt.commercial_membership(tenant_id,id,person_id,group_id,effective_from,status,source,reason) VALUES($1,$2,$3,$4,'2026-01-01','active','FIXTURE','overlap')",
              [a.tenant, req(), a.person, a.groups[2]],
            ),
          ),
        );
      },
    );
    await t.test('concurrent inverse network edges cannot commit a cycle', async () => {
      const one = req(),
        two = req();
      for (const registration of [one, two]) {
        const group = req();
        await admin.query(
          "INSERT INTO rpt.distribution_group(tenant_id,id,name) VALUES($1,$2,'concurrent fixture')",
          [a.tenant, group],
        );
        await admin.query(
          "INSERT INTO rpt.market_registration(tenant_id,id,group_id,market_id,effective_from) VALUES($1,$2,$3,$4,'2020-01-01')",
          [a.tenant, registration, group, a.market],
        );
      }
      const insert = (child: string, parent: string) =>
        db.request(a.identities.owner, req(), (client) =>
          client.query(
            "INSERT INTO rpt.network_parent(tenant_id,id,market_id,child_id,parent_id,effective_from,source,reason) VALUES($1,$2,$3,$4,$5,'2020-01-01','FIXTURE','concurrent')",
            [a.tenant, req(), a.market, child, parent],
          ),
        );
      const results = await Promise.allSettled([insert(one, two), insert(two, one)]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    });
    await t.test(
      'populated schema upgrade preserves canonical persons and denies before/after',
      async () => {
        let fixture: Awaited<ReturnType<typeof seedTenant>> | undefined;
        const upgraded = await cluster.migrate('rpt_upgrade', Infinity, async (client, count) => {
          if (count === 1) fixture = await seedTenant(client, 'upgrade-fixture');
        });
        try {
          assert(fixture);
          assert.equal(
            (
              await upgraded.query('SELECT display_name FROM rpt.person WHERE id=$1', [
                fixture.person,
              ])
            ).rows[0]?.display_name,
            'Synthetic person',
          );
          const upgradedService = new FoundationService(
            new PostgresDatabase(cluster.runtimeConfig('rpt_upgrade')),
          );
          assert.equal(
            (await upgradedService.readPerson(fixture.identities.owner, req(), fixture.person)).id,
            fixture.person,
          );
          await assert.rejects(
            upgradedService.readPerson(fixture.identities.ancestor, req(), fixture.person),
          );
        } finally {
          await upgraded.end();
        }
      },
    );
    await t.test('9 audit exists on changes and denials; append-only even for owner', async () => {
      const changed = await service.updatePerson(
        a.identities.owner,
        req(),
        a.person,
        'Synthetic changed',
        1,
      );
      assert.equal(changed.version, 2);
      const audit = await admin.query(
        'SELECT action,result,request_id,before_digest,after_digest FROM rpt.audit_event WHERE tenant_id=$1',
        [a.tenant],
      );
      assert(audit.rows.some((r) => r.result === 'deny' && r.action === 'person.read'));
      assert(audit.rows.some((r) => r.action === 'update' && r.before_digest && r.after_digest));
      await assert.rejects(admin.query("UPDATE rpt.audit_event SET reason_code='tampered'"));
      await assert.rejects(admin.query('TRUNCATE rpt.audit_event'));
    });
    await t.test(
      '10 reversal preserves original; wrong-context and duplicates rejected',
      async () => {
        await assert.rejects(
          service.appendActivity(
            a.identities.owner,
            req(),
            { ...activity, value: -3, registrationId: a.registrations[2], reversalOf: originalId },
            'fixture-wrong-reversal',
          ),
        );
        await service.appendActivity(
          a.identities.owner,
          req(),
          { ...activity, value: -3, reversalOf: originalId },
          'fixture-reversal',
        );
        const rows = await admin.query(
          'SELECT event_kind,value::text FROM rpt.metric_event_ledger WHERE tenant_id=$1 ORDER BY recorded_at',
          [a.tenant],
        );
        assert.equal(rows.rowCount, 2);
        assert.equal(rows.rows[0]?.value, '3.000000');
        assert.equal(rows.rows[1]?.value, '-3.000000');
        await assert.rejects(
          service.appendActivity(
            a.identities.owner,
            req(),
            { ...activity, value: -3, reversalOf: originalId },
            'fixture-reversal-again',
          ),
        );
        await assert.rejects(admin.query('DELETE FROM rpt.metric_event_ledger'));
      },
    );
    await t.test(
      '14 AI observation cannot replace official global rank or change source authority',
      async () => {
        const observation = req(),
          rank = req();
        await db.request(a.identities.owner, req(), async (client) => {
          await client.query(
            "INSERT INTO rpt.source_observation(tenant_id,id,source_system,domain_key,subject_id,external_id,source_reference,observed_at,effective_at,verified_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id,facts) VALUES($1,$2,'HYCITE','rank',$3,'fixture-official','fixture://official',now(),now(),now(),'official',$4,$5,'matched',$6,'{\"rankKey\":\"RANK_FIXTURE\"}')",
            [a.tenant, observation, a.groups[1], 'a'.repeat(64), req(), a.users.owner],
          );
          await client.query(
            "INSERT INTO rpt.official_rank_assignment(tenant_id,id,group_id,rank_key,observation_id,effective_from) VALUES($1,$2,$3,'RANK_FIXTURE',$4,'2026-01-01')",
            [a.tenant, rank, a.groups[1], observation],
          );
        });
        const inference = req();
        await db.request(a.identities.ai, req(), async (client) => {
          await client.query(
            "INSERT INTO rpt.source_observation(tenant_id,id,source_system,domain_key,subject_id,external_id,source_reference,observed_at,effective_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id) VALUES($1,$2,'RPT_AI','rank',$3,'fixture-inference','fixture://inference',now(),now(),'inference',$4,$5,'pending_review',$6)",
            [a.tenant, inference, a.groups[1], 'b'.repeat(64), req(), a.users.ai],
          );
        });
        await assert.rejects(
          db.request(a.identities.ai, req(), (client) =>
            client.query('UPDATE rpt.official_rank_assignment SET observation_id=$1 WHERE id=$2', [
              inference,
              rank,
            ]),
          ),
        );
        await assert.rejects(
          db.request(a.identities.ai, req(), (client) =>
            client.query(
              "UPDATE rpt.source_observation SET authority_level='official' WHERE id=$1",
              [inference],
            ),
          ),
        );
        await assert.rejects(
          db.request(a.identities.owner, req(), (client) =>
            client.query(
              "INSERT INTO rpt.official_rank_assignment(tenant_id,id,group_id,rank_key,observation_id,effective_from) VALUES($1,$2,$3,'OTHER_RANK',$4,'2025-01-01')",
              [a.tenant, req(), a.groups[1], observation],
            ),
          ),
        );
        assert.equal(
          (
            await admin.query(
              'SELECT observation_id FROM rpt.official_rank_assignment WHERE id=$1',
              [rank],
            )
          ).rows[0]?.observation_id,
          observation,
        );
      },
    );
    await t.test(
      'privacy deletion is verified, object-scoped, hold-aware and retains ledger',
      async () => {
        const privacy = req(),
          hold = req();
        await assert.rejects(
          db.request(a.identities.owner, req(), (client) =>
            client.query('UPDATE rpt.person SET deleted_at=now() WHERE id=$1', [a.person]),
          ),
        );
        await db.request(a.identities.owner, req(), async (client) => {
          await client.query(
            "INSERT INTO rpt.privacy_request(tenant_id,id,person_id,kind,state,verified_at,due_at,reason_code) VALUES($1,$2,$3,'deletion','approved',now(),now()+interval '7 days','fixture')",
            [a.tenant, privacy, a.person],
          );
          await client.query(
            "INSERT INTO rpt.legal_hold(tenant_id,id,person_id,reason_code) VALUES($1,$2,$3,'fixture')",
            [a.tenant, hold, a.person],
          );
          assert.equal(
            (await client.query('SELECT authz.purge_person($1) AS ok', [privacy])).rows[0]?.ok,
            false,
          );
          await client.query('UPDATE rpt.legal_hold SET active=false WHERE id=$1', [hold]);
          assert.equal(
            (await client.query('SELECT authz.purge_person($1) AS ok', [privacy])).rows[0]?.ok,
            true,
          );
        });
        assert.equal(
          (await admin.query('SELECT * FROM rpt.person_pii WHERE tenant_id=$1', [a.tenant]))
            .rowCount,
          0,
        );
        assert.equal(
          (
            await admin.query('SELECT * FROM rpt.metric_event_ledger WHERE tenant_id=$1', [
              a.tenant,
            ])
          ).rowCount,
          2,
        );
        await assert.rejects(service.readPerson(a.identities.owner, req(), a.person));
        await assert.rejects(
          service.appendActivity(a.identities.owner, req(), activity, 'fixture-after-erasure'),
        );
      },
    );
    await t.test(
      'revoked session blocks still-valid signed JWT; policy revocation immediate',
      async () => {
        const bearer = await token(a.identities.owner);
        await admin.query(
          'UPDATE authz.session SET revoked_at=now() WHERE tenant_id=$1 AND id=$2',
          [a.tenant, a.identities.owner.session_id],
        );
        assert.equal(
          (
            await api.request(`/v1/persons/${a.person}`, {
              headers: { authorization: `Bearer ${bearer}` },
            })
          ).status,
          401,
        );
        await admin.query('UPDATE authz.tenant SET policy_version=2 WHERE id=$1', [b.tenant]);
        await assert.rejects(service.readPerson(b.identities.owner, req(), b.person));
      },
    );
    await t.test('API validation, safe telemetry and contract errors', async () => {
      const bearer = await token(a.identities.delegate);
      const invalid = await api.request('/v1/activities', {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...activity, tenantId: b.tenant }),
      });
      assert.equal(invalid.status, 422);
      await telemetry.flush();
      const serialized = JSON.stringify(logs);
      assert(!serialized.includes('Synthetic'));
      assert(!serialized.includes('example.invalid'));
      assert(!serialized.includes('Bearer'));
      assert(!serialized.includes(a.tenant));
      assert(logs.some((r) => r.event === 'trace'));
      assert(logs.some((r) => r.event === 'otel_metrics'));
      assert.equal(
        (await api.request('/v1/unknown', { headers: { authorization: `Bearer ${bearer}` } }))
          .status,
        404,
      );
    });
    await t.test('8 client credential boundary and 12 forward-fix runbook', async () => {
      const boundary = await readFile('scripts/security-check.ts', 'utf8');
      assert(boundary.includes('service_role'));
      const runbook = await readFile('docs/runbooks/migrations.md', 'utf8');
      assert(runbook.includes('forward-fix'));
    });
    const migrations = (
      await admin.query('SELECT * FROM public.foundation_migration ORDER BY name')
    ).rows as unknown;
    await t.test('encrypted full-cluster restore preserves every table and RLS', async () => {
      const tableNames = (
        await admin.query<{ name: string }>(
          "SELECT schemaname||'.'||tablename AS name FROM pg_tables WHERE schemaname IN ('rpt','authz') ORDER BY 1",
        )
      ).rows;
      async function fingerprints(client: typeof admin) {
        const result: Record<string, { count: number; sha256: string }> = {};
        for (const { name } of tableNames) {
          if (!/^(rpt|authz)\.[a-z_]+$/.test(name)) throw new Error('invalid table');
          const rows = (
            await client.query(
              `SELECT to_jsonb(t)::text AS value FROM ${name} t ORDER BY to_jsonb(t)::text`,
            )
          ).rows as unknown;
          const values = z.array(z.object({ value: z.string() })).parse(rows);
          result[name] = {
            count: values.length,
            sha256: createHash('sha256').update(JSON.stringify(values)).digest('hex'),
          };
        }
        return result;
      }
      const before = await fingerprints(admin);
      await root!.end();
      root = undefined;
      const recoveryStarted = performance.now();
      const restored = await cluster.restore();
      root = restored.root;
      const after = await fingerprints(root);
      assert.deepEqual(after, before);
      await assert.rejects(service.readPerson(b.identities.owner, req(), a.person));
      const untouched = await db.request(
        a.identities.delegate,
        req(),
        async (client) =>
          (await client.query('SELECT * FROM rpt.person WHERE tenant_id=$1', [b.tenant])).rowCount,
      );
      assert.equal(untouched, 0);
      await assert.rejects(root.query("UPDATE rpt.audit_event SET result='success'"));
      await writeFile(
        'work/restore-evidence.json',
        JSON.stringify(
          {
            ...restored.evidence,
            tables: before,
            allFingerprintsMatch: true,
            rlsAfterRestore: true,
            recoveryMs: Math.round(performance.now() - recoveryStarted),
            rpo: 'cold snapshot; no accepted writes while stopped',
            productionPitrValidated: false,
          },
          null,
          2,
        ),
      );
    });
    await writeFile(
      'work/database-test-summary.json',
      JSON.stringify(
        {
          postgres: '17.10',
          migrations,
          syntheticOnly: true,
          completedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } finally {
    await root?.end();
    await cluster.stop();
    await telemetry.shutdown();
  }
});
