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
import { warmPlayerChunk } from '@/lib/player-session';
import { resolvePlayerStream } from '@/lib/resolve-player-stream';
import { clamp, withTimeout } from '@/lib/utils';

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

// Mirrors Rust `WATCH_PROGRESS_MIN_RESUME_POSITION_SECS`: below this a position
// counts as "start from the beginning"; shared by resume offers and selector starts.
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

/** Live clock wins over route `startTime`; below `MIN_RESUME_POSITION_SECS` counts as absent. */
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

const RESUME_LOOKUP_TIMEOUT_MS = 6_000;

export async function getLatestEpisodeResumeStartTime(
  mediaId: string,
  mediaType: string,
  season?: number,
  episode?: number,
): Promise<number | undefined> {
  try {
    // Bounded: a wedged store read must not hold "Choose Stream" hostage.
    const progress = await withTimeout(
      api.getWatchProgress(mediaId, mediaType, season, episode),
      RESUME_LOOKUP_TIMEOUT_MS,
      () => null,
    );
    return progress?.resume_start_time;
  } catch {
    return undefined;
  }
}

// Absolute (normalized) season/episode wins over raw stream coordinates.
// One owner for resume targets, lookups, and subtitles.
export function watchProgressCoordinates(
  item?: Pick<WatchProgress, 'absolute_season' | 'absolute_episode' | 'season' | 'episode'> | null,
): { season?: number; episode?: number } {
  // Rust serializes `Option<u32>` as `null`; collapse to `undefined` for downstream guards.
  return {
    season: item?.absolute_season ?? item?.season ?? undefined,
    episode: item?.absolute_episode ?? item?.episode ?? undefined,
  };
}

// Shared row identity for Home's resume rail and Profile's grid/list views.
export function watchProgressItemKey(item: WatchProgress): string {
  const { season, episode } = watchProgressCoordinates(item);
  return `${item.type_}-${item.id}-${season ?? ''}-${episode ?? ''}`;
}

/** `id:season:episode` — lookup key for the backend's per-episode progress index. */
export function episodeProgressKey(id: string, season: number, episode: number): string {
  return `${id}:${season}:${episode}`;
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

// Compact "time left" label; tails under 30s read as finished so nothing claims "0m left".
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
interface HistoryPlaybackOptions {
  onSelectEpisode?: ((reason: HistoryPlaybackPlanReason) => void | Promise<void>) | null;
  /** Ignore late completion after the initiating surface unmounts. */
  isCancelled?: () => boolean;
}

// Player plans warm the resolve and navigate; details plans surface the notice,
// then pick in-page or navigate.
async function applyHistoryPlaybackPlan(
  navigate: NavigateFunction,
  plan: HistoryPlaybackPlan,
  options?: HistoryPlaybackOptions,
): Promise<void> {
  if (options?.isCancelled?.()) {
    return;
  }
  if (plan.kind === 'player') {
    // Fan-out starts now, overlapped with navigation and mpv init.
    if (plan.warmResolveRequest) {
      void resolvePlayerStream(plan.warmResolveRequest).catch(() => undefined);
    }
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
  options?: HistoryPlaybackOptions,
): Promise<void> {
  try {
    // A resume click predicts a player mount — overlap the chunk fetch.
    warmPlayerChunk();
    // Series resumes gate the player's resolve on the details payload.
    if (queryClient) {
      prefetchFullDetailsData(queryClient, { mediaId: item.id, mediaType: item.type_ });
    }
    const plan = await api.buildHistoryPlaybackPlan(item, from);
    await applyHistoryPlaybackPlan(navigate, plan, options);
  } catch (error) {
    if (options?.isCancelled?.()) return;
    toast.error(errorTitle, {
      description: error instanceof Error ? error.message : 'Please try again.',
    });
  }
}
