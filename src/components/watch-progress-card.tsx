import { memo } from 'react';
import { useHistoryPlayback } from '@/hooks/use-history-playback';
import { useToggleEpisodeWatched } from '@/hooks/use-media-library';
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
  /** Continue Watching menu extras: mark the episode watched and skip ahead. */
  episodeActions?: boolean;
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
  episodeActions = false,
}: WatchProgressCardProps) {
  const { play, playNext, isPending } = useHistoryPlayback(item, playErrorTitle);
  const progressPercent = getWatchProgressPercent(item.position, item.duration);
  const progress = progressPercent > 0 ? progressPercent : undefined;

  const mediaItem = watchProgressMediaItem(item);
  const { mutate: setEpisodesWatched } = useToggleEpisodeWatched({ item: mediaItem });
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
  const isEpisodeRow =
    episodeActions && item.type_ !== 'movie' && season !== undefined && episode !== undefined;
  const resolvedIntent = playbackIntent ?? (item.is_watched ? 'replay' : 'resume');

  return (
    <MediaCard
      item={mediaItem}
      progress={progress}
      isNewEpisode={isNewEpisode}
      metaLine={metaLine}
      onPlay={play}
      onPlayNext={isEpisodeRow && resolvedIntent === 'resume' ? () => void playNext() : undefined}
      onMarkWatched={
        isEpisodeRow && !item.is_watched
          ? () => setEpisodesWatched({ episodes: [{ id: '', season, episode }], watched: true })
          : undefined
      }
      playbackIntent={resolvedIntent}
      isPlayPending={isPending}
      onRemoveFromContinue={onRemove ? () => onRemove() : undefined}
      removeFrom={removeFrom}
      subtitle={subtitle}
    />
  );
});
