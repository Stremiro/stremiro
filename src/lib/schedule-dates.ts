import { differenceInCalendarDays, format, isValid, parseISO } from 'date-fns';

/** Leading `YYYY-MM-DD` of an air/release timestamp — addons send bare date or ISO datetime, both mean "this calendar day". */
const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

/** Local-day parse for schedule/air dates — `parseISO` on a `Z` datetime lands on the previous day west of UTC. */
export function parseLocalScheduleDate(value?: string | null): Date | null {
  if (!value) return null;
  const match = ISO_DATE_PREFIX.exec(value.trim());
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = new Date(0);
    date.setFullYear(year, month, day);
    date.setHours(0, 0, 0, 0);
    return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
      ? date
      : null;
  }
  const parsed = parseISO(value);
  return isValid(parsed) ? parsed : null;
}

/** Air-date line: absolute for aired ("Apr 7, 2013"), compact countdown ("in 3d") for unaired. */
export function formatAirDate(value?: string | null): string | null {
  if (!value) return null;
  const date = parseLocalScheduleDate(value);
  if (!date) return null;
  const daysAhead = differenceInCalendarDays(date, new Date());
  if (daysAhead <= 0) return format(date, 'MMM d, yyyy');
  if (daysAhead === 1) return 'Tomorrow';
  if (daysAhead < 14) return `in ${daysAhead}d`;
  if (daysAhead < 63) return `in ${Math.round(daysAhead / 7)}w`;
  return format(date, 'MMM d');
}
