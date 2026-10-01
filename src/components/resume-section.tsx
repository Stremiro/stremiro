import { memo, useMemo } from 'react';
import { RetryBanner } from '@/components/retry-banner';
import { WatchProgressCard } from '@/components/watch-progress-card';
import { useOnlineStatus } from '@/hooks/use-online-status';
import {
  useContinueWatching,
  useRemoveFromContinueWatching,
  useUpNextEntries,
} from '@/hooks/use-media-library';
import { type WatchProgress } from '@/lib/api';
import type { UpNextEntry } from '@/lib/up-next';
import { cn } from '@/lib/utils';
import { HorizontalMediaRail, HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS } from './horizontal-media-rail';
import { watchProgressItemKey } from './profile-collection-rows';

type ResumeRailEntry = { row: WatchProgress; metaLine?: undefined } | UpNextEntry;

// Stable empties keep the merge memo (and the up-next source memo) from
// recomputing every render while queries load.
const EMPTY_ROWS: WatchProgress[] = [];
const EMPTY_UP_NEXT: UpNextEntry[] = [];

// Up-next cards slot in by recency; the continue-watching order (which
// demotes low-confidence resumes) is otherwise preserved.
function mergeByRecency(
  continueWatching: readonly WatchProgress[],
  upNext: readonly UpNextEntry[],
): ResumeRailEntry[] {
  const merged: ResumeRailEntry[] = [];
  let next = 0;
  for (const row of continueWatching) {
    while (next < upNext.length && upNext[next].row.last_watched > row.last_watched) {
      merged.push(upNext[next]);
      next += 1;
    }
    merged.push({ row });
  }
  return merged.concat(upNext.slice(next));
}

// Stable callbacks keep the rail's key-set diff from re-running on unrelated
// renders — inline arrows would rebuild the Set and layout effect each time.
const resumeEntryKey = (entry: ResumeRailEntry) => watchProgressItemKey(entry.row);

const renderResumeEntry = (entry: ResumeRailEntry) =>
  entry.metaLine === undefined ? (
    <ResumeCard item={entry.row} />
  ) : (
    <WatchProgressCard
      item={entry.row}
      metaLine={entry.metaLine}
      playErrorTitle='Failed to open the next episode'
    />
  );

export function ResumeSection() {
  const isOnline = useOnlineStatus();
  const { data = EMPTY_ROWS, isLoading, isError, refetch } = useContinueWatching();
  const { data: upNext = EMPTY_UP_NEXT } = useUpNextEntries(data, {
    enabled: isOnline && !isLoading,
  });
  const entries = useMemo(() => mergeByRecency(data, upNext), [data, upNext]);

  // A failed read must not collapse silently into "no items" — that hides
  // the section forever with no recovery path. A failed *refetch* with rows
  // still cached keeps the stale rail instead: its entries remain playable.
  if (isError && !isLoading && entries.length === 0) {
    return (
      <div className={cn(HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS, 'mb-2')}>
        <RetryBanner
          message="Couldn't load continue watching — try again."
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  // Hidden until there is something to resume; the profile tab has its own
  // empty state.
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
