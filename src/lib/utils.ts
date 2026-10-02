import { type ClassValue, clsx } from 'clsx';
import { differenceInCalendarDays, format, isValid, parseISO } from 'date-fns';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Media types that carry episode structure: series plus anime routes. */
export function isSeriesLikeMediaType(value?: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'series' || normalized === 'anime';
}

export const HEX_COLOR_PATTERN = /^#([0-9a-fA-F]{6})$/;

/** `#rrggbb` to `"r g b"` for use inside `rgb()`/`rgba()` with CSS vars. */
export function hexToRgbTriplet(value: string): `${number} ${number} ${number}` {
  const match = HEX_COLOR_PATTERN.exec(value.trim());
  if (!match?.[1]) return '255 255 255';
  const channels = Number.parseInt(match[1], 16);
  return `${(channels >> 16) & 255} ${(channels >> 8) & 255} ${channels & 255}`;
}

/** Readable text color over a filled accent background. */
export function getAccentTextColor(value: string): '#000000' | '#ffffff' {
  const match = HEX_COLOR_PATTERN.exec(value.trim());
  if (!match?.[1]) return '#000000';
  const channels = Number.parseInt(match[1], 16);
  const luminance =
    (0.299 * ((channels >> 16) & 255) +
      0.587 * ((channels >> 8) & 255) +
      0.114 * (channels & 255)) /
    255;
  return luminance > 0.6 ? '#000000' : '#ffffff';
}

/** Trimmed string, or `undefined` when blank — mirrors Rust `non_blank`. */
export function nonBlank(value?: string | null): string | undefined {
  return value?.trim() || undefined;
}

/** Resolve after `ms` — single owner for poll/verify/settle pacing. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type TimerHandle = ReturnType<typeof setTimeout>;

/** Clear and null out a timeout handle stored in a ref. */
export function clearTimer(timerRef: { current: TimerHandle | null }) {
  if (timerRef.current === null) return;
  clearTimeout(timerRef.current);
  timerRef.current = null;
}

/** `Promise.race` with a self-clearing timer: `onTimeout` supplies the
 * settled value — throw inside it to reject. The timer is always cleared
 * when the race settles so a lost race cannot fire late; `work` is never
 * cancelled. */
export function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: TimerHandle | undefined;
  const timeout = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (error) {
        reject(error);
      }
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** True when the OS asks for reduced motion — JS-driven motion (smooth
 * scrolls) should go instant; CSS animation/transition is covered by the
 * global guard in index.css. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** `<img onError>` fallback: hide the broken element instead of a torn icon. */
export function hideBrokenImage(event: { currentTarget: HTMLElement }) {
  event.currentTarget.style.display = 'none';
}

/** `h:mm:ss` / `mm:ss` clock text for media playback positions. */
export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

/** Zero-padded two digits — single owner for episode/season/time labels. */
export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Inclusive numeric clamp — single owner for slider/delay/scale bounds. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** True for renderable remote art — single owner for poster/backdrop/logo
    guards. Mirrors the backend `is_fetchable_http_url` (http|https): addon
    artwork persisted as http:// must not render as the no-art fallback. */
export function isHttpUrl(value?: string | null): value is string {
  return !!value && /^https?:\/\//.test(value);
}

/** Episode fallback — single owner for `title || Episode N` across cards/panels/calendar. */
export function getEpisodeTitle(title?: string | null, episode?: number): string {
  if (title) return title;
  return `Episode ${episode ?? ''}`.trimEnd();
}

/** Compact `S1:E2` label — single owner for resume/player chrome. */
export function formatSeasonEpisode(season?: number | null, episode?: number | null): string {
  if (typeof season !== 'number' || typeof episode !== 'number') return '';
  return `S${season}:E${episode}`;
}

/** `S1:E2 · Title`, degrading to whichever half exists. */
export function formatEpisodeHeading(
  season?: number | null,
  episode?: number | null,
  title?: string | null,
): string {
  return [formatSeasonEpisode(season, episode), title].filter(Boolean).join(' · ');
}

/** Leading `YYYY-MM-DD` of an air/release timestamp. Addons send either a
    bare date or a full ISO datetime — both mean "this calendar day", so the
    date part is authoritative and any trailing time/offset is noise. */
const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

/** Local-day parse for schedule/air dates — single owner. `parseISO` on a
    Z-suffixed datetime (`2013-04-21T00:00:00Z`) lands on the previous day for
    users west of UTC, shifting air dates one calendar day back. */
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

/** Aired by the given local day; undated episodes count as aired. */
export function isAiredByLocalDay(releaseDate: string | null | undefined, localDayMs: number) {
  const airDate = parseLocalScheduleDate(releaseDate)?.getTime();
  return airDate === undefined || airDate <= localDayMs;
}

/** Episode air-date line: absolute for aired episodes ("Apr 7, 2013" — the
    calendar's vocabulary), compact countdown ("in 3d") for unaired ones. */
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

/** Card/hero type pill — series/anime get their own labels, else Movie. */
export function mediaTypeLabel(type?: string | null): string {
  if (type === 'anime') return 'Anime';
  return type === 'series' ? 'TV Series' : 'Movie';
}

/** Card/hero genre pills — the catalog's genres are already painted, so a
    late details payload must not swap pill text under the user's eyes. */
export function primaryGenrePills(
  catalogGenres: string[] | undefined,
  detailsGenres: string[] | undefined,
  max = 2,
): string[] {
  return (catalogGenres?.length ? catalogGenres : (detailsGenres ?? [])).slice(0, max);
}
