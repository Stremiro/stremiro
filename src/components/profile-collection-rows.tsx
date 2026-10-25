import { formatRelativeTime } from '@/lib/schedule-dates';
import { Check, Loader2, Play, X } from 'lucide-react';
import { memo } from 'react';
import { PosterThumb } from '@/components/poster-thumb';
import { Button } from '@/components/ui/button';
import { WatchProgressCard } from '@/components/watch-progress-card';
import { WindowVirtualizedStack } from '@/components/window-virtualized-stack';
import { useHistoryPlayback } from '@/hooks/use-history-playback';
import {
  getOwnWatchStatus,
  useRemoveFromWatchHistory,
  watchTitleKey,
} from '@/hooks/use-media-library';
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
  watchProgressItemKey,
  watchProgressMediaItem,
} from '@/lib/history-playback';
import { navigateToDetails } from '@/lib/player-navigation';
import { cn, formatSeasonEpisode, mediaTypeLabel } from '@/lib/utils';
import { MediaCard, mediaCardRailKey } from './media-card';

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
  onToggleSelect?: (item: MediaItem, shiftKey?: boolean) => void;
}) {
  return (
    <WindowVirtualizedStack
      items={items}
      getItemKey={mediaCardRailKey}
      estimateSize={() => 76}
      renderItem={(item) => (
        <LibraryListRow
          item={item}
          status={getOwnWatchStatus(watchStatuses, item.id)}
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
  onToggleSelect?: (item: MediaItem, shiftKey?: boolean) => void;
}) {
  const prefetchDetails = usePrefetchDetails(item.id, item.type);

  return (
    <button
      type='button'
      aria-pressed={selectionMode ? isSelected : undefined}
      aria-label={selectionMode ? `${isSelected ? 'Deselect' : 'Select'} ${item.title}` : undefined}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none text-left group focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/30',
        selectionMode && isSelected
          ? 'border-(--accent-nav)/35 bg-(--accent-nav)/[0.06]'
          : 'bg-white/[0.015] border-white/[0.05] hover:bg-white/[0.04] hover:border-white/[0.10] focus-visible:bg-white/[0.04] focus-visible:border-white/[0.12]',
      )}
      onPointerDown={selectionMode ? undefined : prefetchDetails}
      onFocus={selectionMode ? undefined : prefetchDetails}
      onClick={(event) => {
        if (selectionMode) {
          event.preventDefault();
          onToggleSelect?.(item, event.shiftKey);
          return;
        }
        navigateToDetails(item.type, item.id);
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
      <PosterThumb poster={item.poster} title={item.title} mediaType={item.type} />

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

export function HistoryListView({
  items,
  onRemove,
  selectionMode,
  selectedIds,
  onToggleSelect,
}: {
  items: WatchProgress[];
  onRemove: (button: HTMLButtonElement, index: number) => void;
  selectionMode?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (item: WatchProgress, shiftKey?: boolean) => void;
}) {
  return (
    <WindowVirtualizedStack
      items={items}
      getItemKey={watchProgressItemKey}
      estimateSize={() => 78}
      renderItem={(item, index) => (
        <HistoryListRow
          item={item}
          index={index}
          onRemove={onRemove}
          selectionMode={selectionMode}
          isSelected={selectedIds?.has(watchTitleKey(item))}
          onToggleSelect={onToggleSelect}
        />
      )}
    />
  );
}

const HistoryListRow = memo(function HistoryListRow({
  item,
  index,
  onRemove,
  selectionMode = false,
  isSelected = false,
  onToggleSelect,
}: {
  item: WatchProgress;
  index: number;
  onRemove: (button: HTMLButtonElement, index: number) => void;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (item: WatchProgress, shiftKey?: boolean) => void;
}) {
  const prefetchDetails = usePrefetchDetails(item.id, item.type_);
  const progressPct = getWatchProgressPercent(item.position, item.duration);
  const seasonEpisodeLabel = formatSeasonEpisode(
    item.absolute_season ?? undefined,
    item.absolute_episode ?? undefined,
  );
  const watchedAgo = item.last_watched > 0 ? formatRelativeTime(item.last_watched) : null;

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
    <div
      className={cn(
        'group/hrow flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        selectionMode && isSelected
          ? 'border-(--accent-nav)/35 bg-(--accent-nav)/[0.06]'
          : 'bg-white/[0.02] border-white/[0.05] hover:bg-white/[0.05] hover:border-white/[0.10] focus-within:bg-white/[0.04] focus-within:border-white/[0.12]',
      )}
    >
      <button
        type='button'
        aria-label={
          selectionMode
            ? `${isSelected ? 'Deselect' : 'Select'} ${item.title}`
            : `Open details for ${item.title}`
        }
        aria-pressed={selectionMode ? isSelected : undefined}
        onClick={(event) =>
          selectionMode
            ? onToggleSelect?.(item, event.shiftKey)
            : navigateToDetails(item.type_, item.id)
        }
        onPointerDown={selectionMode ? undefined : prefetchDetails}
        onFocus={selectionMode ? undefined : prefetchDetails}
        className='flex flex-1 min-w-0 items-center gap-3 rounded-lg text-left hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/30'
      >
        {selectionMode && (
          <span
            aria-hidden='true'
            className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
              isSelected
                ? 'border-(--accent-nav) bg-(--accent-nav) text-(--on-accent-nav)'
                : 'border-white/25 text-transparent',
            )}
          >
            <Check className='h-3 w-3' strokeWidth={3} />
          </span>
        )}
        <PosterThumb
          poster={item.poster}
          title={item.title}
          mediaType={item.type_}
          progressPct={progressPct}
        />
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
            {watchedAgo && <span className='text-[11px] text-zinc-500'>{watchedAgo}</span>}
          </div>
        </div>
      </button>

      {!selectionMode && (
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
            data-history-remove={index}
            className='h-8 w-8 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-100 md:opacity-0 md:group-hover/hrow:opacity-100 md:group-focus-within/hrow:opacity-100 focus-visible:opacity-100'
            onClick={(e) => {
              e.stopPropagation();
              if (removeItem.isPending) return;
              onRemove(e.currentTarget, index);
              removeItem.mutate();
            }}
            aria-label={`Remove ${item.title} from history`}
            title='Remove from history'
            aria-disabled={removeItem.isPending || undefined}
          >
            <X className='w-3 h-3' />
          </Button>
        </div>
      )}
    </div>
  );
});

export const HistoryItem = memo(function HistoryItem({
  item,
  selectionMode,
  isSelected,
  onToggleSelect,
}: {
  item: WatchProgress;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (item: WatchProgress, shiftKey?: boolean) => void;
}) {
  const { mutate: removeItem } = useRemoveFromWatchHistory({
    itemId: item.id,
    itemTitle: item.title,
    mediaType: item.type_,
  });

  if (selectionMode) {
    return (
      <MediaCard
        item={watchProgressMediaItem(item)}
        selectionMode
        isSelected={isSelected}
        onToggleSelect={(_item, shiftKey = false) => onToggleSelect?.(item, shiftKey)}
      />
    );
  }
  return (
    <WatchProgressCard
      item={item}
      onRemove={removeItem}
      playErrorTitle='Failed to resume playback'
    />
  );
});
