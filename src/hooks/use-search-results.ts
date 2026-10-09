import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api, type AllBrowseCursors, type SearchCatalogPage } from '@/lib/api';
import { canonicalizeSearchText } from '@/lib/api-cache';
import { useLocalDay } from '@/hooks/use-local-day';
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
  // The UI key and request share the same bounded text; Rust validates it.
  const normalizedQuery = canonicalizeSearchText(query);
  const normalizedGenre = canonicalizeSearchText(activeGenre);
  // Feeds pick a browse catalog; text search always hits the search catalog,
  // so a feed must neither filter it nor split its cache key.
  const browseFeed = normalizedQuery ? undefined : activeFeed;
  // The `new` feed is the provider `year` catalog: a single pinned year on the
  // Popular feed, which the backend routes to `year` when no genre is stacked.
  // `useLocalDay` re-keys the query after a midnight rollover — a one-time
  // `getFullYear()` would pin the mount-day's year for an always-open session.
  const localDay = useLocalDay();
  const newFeedYear = browseFeed === 'new' ? localDay.getFullYear() : undefined;
  // `all` with no query merges both browse catalogs; with a query the backend
  // already fans out to the movie and series search catalogs on its own.
  const allBrowse = activeType === 'all' && !normalizedQuery;

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
    queryFn: ({ pageParam }): Promise<SearchCatalogPage> => {
      const feed = browseFeed === 'featured' ? 'featured' : undefined;
      return api.querySearchCatalogPage({
        query: normalizedQuery,
        mediaType: activeType === 'all' ? undefined : activeType,
        feed,
        genres: normalizedGenre ? [normalizedGenre] : undefined,
        yearFrom: newFeedYear,
        yearTo: newFeedYear,
        skip: typeof pageParam === 'number' && pageParam > 0 ? pageParam : undefined,
        allCursors: allBrowse ? (pageParam as AllBrowseCursors) : undefined,
      });
    },
    initialPageParam: (allBrowse ? { movie: 0, series: 0 } : 0) as number | AllBrowseCursors,
    getNextPageParam: (lastPage, allPages, lastPageParam) => {
      if (!allBrowse) {
        return nextCatalogSkip(lastPage, allPages, lastPageParam as number);
      }
      const cursors = lastPage.allCursors;
      return cursors && (cursors.movie !== undefined || cursors.series !== undefined)
        ? cursors
        : undefined;
    },
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    // Keep the previous facet's results visible while the new one loads so
    // tab/feed/genre switches never flash a full skeleton grid.
    // Offline switches must not show the previous category as cached results.
    placeholderData: isOnline ? keepPreviousData : undefined,
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
