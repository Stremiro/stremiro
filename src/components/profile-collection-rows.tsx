import { formatDistanceToNow } from 'date-fns';
import { Loader2, Play, X } from 'lucide-react';
import { memo } from 'react';
import { useNavigate } from 'react-router';
import { RemoteImage } from '@/components/remote-image';
import { Button } from '@/components/ui/button';
import { WatchProgressCard } from '@/components/watch-progress-card';
import { WatchProgressStrip } from '@/components/watch-progress-strip';
import { WindowVirtualizedStack } from '@/components/window-virtualized-stack';
import { useHistoryPlayback } from '@/hooks/use-history-playback';
import { useRemoveFromWatchHistory } from '@/hooks/use-media-library';
import { usePrefetchDetails } from '@/hooks/use-prefetch-details';
import {
  type MediaItem,
  WATCH_STATUS_COLORS,
  WATCH_STATUS_LABELS,
  WATCH_STATUSES,
  type WatchProgress,
  type WatchStatus,
} from '@/lib/api';
import { getWatchProgressPercent, watchProgressCoordinates } from '@/lib/history-playback';
import { navigateToDetails } from '@/lib/player-navigation';
import { cn, formatSeasonEpisode, mediaTypeLabel } from '@/lib/utils';

export function isWatchStatusValue(value: string): value is WatchStatus {
  return (WATCH_STATUSES as readonly string[]).includes(value);
}

// Canonical row key on normalized coords — shared by the grid/list views so
// switching modes keeps virtualizer identity for the same row.
export function watchProgressItemKey(item: WatchProgress): string {
  const { season, episode } = watchProgressCoordinates(item);
  return `${item.type_}-${item.id}-${season ?? ''}-${episode ?? ''}`;
}

function PosterThumb({
  poster,
  title,
  progressPct,
}: {
  poster?: string;
  title: string;
  progressPct?: number;
}) {
  return (
    <div className='relative w-8 h-12 shrink-0 rounded-md overflow-hidden bg-zinc-900/80 ring-1 ring-white/[0.06]'>
      {poster ? (
        <RemoteImage
          src={poster}
          alt={title}
          className='w-full h-full object-cover'
          loading='lazy'
        />
      ) : (
        <div className='w-full h-full flex items-center justify-center text-white/10 text-[8px] font-bold'>
          N/A
        </div>
      )}
      <WatchProgressStrip percent={progressPct ?? 0} className='h-0.5 bg-black/50' />
    </div>
  );
}

export function LibraryList({
  items,
  watchStatuses,
}: {
  items: MediaItem[];
  watchStatuses?: Record<string, string>;
}) {
  return (
    <WindowVirtualizedStack
      items={items}
      getItemKey={(item) => `${item.type}:${item.id}`}
      estimateSize={() => 76}
      renderItem={(item) => <LibraryListRow item={item} status={watchStatuses?.[item.id]} />}
    />
  );
}

const LibraryListRow = memo(function LibraryListRow({
  item,
  status,
}: {
  item: MediaItem;
  status?: string;
}) {
  const navigate = useNavigate();
  const prefetchDetails = usePrefetchDetails(item.id, item.type);

  return (
    <button
      type='button'
      className='w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.05] hover:border-white/[0.10] transition-colors text-left group focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:border-white/20'
      onPointerEnter={prefetchDetails}
      onFocus={prefetchDetails}
      onClick={() => navigateToDetails(navigate, item.type, item.id)}
    >
      <PosterThumb poster={item.poster} title={item.title} />

      <div className='flex-1 min-w-0'>
        <p className='text-[14px] font-semibold text-zinc-100 truncate group-hover:text-white transition-colors'>
          {item.title}
        </p>
        <div className='flex items-center gap-1.5 mt-1 flex-wrap'>
          {item.displayYear && (
            <span className='text-[11px] text-zinc-500'>{item.displayYear}</span>
          )}
          <span className='text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-sm text-zinc-300 bg-white/[0.06]'>
            {mediaTypeLabel(item.type)}
          </span>
          {status && isWatchStatusValue(status) && (
            <span
              className={cn(
                'text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded-sm',
                WATCH_STATUS_COLORS[status].text,
                WATCH_STATUS_COLORS[status].bg,
              )}
            >
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
      <PosterThumb poster={item.poster} title={item.title} progressPct={progressPct} />

      <div className='flex-1 min-w-0'>
        <p className='text-[14px] font-semibold text-zinc-100 truncate'>{item.title}</p>
        <div className='flex items-center gap-2 mt-1'>
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

      <div className='flex items-center gap-0.5 shrink-0'>
        <Button
          size='icon'
          variant='ghost'
          className='h-7 w-7 rounded-md text-zinc-600 hover:text-white hover:bg-white/[0.08] transition-colors'
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
          className='h-7 w-7 rounded-md text-zinc-700 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-100 md:opacity-0 md:group-hover/hrow:opacity-100 md:group-focus-within/hrow:opacity-100 focus-visible:opacity-100'
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
