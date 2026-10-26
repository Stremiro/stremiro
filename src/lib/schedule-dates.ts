export const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
export const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});
const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

export function toLocalDate(date: Date): Temporal.PlainDate {
  return Temporal.PlainDate.from({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  });
}

export function toLocalMidnight(date: Temporal.PlainDate): Date {
  return new Date(date.toZonedDateTime(Temporal.Now.timeZoneId()).epochMilliseconds);
}

/** Rust normalizes release dates; an ISO timestamp's prefix still means its named local day. */
export function parseScheduleDay(value?: string | null): Temporal.PlainDate | null {
  const prefix = value?.trim().match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!prefix) return null;
  try {
    return Temporal.PlainDate.from(prefix);
  } catch {
    return null;
  }
}

export function parseLocalScheduleDate(value?: string | null): Date | null {
  const day = parseScheduleDay(value);
  return day && toLocalMidnight(day);
}

/** Air-date line: absolute for aired ("Apr 7, 2013"), compact countdown ("in 3d") for unaired. */
export function formatAirDate(value: string | null | undefined, today: Date): string | null {
  const day = parseScheduleDay(value);
  if (!day) return null;
  const daysAhead = toLocalDate(today).until(day).days;
  if (daysAhead <= 0) return DATE_FORMATTER.format(day);
  if (daysAhead === 1) return 'Tomorrow';
  if (daysAhead < 14) return `in ${daysAhead}d`;
  if (daysAhead < 63) return `in ${Math.round(daysAhead / 7)}w`;
  return SHORT_DATE_FORMATTER.format(day);
}

const RELATIVE_TIME_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['week', 604_800_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

export function formatRelativeTime(value: number): string {
  const delta = value - Date.now();
  for (const [unit, ms] of RELATIVE_TIME_UNITS) {
    if (Math.abs(delta) >= ms) return RELATIVE_TIME_FORMATTER.format(Math.trunc(delta / ms), unit);
  }
  return 'just now';
}
