import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEffective, evaluateFlag, PendingSource, verbs } from '@rpt/domain';
import { activityCommand, personUpdate } from '@rpt/contracts';
await test('temporal half-open intervals and market/version flag resolution fail closed', () => {
  const from = new Date('2026-01-01'),
    to = new Date('2027-01-01');
  assert(isEffective(from, to, from));
  assert(!isEffective(from, to, to));
  const base = { enabled: true, rolloutPercent: 20, version: 1, from, to, marketId: null };
  assert(evaluateFlag([base], 'ec', 19, from));
  assert(!evaluateFlag([base], 'ec', 20, from));
  assert(
    !evaluateFlag([base, { ...base, enabled: false, marketId: 'ec', version: 2 }], 'ec', 0, from),
  );
  assert(!evaluateFlag([], 'ec', 0, from));
  assert(!evaluateFlag([base], 'ec', -1, from));
});
await test('integration adapters explicitly remain pending and verbs are independent', async () => {
  for (const source of [
    'HYCITE',
    'INCITE',
    'DOCUCITE',
    'WHATSAPP',
    'CALENDAR',
    'AI',
    'STT',
  ] as const)
    assert.deepEqual(await new PendingSource(source).sync(), {
      status: 'PENDING_OFFICIAL_ACCESS',
      source,
    });
  assert(
    verbs.includes('listen') && verbs.includes('view_transcript') && verbs.includes('download'),
  );
  assert.equal(new Set(verbs).size, verbs.length);
});
await test('v1 contracts reject spoofed tenant fields, official sales, NaN and unknown versions', () => {
  assert(
    !personUpdate.safeParse({
      schemaVersion: 1,
      displayName: 'Test',
      expectedVersion: 1,
      tenantId: 'spoofed',
    }).success,
  );
  assert(
    !personUpdate.safeParse({ schemaVersion: 2, displayName: 'Test', expectedVersion: 1 }).success,
  );
  assert(!activityCommand.safeParse({ schemaVersion: 1, metric: 'sales', value: NaN }).success);
});
