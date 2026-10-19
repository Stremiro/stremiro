import { memo, type MouseEvent, useCallback, useMemo } from 'react';
import { useHistoryPlayback } from '@/hooks/use-history-playback';
import type { WatchProgress } from '@/lib/api';
import {
  formatWatchRemaining,
  getWatchProgressPercent,
  watchProgressMediaItem,
} from '@/lib/history-playback';
import { formatSeasonEpisode } from '@/lib/utils';
import { MediaCard } from './media-card';

interface WatchProgressCardProps {
  item: WatchProgress;
  playbackIntent?: 'resume' | 'next-episode';
  /** Overrides the "time left" line (e.g. up-next cards have no progress). */
  metaLine?: string;
  /** Remove mutation differs per surface (history vs. continue watching) — callers own it. */
  onRemove?: () => void;
  /** Toast title when the playback-plan lookup fails. */
  playErrorTitle: string;
}

// WatchProgress → MediaCard adapter for the resume rail and history grid.
export const WatchProgressCard = memo(function WatchProgressCard({
  item,
  playbackIntent = 'resume',
  metaLine: metaLineOverride,
  onRemove,
  playErrorTitle,
}: WatchProgressCardProps) {
  const { play, isPending } = useHistoryPlayback(item, playErrorTitle);
  const progressPercent = getWatchProgressPercent(item.position, item.duration);
  const progress = progressPercent > 0 ? progressPercent : undefined;

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
      playbackIntent={playbackIntent}
      isPlayPending={isPending}
      onRemoveFromContinue={onRemove ? handleRemove : undefined}
      subtitle={
        formatSeasonEpisode(
          item.absolute_season ?? undefined,
          item.absolute_episode ?? undefined,
        ) || undefined
      }
    />
  );
});
