import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api } from '@/lib/api';
import { canonicalizeSearchText } from '@/lib/api-cache';
import { SEARCH_CATALOG_QUERY_KEY } from '@/lib/query-invalidation';
import { flattenCatalogPages, nextCatalogSkip } from '@/lib/search-catalog';
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
  // Canonicalized once so the query key and the sent payload cannot drift:
  // the API layer re-canonicalizes identically before invoking.
  const normalizedQuery = canonicalizeSearchText(query);
  const normalizedGenre = canonicalizeSearchText(activeGenre);
  // Feeds pick a browse catalog; text search always hits the search catalog,
  // so a feed must neither filter it nor split its cache key.
  const browseFeed = normalizedQuery ? undefined : activeFeed;
  // The `new` feed is the provider `year` catalog: a single pinned year on the
  // Popular feed, which the backend routes to `year` when no genre is stacked.
  const newFeedYear = browseFeed === 'new' ? new Date().getFullYear() : undefined;

  const {
    data,
    isLoading,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    isError,
    isFetchNextPageError,
    error,
    refetch,
  } = useInfiniteQuery({
    // Only browse paginates; one infinite query covers both modes. The key
    // head is the shared const — the invalidation sweep matches on it.
    queryKey: [
      ...SEARCH_CATALOG_QUERY_KEY,
      normalizedQuery ?? null,
      activeType,
      browseFeed ?? null,
      normalizedGenre ?? null,
      // `new` pins a year; key it so a rollover can't serve a stale catalog.
      newFeedYear ?? null,
    ],
    queryFn: ({ pageParam }) =>
      api.querySearchCatalogPage({
        query: normalizedQuery,
        mediaType: activeType,
        feed: browseFeed === 'featured' ? 'featured' : undefined,
        genres: normalizedGenre ? [normalizedGenre] : undefined,
        yearFrom: newFeedYear,
        yearTo: newFeedYear,
        skip: pageParam > 0 ? pageParam : undefined,
      }),
    initialPageParam: 0,
    getNextPageParam: nextCatalogSkip,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    // Keep the previous facet's results visible while the new one loads so
    // tab/feed/genre switches never flash a full skeleton grid.
    placeholderData: keepPreviousData,
    enabled: isOnline,
  });

  const results = useMemo(() => flattenCatalogPages(data?.pages ?? []), [data?.pages]);

  return {
    results,
    isLoading,
    isFetching,
    isFetchingNextPage,
    hasNextPage: Boolean(hasNextPage),
    fetchNextPage,
    isError,
    isFetchNextPageError,
    errorObj: error,
    refetch,
  };
}
