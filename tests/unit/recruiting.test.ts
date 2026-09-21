import assert from 'node:assert/strict';
import test from 'node:test';
import {
  recruitingCreate,
  recruitingMutation,
  recruitingPriority,
  recruitingStage,
} from '@rpt/contracts';

void test('E1A contracts preserve the canonical independent recruiting lifecycle', () => {
  assert.deepEqual(recruitingStage.options, [
    'new',
    'initial_contact',
    'qualified',
    'interview_to_schedule',
    'interview_scheduled',
    'interviewed',
    'evaluation',
    'followup_decision',
    'onboarding',
    'activated',
  ]);
  assert.deepEqual(recruitingPriority.options, ['A', 'B', 'C']);
  assert.equal(
    recruitingMutation.safeParse({
      schemaVersion: 1,
      expectedVersion: 1,
      command: { type: 'priority', priority: 'personality_A' },
    }).success,
    false,
  );
});

void test('E1A create contract is strict and shares Person by explicit identity', () => {
  const input = {
    schemaVersion: 1,
    workspaceId: '00000000-0000-4000-8000-000000000001',
    person: { mode: 'existing', id: '00000000-0000-4000-8000-000000000002' },
    source: 'manual',
    priority: null,
  };
  assert.equal(recruitingCreate.safeParse(input).success, true);
  assert.equal(
    recruitingCreate.safeParse({ ...input, opportunityId: crypto.randomUUID() }).success,
    false,
  );
});
