import { type ClassNameValue, twMerge } from 'tailwind-merge';
import type { AccentTargets } from '@/lib/api';

export function cn(...inputs: ClassNameValue[]) {
  return twMerge(inputs);
}

export function queryNeedsRetry(query: {
  isError: boolean;
  isFetched: boolean;
  isPending: boolean;
}): boolean {
  return query.isError || (query.isFetched && query.isPending);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const anyErr = error as Record<string, unknown>;
    if (typeof anyErr.message === 'string' && anyErr.message) return anyErr.message;
    if (typeof anyErr.error === 'string' && anyErr.error) return anyErr.error;
    if (typeof anyErr.err === 'string' && anyErr.err) return anyErr.err;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

export function createObjectIdentity() {
  const ids = new WeakMap<object, number>();
  let nextId = 0;
  return (value: object): number => {
    let id = ids.get(value);
    if (id === undefined) {
      id = ++nextId;
      ids.set(value, id);
    }
    return id;
  };
}

/** Media types that carry episode structure: series plus anime routes. */
export function isSeriesLikeMediaType(value?: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'series' || normalized === 'anime';
}

export const HEX_COLOR_PATTERN = /^#([0-9a-fA-F]{6})$/;

/** Content-column insets clearing the fixed sidebar; never `cn()`-merge — `lg:px-*` would override `lg:pl-[92px]` under tailwind-merge. */
export const SIDEBAR_PAGE_COLUMN_INSETS = 'pr-4 pl-[84px] sm:pr-6 lg:pl-[92px] lg:pr-8';

export const GENRE_LINK_CLASS =
  'rounded-md border border-white/10 bg-white/[0.08] px-2.5 py-1 text-[13px] font-medium text-white/85 backdrop-blur-md transition-colors duration-150 hover:border-white/25 hover:bg-white/[0.14] hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40';

export const POPOVER_MOTION_CLASS =
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none';

function parseHexRgb(value: string): [number, number, number] | null {
  const match = HEX_COLOR_PATTERN.exec(value.trim());
  if (!match?.[1]) return null;
  const channels = Number.parseInt(match[1], 16);
  return [(channels >> 16) & 255, (channels >> 8) & 255, channels & 255];
}

/** `#rrggbb` to `"r g b"` for use inside `rgb()`/`rgba()` with CSS vars. */
function hexToRgbTriplet(value: string): `${number} ${number} ${number}` {
  const [r, g, b] = parseHexRgb(value) ?? [255, 255, 255];
  return `${r} ${g} ${b}`;
}

/** Readable text color over a filled accent background. */
export function getAccentTextColor(value: string): '#000000' | '#ffffff' {
  const rgb = parseHexRgb(value);
  if (!rgb) return '#000000';
  const [r, g, b] = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.179 ? '#000000' : '#ffffff';
}

const NEUTRAL_ACCENT = '#d4d4d8';

export function applyAccentVars(accent: string, targets: AccentTargets) {
  const root = document.documentElement;
  root.style.setProperty('--app-accent-rgb', hexToRgbTriplet(accent));
  const scopes: Array<[string, boolean, boolean]> = [
    ['accent-nav', targets.navigation, true],
    ['accent-act', targets.actions, true],
    ['accent-prog', targets.progress, false],
    ['accent-art', targets.artwork, false],
    ['accent-skip', targets.skip, true],
  ];
  for (const [scope, enabled, foreground] of scopes) {
    const color = enabled ? accent : NEUTRAL_ACCENT;
    root.style.setProperty(`--${scope}`, color);
    root.style.setProperty(`--${scope}-rgb`, hexToRgbTriplet(color));
    if (foreground) root.style.setProperty(`--on-${scope}`, getAccentTextColor(color));
  }
}

/** Trimmed string, or `undefined` when blank — mirrors Rust `non_blank`. */
export function nonBlank(value?: string | null): string | undefined {
  return value?.trim() || undefined;
}

/** 'local' = playback without a catalog title — resume/language/stream-health persistence all skip it. */
export function isLocalMediaId(mediaId?: string | null): boolean {
  return mediaId === 'local';
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

/** LRU-ish insert-or-refresh into a `Map` bounded to `max` — delete+set re-inserts so revisits count as recent. */
export function boundedMapSet<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** Serial queue; the stored tail is recovered so one failure can't wedge later work — errors still propagate to the caller. */
export function createSerialTaskQueue() {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const result = tail.then(operation);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    pending: () => tail,
  };
}

/** `Promise.race` + self-clearing timer; `onTimeout` supplies the settled value (throw to reject). `work` is never cancelled. */
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

let reducedMotionQuery: MediaQueryList | undefined;

/** OS reduced-motion check — JS-driven motion (smooth scrolls) goes instant; CSS is covered by the index.css guard. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  reducedMotionQuery ??= window.matchMedia('(prefers-reduced-motion: reduce)');
  return reducedMotionQuery.matches;
}

/** `ScrollBehavior` honoring reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
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

/** `1 title` / `3 titles` — count with an English plural. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Inclusive numeric clamp — single owner for slider/delay/scale bounds. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Renderable remote art check — mirrors backend `is_fetchable_http_url`; http:// addon art must not render as no-art. */
export function isHttpUrl(value?: string | null): value is string {
  return !!value && /^https?:\/\//i.test(value);
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

/** Card/hero type pill — series/anime get their own labels, else Movie. */
export function mediaTypeLabel(type?: string | null): string {
  if (type?.trim().toLowerCase() === 'anime') return 'Anime';
  return isSeriesLikeMediaType(type) ? 'TV Series' : 'Movie';
}

/** Genre pills — catalog genres are already painted, so a late details payload must not swap the text. */
export function primaryGenrePills(
  catalogGenres: string[] | undefined,
  detailsGenres: string[] | undefined,
  max = 2,
): string[] {
  return (catalogGenres?.length ? catalogGenres : (detailsGenres ?? [])).slice(0, max);
}
