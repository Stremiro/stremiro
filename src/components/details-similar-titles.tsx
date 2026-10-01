import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAddonConfigs } from '@/hooks/use-addon-configs';
import { useOnlineStatus } from '@/hooks/use-online-status';
import type { MediaItem } from '@/lib/api';
import { MEDIA_ROW_STALE_TIME_MS, trendingRowQueryKey } from '@/lib/query-invalidation';
import { collectSearchGenreOptions } from '@/lib/search-page-state';
import {
  fetchSimilarTitles,
  MIN_SIMILAR_TITLES,
  similarTitlesMediaType,
  similarTitlesSeedGenres,
  similarTitlesSourceKey,
} from '@/lib/similar-titles';
import { HorizontalMediaRail } from './horizontal-media-rail';
import { mediaCardRailKey, renderMediaCardRailItem } from './media-card';
import { RetryBanner } from './retry-banner';

// Starts the catalog fetch a screen early, so the rail is usually ready
// before it scrolls into view.
const PREFETCH_ROOT_MARGIN = '600px';

interface DetailsSimilarTitlesProps {
  item: MediaItem;
  contentInsetsClassName: string;
}

export function DetailsSimilarTitles({ item, contentInsetsClassName }: DetailsSimilarTitlesProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const isOnline = useOnlineStatus();
  const { data: addonConfigs } = useAddonConfigs({ enabled: isOnline });
  const mediaType = similarTitlesMediaType(item);
  const seedGenres = useMemo(
    () =>
      addonConfigs
        ? similarTitlesSeedGenres(item.genres, collectSearchGenreOptions(addonConfigs, mediaType))
        : [],
    [addonConfigs, item.genres, mediaType],
  );

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

  const queryEnabled = isOnline && nearViewport && seedGenres.length > 0;
  const {
    data: titles,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    // Under the `trending` prefix so invalidateDiscoveryQueries covers it.
    // The source key refreshes the rail when full metadata (year/genres)
    // lands after a placeholder item.
    queryKey: trendingRowQueryKey(
      'similar',
      mediaType,
      item.id,
      similarTitlesSourceKey(item),
      ...seedGenres,
    ),
    queryFn: () => fetchSimilarTitles(item, mediaType, seedGenres),
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
          railId={`similar:${mediaType}:${item.id}`}
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
