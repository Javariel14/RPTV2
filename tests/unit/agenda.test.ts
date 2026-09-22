import assert from 'node:assert/strict';
import test from 'node:test';
import { agendaCreate, agendaListQuery, agendaMutation } from '@rpt/contracts';

void test('E2A agenda contracts are bounded, timezone-aware and do not accept contact PII', () => {
  const base = {
    schemaVersion: 1 as const,
    type: 'appointment' as const,
    workspaceId: '00000000-0000-4000-8000-000000000001',
    title: 'Visit preparation',
    summary: null,
    startsAt: '2026-03-07T09:00:00-05:00',
    endsAt: '2026-03-07T10:00:00-05:00',
    timezone: 'America/New_York',
    source: 'manual' as const,
    personId: null,
    opportunityId: null,
    recruitmentProfileId: null,
    recurrence: null,
    reminderMinutesBefore: [60],
    travel: {},
  };
  assert.equal(agendaCreate.parse(base).timezone, 'America/New_York');
  assert.equal(
    agendaCreate.safeParse({ ...base, title: 'Call person@example.invalid' }).success,
    false,
  );
  assert.equal(agendaCreate.safeParse({ ...base, title: 'Call +593 999 999 999' }).success, false);
  assert.equal(
    agendaCreate.safeParse({
      ...base,
      opportunityId: base.workspaceId,
      recruitmentProfileId: base.workspaceId,
    }).success,
    false,
  );
  assert.equal(agendaCreate.safeParse({ ...base, timezone: 'Not/A_Timezone' }).success, false);
  assert.equal(agendaCreate.safeParse({ ...base, endsAt: base.startsAt }).success, false);
  assert.equal(
    agendaCreate.safeParse({
      ...base,
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        weekdays: [1, 3],
        until: '2026-04-01T09:00:00-04:00',
      },
    }).success,
    true,
  );
});

void test('E2A list and mutation contracts enforce bounded ranges and versions', () => {
  assert.equal(
    agendaListQuery.safeParse({ from: '2026-01-01T00:00:00Z', to: '2026-05-01T00:00:00Z' }).success,
    false,
  );
  assert.equal(
    agendaMutation.safeParse({
      schemaVersion: 1,
      expectedVersion: 1,
      command: { type: 'complete' },
    }).success,
    true,
  );
  assert.equal(
    agendaMutation.safeParse({
      schemaVersion: 1,
      expectedVersion: 0,
      command: { type: 'complete' },
    }).success,
    false,
  );
});
