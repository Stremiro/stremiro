import type { NavigateFunction } from 'react-router';
import type { BestResolvedStream } from '@/lib/api';
import { currentPathWithSearch } from '@/lib/navigation';
import {
  type PlayerStreamRequest,
  type PreferredStreamIdentity,
  primePlayerStream,
} from '@/lib/resolve-player-stream';

export type PlayerRouteMediaType = 'movie' | 'series' | 'anime';

// Route state persists for the session, so `from` gets a hard cap — an
// unbounded value would linger in memory and history. 2048 covers real URLs.
const PLAYER_ROUTE_FROM_MAX_CHARS = 2048;

export interface PlayerRouteState {
  title?: string;
  poster?: string;
  backdrop?: string;
  logo?: string;
  format?: string;
  streamSourceId?: string;
  streamSourceName?: string;
  streamFamily?: string;
  selectedStreamKey?: string;
  /** The stream key the caller's resolve ran with — replays the cached entry. */
  requestedStreamKey?: string;
  startTime?: number;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  streamSeason?: number;
  streamEpisode?: number;
  resumeFromHistory?: boolean;
  streamLookupId?: string;
  /** The launch page's own origin — when `from` is a details page, this is its
      inbound `from` (e.g. '/search?q=x'), so Back→details→Back reaches the
      real origin. */
  originFrom?: string;
  from?: string;
  openingStreamName?: string;
  openingStreamSource?: string;
}

export function resolvePlayerRouteMediaType(
  mediaType: string | null | undefined,
): PlayerRouteMediaType {
  // Route segments carry the backend's canonical type — `kitsu:` ids are
  // mapped to anime inside the Rust history/resume paths.
  const normalizedType = normalizeRouteText(mediaType)?.toLowerCase();

  if (normalizedType === 'anime') {
    return 'anime';
  }

  return normalizedType === 'movie' ? 'movie' : 'series';
}

/** Details path for an opaque addon id; the id is encoded so `/`, `?` or `#`
    stay inside its route segment (React Router decodes params). */
export function buildDetailsRoute(mediaType: string | null | undefined, mediaId: string): string {
  return `/details/${resolvePlayerRouteMediaType(mediaType)}/${encodeURIComponent(mediaId)}`;
}

/// Details navigation with the caller's path as `from` — one shape so
/// click sites can't drift.
export function navigateToDetails(
  navigate: NavigateFunction,
  mediaType: string | null | undefined,
  mediaId: string,
): void {
  navigate(buildDetailsRoute(mediaType, mediaId), {
    state: { from: currentPathWithSearch() },
  });
}

function normalizeRouteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  // Season/episode 0 are valid (specials) — drop negatives, never falsy zeros.
  const truncated = Math.trunc(value);
  return truncated >= 0 ? truncated : undefined;
}

function normalizeRouteText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === 'null' || lower === 'undefined') {
    return undefined;
  }

  return trimmed;
}

export function sanitizePlayerRouteState(
  state: PlayerRouteState | null | undefined,
): PlayerRouteState {
  if (!state) {
    return {};
  }

  // Route state carries opaque identities only — no credential-bearing URL.
  const sanitized: PlayerRouteState = {};
  const textKeys = [
    'title',
    'poster',
    'backdrop',
    'logo',
    'format',
    'streamSourceId',
    'streamSourceName',
    'streamFamily',
    'selectedStreamKey',
    'requestedStreamKey',
    'streamLookupId',
    'openingStreamName',
    'openingStreamSource',
  ] as const;
  for (const key of textKeys) {
    const normalized = normalizeRouteText(state[key]);
    if (normalized !== undefined) sanitized[key] = normalized;
  }
  if (
    typeof state.startTime === 'number' &&
    Number.isFinite(state.startTime) &&
    state.startTime > 0
  ) {
    sanitized.startTime = state.startTime;
  }
  const absoluteSeason = normalizeRouteNumber(state.absoluteSeason);
  if (absoluteSeason !== undefined) sanitized.absoluteSeason = absoluteSeason;
  const absoluteEpisode = normalizeRouteNumber(state.absoluteEpisode);
  if (absoluteEpisode !== undefined) sanitized.absoluteEpisode = absoluteEpisode;
  const streamSeason = normalizeRouteNumber(state.streamSeason);
  if (streamSeason !== undefined) sanitized.streamSeason = streamSeason;
  const streamEpisode = normalizeRouteNumber(state.streamEpisode);
  if (streamEpisode !== undefined) sanitized.streamEpisode = streamEpisode;
  if (state.resumeFromHistory === true) sanitized.resumeFromHistory = true;
  const originFrom = resolveSafeInternalReturnPath(state.originFrom);
  if (originFrom !== undefined) sanitized.originFrom = originFrom;
  const from = normalizeRouteText(state.from);
  if (from !== undefined && from.length <= PLAYER_ROUTE_FROM_MAX_CHARS) sanitized.from = from;
  return sanitized;
}

