import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deriveCrmIntelligence,
  type CrmIntelligenceSignals,
} from '../../packages/application/src/crm-intelligence.js';

const opportunityId = '10000000-0000-4000-8000-000000000001';
const base: CrmIntelligenceSignals = {
  opportunityId,
  stage: 'contacted',
  nextAction: 'schedule',
  nextAt: null,
  updatedAt: '2026-09-20T12:00:00.000Z',
  asOf: '2026-09-21T12:00:00.000Z',
  lastActivityAt: '2026-09-20T12:00:00.000Z',
  overdueTaskCount: 0,
  overdueTaskId: null,
  pendingObjectionCount: 0,
  pendingCommitmentCount: 0,
  futureAppointmentAt: null,
  futureAppointmentId: null,
  orderSimulatedStatus: null,
};

await test('E1D post-sale recommendations respect the authorized simulated order boundary', () => {
  for (const [orderSimulatedStatus, expected] of [
    ['approved', 'delivery'],
    ['delivered', 'curation'],
    ['curation_pending', 'curation'],
    ['cured', 'none'],
    ['rejected', 'none'],
    [null, 'none'],
  ] as const) {
    const result = deriveCrmIntelligence({
      ...base,
      stage: 'won_simulated',
      orderSimulatedStatus,
    });
    assert.equal(result.nextBestAction.type, expected);
    assert.equal(result.nextBestAction.advisory, true);
  }
});

await test('E1C3 derives deterministic, bounded and explainable results', () => {
  const first = deriveCrmIntelligence(base);
  const second = deriveCrmIntelligence({ ...base });
  assert.deepEqual(second, first);
  assert.equal(first.relationshipHealth, 'healthy');
  assert.equal(first.operationalScore, 70);
  assert.ok(first.scoreReasons.length > 0);
  assert.ok(first.operationalScore >= 0 && first.operationalScore <= 100);
  assert.equal(first.nextBestAction.type, 'appointment');
  assert.equal(first.nextBestAction.advisory, true);
  assert.equal(first.nextBestAction.ruleVersion, 'commercial-beta-v1');
});

await test('E1C3 recent activity improves health while overdue work is at risk', () => {
  const recent = deriveCrmIntelligence(base);
  const overdue = deriveCrmIntelligence({
    ...base,
    updatedAt: '2026-08-01T12:00:00.000Z',
    lastActivityAt: '2026-08-01T12:00:00.000Z',
    overdueTaskCount: 1,
    overdueTaskId: '20000000-0000-4000-8000-000000000002',
  });
  assert.equal(recent.relationshipHealth, 'healthy');
  assert.equal(overdue.relationshipHealth, 'at_risk');
  assert.ok(overdue.relationshipHealthReasons.includes('overdue_task'));
  assert.ok(overdue.relationshipHealthReasons.includes('inactive_14d'));
  assert.ok(overdue.operationalScore < recent.operationalScore);
  assert.equal(overdue.nextBestAction.type, 'complete_task');
  assert.equal(overdue.nextBestAction.priority, 'high');
});

await test('E1C3 uses existing structured signals and never PII', () => {
  const pending = deriveCrmIntelligence({
    ...base,
    pendingObjectionCount: 1,
    pendingCommitmentCount: 1,
  });
  assert.ok(pending.relationshipHealthReasons.includes('pending_objection'));
  assert.ok(pending.relationshipHealthReasons.includes('pending_commitment'));
  assert.equal(pending.nextBestAction.type, 'entry');
  assert.equal(pending.nextBestAction.reason, 'pending_objection');
  assert.equal(JSON.stringify(pending).includes('email'), false);
  assert.equal(JSON.stringify(pending).includes('phone'), false);
});

await test('E1C3 future appointments and missing next action produce coherent NBA', () => {
  const appointmentId = '30000000-0000-4000-8000-000000000003';
  const scheduled = deriveCrmIntelligence({
    ...base,
    stage: 'appointment',
    futureAppointmentAt: '2026-09-22T12:00:00.000Z',
    futureAppointmentId: appointmentId,
  });
  assert.ok(scheduled.relationshipHealthReasons.includes('scheduled_appointment'));
  assert.equal(scheduled.nextBestAction.type, 'prepare_appointment');
  assert.deepEqual(scheduled.nextBestAction.reference, { type: 'appointment', id: appointmentId });
  const missing = deriveCrmIntelligence({ ...base, nextAction: 'none' });
  assert.ok(missing.relationshipHealthReasons.includes('missing_next_action'));
  assert.equal(missing.relationshipHealth, 'attention');
  const closed = deriveCrmIntelligence({
    ...base,
    stage: 'lost',
    overdueTaskCount: 1,
    overdueTaskId: '40000000-0000-4000-8000-000000000004',
  });
  assert.equal(closed.nextBestAction.type, 'none');
  assert.equal(closed.nextBestAction.reason, 'closed_stage');
});
