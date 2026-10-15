import { formatDistanceToNow } from 'date-fns';
import { Check, Loader2, Play, X } from 'lucide-react';
import { memo } from 'react';
import { useNavigate } from 'react-router';
import { PosterThumb } from '@/components/poster-thumb';
import { Button } from '@/components/ui/button';
import { WatchProgressCard } from '@/components/watch-progress-card';
import { WindowVirtualizedStack } from '@/components/window-virtualized-stack';
import { useHistoryPlayback } from '@/hooks/use-history-playback';
import { useRemoveFromWatchHistory } from '@/hooks/use-media-library';
import { usePrefetchDetails } from '@/hooks/use-prefetch-details';
import {
  type MediaItem,
  WATCH_STATUS_COLORS,
  WATCH_STATUS_LABELS,
  type WatchProgress,
  type WatchStatus,
} from '@/lib/api';
import {
  getWatchProgressPercent,
  watchProgressCoordinates,
  watchProgressItemKey,
} from '@/lib/history-playback';
import { navigateToDetails } from '@/lib/player-navigation';
import { cn, formatSeasonEpisode, mediaTypeLabel } from '@/lib/utils';
import { mediaCardRailKey } from './media-card';

export function LibraryList({
  items,
  watchStatuses,
  selectionMode,
  selectedIds,
  onToggleSelect,
}: {
  items: MediaItem[];
  watchStatuses?: Record<string, WatchStatus>;
  selectionMode?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (item: MediaItem) => void;
}) {
  return (
    <WindowVirtualizedStack
      items={items}
      getItemKey={mediaCardRailKey}
      estimateSize={() => 76}
      renderItem={(item) => (
        <LibraryListRow
          item={item}
          status={watchStatuses?.[item.id]}
          selectionMode={selectionMode}
          isSelected={selectedIds?.has(item.id) ?? false}
          onToggleSelect={onToggleSelect}
        />
      )}
    />
  );
}

const LibraryListRow = memo(function LibraryListRow({
  item,
  status,
  selectionMode = false,
  isSelected = false,
  onToggleSelect,
}: {
  item: MediaItem;
  status?: WatchStatus;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (item: MediaItem) => void;
}) {
  const navigate = useNavigate();
  const prefetchDetails = usePrefetchDetails(item.id, item.type);

  return (
    <button
      type='button'
      aria-pressed={selectionMode ? isSelected : undefined}
      aria-label={selectionMode ? `${isSelected ? 'Deselect' : 'Select'} ${item.title}` : undefined}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2.5 rounded-md border hover:bg-white/[0.04] hover:border-white/[0.10] transition-colors text-left group focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:border-white/20',
        selectionMode && isSelected
          ? 'border-white/[0.18] bg-white/[0.06]'
          : 'bg-white/[0.015] border-white/[0.05]',
      )}
      onPointerEnter={selectionMode ? undefined : prefetchDetails}
      onFocus={selectionMode ? undefined : prefetchDetails}
      onClick={(event) => {
        if (selectionMode) {
          event.preventDefault();
          onToggleSelect?.(item);
          return;
        }
        navigateToDetails(navigate, item.type, item.id);
      }}
    >
      {selectionMode && (
        <span
          aria-hidden='true'
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors',
            isSelected
              ? 'border-(--accent-nav) bg-(--accent-nav) text-(--on-accent-nav)'
              : 'border-white/25 bg-black/30 text-transparent group-hover:border-white/50',
          )}
        >
          <Check className='h-3 w-3' strokeWidth={3} />
        </span>
      )}
      <PosterThumb poster={item.poster} title={item.title} />

      <div className='flex-1 min-w-0'>
        <p
          dir='auto'
          title={item.title}
          className='text-[13px] font-medium text-zinc-100 truncate group-hover:text-white transition-colors'
        >
          {item.title}
        </p>
        <div className='flex items-center gap-1.5 mt-1 flex-wrap'>
          {item.displayYear && (
            <span className='text-[11px] text-zinc-500'>{item.displayYear}</span>
          )}
          <span className='text-[11px] text-zinc-400'>{mediaTypeLabel(item.type)}</span>
          {status && (
            <span className={cn('text-[11px] font-medium', WATCH_STATUS_COLORS[status].text)}>
              {WATCH_STATUS_LABELS[status]}
            </span>
          )}
        </div>
      </div>
    </button>
  );
});

