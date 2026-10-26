import type { QueryClient } from '@tanstack/react-query';
import type { NavigateFunction } from 'react-router';
import { toast } from 'sonner';
import { api, type MediaItem, type WatchProgress } from '@/lib/api';
import { prefetchFullDetailsData } from '@/lib/details-prefetch';
import { warmPlayerChunk } from '@/lib/route-chunks';
import {
  claimPlaybackLaunch,
  isCurrentPlaybackLaunch,
  PLAYER_RESTART_START_TIME,
} from '@/lib/player-navigation';
import { resolvePlayerStream } from '@/lib/resolve-player-stream';
import {
  clamp,
  formatSeasonEpisode,
  formatTime,
  isSeriesLikeMediaType,
  withTimeout,
} from '@/lib/utils';

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
  return {
    title: 'Episode context missing',
    description:
      mode === 'select-episode'
        ? 'Select the episode below to continue watching.'
        : 'Opening details so you can select the episode to continue.',
  };
}

/** An observed beginning suppresses history; only an unavailable clock falls back. */
export function playableResumePosition(
  livePosition: number | undefined,
  routeStartTime: number | undefined,
): number | undefined {
  const position =
    livePosition !== undefined && Number.isFinite(livePosition) ? livePosition : routeStartTime;
  if (position === undefined || !Number.isFinite(position) || position < 0) return undefined;
  return position >= MIN_RESUME_POSITION_SECS ? position : PLAYER_RESTART_START_TIME;
}

/** "S2:E4 · From 23:14": where playback will land, for the loading card. */
export function formatPlaybackLanding(
  season: number | undefined,
  episode: number | undefined,
  startTime: number | undefined,
): string | undefined {
  const resumeAt =
    startTime !== undefined && startTime >= MIN_RESUME_POSITION_SECS
      ? `From ${formatTime(startTime)}`
      : '';
  return [formatSeasonEpisode(season, episode), resumeAt].filter(Boolean).join(' · ') || undefined;
}

const RESUME_LOOKUP_TIMEOUT_MS = 6_000;

export async function getLatestEpisodeResumeStartTime(
  mediaId: string,
  mediaType: string,
  season?: number,
  episode?: number,
): Promise<number | undefined> {
  try {
    // Bounded: a wedged store read must not hold "Choose stream" hostage.
    const progress = await withTimeout(
      api.getWatchProgress(mediaId, mediaType, season, episode),
      RESUME_LOOKUP_TIMEOUT_MS,
      () => {
        throw new Error('resume lookup timed out');
      },
    );
    // A definite "no resume" skips the player's own history lookup.
    return progress?.resume_start_time ?? PLAYER_RESTART_START_TIME;
  } catch {
    return undefined;
  }
}

// Series and anime routes share history rows and player sessions.
export function isSameMediaKind(left?: string | null, right?: string | null): boolean {
  return left === right || (isSeriesLikeMediaType(left) && isSeriesLikeMediaType(right));
}

// Shared row identity for Home's resume rail and Profile's grid/list views.
export function watchProgressItemKey(item: WatchProgress): string {
  return `${item.type_}-${item.id}-${item.absolute_season ?? ''}-${item.absolute_episode ?? ''}`;
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

function isValidProgressTiming(position: number, duration: number): boolean {
  return Number.isFinite(position) && Number.isFinite(duration) && duration > 0;
}

// Shared progress percent; invalid inputs render as 0.
export function getWatchProgressPercent(position: number, duration: number): number {
  if (!isValidProgressTiming(position, duration)) return 0;
  return clamp((position / duration) * 100, 0, 100);
}

// Compact "time left" label; tails under 30s read as finished so nothing claims "0m left".
export function formatWatchRemaining(position: number, duration: number): string | null {
  if (!isValidProgressTiming(position, duration)) return null;

  const remainingSecs = Math.max(0, duration - position);
  if (remainingSecs < 30) return null;
  const mins = Math.max(1, Math.round(remainingSecs / 60));
  if (mins < 60) return `${mins}m left`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest === 0 ? `${hours}h left` : `${hours}h ${rest}m left`;
}
interface HistoryPlaybackOptions {
  launchGeneration?: number;
  onSelectEpisode?: (() => void | Promise<void>) | null;
  /** Ignore late completion after the launch owner unmounts. */
  isCancelled?: () => boolean;
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
  const launchGeneration = options?.launchGeneration ?? claimPlaybackLaunch();
  const launchOptions = {
    ...options,
    isCancelled: () =>
      !isCurrentPlaybackLaunch(launchGeneration) || options?.isCancelled?.() === true,
  };
  try {
    // A resume click predicts a player mount — overlap the chunk fetch.
    warmPlayerChunk();
    // Series resumes gate the player's resolve on the details payload.
    if (queryClient) {
      prefetchFullDetailsData(queryClient, { mediaId: item.id, mediaType: item.type_ });
    }
    const plan = await api.buildHistoryPlaybackPlan(item, from);
    if (launchOptions.isCancelled()) return;
    // Player plans warm the resolve and navigate; details plans surface the notice,
    // then pick in-page or navigate.
    if (plan.kind === 'player') {
      // Fan-out starts now, overlapped with navigation and mpv init.
      if (plan.warmResolveRequest) {
        void resolvePlayerStream(plan.warmResolveRequest).catch(() => undefined);
      }
      void navigate(plan.target, { state: plan.state });
      return;
    }

    const onSelectEpisode = launchOptions.onSelectEpisode;
    const notice = getHistoryPlaybackFallbackNotice(
      onSelectEpisode ? 'select-episode' : 'open-details',
    );
    toast.info(notice.title, { description: notice.description });

    if (onSelectEpisode) {
      await onSelectEpisode();
      return;
    }

    void navigate(plan.target, { state: plan.state });
  } catch (error) {
    if (launchOptions.isCancelled()) return;
    toast.error(errorTitle, {
      description: error instanceof Error ? error.message : 'Please try again.',
    });
  }
}
