import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FoundationService } from '@rpt/application';
import { FoundationError, type CrmCommand, type Identity } from '@rpt/contracts';
import { PostgresDatabase } from '@rpt/persistence';
import { seedCrm } from '../helpers/crm-fixtures.js';
import { startPostgres } from '../helpers/postgres.js';

await test(
  'E1C1 commercial collaborators, activities and referral core',
  { timeout: 240_000 },
  async (t) => {
    const cluster = await startPostgres();
    const root = await cluster.migrate();
    try {
      const a = await seedCrm(root, 'e1c1-a', 5);
      const b = await seedCrm(root, 'e1c1-b', 2);
      const database = new PostgresDatabase(cluster.runtimeConfig());
      const service = new FoundationService(database);
      const opportunityId = a.ids[1]!;
      const denied = (error: unknown) =>
        error instanceof FoundationError && ['NOT_FOUND', 'FORBIDDEN'].includes(error.code);
      const detail = (identity: Identity = a.identities.owner) =>
        service.detailCrm(identity, randomUUID(), opportunityId);
      const run = async (
        command: CrmCommand,
        options: { identity?: Identity; key?: string; expectedVersion?: number } = {},
      ) =>
        service.commandCrm(
          options.identity ?? a.identities.owner,
          randomUUID(),
          opportunityId,
          {
            schemaVersion: 1,
            expectedVersion: options.expectedVersion ?? (await detail()).row.version,
            command,
          },
          options.key ?? randomUUID(),
        );

      await t.test('collaboration is explicit, scoped and immediately revocable', async () => {
        const originalOwner = (await detail()).row.ownerId;
        const until = new Date(Date.now() + 3_600_000).toISOString();
        await run({
          type: 'add_collaborator',
          userId: a.users.delegate,
          access: 'read',
          until,
        });
        const ownerView = await detail();
        assert.equal(ownerView.row.ownerId, originalOwner);
        assert.deepEqual(
          ownerView.collaborators.map(({ userId, access }) => ({ userId, access })),
          [{ userId: a.users.delegate, access: 'read' }],
        );
        const collaboratorView = await detail(a.identities.delegate);
        assert.equal(collaboratorView.row.ownerId, originalOwner);
        assert.equal(collaboratorView.row.canUpdate, false);
        assert.equal(collaboratorView.row.canContact, false);
        assert.equal(collaboratorView.contact, null);
        await assert.rejects(detail(a.identities.ancestor), denied);
        await assert.rejects(
          run({
            type: 'add_collaborator',
            userId: b.users.delegate,
            access: 'read',
            until,
          }),
          denied,
        );
        await run({ type: 'remove_collaborator', userId: a.users.delegate });
        await assert.rejects(detail(a.identities.delegate), denied);
        await run({
          type: 'add_collaborator',
          userId: a.users.delegate,
          access: 'read',
          until,
        });
        await root.query(
          "DELETE FROM authz.role_capability WHERE tenant_id=$1 AND role_key='delegate' AND object_type='opportunity' AND verb='read' AND field_class='CONFIDENTIAL'",
          [a.tenant],
        );
        await assert.rejects(detail(a.identities.delegate), denied);
        assert.equal((await detail()).collaborators.length, 0);
        await root.query(
          "INSERT INTO authz.role_capability VALUES($1,'delegate','opportunity','read','CONFIDENTIAL',false,1)",
          [a.tenant],
        );
        await run({ type: 'remove_collaborator', userId: a.users.delegate });
        assert.equal((await detail()).row.ownerId, originalOwner);
      });

      await t.test('call and message are append-only internal facts with idempotency', async () => {
        const beforeExternal = await root.query<{ observations: number; metrics: number }>(
          `SELECT
          (SELECT count(*)::int FROM rpt.source_observation WHERE tenant_id=$1) observations,
          (SELECT count(*)::int FROM rpt.metric_event_ledger WHERE tenant_id=$1) metrics`,
          [a.tenant],
        );
        const call = {
          type: 'activity' as const,
          kind: 'call' as const,
          occurredAt: '2026-09-21T12:00:00Z',
          summary: 'Synthetic call record',
        };
        const version = (await detail()).row.version;
        const key = randomUUID();
        const first = await run(call, { key, expectedVersion: version });
        const replay = await run(call, { key, expectedVersion: version });
        assert.deepEqual(replay, first);
        await run({
          type: 'activity',
          kind: 'message',
          occurredAt: '2026-09-21T12:05:00Z',
          summary: 'Synthetic message record',
        });
        const after = await detail();
        assert.equal(after.activities.filter((activity) => activity.kind === 'call').length, 1);
        assert.equal(after.activities.filter((activity) => activity.kind === 'message').length, 1);
        assert.ok(after.timeline.some((event) => event.action === 'call'));
        assert.ok(after.timeline.some((event) => event.action === 'message'));
        for (const activity of after.activities) {
          assert.equal(activity.source, 'RPT_USER');
          assert.equal(activity.actorId, a.users.owner);
          assert.ok(activity.requestId);
        }
        await assert.rejects(
          run(
            {
              type: 'activity',
              kind: 'call',
              occurredAt: '2026-09-21T12:10:00Z',
              summary: 'Stale activity',
            },
            { expectedVersion: version },
          ),
          (error) => error instanceof FoundationError && error.code === 'CONFLICT',
        );
        const afterExternal = await root.query<{ observations: number; metrics: number }>(
          `SELECT
          (SELECT count(*)::int FROM rpt.source_observation WHERE tenant_id=$1) observations,
          (SELECT count(*)::int FROM rpt.metric_event_ledger WHERE tenant_id=$1) metrics`,
          [a.tenant],
        );
        assert.deepEqual(afterExternal.rows, beforeExternal.rows);
        await assert.rejects(
          database.request(a.identities.owner, randomUUID(), (client) =>
            client.query("UPDATE rpt.crm_activity SET summary='tampered' WHERE opportunity_id=$1", [
              opportunityId,
            ]),
          ),
        );
      });

      await t.test(
        'referral reuses an authorized same-tenant Person without granting access',
        async () => {
          const peopleBefore = (
            await root.query<{ count: number }>(
              'SELECT count(*)::int count FROM rpt.person WHERE tenant_id=$1',
              [a.tenant],
            )
          ).rows[0]!.count;
          const grantsBefore = (
            await root.query<{ count: number }>(
              'SELECT count(*)::int count FROM authz.access_grant WHERE tenant_id=$1 AND object_id=$2',
              [a.tenant, a.persons[2]],
            )
          ).rows[0]!.count;
          await run({ type: 'set_referral', referrerPersonId: a.persons[2]! });
          const after = await detail();
          assert.equal(after.referrer?.id, a.persons[2]);
          assert.equal(
            (
              await root.query<{ count: number }>(
                'SELECT count(*)::int count FROM rpt.person WHERE tenant_id=$1',
                [a.tenant],
              )
            ).rows[0]!.count,
            peopleBefore,
          );
          assert.equal(
            (
              await root.query<{ count: number }>(
                'SELECT count(*)::int count FROM authz.access_grant WHERE tenant_id=$1 AND object_id=$2',
                [a.tenant, a.persons[2]],
              )
            ).rows[0]!.count,
            grantsBefore,
          );
          await assert.rejects(
            run({ type: 'set_referral', referrerPersonId: b.persons[0]! }),
            (error) => error instanceof FoundationError && error.code === 'INVALID_REQUEST',
          );
          assert.equal((await detail()).referrer?.id, a.persons[2]);
        },
      );

      await t.test('sensitive mutations retain audit and provenance', async () => {
        const audit = await root.query<{ object_type: string; action: string }>(
          `SELECT object_type,action FROM rpt.audit_event
         WHERE tenant_id=$1 AND (object_type IN ('crm_activity','access_grant','opportunity') OR action='crm.command')`,
          [a.tenant],
        );
        assert.ok(audit.rows.some((row) => row.object_type === 'crm_activity'));
        assert.ok(audit.rows.some((row) => row.object_type === 'access_grant'));
        assert.ok(audit.rows.some((row) => row.action === 'crm.command'));
      });
    } finally {
      await root.end();
      await cluster.stop();
    }
  },
);
