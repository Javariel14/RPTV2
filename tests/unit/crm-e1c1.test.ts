import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { crmCommand, crmMutation } from '@rpt/contracts';

await test('E1C1 commands are strict, versioned and bounded', () => {
  const versioned = (command: unknown) =>
    crmMutation.parse({ schemaVersion: 1, expectedVersion: 1, command });
  assert.equal(
    versioned({
      type: 'activity',
      kind: 'call',
      occurredAt: '2026-09-21T12:00:00Z',
      summary: 'Synthetic internal record',
    }).command.type,
    'activity',
  );
  assert.equal(
    versioned({
      type: 'add_collaborator',
      userId: randomUUID(),
      access: 'read',
      until: '2026-09-22T12:00:00Z',
    }).command.type,
    'add_collaborator',
  );
  assert.equal(
    versioned({ type: 'set_referral', referrerPersonId: randomUUID() }).command.type,
    'set_referral',
  );
  assert.equal(
    crmCommand.safeParse({
      type: 'activity',
      kind: 'email',
      occurredAt: '2026-09-21T12:00:00Z',
      summary: 'Not supported',
    }).success,
    false,
  );
  assert.equal(
    crmCommand.safeParse({
      type: 'add_collaborator',
      userId: randomUUID(),
      access: 'admin',
      until: '2026-09-22T12:00:00Z',
    }).success,
    false,
  );
  assert.equal(
    crmCommand.safeParse({
      type: 'set_referral',
      referrerPersonId: randomUUID(),
      tenantId: randomUUID(),
    }).success,
    false,
  );
});
