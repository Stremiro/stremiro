import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api, type MediaItem, type SearchCatalogPage } from '@/lib/api';
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

// `all` browse owns one cursor per catalog — movie and series pages advance
// independently so an exhausted or failing branch can't strand the other.
interface AllBrowseCursors {
  movie?: number;
  series?: number;
}

interface SearchResultsPage extends SearchCatalogPage {
  /** `all`-browse pages carry per-catalog cursors instead of `nextSkip`. */
  allCursors?: AllBrowseCursors;
}

const ALL_BROWSE_TYPES = ['movie', 'series'] as const;

async function fetchAllBrowsePage(
  cursors: AllBrowseCursors,
  options: { feed?: 'featured'; genre?: string; year?: number },
): Promise<SearchResultsPage> {
  const branches = ALL_BROWSE_TYPES.flatMap((type) => {
    const skip = cursors[type];
    return skip === undefined ? [] : [{ type, skip }];
  });
  const settled = await Promise.allSettled(
    branches.map((branch) =>
      api.querySearchCatalogPage({
        mediaType: branch.type,
        feed: options.feed,
        genres: options.genre ? [options.genre] : undefined,
        yearFrom: options.year,
        yearTo: options.year,
        skip: branch.skip > 0 ? branch.skip : undefined,
      }),
    ),
  );

  const pages = new Map<(typeof ALL_BROWSE_TYPES)[number], SearchCatalogPage>();
  const allCursors: AllBrowseCursors = {};
  let firstError: unknown;
  settled.forEach((outcome, index) => {
    const branch = branches[index];
    if (outcome.status === 'rejected') {
      // Retry the failed branch on the next page: one flaky catalog must not
      // blank the other's remaining results or end pagination.
      allCursors[branch.type] = branch.skip;
      firstError ??= outcome.reason;
      return;
    }
    pages.set(branch.type, outcome.value);
    const nextSkip = outcome.value.nextSkip;
    allCursors[branch.type] =
      typeof nextSkip === 'number' && nextSkip > branch.skip ? nextSkip : undefined;
  });

  if (pages.size === 0) {
    throw firstError ?? new Error('Failed to load catalog.');
  }

  // Interleave branches so the merged grid mixes movies and series.
  const items: MediaItem[] = [];
  const movieItems = pages.get('movie')?.items ?? [];
  const seriesItems = pages.get('series')?.items ?? [];
  for (let index = 0; index < Math.max(movieItems.length, seriesItems.length); index += 1) {
    if (index < movieItems.length) items.push(movieItems[index]);
    if (index < seriesItems.length) items.push(seriesItems[index]);
  }

  return { items, nextSkip: null, allCursors };
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
  const newFeedYear = browseFeed === 'new' ? new Date().getFullYear() : undefined;
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
    queryFn: ({ pageParam }): Promise<SearchResultsPage> => {
      if (allBrowse) {
        return fetchAllBrowsePage(pageParam as AllBrowseCursors, {
          feed: browseFeed === 'featured' ? 'featured' : undefined,
          genre: normalizedGenre,
          year: newFeedYear,
        });
      }
      return api.querySearchCatalogPage({
        query: normalizedQuery,
        mediaType: activeType === 'all' ? undefined : activeType,
        feed: browseFeed === 'featured' ? 'featured' : undefined,
        genres: normalizedGenre ? [normalizedGenre] : undefined,
        yearFrom: newFeedYear,
        yearTo: newFeedYear,
        skip: typeof pageParam === 'number' && pageParam > 0 ? pageParam : undefined,
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
