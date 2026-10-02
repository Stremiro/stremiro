import type { UpNextCandidate, WatchProgress } from '@/lib/api';
import { parseLocalScheduleDate } from '@/lib/utils';
const NEW_EPISODE_WINDOW_MS = 1000 * 60 * 60 * 24 * 7;

const UP_NEXT_META_LINE = 'Up next';
const NEW_EPISODE_META_LINE = 'New episode';

export interface UpNextEntry {
  row: WatchProgress;
  metaLine: string;
}

export function buildUpNextEntries(
  candidates: readonly UpNextCandidate[],
  now: number,
): UpNextEntry[] {
  return candidates.map(({ row, releaseDate }) => {
    // Local midnight preserves the seven-day badge across daylight saving.
    const releasedAt = parseLocalScheduleDate(releaseDate)?.getTime() ?? Number.NaN;
    return {
      row,
      metaLine:
        now - releasedAt <= NEW_EPISODE_WINDOW_MS && releasedAt > row.last_watched
          ? NEW_EPISODE_META_LINE
          : UP_NEXT_META_LINE,
    };
  });
}
