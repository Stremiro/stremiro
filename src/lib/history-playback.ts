import type { QueryClient } from '@tanstack/react-query';
import type { NavigateFunction } from 'react-router';
import { toast } from 'sonner';
import {
  api,
  type HistoryPlaybackPlan,
  type HistoryPlaybackPlanReason,
  type MediaItem,
  type WatchProgress,
} from '@/lib/api';
import { prefetchFullDetailsData } from '@/lib/details-prefetch';
import { resolvePlayerRouteMediaType } from '@/lib/player-navigation';
import { warmPlayerChunk } from '@/lib/player-session';
import { resolvePlayerStream } from '@/lib/resolve-player-stream';
import { clamp, isSeriesLikeMediaType, withTimeout } from '@/lib/utils';

export interface DetailsHistoryRouteState {
  // Optional: a self-referential `from` dead-ends the titlebar Back button.
  from?: string;
  season?: number;
  reopenStreamSelector?: boolean;
  reopenStreamSeason?: number;
  reopenStreamEpisode?: number;
  reopenStartTime?: number;
}

type HistoryPlaybackFallbackNoticeMode = 'open-details' | 'select-episode';

// Mirrors Rust `WATCH_PROGRESS_MIN_RESUME_POSITION_SECS`: below this a
// position counts as "start from the beginning" — resume offers, persistence,
// and selector start times all share it.
export const MIN_RESUME_POSITION_SECS = 5;

export function getHistoryPlaybackFallbackNotice(mode: HistoryPlaybackFallbackNoticeMode): {
  title: string;
  description: string;
} {
  return mode === 'select-episode'
    ? {
        title: 'Episode context missing',
        description: 'Select the episode below to continue watching.',
      }
    : {
        title: 'Episode context missing',
        description: 'Opening details so you can select the episode to continue.',
      };
}

/** The live clock position wins; the route's `startTime` is the fallback.
    Below `MIN_RESUME_POSITION_SECS` counts as absent — the backend's own
    no-resume boundary. */
export function playableResumePosition(
  livePosition: number | undefined,
  routeStartTime: number | undefined,
): number | undefined {
  if (
    livePosition !== undefined &&
    Number.isFinite(livePosition) &&
    livePosition >= MIN_RESUME_POSITION_SECS
  ) {
    return livePosition;
  }
  return routeStartTime !== undefined &&
    Number.isFinite(routeStartTime) &&
    routeStartTime >= MIN_RESUME_POSITION_SECS
    ? routeStartTime
    : undefined;
}

export function getPlayableResumeStartTime(
  item?: Pick<WatchProgress, 'resume_start_time'> | null,
): number | undefined {
  // Unwraps the Rust resume decision; UI never reimplements thresholds.
  if (!item) return undefined;
  if (typeof item.resume_start_time !== 'number' || !Number.isFinite(item.resume_start_time)) {
    return undefined;
  }

  return item.resume_start_time > 0 ? item.resume_start_time : undefined;
}

const RESUME_LOOKUP_TIMEOUT_MS = 6_000;

export async function getLatestEpisodeResumeStartTime(
  mediaId: string,
  mediaType: string,
  season?: number,
  episode?: number,
): Promise<number | undefined> {
  try {
    // Bounded: a wedged store read must not hold "Choose Stream" hostage —
    // the resume position is advisory.
    const progress = await withTimeout(
      api.getWatchProgress(mediaId, mediaType, season, episode),
      RESUME_LOOKUP_TIMEOUT_MS,
      () => null,
    );
    return getPlayableResumeStartTime(progress);
  } catch {
    return undefined;
  }
}

// Canonical coordinates — the absolute (normalized) season/episode wins over
// the raw stream coordinates. One owner for resume targets, lookups, and subtitles.
export function watchProgressCoordinates(
  item?: Pick<WatchProgress, 'absolute_season' | 'absolute_episode' | 'season' | 'episode'> | null,
): { season?: number; episode?: number } {
  // Rust serializes `Option<u32>` as explicit `null` — collapse to
  // `undefined`, which is what the `=== undefined` guards downstream test.
  return {
    season: item?.absolute_season ?? item?.season ?? undefined,
    episode: item?.absolute_episode ?? item?.episode ?? undefined,
  };
}

/** `id:season:episode` — the per-episode progress-map key format. One owner
    so map writes and lookups can't drift on ordering or separators. */
