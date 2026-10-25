import { useQuery } from '@tanstack/react-query';
import { useNearViewport } from '@/hooks/use-near-viewport';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { api, type MediaItem } from '@/lib/api';
import { similarTitlesQueryKey } from '@/lib/api-discovery';
import { MEDIA_ROW_STALE_TIME_MS } from '@/lib/query-invalidation';
import { HorizontalMediaRail } from './horizontal-media-rail';
import { mediaCardRailKey, renderMediaCardRailItem } from './media-card';
import { RetryBanner } from './retry-banner';

/** Fewer matches than this reads as filler — the rail hides instead. */
const MIN_SIMILAR_TITLES = 4;
const EMPTY_TITLES: MediaItem[] = [];

interface DetailsSimilarTitlesProps {
  item: MediaItem;
  contentInsetsClassName: string;
}

export function DetailsSimilarTitles({ item, contentInsetsClassName }: DetailsSimilarTitlesProps) {
  const isOnline = useOnlineStatus();
  // The rail sits below the episodes; fetch once it nears the viewport.
  const { anchorRef, nearViewport } = useNearViewport();

  const queryEnabled = isOnline && (item.genres?.length ?? 0) > 0;
  const queryKey = similarTitlesQueryKey(item);
  const {
    data: titles,
    isLoading,
    isError,
    isFetched,
    isFetching,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: () => api.querySimilarTitles(item),
    enabled: queryEnabled && nearViewport,
    // Match the trending/similar/type/id scope, not the changing ranking inputs.
    placeholderData: (previous, previousQuery) =>
      queryKey.slice(0, 4).every((part, index) => previousQuery?.queryKey[index] === part)
        ? previous
        : undefined,
    staleTime: MEDIA_ROW_STALE_TIME_MS,
  });

  // A failed refetch keeps the last good data — stale cards beat a notice.
  const hasTitles = !!titles && titles.length >= MIN_SIMILAR_TITLES;
  // The deferred skeleton reserves the rail's height so the fetch can't shift the page.
  const showSkeleton = queryEnabled && !hasTitles && (!nearViewport || (isLoading && !isFetched));
  const showRetry =
    queryEnabled && nearViewport && (isError || (isFetched && isLoading)) && !hasTitles;

  return (
    <div ref={anchorRef}>
      {hasTitles || showSkeleton ? (
        <HorizontalMediaRail<MediaItem>
          title='More like this'
          contentInsetsClassName={contentInsetsClassName}
          sectionClassName='pt-10 animate-in fade-in duration-500 motion-reduce:animate-none'
          railId={`similar:${item.type}:${item.id}`}
          items={titles ?? EMPTY_TITLES}
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
            isRetrying={isFetching}
            onRetry={() => void refetch()}
          />
        </div>
      ) : null}
    </div>
  );
}
