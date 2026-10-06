import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addCalendarDays,
  agendaAnchorForTimeZone,
  calendarDayInTimeZone,
  rangeFor,
} from '../../apps/web/app/agenda-time.js';

void test('Agenda calendar day follows an explicit timezone across calendar boundaries', () => {
  for (const [instant, timezone, expected] of [
    ['2026-10-04T23:52:00Z', 'America/Guayaquil', '2026-10-04'],
    ['2026-10-05T03:52:00Z', 'America/Guayaquil', '2026-10-04'],
    ['2026-10-05T05:00:00Z', 'America/Guayaquil', '2026-10-05'],
    ['2026-11-01T03:59:00Z', 'America/Guayaquil', '2026-10-31'],
    ['2027-01-01T03:59:00Z', 'America/Guayaquil', '2026-12-31'],
    ['2026-10-04T12:30:00Z', 'Pacific/Kiritimati', '2026-10-05'],
  ] as const) {
    assert.equal(calendarDayInTimeZone(instant, timezone), expected);
    const range = rangeFor(expected, 'today', timezone);
    for (const boundary of [range.from, new Date(Date.parse(range.to) - 1)])
      assert.equal(calendarDayInTimeZone(boundary, timezone), expected);
  }
  assert.throws(() => calendarDayInTimeZone('2026-10-05T03:52:00Z', 'Invalid/Zone'));
  assert.equal(addCalendarDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addCalendarDays('2026-12-31', 7), '2027-01-07');
});
void test('Authenticated Agenda timezone resyncs only an automatic today anchor', () => {
  const instant = '2026-10-05T03:52:00Z';
  const fallbackDay = calendarDayInTimeZone(instant, 'UTC');
  assert.equal(fallbackDay, '2026-10-05');
  assert.equal(
    agendaAnchorForTimeZone(fallbackDay, true, instant, 'America/Guayaquil'),
    '2026-10-04',
  );
  const manualDay = '2026-09-20';
  assert.equal(agendaAnchorForTimeZone(manualDay, false, instant, 'America/Guayaquil'), manualDay);
  assert.equal(
    agendaAnchorForTimeZone(manualDay, true, instant, 'America/Guayaquil'),
    '2026-10-04',
  );
});