export function episodeProgressKey(id: string, season: number, episode: number): string {
  return `${id}:${season}:${episode}`;
}

interface TitleProgressIndex {
  /** Per-episode rows keyed under both normalized and raw coordinates. */
  episodeProgressMap: Map<string, WatchProgress>;
  movieProgress: WatchProgress | null;
  /** First series-like row — history arrives sorted by `last_watched` DESC. */
  latestSeriesProgress: WatchProgress | null;
}

// One fold over a title's watch rows feeding details and the episodes panel —
// single owner so map/key semantics can't drift between surfaces.
export function indexTitleWatchProgress(history: WatchProgress[] | undefined): TitleProgressIndex {
  const episodeProgressMap = new Map<string, WatchProgress>();
  let movieProgress: WatchProgress | null = null;
  let latestSeriesProgress: WatchProgress | null = null;
  if (history?.length) {
    // Rows arrive `last_watched` DESC; the map resolves a key to the newest
    // claimant — the same pick the backend's latest-match + donor merge makes.
    for (const entry of history) {
      if (entry.type_ === 'movie' && !movieProgress) movieProgress = entry;
      if (isSeriesLikeMediaType(entry.type_) && !latestSeriesProgress) {
        latestSeriesProgress = entry;
      }
      if (entry.type_ !== 'series') continue;
      const { season, episode } = watchProgressCoordinates(entry);
      if (season === undefined || episode === undefined) continue;
      const key = episodeProgressKey(entry.id, season, episode);
      if (!episodeProgressMap.has(key)) episodeProgressMap.set(key, entry);
    }
    // Raw-coordinate keys fill only unclaimed slots: a row's stream S/E can
    // collide with another episode's canonical key and must never shadow it.
    for (const entry of history) {
      if (entry.type_ !== 'series') continue;
      if (entry.season == null || entry.episode == null) continue;
      const key = episodeProgressKey(entry.id, entry.season, entry.episode);
      if (!episodeProgressMap.has(key)) episodeProgressMap.set(key, entry);
    }
  }
  return { episodeProgressMap, movieProgress, latestSeriesProgress };
}

// "Last used" stream identity for the selector badge: exact canonical coords
// first, then the newest matching row (`last_watched` DESC) — only rows of
// the target's media kind (movie vs series/anime).
export function getLastUsedStreamIdentity(
  history: readonly WatchProgress[] | undefined,
  mediaType: string,
  season?: number,
  episode?: number,
): { lastStreamKey?: string; lastStreamFamily?: string } {
  const seriesLikeTarget = isSeriesLikeMediaType(mediaType);
  const sameKind = (row: WatchProgress) => isSeriesLikeMediaType(row.type_) === seriesLikeTarget;
  const exactCoords = (row: WatchProgress) => {
    const coords = watchProgressCoordinates(row);
    return coords.season === season && coords.episode === episode;
  };
  const candidate =
    history?.find((row) => sameKind(row) && exactCoords(row)) ?? history?.find(sameKind);
  return {
    lastStreamKey: candidate?.last_stream_key || undefined,
    // Exact keys are per-episode — on a sibling episode the release family
    // is the signal that survives.
    lastStreamFamily: candidate?.stream_family || undefined,
  };
}

// WatchProgress → MediaItem card adapter — cards only need identity + poster.
export function watchProgressMediaItem(item: WatchProgress): MediaItem {
  return {
    id: item.id,
    title: item.title,
    type: item.type_ as MediaItem['type'],
    poster: item.poster,
  };
}

// Shared progress percent; invalid inputs render as 0.
export function getWatchProgressPercent(position: number, duration: number): number {
  if (
    typeof position !== 'number' ||
    typeof duration !== 'number' ||
    !Number.isFinite(position) ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    return 0;
  }

  return clamp((position / duration) * 100, 0, 100);
}

