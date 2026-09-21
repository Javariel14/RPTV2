import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { FoundationService } from '@rpt/application';
import { PostgresDatabase } from '@rpt/persistence';
import { seedCrm } from '../helpers/crm-fixtures.js';
import { seedRecruiting } from '../helpers/recruiting-fixtures.js';
import { startPostgres } from '../helpers/postgres.js';

void test('E1B Recruiting UI read model', async () => {
  const cluster = await startPostgres();
  const root = await cluster.migrate();
  try {
    const fixture = await seedCrm(root, 'recruiting-ui', 4);
    const recruiting = await seedRecruiting(root, fixture, 4);
    const service = new FoundationService(new PostgresDatabase(cluster.runtimeConfig()));
    const context = await service.recruitingContext(fixture.identities.owner, randomUUID());
    assert.equal(context.workspace.id, recruiting.workspace);
    assert.equal(context.owners.length, 2);

    const list = await service.listRecruitmentProfiles(fixture.identities.owner, randomUUID(), {
      workspaceId: recruiting.workspace,
      query: 'sintética 001',
      source: 'referral',
      activity: 'due',
    });
    assert.equal(list.total, 1);
    assert.equal(list.rows[0]?.nextAction, 'Seguimiento sintético 1');
    assert.equal(list.rows[0]?.ownerLabel, 'self');
    assert.ok(list.stages.some((item) => item.stage === 'new' && item.count === 1));

    const detail = await service.detailRecruitmentProfile(
      fixture.identities.owner,
      randomUUID(),
      recruiting.ids[0]!,
    );
    assert.deepEqual(detail.permissions, {
      appointment: true,
      interview: true,
      followup: true,
      completeFollowup: true,
      hook: true,
    });
  } finally {
    await root.end();
    await cluster.stop();
  }
});
