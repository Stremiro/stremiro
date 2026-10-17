import { memo } from 'react';
import { format } from 'date-fns';
import { RetryBanner } from '@/components/retry-banner';
import { WatchProgressCard } from '@/components/watch-progress-card';
import { useLocalDay } from '@/hooks/use-local-day';
import { useRemoveFromContinueWatching, useResumeRail } from '@/hooks/use-media-library';
import { type ResumeRailEntry, type WatchProgress } from '@/lib/api';
import { watchProgressItemKey } from '@/lib/history-playback';
import { cn } from '@/lib/utils';
import { HorizontalMediaRail, HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS } from './horizontal-media-rail';

// The "aired in the last week" decision arrives on the row; only labels live here.
const UP_NEXT_META_LINE = 'Up next';
const NEW_EPISODE_META_LINE = 'New episode';

// A stable empty keeps the rail's key-set diff from re-running while loading.
const EMPTY_ENTRIES: ResumeRailEntry[] = [];

// Stable callbacks keep the rail's key-set diff from re-running per render.
const resumeEntryKey = (entry: ResumeRailEntry) => watchProgressItemKey(entry.row);

const renderResumeEntry = (entry: ResumeRailEntry) =>
  entry.isNewEpisode === undefined ? (
    <ResumeCard item={entry.row} />
  ) : (
    <WatchProgressCard
      item={entry.row}
      metaLine={entry.isNewEpisode ? NEW_EPISODE_META_LINE : UP_NEXT_META_LINE}
      playErrorTitle='Failed to open the next episode'
    />
  );

export function ResumeSection() {
  const localDay = useLocalDay();
  const {
    data: entries = EMPTY_ENTRIES,
    isLoading,
    isError,
    isFetched,
    isFetching,
    refetch,
  } = useResumeRail(format(localDay, 'yyyy-MM-dd'), localDay.getTime());

  const retryBanner = (
    <RetryBanner
      className='w-full max-w-xl'
      message={
        entries.length > 0
          ? "Couldn't refresh continue watching."
          : "Couldn't load continue watching — try again."
      }
      isRetrying={isFetching}
      onRetry={() => void refetch()}
    />
  );

  // A failed read must not collapse into "no items" (hides the section with no
  // recovery); a failed refetch with cached rows keeps the playable stale rail.
  if ((isError || (isFetched && isLoading)) && entries.length === 0) {
    return <div className={cn(HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS, 'mb-2')}>{retryBanner}</div>;
  }

  // Hidden until there is something to resume.
  if (!isLoading && entries.length === 0) {
    return null;
  }

  return (
    <HorizontalMediaRail
      title='Continue Watching'
      railId='continue-watching'
      items={entries}
      isLoading={isLoading}
      getItemKey={resumeEntryKey}
      renderItem={renderResumeEntry}
      skeletonCount={5}
      headerContent={isError && <div className='mt-3'>{retryBanner}</div>}
      scrollerClassName='gap-4 pt-4 relative z-0'
      viewportClassName='relative'
    />
  );
}

const ResumeCard = memo(function ResumeCard({ item }: { item: WatchProgress }) {
  const { mutate: removeFromContinueWatching } = useRemoveFromContinueWatching({
    itemId: item.id,
    itemTitle: item.title,
    mediaType: item.type_,
  });

  return (
    <WatchProgressCard
      item={item}
      onRemove={removeFromContinueWatching}
      playErrorTitle='Failed to open continue watching item'
    />
  );
});