function buildPlayerRoute(
  mediaType: PlayerRouteMediaType,
  mediaId: string,
  absoluteSeason?: number,
  absoluteEpisode?: number,
  streamSeason?: number,
  streamEpisode?: number,
): string {
  // Prefer canonical coordinates; fall back to stream S/E so callers can still deep-link.
  const season = normalizeRouteNumber(absoluteSeason) ?? normalizeRouteNumber(streamSeason);
  const episode = normalizeRouteNumber(absoluteEpisode) ?? normalizeRouteNumber(streamEpisode);
  const base = `/player/${mediaType}/${encodeURIComponent(mediaId)}`;

  return season !== undefined && episode !== undefined ? `${base}/${season}/${episode}` : base;
}

// The player owns one history slot: hops inside it (episode advance, in-player
// pick) replace the live entry — a push would leave stale /player coordinates
// for a later POP to resurrect. A launch from a page still pushes. Evaluated
// at navigate time — the call site can fire expanded or minimized.
function isPlayerRoutePath(pathname: string): boolean {
  return pathname === '/player' || pathname.startsWith('/player/');
}

/**
 * One owner for "safe to navigate back to": an internal, non-player path.
 * Rejects non-strings, blank/'null' text, oversized payloads, external values,
 * and `/player` routes — a player target would relaunch the session Back just
 * left. Accepts `unknown` so raw `location.state` validates without a cast.
 */
export function resolveSafeInternalReturnPath(from: unknown): string | undefined {
  const normalized = normalizeRouteText(from);
  if (
    normalized === undefined ||
    normalized.length > PLAYER_ROUTE_FROM_MAX_CHARS ||
    !normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    isPlayerRoutePath(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

/**
 * Route state for a resolve winner — one owner of the `requested` vs
 * `selected` key contract: `requestedStreamKey` is the caller's own resolve
 * key (the cache entry the player replays); `selectedStreamKey` is the winner
 * — a failover can differ from the pick.
 *
 * The resolved URL never enters route state — opaque identities only, and the
 * player re-resolves a fresh URL on mount.
 */
function buildResolvedStreamRouteState(
  request: PlayerStreamRequest,
  resolved: BestResolvedStream,
  extras: PlayerRouteState = {},
  picked?: PreferredStreamIdentity,
): PlayerRouteState {
  const explicit: PlayerRouteState = {
    absoluteEpisode: request.absoluteEpisode,
    absoluteSeason: request.absoluteSeason,
    format: resolved.format,
    requestedStreamKey: picked?.streamKey ?? resolved.streamKey,
    selectedStreamKey: resolved.streamKey ?? picked?.streamKey,
    streamEpisode: request.streamEpisode,
    streamFamily: resolved.streamFamily ?? picked?.streamFamily,
    streamLookupId: request.streamLookupId,
    streamSeason: request.streamSeason,
    streamSourceId: resolved.sourceId ?? picked?.sourceId,
    streamSourceName: resolved.sourceName ?? picked?.sourceName,
    title: request.title,
  };
  // An absent request field must not erase a caller extra — `{...extras,
  // ...explicit}` would overwrite with `undefined`.
  for (const key of Object.keys(explicit) as (keyof PlayerRouteState)[]) {
    if (explicit[key] === undefined) delete explicit[key];
  }
  return { ...extras, ...explicit };
}

/**
 * Launch the player for a resolve winner — one owner of prime, route state and
 * history slot. The prime seeds the entry the player replays so mount pays
 * zero resolve; `picked` is the selector pick whose key that replay uses.
 */
export function launchResolvedStream(
  navigate: NavigateFunction,
  request: PlayerStreamRequest,
  resolved: BestResolvedStream,
  extras?: PlayerRouteState,
  picked?: PreferredStreamIdentity,
): void {
  primePlayerStream(resolved, request, picked?.streamKey);
  const state = sanitizePlayerRouteState(
    buildResolvedStreamRouteState(request, resolved, extras, picked),
  );
  navigate(
    buildPlayerRoute(
      request.mediaType,
      request.mediaId,
      state.absoluteSeason,
      state.absoluteEpisode,
      state.streamSeason,
      state.streamEpisode,
    ),
    { state, replace: isPlayerRoutePath(window.location.pathname) },
  );
}
