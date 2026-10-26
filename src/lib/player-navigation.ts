import type { NavigateFunction } from 'react-router';
import type { BestResolvedStream } from '@/lib/api';
import { currentPathWithSearch, navigateApp } from '@/lib/navigation';
import {
  type PlayerStreamRequest,
  type PreferredStreamIdentity,
  primePlayerStream,
} from '@/lib/resolve-player-stream';

export type PlayerRouteMediaType = 'movie' | 'series' | 'anime';

// Positive but below the resume threshold: suppress saved history without seeking.
export const PLAYER_RESTART_START_TIME = 1;

let playbackLaunchGeneration = 0;

export function claimPlaybackLaunch(): number {
  return ++playbackLaunchGeneration;
}

export function isCurrentPlaybackLaunch(generation: number): boolean {
  return generation === playbackLaunchGeneration;
}

// Route state persists for the session — cap `from` so an unbounded value can't linger in memory/history.
const PLAYER_ROUTE_FROM_MAX_CHARS = 2048;

export interface PlayerRouteState {
  title?: string;
  poster?: string;
  backdrop?: string;
  logo?: string;
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
  /** The launch page's own origin — when `from` is a details page, this is its inbound `from`, so Back→details→Back reaches the real origin. */
  originFrom?: string;
  from?: string;
  openingStreamName?: string;
  openingStreamSource?: string;
}

export function resolvePlayerRouteMediaType(
  mediaType: string | null | undefined,
): PlayerRouteMediaType {
  // Route segments carry the canonical type — `kitsu:` ids map to anime in Rust's history/resume paths.
  const normalizedType = normalizeRouteText(mediaType)?.toLowerCase();

  if (normalizedType === 'anime') {
    return 'anime';
  }

  return normalizedType === 'movie' ? 'movie' : 'series';
}

/** Details path for an opaque addon id — encoded so `/`/`?`/`#` stay inside the segment (RR decodes params). */
export function buildDetailsRoute(mediaType: string | null | undefined, mediaId: string): string {
  return `/details/${resolvePlayerRouteMediaType(mediaType)}/${encodeURIComponent(mediaId)}`;
}

/// Details navigation with the caller's path as `from` — one shape so
/// click sites can't drift.
export function navigateToDetails(mediaType: string | null | undefined, mediaId: string): void {
  navigateApp(buildDetailsRoute(mediaType, mediaId), {
    state: { from: currentPathWithSearch() },
  });
}

export function normalizeRouteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  // Season/episode 0 are valid (specials) — drop negatives, never falsy zeros.
  const truncated = Math.trunc(value);
  return truncated >= 0 ? truncated : undefined;
}

function normalizeRouteText(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const lower = trimmed.toLowerCase();
  return trimmed && lower !== 'null' && lower !== 'undefined' ? trimmed : undefined;
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
    state.startTime >= 0
  ) {
    sanitized.startTime = state.startTime || PLAYER_RESTART_START_TIME;
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

function parseRouteSegmentNumber(value: string | undefined): number | undefined {
  // Season/episode 0 are valid coordinates (specials).
  return value ? normalizeRouteNumber(Number.parseInt(value, 10)) : undefined;
}

/** Everything the player derives from its launch; the session host's loading screen reads the same view. */
export function resolvePlayerLaunch(launch: {
  type?: string;
  id?: string;
  season?: string;
  episode?: string;
  state?: unknown;
}) {
  const { type, id, season, episode } = launch;
  const state = sanitizePlayerRouteState(launch.state as PlayerRouteState | null);
  const routeSeason = parseRouteSegmentNumber(season);
  const routeEpisode = parseRouteSegmentNumber(episode);
  return {
    ...state,
    id,
    type,
    seasonParam: season,
    episodeParam: episode,
    routeSeason,
    routeEpisode,
    // Sanitized state fields need no second parse.
    routeAbsoluteSeason: state.absoluteSeason ?? routeSeason,
    routeAbsoluteEpisode: state.absoluteEpisode ?? routeEpisode,
    title: state.title || 'Unknown Title',
    // Raw route title — the 'Unknown Title' display fallback must not enter ranking or the best-stream key.
    resolveTitle: state.title,
    isHistoryResume: state.resumeFromHistory === true,
    effectiveResolveMediaType: resolvePlayerRouteMediaType(type),
  };
}
// The player owns one history slot: in-player hops replace, page launches push — a push
// inside /player would leave stale coordinates for a later POP to resurrect. Evaluated at navigate time.
function isPlayerRoutePath(pathname: string): boolean {
  return pathname === '/player' || pathname.startsWith('/player/');
}

/** "Safe to navigate back to" — an internal, non-player path (a player target would relaunch the session Back just left). */
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

/** Route state for a resolve winner: `requestedStreamKey` replays the caller's cached
    resolve; `selectedStreamKey` is the winner (failover can differ). URL never enters state. */
function buildResolvedStreamRouteState(
  request: PlayerStreamRequest,
  resolved: BestResolvedStream,
  extras: PlayerRouteState = {},
  picked?: PreferredStreamIdentity,
): PlayerRouteState {
  const explicit: PlayerRouteState = {
    absoluteEpisode: request.absoluteEpisode,
    absoluteSeason: request.absoluteSeason,
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
  // Absent request fields must not erase caller extras — spread would overwrite with `undefined`.
  for (const key of Object.keys(explicit) as (keyof PlayerRouteState)[]) {
    if (explicit[key] === undefined) delete explicit[key];
  }
  return { ...extras, ...explicit };
}

/** Launch the player for a resolve winner — primes the cache entry the player replays so mount pays zero resolve. */
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
  const season = state.absoluteSeason ?? state.streamSeason;
  const episode = state.absoluteEpisode ?? state.streamEpisode;
  const base = `/player/${request.mediaType}/${encodeURIComponent(request.mediaId)}`;
  void navigate(
    season !== undefined && episode !== undefined ? `${base}/${season}/${episode}` : base,
    { state, replace: isPlayerRoutePath(window.location.pathname) },
  );
}
