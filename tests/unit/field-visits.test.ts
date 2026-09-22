import assert from 'node:assert/strict';
import test from 'node:test';
import { fieldVisitCreate, fieldVisitListQuery, fieldVisitMutation } from '@rpt/contracts';

const id = '10000000-0000-4000-8000-000000000001';

void test('E2C visit contracts require one schedule source and bounded ranges', () => {
  const base = {
    schemaVersion: 1,
    workspaceId: id,
    agendaItemId: null,
    personId: null,
    opportunityId: null,
    scheduledAt: '2026-10-10T15:00:00Z',
    purpose: 'Synthetic field visit',
  };
  assert.equal(fieldVisitCreate.parse(base).scheduledAt, '2026-10-10T15:00:00Z');
  assert.equal(
    fieldVisitCreate.safeParse({ ...base, agendaItemId: id, scheduledAt: null }).success,
    true,
  );
  assert.equal(fieldVisitCreate.safeParse({ ...base, agendaItemId: id }).success, false);
  assert.equal(fieldVisitCreate.safeParse({ ...base, scheduledAt: null }).success, false);
  assert.equal(
    fieldVisitListQuery.safeParse({
      from: '2026-01-01T00:00:00Z',
      to: '2027-01-01T00:00:00Z',
    }).success,
    false,
  );
});

void test('E2C location is explicit, bounded and cannot carry arbitrary metadata', () => {
  const command = {
    schemaVersion: 1,
    expectedVersion: 1,
    command: {
      type: 'check_in',
      location: {
        latitude: -0.180653,
        longitude: -78.467834,
        accuracyMeters: 12.5,
        source: 'device_explicit',
        consentContext: 'explicit_visit_action',
      },
    },
  };
  assert.equal(fieldVisitMutation.safeParse(command).success, true);
  assert.equal(
    fieldVisitMutation.safeParse({
      ...command,
      command: { ...command.command, location: { ...command.command.location, latitude: 91 } },
    }).success,
    false,
  );
  assert.equal(
    fieldVisitMutation.safeParse({
      ...command,
      command: { ...command.command, location: { ...command.command.location, tracking: true } },
    }).success,
    false,
  );
});