// Compact "time left" label ("24m left", "1h 5m left"). Rounds to the minute;
// tails under half a minute read as finished so nothing claims "0m left".
export function formatWatchRemaining(position: number, duration: number): string | null {
  if (
    typeof position !== 'number' ||
    typeof duration !== 'number' ||
    !Number.isFinite(position) ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    return null;
  }

  const remainingSecs = Math.max(0, duration - position);
  if (remainingSecs < 30) return null;
  const mins = Math.max(1, Math.round(remainingSecs / 60));
  if (mins < 60) return `${mins}m left`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest === 0 ? `${hours}h left` : `${hours}h ${rest}m left`;
}
// Fire the player's exact resolve request when the plan lands: the best-stream
// cache dedupes in-flight calls, so the mount-time auto-resolve joins this
// request. Every field must mirror the player's derivation — a difference
// silently misses the cache key.
function warmHistoryPlayerResolve(plan: HistoryPlaybackPlan): void {
  const state = plan.state;
  if (plan.kind !== 'player') return;

  // plan.target is `/player/{type}/{id}/…` — Rust already canonicalized the
  // media type (kitsu: → anime), which the frontend mapping can't see.
  const [, , typeSegment, idSegment] = plan.target.split('/');
  const mediaId = idSegment && decodeURIComponent(idSegment).trim();
  if (!mediaId) return;

  const mediaType = resolvePlayerRouteMediaType(typeSegment);
  // A coordinate-less warm keys on `na|na` while the replay uses the mapped
  // pair — a guaranteed miss that still pays a full addon fan-out.
  if (
    isSeriesLikeMediaType(mediaType) &&
    (state.absoluteSeason !== undefined || state.absoluteEpisode !== undefined) &&
    state.streamSeason === undefined &&
    state.streamEpisode === undefined
  ) {
    return;
  }

  void resolvePlayerStream({
    mediaType,
    mediaId,
    streamLookupId: state.streamLookupId,
    streamSeason: state.streamSeason,
    streamEpisode: state.streamEpisode,
    absoluteSeason: state.absoluteSeason,
    absoluteEpisode: state.absoluteEpisode,
    // The player's replay feeds `state.title` unfallbacked — the display
    // default must not enter the ranking key.
    title: state.title || undefined,
    preferred: {
      streamKey: state.selectedStreamKey,
      sourceId: state.streamSourceId,
      sourceName: state.streamSourceName,
      streamFamily: state.streamFamily,
    },
  }).catch(() => {
    // A failed warm never caches — the mount-time call retries on the same
    // key and owns the error surface.
  });
}

// One owner for applying a plan: player plans warm the resolve and navigate;
// details plans surface the notice, then pick in-page or navigate.
export async function applyHistoryPlaybackPlan(
  navigate: NavigateFunction,
  plan: HistoryPlaybackPlan,
  options?: {
    onSelectEpisode?: ((reason: HistoryPlaybackPlanReason) => void | Promise<void>) | null;
    /** Late-completion guard: if the initiating surface unmounted meanwhile,
        navigating would yank the user away from wherever they went. */
    isCancelled?: () => boolean;
  },
): Promise<void> {
  if (options?.isCancelled?.()) {
    return;
  }
  if (plan.kind === 'player') {
    // The addon fan-out starts now, overlapped with navigation and mpv init —
    // the player joins this in-flight request.
    warmHistoryPlayerResolve(plan);
    navigate(plan.target, { state: plan.state });
    return;
  }

  const onSelectEpisode = options?.onSelectEpisode;
  const notice = getHistoryPlaybackFallbackNotice(
    onSelectEpisode ? 'select-episode' : 'open-details',
  );
  toast.info(notice.title, { description: notice.description });

  if (onSelectEpisode) {
    await onSelectEpisode(plan.reason ?? 'missing-episode-context');
    return;
  }

  navigate(plan.target, { state: plan.state });
}

// Builds the Rust playback plan; details redirects surface a notice.
export async function openHistoryPlaybackPlan(
  navigate: NavigateFunction,
  item: WatchProgress,
  from: string,
  errorTitle: string,
  queryClient?: QueryClient,
  options?: { isCancelled?: () => boolean },
): Promise<void> {
  // A resume click predicts a player mount — overlap the chunk fetch.
  warmPlayerChunk();
  // Series resumes gate the player's resolve on the details payload — start
  // it now so it overlaps the plan lookup and navigation.
  if (queryClient) {
    prefetchFullDetailsData(queryClient, { mediaId: item.id, mediaType: item.type_ });
  }
  try {
    const plan = await api.buildHistoryPlaybackPlan(item, from);
    await applyHistoryPlaybackPlan(navigate, plan, { isCancelled: options?.isCancelled });
  } catch (error) {
    toast.error(errorTitle, {
      description: error instanceof Error ? error.message : 'Please try again.',
    });
  }
}
