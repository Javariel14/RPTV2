import assert from 'node:assert/strict';
import test from 'node:test';
import { agendaCatalogs } from '../../apps/web/app/agenda-catalog.js';
import { localInput, rangeFor, zonedInstant } from '../../apps/web/app/agenda-time.js';

void test('E2B calendar ranges are bounded and deterministic', () => {
  assert.deepEqual(rangeFor('2026-09-23', 'day'), {
    from: '2026-09-23T00:00:00.000Z',
    to: '2026-09-24T00:00:00.000Z',
  });
  assert.deepEqual(rangeFor('2026-09-23', 'week'), {
    from: '2026-09-21T00:00:00.000Z',
    to: '2026-09-28T00:00:00.000Z',
  });
  assert.deepEqual(rangeFor('2026-09-23', 'day', 'America/Guayaquil'), {
    from: '2026-09-23T05:00:00.000Z',
    to: '2026-09-24T05:00:00.000Z',
  });
  assert.equal(
    (Date.parse(rangeFor('2026-09-23', 'list').to) -
      Date.parse(rangeFor('2026-09-23', 'list').from)) /
      86_400_000,
    31,
  );
});

void test('E2B timezone conversion round-trips and rejects a DST gap', () => {
  const instant = zonedInstant('2026-11-01T01:30', 'America/New_York');
  assert.equal(localInput(instant, 'America/New_York'), '2026-11-01T01:30');
  assert.throws(() => zonedInstant('2026-03-08T02:30', 'America/New_York'));
  assert.equal(localInput('2026-09-22T15:00:00.000Z', 'America/Guayaquil'), '2026-09-22T10:00');
});

void test('E2B critical labels exist in all supported locales', () => {
  for (const locale of ['es', 'en', 'fr', 'pt'] as const) {
    const catalog = agendaCatalogs[locale];
    for (const key of [
      'today',
      'week',
      'forbidden',
      'conflict',
      'reschedule',
      'confirmation',
      'reminders',
      'recurrence',
    ]) {
      assert.ok(catalog[key], `${locale}.${key}`);
      assert.notEqual(catalog[key], key);
    }
  }
});
