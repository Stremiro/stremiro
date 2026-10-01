import { memo, type MouseEvent, useCallback, useMemo } from 'react';
import { MediaCard } from '@/components/media-card';
import { useHistoryPlayback } from '@/hooks/use-history-playback';
import type { WatchProgress } from '@/lib/api';
import {
  formatWatchRemaining,
  getWatchProgressPercent,
  watchProgressCoordinates,
  watchProgressMediaItem,
} from '@/lib/history-playback';
import { formatSeasonEpisode } from '@/lib/utils';

interface WatchProgressCardProps {
  item: WatchProgress;
  /** Overrides the "time left" line (e.g. up-next cards have no progress). */
  metaLine?: string;
  /** The remove mutation differs per surface (watch history vs. continue
      watching) — callers keep owning it. */
  onRemove?: () => void;
  /** Toast title when the playback-plan lookup fails. */
  playErrorTitle: string;
}

// WatchProgress → MediaCard adapter shared by the home resume rail and the
// profile history/continue-watching grids.
export const WatchProgressCard = memo(function WatchProgressCard({
  item,
  metaLine: metaLineOverride,
  onRemove,
  playErrorTitle,
}: WatchProgressCardProps) {
  const { play, isPending } = useHistoryPlayback(item, playErrorTitle);
  const progressPercent = getWatchProgressPercent(item.position, item.duration);
  const progress = progressPercent > 0 ? progressPercent : undefined;
  const { season, episode } = watchProgressCoordinates(item);

  const mediaItem = useMemo(() => watchProgressMediaItem(item), [item]);
  // The S/E tag rides the poster badge (`subtitle`), so the meta line only
  // carries time left.
  const metaLine =
    metaLineOverride ?? formatWatchRemaining(item.position, item.duration) ?? undefined;

  // Stable callbacks keep MediaCard's memo effective.
  const handleRemove = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onRemove?.();
    },
    [onRemove],
  );

  return (
    <MediaCard
      item={mediaItem}
      progress={progress}
      metaLine={metaLine}
      onPlay={play}
      isPlayPending={isPending}
      onRemoveFromContinue={onRemove ? handleRemove : undefined}
      subtitle={formatSeasonEpisode(season, episode) || undefined}
    />
  );
});
