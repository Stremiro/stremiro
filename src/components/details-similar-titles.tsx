import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { api, type MediaItem } from '@/lib/api';
import { MEDIA_ROW_STALE_TIME_MS, trendingRowQueryKey } from '@/lib/query-invalidation';
import { HorizontalMediaRail } from './horizontal-media-rail';
import { mediaCardRailKey, renderMediaCardRailItem } from './media-card';
import { RetryBanner } from './retry-banner';

// Starts the catalog fetch a screen early, so the rail is usually ready
// before it scrolls into view.
const PREFETCH_ROOT_MARGIN = '600px';
/** Fewer matches than this reads as filler — the rail hides instead. */
const MIN_SIMILAR_TITLES = 4;

interface DetailsSimilarTitlesProps {
  item: MediaItem;
  contentInsetsClassName: string;
}

export function DetailsSimilarTitles({ item, contentInsetsClassName }: DetailsSimilarTitlesProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const isOnline = useOnlineStatus();

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || nearViewport) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setNearViewport(true);
      },
      { rootMargin: PREFETCH_ROOT_MARGIN },
    );
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [nearViewport]);

  const queryEnabled = isOnline && nearViewport && (item.genres?.length ?? 0) > 0;
  const {
    data: titles,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    // Under the `trending` prefix so invalidateDiscoveryQueries covers it.
    // Year and genres are in the key so the rail refreshes when full
    // metadata lands after a placeholder item.
    queryKey: trendingRowQueryKey(
      'similar',
      item.type,
      item.id,
      item.year ?? '',
      ...(item.genres ?? []),
    ),
    queryFn: () => api.querySimilarTitles(item),
    enabled: queryEnabled,
    staleTime: MEDIA_ROW_STALE_TIME_MS,
  });

  // A failed refetch keeps the last good data — stale cards beat a notice.
  const hasTitles = !!titles && titles.length >= MIN_SIMILAR_TITLES;
  const showSkeleton = queryEnabled && isLoading && !hasTitles;
  const showRetry = queryEnabled && isError && !hasTitles;

  return (
    <div ref={anchorRef}>
      {hasTitles || showSkeleton ? (
        <HorizontalMediaRail<MediaItem>
          title='More like this'
          contentInsetsClassName={contentInsetsClassName}
          sectionClassName='pt-10 animate-in fade-in duration-500 motion-reduce:animate-none'
          railId={`similar:${item.type}:${item.id}`}
          items={titles ?? []}
          isLoading={showSkeleton}
          skeletonCount={6}
          getItemKey={mediaCardRailKey}
          renderItem={renderMediaCardRailItem}
        />
      ) : showRetry ? (
        <div className={`${contentInsetsClassName} pt-10`}>
          <h2 className='text-[17px] font-semibold tracking-[-0.02em] text-white'>
            More like this
          </h2>
          <RetryBanner
            className='mt-2'
            message="Couldn't load recommendations."
            onRetry={() => void refetch()}
          />
        </div>
      ) : null}
    </div>
  );
}
