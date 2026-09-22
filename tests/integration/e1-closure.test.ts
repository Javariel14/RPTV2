import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { FoundationService } from '@rpt/application';
import { FoundationError } from '@rpt/contracts';
import { PostgresDatabase } from '@rpt/persistence';
import { seedCrm } from '../helpers/crm-fixtures.js';
import { startPostgres } from '../helpers/postgres.js';

void test('E1 cross-lifecycle closure', { timeout: 240_000 }, async (t) => {
  const cluster = await startPostgres();
  const root = await cluster.migrate();
  try {
    const a = await seedCrm(root, 'e1-closure-a', 2);
    const b = await seedCrm(root, 'e1-closure-b', 1);
    const recruitingWorkspace = randomUUID();
    await root.query(
      "INSERT INTO rpt.crm_workspace(tenant_id,id,name,registration_id,kind) VALUES($1,$2,'E1 recruiting closure',$3,'recruitment')",
      [a.tenant, recruitingWorkspace, a.registrations[1]],
    );
    await root.query(
      "INSERT INTO rpt.feature_flag(tenant_id,id,key,policy_version,enabled,rollout_percent,effective_from) VALUES($1,$2,'recruiting_crm_core',1,true,100,'2020-01-01')",
      [a.tenant, randomUUID()],
    );
    for (const verb of ['read', 'create', 'update', 'reassign', 'share']) {
      await root.query(
        "INSERT INTO authz.role_capability VALUES($1,'owner','recruitment_profile',$2,'CONFIDENTIAL',false,1)",
        [a.tenant, verb],
      );
      await root.query(
        `INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
         VALUES($1,$2,$3,$4,'recruitment_profile',$5,'CONFIDENTIAL',1)`,
        [a.tenant, randomUUID(), recruitingWorkspace, a.users.owner, verb],
      );
    }
    await root.query(
      "INSERT INTO authz.role_capability VALUES($1,'delegate','recruitment_profile','read','CONFIDENTIAL',false,1)",
      [a.tenant],
    );
    await root.query(
      'INSERT INTO rpt.person_pii(tenant_id,person_id,email,phone) VALUES($1,$2,$3,$4)',
      [a.tenant, a.persons[1], 'shared-person@example.invalid', '+000000099'],
    );

    const service = new FoundationService(new PostgresDatabase(cluster.runtimeConfig()));
    const profile = await service.createRecruitmentProfile(
      a.identities.owner,
      randomUUID(),
      {
        schemaVersion: 1,
        workspaceId: recruitingWorkspace,
        person: { mode: 'existing', id: a.persons[1]! },
        source: 'referral',
        priority: 'B',
      },
      'e1-closure-profile',
    );
    const opportunityId = a.ids[1]!;
    const denied = (error: unknown) =>
      error instanceof FoundationError && ['FORBIDDEN', 'NOT_FOUND'].includes(error.code);
    const commercial = (identity = a.identities.delegate) =>
      service.detailCrm(identity, randomUUID(), opportunityId);
    const recruiting = (identity = a.identities.delegate) =>
      service.detailRecruitmentProfile(identity, randomUUID(), profile.id);
    const commercialCommand = async (command: unknown) =>
      service.commandCrm(
        a.identities.owner,
        randomUUID(),
        opportunityId,
        {
          schemaVersion: 1,
          expectedVersion: (
            await service.detailCrm(a.identities.owner, randomUUID(), opportunityId)
          ).row.version,
          command,
        },
        randomUUID(),
      );

    await t.test('one Person owns independent Commercial and Recruiting lifecycles', async () => {
      const before = await root.query<{ persons: number; commercial: string; recruiting: string }>(
        `SELECT
          (SELECT count(*)::int FROM rpt.person WHERE tenant_id=$1 AND id=$2) persons,
          (SELECT stage::text FROM rpt.opportunity WHERE tenant_id=$1 AND id=$3) commercial,
          (SELECT stage::text FROM rpt.recruitment_profile WHERE tenant_id=$1 AND id=$4) recruiting`,
        [a.tenant, a.persons[1], opportunityId, profile.id],
      );
      assert.deepEqual(before.rows[0], { persons: 1, commercial: 'new', recruiting: 'new' });
      await service.commandRecruitmentProfile(
        a.identities.owner,
        randomUUID(),
        profile.id,
        {
          schemaVersion: 1,
          expectedVersion: profile.version,
          command: { type: 'stage', stage: 'initial_contact' },
        },
        'e1-closure-recruiting-stage',
      );
      const after = await root.query<{ commercial: string; recruiting: string }>(
        `SELECT
          (SELECT stage::text FROM rpt.opportunity WHERE tenant_id=$1 AND id=$2) commercial,
          (SELECT stage::text FROM rpt.recruitment_profile WHERE tenant_id=$1 AND id=$3) recruiting`,
        [a.tenant, opportunityId, profile.id],
      );
      assert.deepEqual(after.rows[0], { commercial: 'new', recruiting: 'initial_contact' });
      await commercialCommand({ type: 'stage', stage: 'contacted' });
      assert.equal((await commercial(a.identities.owner)).row.stage, 'contacted');
      assert.equal((await recruiting(a.identities.owner)).row.stage, 'initial_contact');
      const counts = await root.query(
        `SELECT
          (SELECT count(*)::int FROM rpt.person WHERE tenant_id=$1 AND id=$2) persons,
          (SELECT count(*)::int FROM rpt.opportunity WHERE tenant_id=$1 AND person_id=$2) opportunities,
          (SELECT count(*)::int FROM rpt.recruitment_profile WHERE tenant_id=$1 AND person_id=$2) profiles`,
        [a.tenant, a.persons[1]],
      );
      assert.deepEqual(counts.rows[0], { persons: 1, opportunities: 1, profiles: 1 });
    });

    await t.test('Commercial and Recruiting grants remain independent when revoked', async () => {
      await assert.rejects(commercial(), denied);
      await assert.rejects(recruiting(), denied);

      await commercialCommand({
        type: 'add_collaborator',
        userId: a.users.delegate,
        access: 'read',
        until: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const commercialOnly = await commercial();
      assert.equal(commercialOnly.contact, null);
      assert.equal(commercialOnly.row.canContact, false);
      await assert.rejects(recruiting(), denied);

      const recruitingPersonGrant = await service.createGrant(a.identities.owner, randomUUID(), {
        objectId: a.persons[1]!,
        granteeId: a.users.delegate,
        verb: 'read',
        field: 'CONFIDENTIAL',
        until: new Date(Date.now() + 3_600_000).toISOString(),
        reason: 'E1D recruiting Person access',
      });
      const recruitingGrant = randomUUID();
      await root.query(
        `INSERT INTO authz.access_grant(tenant_id,id,object_type,object_id,grantor_id,grantee_id,verb,field_class,effective_from,effective_to,policy_version,reason)
         VALUES($1,$2,'recruitment_profile',$3,$4,$5,'read','CONFIDENTIAL',now(),now()+interval '1 hour',1,'E1D recruiting access')`,
        [a.tenant, recruitingGrant, profile.id, a.users.owner, a.users.delegate],
      );
      const bothRecruiting = await recruiting();
      assert.equal(bothRecruiting.contact, null);
      await commercialCommand({ type: 'remove_collaborator', userId: a.users.delegate });
      await assert.rejects(commercial(), denied);
      assert.equal((await recruiting()).row.personId, a.persons[1]);

      await commercialCommand({
        type: 'add_collaborator',
        userId: a.users.delegate,
        access: 'read',
        until: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await root.query('UPDATE authz.access_grant SET revoked_at=now() WHERE id=$1', [
        recruitingGrant,
      ]);
      await service.revokeGrant(a.identities.owner, randomUUID(), recruitingPersonGrant.id);
      await assert.rejects(recruiting(), denied);
      assert.equal((await commercial()).row.personId, a.persons[1]);
    });

    await t.test('tenant and Network boundaries deny both lifecycles', async () => {
      for (const identity of [a.identities.ancestor, b.identities.owner]) {
        await assert.rejects(commercial(identity), denied);
        await assert.rejects(recruiting(identity), denied);
      }
    });
  } finally {
    await root.end();
    await cluster.stop();
  }
});
