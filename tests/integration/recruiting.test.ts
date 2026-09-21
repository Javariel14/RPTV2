import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { FoundationError, type Identity } from '@rpt/contracts';
import { FoundationService } from '@rpt/application';
import { PostgresDatabase } from '@rpt/persistence';
import { createApi } from '../../apps/api/src/app.js';
import { seedTenant } from '../helpers/fixtures.js';
import { startPostgres } from '../helpers/postgres.js';

void test('E1A Recruiting CRM Core', async (t) => {
  const cluster = await startPostgres();
  const root = await cluster.migrate();
  try {
    const a = await seedTenant(root, 'recruiting-a');
    const b = await seedTenant(root, 'recruiting-b');
    const workspaces = { a: randomUUID(), b: randomUUID() };
    for (const [fixture, workspace] of [
      [a, workspaces.a],
      [b, workspaces.b],
    ] as const) {
      await root.query(
        "INSERT INTO rpt.crm_workspace(tenant_id,id,name,registration_id,kind) VALUES($1,$2,'Recruiting test',$3,'recruitment')",
        [fixture.tenant, workspace, fixture.registrations[1]],
      );
      await root.query(
        "INSERT INTO rpt.feature_flag(tenant_id,id,key,policy_version,enabled,rollout_percent,effective_from) VALUES($1,$2,'recruiting_crm_core',1,true,100,'2020-01-01')",
        [fixture.tenant, randomUUID()],
      );
      for (const verb of ['read', 'create', 'update', 'reassign', 'share']) {
        await root.query(
          "INSERT INTO authz.role_capability VALUES($1,'owner','recruitment_profile',$2,'CONFIDENTIAL',false,1)",
          [fixture.tenant, verb],
        );
        await root.query(
          `INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
           VALUES($1,$2,$3,$4,'recruitment_profile',$5,'CONFIDENTIAL',1)`,
          [fixture.tenant, randomUUID(), workspace, fixture.users.owner, verb],
        );
      }
      await root.query(
        `INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
         VALUES($1,$2,$3,$4,'person','create','CONFIDENTIAL',1)`,
        [fixture.tenant, randomUUID(), workspace, fixture.users.owner],
      );
      for (const [objectType, verbs] of Object.entries({
        recruitment_appointment: ['read', 'create'],
        recruitment_interview: ['read', 'create'],
        recruitment_followup: ['read', 'create', 'update'],
        recruitment_hook: ['read', 'create'],
      }))
        for (const verb of verbs)
          await root.query(
            "INSERT INTO authz.role_capability VALUES($1,'owner',$2,$3,'CONFIDENTIAL',false,1)",
            [fixture.tenant, objectType, verb],
          );
      for (const verb of ['read', 'update'])
        await root.query(
          "INSERT INTO authz.role_capability VALUES($1,'delegate','recruitment_profile',$2,'CONFIDENTIAL',false,1)",
          [fixture.tenant, verb],
        );
    }

    const database = new PostgresDatabase(cluster.runtimeConfig());
    const service = new FoundationService(database);
    const createExisting = {
      schemaVersion: 1 as const,
      workspaceId: workspaces.a,
      person: { mode: 'existing' as const, id: a.person },
      source: 'referral' as const,
      priority: null,
    };
    const personCountBefore = Number(
      (await root.query('SELECT count(*) n FROM rpt.person WHERE tenant_id=$1', [a.tenant])).rows[0]
        .n,
    );
    const created = await service.createRecruitmentProfile(
      a.identities.owner,
      randomUUID(),
      createExisting,
      'create-existing-01',
    );

    await t.test(
      'existing Person is reused without Opportunity or duplicate identity',
      async () => {
        const replay = await service.createRecruitmentProfile(
          a.identities.owner,
          randomUUID(),
          createExisting,
          'create-existing-01',
        );
        assert.deepEqual(replay, created);
        assert.equal(
          Number(
            (await root.query('SELECT count(*) n FROM rpt.person WHERE tenant_id=$1', [a.tenant]))
              .rows[0].n,
          ),
          personCountBefore,
        );
        assert.equal(
          Number(
            (
              await root.query('SELECT count(*) n FROM rpt.opportunity WHERE tenant_id=$1', [
                a.tenant,
              ])
            ).rows[0].n,
          ),
          0,
        );
      },
    );

    await t.test(
      'Person plus profile can be created atomically without commercial side effects',
      async () => {
        const value = await service.createRecruitmentProfile(
          a.identities.owner,
          randomUUID(),
          {
            schemaVersion: 1,
            workspaceId: workspaces.a,
            person: {
              mode: 'new',
              displayName: 'Candidate synthetic',
              email: 'candidate@example.invalid',
              phone: '+000000001',
            },
            source: 'manual',
            priority: null,
          },
          'create-new-person-01',
        );
        const detail = await service.detailRecruitmentProfile(
          a.identities.owner,
          randomUUID(),
          value.id,
        );
        assert.equal(detail.row.displayName, 'Candidate synthetic');
        assert.equal(detail.contact?.email, 'candidate@example.invalid');
        assert.notEqual(detail.row.personId, a.person);
        assert.equal(
          Number(
            (
              await root.query('SELECT count(*) n FROM rpt.opportunity WHERE tenant_id=$1', [
                a.tenant,
              ])
            ).rows[0].n,
          ),
          0,
        );
      },
    );

    await t.test('authorized list/detail are tenant isolated and BOLA-safe', async () => {
      const list = await service.listRecruitmentProfiles(a.identities.owner, randomUUID(), {
        workspaceId: workspaces.a,
      });
      assert.equal(list.total, 2);
      assert.ok(list.rows.every((row) => row.workspaceId === workspaces.a));
      for (const target of [created.id, randomUUID()])
        await assert.rejects(
          service.detailRecruitmentProfile(b.identities.owner, randomUUID(), target),
          (error) => error instanceof FoundationError && error.code === 'NOT_FOUND',
        );
      await assert.rejects(
        service.listRecruitmentProfiles(b.identities.owner, randomUUID(), {
          workspaceId: workspaces.a,
        }),
        (error) => error instanceof FoundationError && error.code === 'FORBIDDEN',
      );
    });

    await t.test('Network ancestry grants no Recruiting CRM access', async () => {
      await assert.rejects(
        service.detailRecruitmentProfile(a.identities.ancestor, randomUUID(), created.id),
        (error) => error instanceof FoundationError && error.code === 'NOT_FOUND',
      );
    });

    await t.test(
      'explicit delegation works, missing action permission is forbidden, revocation is immediate',
      async () => {
        const personGrant = await service.createGrant(a.identities.owner, randomUUID(), {
          objectId: a.person,
          granteeId: a.users.delegate,
          verb: 'read',
          field: 'CONFIDENTIAL',
          until: new Date(Date.now() + 3_600_000).toISOString(),
          reason: 'E1A person read',
        });
        const profileGrants = [randomUUID(), randomUUID()];
        for (const [index, verb] of ['read', 'update'].entries())
          await root.query(
            `INSERT INTO authz.access_grant(tenant_id,id,object_type,object_id,grantor_id,grantee_id,verb,field_class,effective_from,effective_to,policy_version,reason)
           VALUES($1,$2,'recruitment_profile',$3,$4,$5,$6,'CONFIDENTIAL',now(),now()+interval '1 hour',1,'E1A explicit delegation')`,
            [a.tenant, profileGrants[index], created.id, a.users.owner, a.users.delegate, verb],
          );
        const access = await database.request(
          a.identities.delegate,
          randomUUID(),
          async (client) =>
            (
              await client.query(
                `SELECT authz.allowed('person',$1,'read','CONFIDENTIAL') person_read,
              authz.allowed('recruitment_profile',$2,'read','CONFIDENTIAL') profile_read,
              authz.recruiting_allowed($2,'read') recruiting_read`,
                [a.person, created.id],
              )
            ).rows[0],
        );
        assert.deepEqual(access, { person_read: true, profile_read: true, recruiting_read: true });
        assert.equal(
          (await service.detailRecruitmentProfile(a.identities.delegate, randomUUID(), created.id))
            .row.canUpdate,
          true,
        );
        await assert.rejects(
          service.commandRecruitmentProfile(
            a.identities.delegate,
            randomUUID(),
            created.id,
            {
              schemaVersion: 1,
              expectedVersion: created.version,
              command: {
                type: 'followup',
                dueAt: '2026-10-01T12:00:00Z',
                text: 'Not authorized',
              },
            },
            'delegate-followup-01',
          ),
          (error) => error instanceof FoundationError && error.code === 'FORBIDDEN',
        );
        await root.query(
          'UPDATE authz.access_grant SET revoked_at=now() WHERE id=ANY($1::uuid[])',
          [profileGrants],
        );
        await assert.rejects(
          service.detailRecruitmentProfile(a.identities.delegate, randomUUID(), created.id),
          (error) => error instanceof FoundationError && error.code === 'NOT_FOUND',
        );
        await service.revokeGrant(a.identities.owner, randomUUID(), personGrant.id);
      },
    );

    const command = async (value: unknown, key = randomUUID()) => {
      const current = await service.detailRecruitmentProfile(
        a.identities.owner,
        randomUUID(),
        created.id,
      );
      return service.commandRecruitmentProfile(
        a.identities.owner,
        randomUUID(),
        created.id,
        { schemaVersion: 1, expectedVersion: current.row.version, command: value },
        key,
      );
    };

    await t.test('commercial and recruiting lifecycles remain independent', async () => {
      const opportunity = randomUUID();
      await root.query(
        `INSERT INTO rpt.opportunity(tenant_id,id,person_id,workspace_id,owner_id,title,source)
         VALUES($1,$2,$3,$4,$5,'Independent commercial','manual')`,
        [a.tenant, opportunity, a.person, a.workspace, a.users.owner],
      );
      await command({ type: 'stage', stage: 'initial_contact' });
      assert.equal(
        (
          await root.query('SELECT stage FROM rpt.opportunity WHERE tenant_id=$1 AND id=$2', [
            a.tenant,
            opportunity,
          ])
        ).rows[0].stage,
        'new',
      );
      assert.equal(
        (await service.detailRecruitmentProfile(a.identities.owner, randomUUID(), created.id)).row
          .stage,
        'initial_contact',
      );
    });

    await t.test(
      'priority is operational, concurrency conflicts and sensitive commands are idempotent',
      async () => {
        const before = await service.detailRecruitmentProfile(
          a.identities.owner,
          randomUUID(),
          created.id,
        );
        const priorityInput = {
          schemaVersion: 1 as const,
          expectedVersion: before.row.version,
          command: { type: 'priority' as const, priority: 'A' as const },
        };
        const priorityKey = 'priority-command-01';
        const first = await service.commandRecruitmentProfile(
          a.identities.owner,
          randomUUID(),
          created.id,
          priorityInput,
          priorityKey,
        );
        const replay = await service.commandRecruitmentProfile(
          a.identities.owner,
          randomUUID(),
          created.id,
          priorityInput,
          priorityKey,
        );
        assert.deepEqual(replay, first);
        await assert.rejects(
          service.commandRecruitmentProfile(
            a.identities.owner,
            randomUUID(),
            created.id,
            {
              schemaVersion: 1,
              expectedVersion: before.row.version,
              command: { type: 'substatus', substatus: 'contacted' },
            },
            'stale-command-01',
          ),
          (error) => error instanceof FoundationError && error.code === 'CONFLICT',
        );
        const detail = await service.detailRecruitmentProfile(
          a.identities.owner,
          randomUUID(),
          created.id,
        );
        assert.equal(detail.row.priority, 'A');
        const comment = (
          await root.query(
            "SELECT col_description('rpt.recruitment_profile'::regclass,attnum) value FROM pg_attribute WHERE attrelid='rpt.recruitment_profile'::regclass AND attname='priority'",
          )
        ).rows[0].value as string;
        assert.match(comment, /Operational recruiting priority/);
        assert.equal(
          Number(
            (
              await root.query(
                "SELECT count(*) n FROM rpt.recruitment_event WHERE tenant_id=$1 AND profile_id=$2 AND action='priority.changed'",
                [a.tenant, created.id],
              )
            ).rows[0].n,
          ),
          1,
        );
      },
    );

    await t.test(
      'appointment, interview, followup completion and boundary hooks persist',
      async () => {
        await command({
          type: 'appointment',
          startsAt: '2026-10-02T15:00:00Z',
          timezone: 'America/Guayaquil',
          channel: 'video',
        });
        await command({
          type: 'interview',
          occurredAt: '2026-10-02T16:00:00Z',
          outcome: 'attended',
          notes: 'Objective evidence only',
        });
        const followupKey = 'followup-idempotent-01';
        const before = await service.detailRecruitmentProfile(
          a.identities.owner,
          randomUUID(),
          created.id,
        );
        const followupInput = {
          schemaVersion: 1 as const,
          expectedVersion: before.row.version,
          command: {
            type: 'followup' as const,
            dueAt: '2026-10-03T12:00:00Z',
            text: 'Follow up synthetic',
          },
        };
        await service.commandRecruitmentProfile(
          a.identities.owner,
          randomUUID(),
          created.id,
          followupInput,
          followupKey,
        );
        await service.commandRecruitmentProfile(
          a.identities.owner,
          randomUUID(),
          created.id,
          followupInput,
          followupKey,
        );
        let detail = await service.detailRecruitmentProfile(
          a.identities.owner,
          randomUUID(),
          created.id,
        );
        assert.equal(detail.appointments.length, 1);
        assert.equal(detail.interviews.length, 1);
        assert.equal(detail.followups.length, 1);
        await command({ type: 'complete_followup', followupId: detail.followups[0]!.id });
        await command({ type: 'hook', kind: 'training', reference: 'future-training-boundary' });
        await command({ type: 'hook', kind: 'onboarding', reference: null });
        detail = await service.detailRecruitmentProfile(
          a.identities.owner,
          randomUUID(),
          created.id,
        );
        assert.ok(detail.followups[0]?.completedAt);
        assert.deepEqual(detail.hooks.map((hook) => hook.kind).sort(), ['onboarding', 'training']);
      },
    );

    await t.test('owner reassignment requires explicit workspace permission', async () => {
      const second = await service.createRecruitmentProfile(
        a.identities.owner,
        randomUUID(),
        {
          schemaVersion: 1,
          workspaceId: workspaces.a,
          person: { mode: 'new', displayName: 'Reassignment target', email: '', phone: '' },
          source: 'event',
          priority: 'B',
        },
        'create-reassign-01',
      );
      await assert.rejects(
        service.commandRecruitmentProfile(
          a.identities.owner,
          randomUUID(),
          second.id,
          {
            schemaVersion: 1,
            expectedVersion: second.version,
            command: { type: 'reassign_owner', ownerId: a.users.delegate },
          },
          'reassign-denied-01',
        ),
        (error) => error instanceof FoundationError && error.code === 'FORBIDDEN',
      );
      for (const verb of ['read', 'update'])
        await root.query(
          `INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
           VALUES($1,$2,$3,$4,'recruitment_profile',$5,'CONFIDENTIAL',1)`,
          [a.tenant, randomUUID(), workspaces.a, a.users.delegate, verb],
        );
      const secondPerson = (
        await service.detailRecruitmentProfile(a.identities.owner, randomUUID(), second.id)
      ).row.personId;
      await service.createGrant(a.identities.owner, randomUUID(), {
        objectId: secondPerson,
        granteeId: a.users.delegate,
        verb: 'read',
        field: 'CONFIDENTIAL',
        until: new Date(Date.now() + 3_600_000).toISOString(),
        reason: 'E1A reassigned profile identity',
      });
      const reassigned = await service.commandRecruitmentProfile(
        a.identities.owner,
        randomUUID(),
        second.id,
        {
          schemaVersion: 1,
          expectedVersion: second.version,
          command: { type: 'reassign_owner', ownerId: a.users.delegate },
        },
        'reassign-allowed-01',
      );
      assert.equal(reassigned.version, 2);
      assert.equal(
        (await service.detailRecruitmentProfile(a.identities.delegate, randomUUID(), second.id)).row
          .ownerId,
        a.users.delegate,
      );
    });

    await t.test(
      'audit and provenance are append-only and API errors remain distinct',
      async () => {
        assert.ok(
          Number(
            (
              await root.query(
                "SELECT count(*) n FROM rpt.audit_event WHERE tenant_id=$1 AND action IN ('recruiting.create','recruiting.command')",
                [a.tenant],
              )
            ).rows[0].n,
          ) > 0,
        );
        assert.ok(
          Number(
            (
              await root.query(
                "SELECT count(*) n FROM rpt.recruitment_event WHERE tenant_id=$1 AND profile_id=$2 AND source='RPT_USER' AND authority='manual' AND request_id IS NOT NULL",
                [a.tenant, created.id],
              )
            ).rows[0].n,
          ) >= 7,
        );
        await assert.rejects(
          database.request(a.identities.owner, randomUUID(), (client) =>
            client.query("UPDATE rpt.recruitment_event SET action='tampered' WHERE profile_id=$1", [
              created.id,
            ]),
          ),
        );

        let apiIdentity: Identity = a.identities.owner;
        const api = createApi(service, { verify: async () => apiIdentity });
        const headers = { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' };
        const detail = await service.detailRecruitmentProfile(
          a.identities.owner,
          randomUUID(),
          created.id,
        );
        assert.equal(
          (await api.request(`/v1/recruiting/profiles/${created.id}`, { headers })).status,
          200,
        );
        assert.equal(
          (
            await api.request(`/v1/recruiting/profiles/${created.id}/commands`, {
              method: 'POST',
              headers: { ...headers, 'Idempotency-Key': 'api-invalid-01' },
              body: JSON.stringify({
                schemaVersion: 1,
                expectedVersion: 0,
                command: { type: 'priority', priority: 'A' },
              }),
            })
          ).status,
          422,
        );
        assert.equal(
          (
            await api.request(`/v1/recruiting/profiles/${created.id}/commands`, {
              method: 'POST',
              headers: { ...headers, 'Idempotency-Key': 'api-conflict-01' },
              body: JSON.stringify({
                schemaVersion: 1,
                expectedVersion: detail.row.version - 1,
                command: { type: 'substatus', substatus: 'contacted' },
              }),
            })
          ).status,
          409,
        );
        apiIdentity = b.identities.owner;
        assert.equal(
          (await api.request(`/v1/recruiting/profiles/${created.id}`, { headers })).status,
          404,
        );
        apiIdentity = a.identities.outsider;
        assert.equal(
          (
            await api.request(
              `/v1/recruiting/profiles?config=${encodeURIComponent(JSON.stringify({ workspaceId: workspaces.a }))}`,
              { headers },
            )
          ).status,
          403,
        );
      },
    );
  } finally {
    await root.end();
    await cluster.stop();
  }
});
