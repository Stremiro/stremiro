import { memo } from 'react';
import { RetryBanner } from '@/components/retry-banner';
import { WatchProgressCard } from '@/components/watch-progress-card';
import { useLocalDay } from '@/hooks/use-local-day';
import { useRemoveFromContinueWatching, useResumeRail } from '@/hooks/use-media-library';
import type { ResumeRailEntry } from '@/lib/api';
import { watchProgressItemKey } from '@/lib/history-playback';
import { cn, pad2, queryNeedsRetry } from '@/lib/utils';
import { HorizontalMediaRail, HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS } from './horizontal-media-rail';

// A stable empty keeps the rail's key-set diff from re-running while loading.
const EMPTY_ENTRIES: ResumeRailEntry[] = [];

// Stable callbacks keep the rail's key-set diff from re-running per render.
const resumeEntryKey = (entry: ResumeRailEntry) => watchProgressItemKey(entry.row);

const renderResumeEntry = (entry: ResumeRailEntry) => <ResumeCard entry={entry} />;

export function ResumeSection() {
  const localDay = useLocalDay();
  const localToday = `${String(localDay.getFullYear()).padStart(4, '0')}-${pad2(localDay.getMonth() + 1)}-${pad2(localDay.getDate())}`;
  const resumeRailQuery = useResumeRail(localToday, localDay.getTime());
  const {
    data: entries = EMPTY_ENTRIES,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = resumeRailQuery;

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

  return (
    <section data-resume-section aria-label='Continue Watching' tabIndex={-1}>
      {queryNeedsRetry(resumeRailQuery) && entries.length === 0 ? (
        <div className={cn(HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS, 'mb-2')}>{retryBanner}</div>
      ) : !isLoading && entries.length === 0 ? null : (
        <HorizontalMediaRail
          title='Continue Watching'
          railId='continue-watching'
          items={entries}
          isLoading={isLoading}
          getItemKey={resumeEntryKey}
          renderItem={renderResumeEntry}
          skeletonCount={5}
          headerContent={isError && <div className='mt-3'>{retryBanner}</div>}
          scrollerClassName='pt-4 relative z-0'
        />
      )}
    </section>
  );
}

const ResumeCard = memo(function ResumeCard({ entry }: { entry: ResumeRailEntry }) {
  const { row: item, isNewEpisode } = entry;
  const isUpNext = isNewEpisode !== undefined;
  const { mutate: removeFromContinueWatching } = useRemoveFromContinueWatching({
    itemId: item.id,
    itemTitle: item.title,
    mediaType: item.type_,
  });

  return (
    <WatchProgressCard
      item={item}
      onRemove={removeFromContinueWatching}
      removeFrom='Continue Watching'
      playbackIntent={isUpNext ? 'next-episode' : 'resume'}
      isNewEpisode={isNewEpisode === true}
      metaLine={isUpNext ? 'Up next' : undefined}
      playErrorTitle={
        isUpNext ? 'Failed to open the next episode' : 'Failed to open continue watching item'
      }
    />
  );
});
