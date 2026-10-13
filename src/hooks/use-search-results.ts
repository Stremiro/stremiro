import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useLocalDay } from '@/hooks/use-local-day';
import { flattenCatalogPages, searchCatalogQueryOptions } from '@/lib/search-catalog';
import type { SearchFeed, SearchMediaType } from '@/lib/search-page-state';

interface UseSearchResultsArgs {
  query: string;
  activeType: SearchMediaType;
  activeFeed: SearchFeed;
  activeGenre?: string;
  isOnline: boolean;
}

export function useSearchResults({
  query,
  activeType,
  activeFeed,
  activeGenre,
  isOnline,
}: UseSearchResultsArgs) {
  // The `new` feed is the provider `year` catalog. `useLocalDay` re-keys after
  // a midnight rollover; a one-time `getFullYear()` would pin the mount day.
  const localDay = useLocalDay();

  const {
    data,
    isFetched,
    isLoading,
    isFetching,
    isFetchingNextPage,
    isPlaceholderData,
    hasNextPage,
    fetchNextPage,
    isError,
    isFetchNextPageError,
    error,
    refetch,
  } = useInfiniteQuery({
    ...searchCatalogQueryOptions(
      { query, type: activeType, feed: activeFeed, genre: activeGenre },
      localDay.getFullYear(),
    ),
    // Keep previous facet results visible during switches; offline switches
    // must not show them as cached results.
    placeholderData: isOnline ? keepPreviousData : undefined,
    enabled: isOnline,
  });

  const results = useMemo(() => flattenCatalogPages(data?.pages ?? []), [data?.pages]);

  return {
    results,
    isFetched,
    isLoading,
    isFetching,
    isFetchingNextPage,
    isPlaceholderData,
    hasNextPage: Boolean(hasNextPage),
    fetchNextPage,
    isError,
    isFetchNextPageError,
    errorObj: error,
    refetch,
  };
}
