import { localInput, zonedInstant } from '../../apps/web/app/agenda-time.js';

// Synthetic Ecuador lab only. Calendar arithmetic is separate from instant conversion.
export function localFixtureTime(now: Date, dayOffset: number, hour: number) {
  const timezone = 'America/Guayaquil';
  const anchor = localInput(now.toISOString(), timezone).slice(0, 10);
  const calendar = new Date(`${anchor}T00:00:00Z`);
  calendar.setUTCDate(calendar.getUTCDate() + dayOffset);
  return new Date(
    zonedInstant(
      `${calendar.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00`,
      timezone,
    ),
  );
}
