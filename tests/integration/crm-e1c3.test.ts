import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FoundationService } from '@rpt/application';
import { crmListQuery, FoundationError } from '@rpt/contracts';
import { PostgresDatabase } from '@rpt/persistence';
import { seedCrm } from '../helpers/crm-fixtures.js';
import { startPostgres } from '../helpers/postgres.js';

await test(
  'E1C3 authorized deterministic commercial intelligence',
  { timeout: 240_000 },
  async (t) => {
    const cluster = await startPostgres();
    const root = await cluster.migrate();
    try {
      const a = await seedCrm(root, 'e1c3-a', 5);
      const b = await seedCrm(root, 'e1c3-b', 1);
      const service = new FoundationService(new PostgresDatabase(cluster.runtimeConfig()));
      const query = crmListQuery.parse({ filters: { owner: 'all' } });
      const list = (identity = a.identities.owner) =>
        service.listCrm(identity, randomUUID(), query);
      const detail = (id: string, identity = a.identities.owner) =>
        service.detailCrm(identity, randomUUID(), id);
      const denied = (error: unknown) =>
        error instanceof FoundationError && ['FORBIDDEN', 'NOT_FOUND'].includes(error.code);

      await t.test('List and Detail expose the same bounded explainable result', async () => {
        const listed = await list();
        const row = listed.rows.find(({ id }) => id === a.ids[1])!;
        const found = await detail(a.ids[1]!);
        for (const key of [
          'relationshipHealth',
          'relationshipHealthReasons',
          'operationalScore',
          'scoreReasons',
          'nextBestActionReason',
          'intelligenceRuleVersion',
        ] as const)
          assert.deepEqual(found.row[key], row[key]);
        const { generatedAt: detailGeneratedAt, ...detailAction } = found.row.nextBestAction;
        const { generatedAt: listGeneratedAt, ...listAction } = row.nextBestAction;
        assert.deepEqual(detailAction, listAction);
        assert.ok(Date.parse(detailGeneratedAt) >= Date.parse(listGeneratedAt));
        assert.ok(row.operationalScore >= 0 && row.operationalScore <= 100);
        assert.ok(row.scoreReasons.length > 0);
        assert.equal(row.nextBestAction.advisory, true);
        assert.match(row.nextBestAction.explanation, /^rpt:/);
        assert.equal(JSON.stringify(listed).includes('email'), false);
        assert.equal(JSON.stringify(listed).includes('phone'), false);
      });

      await t.test(
        'recent activity is recognized without executing an external action',
        async () => {
          const id = a.ids[1]!;
          await root.query(
            "UPDATE rpt.opportunity SET updated_at='2026-08-01',next_action='schedule',next_at=NULL WHERE tenant_id=$1 AND id=$2",
            [a.tenant, id],
          );
          const before = await detail(id);
          assert.equal(before.row.relationshipHealth, 'healthy');
          assert.equal(before.row.relationshipHealthReasons.includes('recent_activity'), false);
          const factsBefore = await root.query<{ activities: number; events: number }>(
            `SELECT
          (SELECT count(*)::int FROM rpt.crm_activity WHERE tenant_id=$1 AND opportunity_id=$2) activities,
          (SELECT count(*)::int FROM rpt.crm_event WHERE tenant_id=$1 AND opportunity_id=$2) events`,
            [a.tenant, id],
          );
          await root.query(
            `INSERT INTO rpt.crm_activity(tenant_id,id,opportunity_id,kind,occurred_at,actor_id,summary,request_id)
         VALUES($1,$2,$3,'call',now(),$4,'Synthetic recent activity',$5)`,
            [a.tenant, randomUUID(), id, a.users.owner, randomUUID()],
          );
          const after = await detail(id);
          assert.equal(after.row.relationshipHealth, 'healthy');
          assert.ok(after.row.relationshipHealthReasons.includes('recent_activity'));
          assert.ok(after.row.operationalScore >= before.row.operationalScore);
          const factsAfter = await root.query<{ activities: number; events: number }>(
            `SELECT
          (SELECT count(*)::int FROM rpt.crm_activity WHERE tenant_id=$1 AND opportunity_id=$2) activities,
          (SELECT count(*)::int FROM rpt.crm_event WHERE tenant_id=$1 AND opportunity_id=$2) events`,
            [a.tenant, id],
          );
          assert.equal(factsAfter.rows[0]!.activities, factsBefore.rows[0]!.activities + 1);
          assert.equal(factsAfter.rows[0]!.events, factsBefore.rows[0]!.events);
          await detail(id);
          assert.deepEqual(
            await root
              .query(
                'SELECT count(*)::int n FROM rpt.crm_activity WHERE tenant_id=$1 AND opportunity_id=$2',
                [a.tenant, id],
              )
              .then((r) => r.rows[0]),
            {
              n: factsAfter.rows[0]!.activities,
            },
          );
        },
      );

      await t.test(
        'overdue task, missing action, objection and commitment drive stable reasons',
        async () => {
          const id = a.ids[2]!;
          const taskId = randomUUID();
          for (const [entryId, kind, due] of [
            [taskId, 'task', '2026-09-01T12:00:00Z'],
            [randomUUID(), 'objection', null],
            [randomUUID(), 'commitment', null],
          ] as const)
            await root.query(
              `INSERT INTO rpt.crm_entry(tenant_id,id,opportunity_id,kind,body,due_at,actor_id)
           VALUES($1,$2,$3,$4,'Synthetic E1C3 signal',$5,$6)`,
              [a.tenant, entryId, id, kind, due, a.users.owner],
            );
          await root.query(
            "UPDATE rpt.opportunity SET next_action='none',next_at=NULL,updated_at='2026-08-01' WHERE tenant_id=$1 AND id=$2",
            [a.tenant, id],
          );
          const result = (await detail(id)).row;
          for (const reason of [
            'overdue_task',
            'missing_next_action',
            'pending_objection',
            'pending_commitment',
          ] as const)
            assert.ok(result.relationshipHealthReasons.includes(reason));
          assert.equal(result.relationshipHealth, 'at_risk');
          assert.equal(result.nextBestAction.type, 'complete_task');
          assert.equal(result.nextBestAction.reference.id, taskId);
          assert.equal(result.nextBestActionReason, 'overdue_task');
        },
      );

      await t.test('future appointment produces a coherent advisory recommendation', async () => {
        const id = a.ids[3]!;
        const appointmentId = randomUUID();
        await root.query(
          `INSERT INTO rpt.appointment(tenant_id,id,opportunity_id,starts_at,timezone,channel)
         VALUES($1,$2,$3,now()+interval '1 day','America/Guayaquil','visit')`,
          [a.tenant, appointmentId, id],
        );
        await root.query(
          "UPDATE rpt.opportunity SET stage='appointment',next_action='demo',next_at=now()+interval '1 day' WHERE tenant_id=$1 AND id=$2",
          [a.tenant, id],
        );
        const result = (await detail(id)).row;
        assert.ok(result.relationshipHealthReasons.includes('scheduled_appointment'));
        assert.equal(result.nextBestAction.type, 'prepare_appointment');
        assert.equal(result.nextBestAction.reference.id, appointmentId);
      });

      await t.test(
        'tenant, Network, explicit collaboration and revocation remain authoritative',
        async () => {
          const id = a.ids[4]!;
          for (const [identity, objectId] of [
            [a.identities.ancestor, id],
            [a.identities.owner, b.ids[0]!],
          ] as const)
            await assert.rejects(detail(objectId, identity), denied);
          assert.equal((await list(a.identities.delegate)).total, 0);
          const version = (await detail(id)).row.version;
          await service.commandCrm(
            a.identities.owner,
            randomUUID(),
            id,
            {
              schemaVersion: 1,
              expectedVersion: version,
              command: {
                type: 'add_collaborator',
                userId: a.users.delegate,
                access: 'read',
                until: new Date(Date.now() + 600_000).toISOString(),
              },
            },
            randomUUID(),
          );
          const delegated = await detail(id, a.identities.delegate);
          assert.equal(delegated.row.canContact, false);
          assert.equal(delegated.contact, null);
          assert.equal(delegated.row.nextBestAction.advisory, true);
          assert.equal((await list(a.identities.delegate)).total, 1);
          await service.commandCrm(
            a.identities.owner,
            randomUUID(),
            id,
            {
              schemaVersion: 1,
              expectedVersion: (await detail(id)).row.version,
              command: { type: 'remove_collaborator', userId: a.users.delegate },
            },
            randomUUID(),
          );
          await assert.rejects(detail(id, a.identities.delegate), denied);
          assert.equal((await list(a.identities.delegate)).total, 0);
        },
      );
    } finally {
      await root.end();
      await cluster.stop();
    }
  },
);
