import type { MediaSchedule, WatchProgress, WatchStatus } from '@/lib/api';
import { isWatchedProgress, watchProgressCoordinates } from '@/lib/history-playback';
import { isSeriesLikeMediaType, parseLocalScheduleDate } from '@/lib/utils';

const UP_NEXT_MAX_TITLES = 12;
const UP_NEXT_LOOKBACK_MS = 1000 * 60 * 60 * 24 * 90;
const NEW_EPISODE_WINDOW_MS = 1000 * 60 * 60 * 24 * 7;

export const UP_NEXT_META_LINE = 'Up next';
export const NEW_EPISODE_META_LINE = 'New episode';

export interface UpNextEntry {
  row: WatchProgress;
  metaLine: string;
}

/** Series whose latest row is a finished episode — continue watching drops
    them, so they're the only titles that can need an up-next card. History
    arrives newest first, so the cap keeps the most recent. */
export function pickUpNextSources(
  history: readonly WatchProgress[] | undefined,
  continueWatching: readonly WatchProgress[],
  statuses: Record<string, WatchStatus> | undefined,
): WatchProgress[] {
  if (!history) return [];
  const resumable = new Set(continueWatching.map((row) => row.id));
  return history
    .filter(
      (row) =>
        isSeriesLikeMediaType(row.type_) &&
        isWatchedProgress(row) &&
        !resumable.has(row.id) &&
        statuses?.[row.id] !== 'dropped',
    )
    .slice(0, UP_NEXT_MAX_TITLES);
}

export function isRecentUpNextSource(row: WatchProgress, now: number): boolean {
  return now - row.last_watched <= UP_NEXT_LOOKBACK_MS;
}

/**
 * The next aired episode after each finished row, as a fresh zero-progress
 * row. Only the release-family hints carry over — the exact stream key and
 * lookup id belong to the finished episode.
 */
export function buildUpNextEntries(
  sources: readonly WatchProgress[],
  schedules: readonly MediaSchedule[],
  now: number,
): UpNextEntry[] {
  const schedulesById = new Map(schedules.map((schedule) => [schedule.id, schedule]));
  return sources.flatMap((source) => {
    const { season, episode } = watchProgressCoordinates(source);
    const schedule = schedulesById.get(source.id);
    if (!schedule || season === undefined || episode === undefined) return [];

    let next: MediaSchedule['episodes'][number] | undefined;
    for (const candidate of schedule.episodes) {
      // Specials only follow specials.
      if (candidate.season === 0 && season !== 0) continue;
      const isAfter =
        candidate.season > season || (candidate.season === season && candidate.episode > episode);
      const isBefore =
        next !== undefined &&
        (candidate.season < next.season ||
          (candidate.season === next.season && candidate.episode < next.episode));
      if (isAfter && (next === undefined || isBefore)) next = candidate;
    }
    const releasedAt = next
      ? (parseLocalScheduleDate(next.releaseDate)?.getTime() ?? Number.NaN)
      : Number.NaN;
    if (!next || Number.isNaN(releasedAt) || releasedAt > now) return [];

    return [
      {
        row: {
          id: source.id,
          type_: source.type_,
          season: next.season,
          episode: next.episode,
          absolute_season: next.season,
          absolute_episode: next.episode,
          position: 0,
          duration: 0,
          last_watched: source.last_watched,
          title: source.title,
          poster: source.poster,
          backdrop: source.backdrop,
          source_id: source.source_id,
          source_name: source.source_name,
          stream_family: source.stream_family,
        },
        metaLine:
          now - releasedAt <= NEW_EPISODE_WINDOW_MS && releasedAt > source.last_watched
            ? NEW_EPISODE_META_LINE
            : UP_NEXT_META_LINE,
      },
    ];
  });
}
