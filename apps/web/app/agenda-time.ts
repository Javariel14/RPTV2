export function localInput(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(new Date(instant))
    .reduce<Record<string, string>>((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function zonedInstant(local: string, timeZone: string) {
  const wanted = Date.UTC(
    Number(local.slice(0, 4)),
    Number(local.slice(5, 7)) - 1,
    Number(local.slice(8, 10)),
    Number(local.slice(11, 13)),
    Number(local.slice(14, 16)),
  );
  let guess = wanted;
  for (let pass = 0; pass < 3; pass++) {
    const shown = localInput(new Date(guess).toISOString(), timeZone);
    const actual = Date.UTC(
      Number(shown.slice(0, 4)),
      Number(shown.slice(5, 7)) - 1,
      Number(shown.slice(8, 10)),
      Number(shown.slice(11, 13)),
      Number(shown.slice(14, 16)),
    );
    guess += wanted - actual;
  }
  if (localInput(new Date(guess).toISOString(), timeZone) !== local)
    throw new Error('INVALID_LOCAL_TIME');
  return new Date(guess).toISOString();
}

export function rangeFor(
  anchor: string,
  view: 'today' | 'day' | 'week' | 'list',
  timeZone = 'UTC',
) {
  const start = new Date(`${anchor}T00:00:00Z`);
  if (view === 'week') {
    const weekday = start.getUTCDay() || 7;
    start.setUTCDate(start.getUTCDate() - weekday + 1);
  }
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + (view === 'week' ? 7 : view === 'list' ? 31 : 1));
  return {
    from: zonedInstant(`${start.toISOString().slice(0, 10)}T00:00`, timeZone),
    to: zonedInstant(`${end.toISOString().slice(0, 10)}T00:00`, timeZone),
  };
}
