import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FoundationService } from '@rpt/application';
import { PostgresDatabase } from '@rpt/persistence';
import { FoundationError, type Identity, type crmCommand } from '@rpt/contracts';
import type { z } from 'zod';
import { startPostgres } from '../helpers/postgres.js';
import { seedCrm } from '../helpers/crm-fixtures.js';
import { createApi } from '../../apps/api/src/app.js';
import { JwtIdentityVerifier } from '@rpt/policy';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';

await test('U4 persisted commands, detail and authorization', { timeout: 240000 }, async (t) => {
  const cluster = await startPostgres();
  const root = await cluster.migrate();
  try {
    const a = await seedCrm(root, 'u4-a', 6),
      b = await seedCrm(root, 'u4-b', 2);
    const database = new PostgresDatabase(cluster.runtimeConfig()),
      service = new FoundationService(database);
    const id = a.ids[1]!;
    const approvalKey = randomUUID();
    let approvalInput: {
      schemaVersion: number;
      expectedVersion: number;
      command: z.infer<typeof crmCommand>;
    };
    const detail = (target = id, identity = a.identities.owner) =>
      service.detailCrm(identity, randomUUID(), target);
    const run = async (command: z.infer<typeof crmCommand>, target = id) =>
      service.commandCrm(
        a.identities.owner,
        randomUUID(),
        target,
        { schemaVersion: 1, expectedVersion: (await detail(target)).row.version, command },
        randomUUID(),
      );
    const denied = (error: unknown) =>
      error instanceof FoundationError && error.code === 'NOT_FOUND';
    await t.test('detail hides foreign, unknown, sibling, Network; PII not in list', async () => {
      for (const [target, identity] of [
        [b.ids[0], a.identities.owner],
        [randomUUID(), a.identities.owner],
        [id, a.identities.delegate],
        [id, a.identities.ancestor],
        [id, a.identities.outsider],
      ] as [string, Identity][])
        await assert.rejects(detail(target, identity), denied);
      assert.equal((await detail()).contact, null);
      await run({ type: 'edit_contact', email: 'u4@example.invalid', phone: '+000001' });
      assert.equal((await detail()).contact?.email, 'u4@example.invalid');
      assert.equal(
        JSON.stringify(
          await service.listCrm(a.identities.owner, randomUUID(), { filters: {} }),
        ).includes('u4@example.invalid'),
        false,
      );
    });
    await t.test(
      'concurrent version commands produce one success, retry exactly once, mismatched key conflict',
      async () => {
        const input = {
          schemaVersion: 1,
          expectedVersion: (await detail()).row.version,
          command: { type: 'entry', kind: 'note', text: 'exactly once' },
        };
        const key = randomUUID();
        const results = await Promise.allSettled([
          service.commandCrm(a.identities.owner, randomUUID(), id, input, key),
          service.commandCrm(a.identities.owner, randomUUID(), id, input, randomUUID()),
        ]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(
          results.filter(
            (r) =>
              r.status === 'rejected' &&
              r.reason instanceof FoundationError &&
              r.reason.code === 'CONFLICT',
          ).length,
          1,
        );
        // A separate deterministic key verifies replay without depending on race winner.
        const version = (await detail()).row.version,
          retryKey = randomUUID();
        const retry = {
          schemaVersion: 1,
          expectedVersion: version,
          command: { type: 'entry', kind: 'note', text: 'retry' },
        };
        const first = await service.commandCrm(
          a.identities.owner,
          randomUUID(),
          id,
          retry,
          retryKey,
        );
        assert.deepEqual(
          await service.commandCrm(a.identities.owner, randomUUID(), id, retry, retryKey),
          first,
        );
        await assert.rejects(
          service.commandCrm(
            a.identities.owner,
            randomUUID(),
            id,
            { ...retry, expectedVersion: version + 1 },
            retryKey,
          ),
          (e) => e instanceof FoundationError && e.code === 'CONFLICT',
        );
        assert.equal((await detail()).entries.filter((e) => e.text === 'retry').length, 1);
      },
    );
    await t.test(
      'all CRM commands persist the simulated lifecycle and immutable evidence',
      async () => {
        await assert.rejects(run({ type: 'stage', stage: 'won' }));
        await assert.rejects(run({ type: 'delivery' }));
        await run({ type: 'stage', stage: 'contacted' });
        await run({
          type: 'appointment',
          startsAt: '2026-09-20T15:00:00Z',
          timezone: 'America/Guayaquil',
          channel: 'visit',
        });
        await run({ type: 'demo', outcome: 'purchase_intent_confirmed' });
        await run({
          type: 'quote',
          product: 'Synthetic test product',
          amount: '120.00',
          currency: 'USD',
        });
        await run({
          type: 'quote',
          product: 'Synthetic revision',
          amount: '121.00',
          currency: 'USD',
        });
        await run({ type: 'submit_order' });
        assert.equal((await detail()).row.stage, 'pending_approval');
        await run({ type: 'reconcile_mock', result: 'conflict' });
        assert.equal((await detail()).row.stage, 'pending_approval');
        approvalInput = {
          schemaVersion: 1,
          expectedVersion: (await detail()).row.version,
          command: { type: 'reconcile_mock', result: 'approved' },
        };
        await service.commandCrm(a.identities.owner, randomUUID(), id, approvalInput, approvalKey);
        assert.equal((await detail()).row.stage, 'won_simulated');
        await run({ type: 'delivery' });
        await run({ type: 'curation' });
        for (const kind of ['note', 'task', 'objection', 'commitment'] as const)
          await run({
            type: 'entry',
            kind,
            text: `U4 ${kind}`,
            dueAt: kind === 'task' ? '2026-09-22T10:00:00Z' : null,
          });
        const task = (await detail()).entries.find((e) => e.kind === 'task')!;
        await run({ type: 'complete_task', entryId: task.id });
        await assert.rejects(run({ type: 'complete_task', entryId: b.ids[0]! }), denied);
        const before = await detail();
        await run({
          type: 'edit_person',
          displayName: 'Synthetic renamed',
          personVersion: before.row.personVersion,
        });
        await assert.rejects(
          run({
            type: 'edit_person',
            displayName: 'Stale',
            personVersion: before.row.personVersion,
          }),
          (e) => e instanceof FoundationError && e.code === 'CONFLICT',
        );
        const after = await detail();
        assert.equal(after.row.name, 'Synthetic renamed');
        assert.equal(after.order?.simulatedStatus, 'cured');
        assert.equal(after.quotes.length, 2);
        assert.ok(after.entries.find((e) => e.id === task.id)?.completedAt);
        assert.ok(after.timeline.length >= 15);
        const observations = await root.query(
          'SELECT authority_level,verified_at,facts FROM rpt.source_observation WHERE subject_id=$1',
          [id],
        );
        assert.equal(observations.rowCount, 2);
        for (const o of observations.rows) {
          assert.equal(o.authority_level, 'manual');
          assert.equal(o.verified_at, null);
          assert.equal(o.facts.simulation, true);
        }
        assert.equal(
          (
            await root.query(
              "SELECT count(*)::int n FROM rpt.metric_event_ledger WHERE metric_key='sales'",
            )
          ).rows[0].n,
          0,
        );
        await assert.rejects(
          database.request(a.identities.owner, randomUUID(), (c) =>
            c.query("UPDATE rpt.crm_event SET action='tampered' WHERE opportunity_id=$1", [id]),
          ),
        );
        assert.ok(
          (
            await root.query(
              "SELECT count(*)::int n FROM rpt.audit_event WHERE tenant_id=$1 AND action='crm.command'",
              [a.tenant],
            )
          ).rows[0].n > 0,
        );
      },
    );
    await t.test(
      'API validates shape, idempotency and indistinguishable foreign/unknown errors',
      async () => {
        const keys = await generateKeyPair('ES256');
        const api = createApi(
          service,
          new JwtIdentityVerifier(
            a.identities.owner.iss,
            'authenticated',
            createLocalJWKSet({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'u4' }] }),
          ),
        );
        const identity = a.identities.owner;
        const token = await new SignJWT({ session_id: identity.session_id, aal: identity.aal })
          .setProtectedHeader({ alg: 'ES256', kid: 'u4' })
          .setIssuer(identity.iss)
          .setSubject(identity.sub)
          .setAudience('authenticated')
          .setIssuedAt()
          .setExpirationTime('1h')
          .sign(keys.privateKey);
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        const read = await api.request(`/v1/crm/opportunities/${id}`, { headers });
        assert.equal(read.status, 200);
        assert.equal(read.headers.get('cache-control'), 'no-store');
        for (const target of [b.ids[0]!, randomUUID()]) {
          const get = await api.request(`/v1/crm/opportunities/${target}`, { headers });
          assert.equal(get.status, 404);
          assert.equal(((await get.json()) as { error: { code: string } }).error.code, 'NOT_FOUND');
          const post = await api.request(`/v1/crm/opportunities/${target}/commands`, {
            method: 'POST',
            headers: { ...headers, 'Idempotency-Key': randomUUID() },
            body: JSON.stringify({
              schemaVersion: 1,
              expectedVersion: 1,
              command: { type: 'entry', kind: 'note', text: 'BOLA' },
            }),
          });
          assert.equal(post.status, 404);
          assert.equal(
            ((await post.json()) as { error: { code: string } }).error.code,
            'NOT_FOUND',
          );
        }
        const command = {
          schemaVersion: 1,
          expectedVersion: (await detail()).row.version,
          command: { type: 'entry', kind: 'objection', text: 'API synthetic' },
        };
        const key = randomUUID();
        const post = () =>
          api.request(`/v1/crm/opportunities/${id}/commands`, {
            method: 'POST',
            headers: { ...headers, 'Idempotency-Key': key },
            body: JSON.stringify(command),
          });
        const first = await post(),
          second = await post();
        assert.equal(first.status, 200);
        assert.deepEqual(
          ((await first.json()) as { data: unknown }).data,
          ((await second.json()) as { data: unknown }).data,
        );
        assert.equal(
          (
            await api.request(`/v1/crm/opportunities/${id}/commands`, {
              method: 'POST',
              headers,
              body: JSON.stringify(command),
            })
          ).status,
          422,
        );
        assert.equal(
          (
            await api.request(`/v1/crm/opportunities/${id}/commands`, {
              method: 'POST',
              headers: { ...headers, 'Idempotency-Key': randomUUID() },
              body: JSON.stringify({ ...command, tenantId: b.tenant }),
            })
          ).status,
          422,
        );
        assert.equal((await api.request(`/v1/crm/opportunities/${id}`)).status, 401);
      },
    );
    await t.test('manual authority revocation updates permission and blocks commands', async () => {
      assert.equal((await detail()).permissions.reconcile, true);
      await root.query(
        "UPDATE authz.source_authority SET revoked_at=now() WHERE tenant_id=$1 AND source_system='MANUAL_RECONCILIATION'",
        [a.tenant],
      );
      assert.equal((await detail()).permissions.reconcile, false);
      await assert.rejects(run({ type: 'reconcile_mock', result: 'approved' }), denied);
      await assert.rejects(
        service.commandCrm(a.identities.owner, randomUUID(), id, approvalInput, approvalKey),
        denied,
      );
    });
    await t.test(
      'exact read delegation excludes PII and actions; immediate revocation denies detail and receipt replay',
      async () => {
        const target = a.ids[2]!;
        const personGrant = await service.createGrant(a.identities.owner, randomUUID(), {
          objectId: a.persons[2]!,
          granteeId: a.users.delegate,
          verb: 'read',
          field: 'CONFIDENTIAL',
          until: new Date(Date.now() + 3600000).toISOString(),
          reason: 'synthetic U4 detail',
        });
        const grant = (
          await database.request(
            a.identities.owner,
            randomUUID(),
            async (c) =>
              (
                await c.query<{ id: string }>(
                  "SELECT authz.crm_grant($1,$2,'read',now()+interval '1 hour','U4 test') id",
                  [target, a.users.delegate],
                )
              ).rows[0]!,
          )
        ).id;
        const read = await detail(target, a.identities.delegate);
        assert.equal(read.row.canUpdate, false);
        assert.equal(read.row.canContact, false);
        assert.equal(read.contact, null);
        assert.equal(read.entries.length, 0);
        await assert.rejects(
          service.commandCrm(
            a.identities.delegate,
            randomUUID(),
            target,
            {
              schemaVersion: 1,
              expectedVersion: read.row.version,
              command: { type: 'stage', stage: 'contacted' },
            },
            randomUUID(),
          ),
          denied,
        );
        for (const [type, verb] of [
          ['opportunity', 'update'],
          ['entry', 'read'],
          ['entry', 'create'],
          ['activity', 'create'],
        ])
          await root.query(
            "INSERT INTO authz.role_capability VALUES($1,'delegate',$2,$3,'CONFIDENTIAL',false,1)",
            [a.tenant, type, verb],
          );
        const updateGrant = await database.request(
          a.identities.owner,
          randomUUID(),
          async (c) =>
            (
              await c.query<{ id: string }>(
                "SELECT authz.crm_grant($1,$2,'update',now()+interval '1 hour','U4 exact update') id",
                [target, a.users.delegate],
              )
            ).rows[0]!.id,
        );
        const delegated = await detail(target, a.identities.delegate);
        assert.equal(delegated.permissions.notes, true);
        assert.equal(delegated.permissions.editPerson, false);
        assert.equal(delegated.permissions.editContact, false);
        const delegatedInput = {
          schemaVersion: 1,
          expectedVersion: delegated.row.version,
          command: { type: 'entry', kind: 'note', text: 'explicit delegation' },
        };
        const delegatedKey = randomUUID();
        await service.commandCrm(
          a.identities.delegate,
          randomUUID(),
          target,
          delegatedInput,
          delegatedKey,
        );
        await root.query('UPDATE authz.access_grant SET revoked_at=now() WHERE id=$1', [
          updateGrant,
        ]);
        await assert.rejects(
          service.commandCrm(
            a.identities.delegate,
            randomUUID(),
            target,
            delegatedInput,
            delegatedKey,
          ),
          denied,
        );
        await root.query('UPDATE authz.access_grant SET revoked_at=now() WHERE id=$1', [grant]);
        await assert.rejects(detail(target, a.identities.delegate), denied);
        await service.revokeGrant(a.identities.owner, randomUUID(), personGrant.id);
        const key = randomUUID(),
          input = {
            schemaVersion: 1,
            expectedVersion: (await detail(target)).row.version,
            command: { type: 'entry', kind: 'note', text: 'before revoke' },
          };
        await service.commandCrm(a.identities.owner, randomUUID(), target, input, key);
        await root.query(
          "DELETE FROM authz.role_capability WHERE tenant_id=$1 AND role_key='owner' AND object_type='entry' AND verb='create'",
          [a.tenant],
        );
        await assert.rejects(
          service.commandCrm(a.identities.owner, randomUUID(), target, input, key),
          denied,
        );
        await root.query('UPDATE authz.session SET revoked_at=now() WHERE id=$1', [
          a.identities.owner.session_id,
        ]);
        await assert.rejects(
          detail(),
          (e) => e instanceof FoundationError && e.code === 'UNAUTHENTICATED',
        );
      },
    );
    await t.test('U4 volume after ANALYZE retains bounded U3 permission scans', async () => {
      const volume = await seedCrm(root, 'u4-volume', 45);
      await root.query('ANALYZE');
      const result = await service.listCrm(volume.identities.owner, randomUUID(), { filters: {} });
      assert.equal(result.total, 45);
      assert.equal(result.rows.length, 20);
    });
  } finally {
    await root.end();
    await cluster.stop();
  }
});
