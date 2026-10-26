import { memo } from 'react';
import { useHistoryPlayback } from '@/hooks/use-history-playback';
import type { WatchProgress } from '@/lib/api';
import {
  formatWatchRemaining,
  getWatchProgressPercent,
  watchProgressMediaItem,
} from '@/lib/history-playback';
import { formatSeasonEpisode } from '@/lib/utils';
import { MediaCard, type PlaybackIntent } from './media-card';

interface WatchProgressCardProps {
  item: WatchProgress;
  playbackIntent?: PlaybackIntent;
  isNewEpisode?: boolean;
  /** Overrides the "time left" line (e.g. up-next cards have no progress). */
  metaLine?: string;
  /** Remove mutation differs per surface (history vs. continue watching) — callers own it. */
  onRemove?: () => void;
  removeFrom?: string;
  /** Toast title when the playback-plan lookup fails. */
  playErrorTitle: string;
}

// WatchProgress → MediaCard adapter for the resume rail and history grid.
export const WatchProgressCard = memo(function WatchProgressCard({
  item,
  playbackIntent,
  isNewEpisode,
  metaLine: metaLineOverride,
  onRemove,
  removeFrom,
  playErrorTitle,
}: WatchProgressCardProps) {
  const { play, isPending } = useHistoryPlayback(item, playErrorTitle);
  const progressPercent = getWatchProgressPercent(item.position, item.duration);
  const progress = progressPercent > 0 ? progressPercent : undefined;

  const mediaItem = watchProgressMediaItem(item);
  // The S/E tag rides the poster badge (`subtitle`), so the meta line only
  // carries time left.
  const metaLine =
    metaLineOverride ??
    (item.is_watched
      ? 'Watched'
      : (formatWatchRemaining(item.position, item.duration) ?? undefined));
  const season = item.absolute_season ?? undefined;
  const episode = item.absolute_episode ?? undefined;
  const subtitle = formatSeasonEpisode(season, episode) || undefined;

  return (
    <MediaCard
      item={mediaItem}
      progress={progress}
      isNewEpisode={isNewEpisode}
      metaLine={metaLine}
      onPlay={play}
      playbackIntent={playbackIntent ?? (item.is_watched ? 'replay' : 'resume')}
      isPlayPending={isPending}
      onRemoveFromContinue={onRemove ? () => onRemove() : undefined}
      removeFrom={removeFrom}
      subtitle={subtitle}
    />
  );
});
