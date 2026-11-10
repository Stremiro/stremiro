import { type ClassNameValue, twMerge } from 'tailwind-merge';
import type { AccentTargets } from '@/lib/api';

export function cn(...inputs: ClassNameValue[]) {
  return twMerge(inputs);
}

// Unknown IDs are ignored; unlisted rows keep their original order at the end.
export function orderByIds<T extends { id: string }>(
  source: T[],
  orderedIds?: readonly string[] | null,
): T[] {
  if (!orderedIds) return source;
  const remaining = new Map<string, T>();
  for (const item of source) remaining.set(item.id, item);
  const ordered: T[] = [];
  for (const id of orderedIds) {
    const item = remaining.get(id);
    remaining.delete(id);
    if (item) ordered.push(item);
  }
  for (const item of remaining.values()) ordered.push(item);
  return ordered;
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

/** Inline status strip for offline/capability notices — lighter than `RetryBanner`. */
export const PAGE_NOTICE_CLASS =
  'flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.025] px-4 py-3 text-[13px] leading-relaxed text-zinc-400';

/** Gradient icon tile next to section headers and empty states — callers add size + radius. */
export const ICON_CHIP_CLASS =
  'flex items-center justify-center bg-linear-to-b from-white/[0.08] to-white/[0.02] ring-1 ring-inset ring-white/[0.08]';

/** Bare title icons (rails, page h1s) settle in just after the page fade — callers add size. */
export const TITLE_ICON_CLASS =
  'shrink-0 text-white motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-500 motion-safe:fill-mode-backwards motion-safe:[animation-delay:120ms]';

export const GENRE_LINK_CLASS =
  'inline-flex min-h-7 items-center gap-1.5 rounded-sm text-[13px] font-medium text-white/65 transition-colors hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40';

export const POPOVER_MOTION_CLASS =
  'data-[state=open]:animate-surface-in data-[state=closed]:animate-surface-out motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none';

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
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.179 ? '#000000' : '#ffffff';
}

const NEUTRAL_ACCENT = '#d4d4d8';
const NEUTRAL_ACCENT_RGB = hexToRgbTriplet(NEUTRAL_ACCENT);
const NEUTRAL_ACCENT_TEXT = getAccentTextColor(NEUTRAL_ACCENT);

export function applyAccentVars(accent: string, targets: AccentTargets) {
  const root = document.documentElement;
  const accentRgb = hexToRgbTriplet(accent);
  const accentText = getAccentTextColor(accent);
  root.style.setProperty('--app-accent-rgb', accentRgb);
  const scopes: Array<[string, boolean, boolean]> = [
    ['accent-nav', targets.navigation, true],
    ['accent-act', targets.actions, true],
    ['accent-prog', targets.progress, false],
    ['accent-art', targets.artwork, false],
    ['accent-skip', targets.skip, false],
  ];
  for (const [scope, enabled, foreground] of scopes) {
    const color = enabled ? accent : NEUTRAL_ACCENT;
    root.style.setProperty(`--${scope}`, color);
    root.style.setProperty(`--${scope}-rgb`, enabled ? accentRgb : NEUTRAL_ACCENT_RGB);
    if (foreground)
      root.style.setProperty(`--on-${scope}`, enabled ? accentText : NEUTRAL_ACCENT_TEXT);
  }
  root.style.setProperty('--accent-seek', targets.seekbar ? accent : '#ffffff');
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
    enqueue<T>(this: void, operation: () => Promise<T>): Promise<T> {
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

/** Monotonic counter for latest-writer-wins guards — `bump` returns the new value. */
export function createGeneration() {
  let value = 0;
  return {
    get: () => value,
    bump: () => ++value,
    isCurrent: (generation: number) => generation === value,
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

/** Await cleanup without putting `try/finally` in compiler-managed hooks. */
export function withFinally<T>(work: Promise<T>, cleanup: () => unknown): Promise<T> {
  return work.finally(cleanup);
}

let reducedMotionQuery: MediaQueryList | undefined;

function getReducedMotionQuery(): MediaQueryList | undefined {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
  reducedMotionQuery ??= window.matchMedia('(prefers-reduced-motion: reduce)');
  return reducedMotionQuery;
}

/** OS reduced-motion check — JS-driven motion (smooth scrolls) goes instant; CSS is covered by the index.css guard. */
export function prefersReducedMotion(): boolean {
  return getReducedMotionQuery()?.matches ?? false;
}

/** `useSyncExternalStore` subscribe half — fires when the OS reduced-motion setting flips mid-session. */
export function subscribeReducedMotion(callback: () => void): () => void {
  const query = getReducedMotionQuery();
  if (!query) return () => {};
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
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

/** Renderable remote art check; http:// addon art must not render as no-art. */
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

const MEDIA_TYPE_ACRONYMS = new Set(['tv', 'ppv', 'iptv']);

/** Card/hero type pill — series/anime get their own labels, addon types titlecase per word, else Movie. */
export function mediaTypeLabel(type?: string | null): string {
  const normalized = type?.trim().toLowerCase();
  if (normalized === 'anime') return 'Anime';
  if (isSeriesLikeMediaType(type)) return 'TV Series';
  if (!normalized || normalized === 'movie') return 'Movie';
  return (
    normalized
      .split(/[\s_-]+/)
      .filter(Boolean)
      .map((word) =>
        MEDIA_TYPE_ACRONYMS.has(word) ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1),
      )
      .join(' ') || 'Movie'
  );
}

/** Genre pills — catalog genres are already painted, so a late details payload must not swap the text. */
export function primaryGenrePills(
  catalogGenres: string[] | undefined,
  detailsGenres: string[] | undefined,
  max = 2,
): string[] {
  return (catalogGenres?.length ? catalogGenres : (detailsGenres ?? [])).slice(0, max);
}

/** Addon runtimes arrive as bare minutes ("142") or prose ("45 min") — collapse numeric to "2h 22m". */
export function formatRuntime(runtime?: string | null): string | undefined {
  const trimmed = runtime?.trim();
  if (!trimmed) return undefined;
  const mins = Number(trimmed);
  if (!Number.isInteger(mins) || mins <= 0) return trimmed;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return hours === 0 ? `${mins}m` : rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