export function HistoryListView({ items }: { items: WatchProgress[] }) {
  return (
    <WindowVirtualizedStack
      items={items}
      getItemKey={watchProgressItemKey}
      estimateSize={() => 78}
      renderItem={(item) => <HistoryListRow item={item} />}
    />
  );
}

const HistoryListRow = memo(function HistoryListRow({ item }: { item: WatchProgress }) {
  const navigate = useNavigate();
  const prefetchDetails = usePrefetchDetails(item.id, item.type_);
  const progressPct = getWatchProgressPercent(item.position, item.duration);
  const { season, episode } = watchProgressCoordinates(item);
  const seasonEpisodeLabel = formatSeasonEpisode(season, episode);
  const watchedAgo =
    item.last_watched > 0
      ? formatDistanceToNow(new Date(item.last_watched), { addSuffix: true })
      : null;

  const removeItem = useRemoveFromWatchHistory({
    itemId: item.id,
    itemTitle: item.title,
    mediaType: item.type_,
  });
  const { play: handlePlay, isPending: isPlayPending } = useHistoryPlayback(
    item,
    'Failed to open watch history item',
  );

  return (
    <div className='group/hrow flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.05] hover:border-white/[0.10] transition-colors'>
      <button
        type='button'
        aria-label={`Open details for ${item.title}`}
        onClick={() => navigateToDetails(navigate, item.type_, item.id)}
        onPointerEnter={prefetchDetails}
        onFocus={prefetchDetails}
        className='flex flex-1 min-w-0 items-center gap-3 rounded-lg text-left hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/30'
      >
        <PosterThumb poster={item.poster} title={item.title} progressPct={progressPct} />
        <div className='flex-1 min-w-0'>
          <p
            dir='auto'
            title={item.title}
            className='text-[13px] font-medium text-zinc-100 truncate'
          >
            {item.title}
          </p>
          <div className='flex flex-wrap items-center gap-x-2 gap-y-1 mt-1'>
            {seasonEpisodeLabel && (
              <span className='text-[11px] text-zinc-400 font-medium'>{seasonEpisodeLabel}</span>
            )}
            {progressPct > 0 && (
              <span className='text-[11px] text-zinc-500 tabular-nums'>
                {Math.round(progressPct)}%
              </span>
            )}
            {watchedAgo && <span className='text-[11px] text-zinc-600'>{watchedAgo}</span>}
          </div>
        </div>
      </button>

      <div className='flex items-center gap-0.5 shrink-0'>
        <Button
          size='icon'
          variant='ghost'
          className='h-8 w-8 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors'
          onClick={(e) => {
            if (!isPlayPending) void handlePlay(e);
          }}
          aria-label={`Play ${item.title}`}
          title='Play'
          aria-disabled={isPlayPending || undefined}
        >
          {isPlayPending ? (
            <Loader2 className='w-3 h-3 animate-spin' />
          ) : (
            <Play className='w-3 h-3 fill-current' />
          )}
        </Button>
        <Button
          size='icon'
          variant='ghost'
          className='h-8 w-8 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-100 md:opacity-0 md:group-hover/hrow:opacity-100 md:group-focus-within/hrow:opacity-100 focus-visible:opacity-100'
          onClick={(e) => {
            e.stopPropagation();
            if (!removeItem.isPending) removeItem.mutate();
          }}
          aria-label={`Remove ${item.title} from history`}
          title='Remove from history'
          aria-disabled={removeItem.isPending || undefined}
        >
          <X className='w-3 h-3' />
        </Button>
      </div>
    </div>
  );
});

export const HistoryItem = memo(function HistoryItem({ item }: { item: WatchProgress }) {
  const { mutate: removeItem } = useRemoveFromWatchHistory({
    itemId: item.id,
    itemTitle: item.title,
    mediaType: item.type_,
  });

  return (
    <WatchProgressCard
      item={item}
      onRemove={removeItem}
      playErrorTitle='Failed to resume playback'
    />
  );
});
