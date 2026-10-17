import {
  infiniteQueryOptions,
  replaceEqualDeep,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';

import { api, type SearchCatalogContinuation, type SearchCatalogPage } from '@/lib/api';
import { canonicalizeSearchText } from '@/lib/api-cache';
import { SEARCH_CATALOG_GC_TIME_MS, SEARCH_CATALOG_QUERY_KEY } from '@/lib/query-invalidation';
import type { SearchFacets } from '@/lib/search-page-state';

type CachedSearchCatalogPage = Omit<SearchCatalogPage, 'continuation'> & {
  continuation?: SearchCatalogContinuation;
};
type CachedSearchCatalogData = InfiniteData<
  CachedSearchCatalogPage,
  SearchCatalogContinuation | undefined
>;

export function searchCatalogQueryOptions(facets: SearchFacets, localYear: number) {
  // The UI key and request share the same bounded text; Rust validates it.
  const normalizedQuery = canonicalizeSearchText(facets.query);
  const normalizedGenre = canonicalizeSearchText(facets.genre);
  // Feeds pick a browse catalog; text search always hits the search catalog,
  // so a feed must neither filter it nor split its cache key.
  const browseFeed = normalizedQuery ? undefined : facets.feed;
  const newFeedYear = browseFeed === 'new' ? localYear : undefined;
  return infiniteQueryOptions<
    CachedSearchCatalogPage,
    Error,
    CachedSearchCatalogData,
    readonly unknown[],
    SearchCatalogContinuation | undefined
  >({
    // Browse and text search share paging; the key head matches the invalidation sweep.
    queryKey: [
      ...SEARCH_CATALOG_QUERY_KEY,
      normalizedQuery ?? null,
      facets.type,
      browseFeed ?? null,
      normalizedGenre ?? null,
      // `new` pins a year; key it so a rollover can't serve a stale catalog.
      newFeedYear ?? null,
    ],
    queryFn: ({ pageParam }): Promise<SearchCatalogPage> => {
      const feed = browseFeed === 'featured' ? 'featured' : undefined;
      return api.querySearchCatalogPage({
        query: normalizedQuery,
        mediaType: facets.type === 'all' ? undefined : facets.type,
        feed,
        genres: normalizedGenre ? [normalizedGenre] : undefined,
        yearFrom: newFeedYear,
        yearTo: newFeedYear,
        continuation: pageParam,
      });
    },
    initialPageParam: undefined as SearchCatalogContinuation | undefined,
    getNextPageParam: (lastPage) => (lastPage.exhausted ? undefined : lastPage.continuation),
    structuralSharing: (previous, next) => {
      const data = next as CachedSearchCatalogData | undefined;
      if (!Array.isArray(data?.pages)) return next;
      // Seen keys accumulate; only the last continuation is read. Revisit for backward paging/maxPages.
      const compacted = {
        ...data,
        pages: data.pages.map((page, index) =>
          index < data.pages.length - 1 && page.continuation
            ? { items: page.items, exhausted: page.exhausted }
            : page,
        ),
        pageParams: data.pageParams.map((param, index) => (index === 0 ? param : undefined)),
      };
      return replaceEqualDeep(previous, compacted);
    },
    staleTime: Infinity,
    gcTime: SEARCH_CATALOG_GC_TIME_MS,
  });
}

// Intent prefetch on hover/focus; staleTime keeps a fresh cached facet free.
export function prefetchSearchCatalog(queryClient: QueryClient, facets: SearchFacets): void {
  void queryClient.prefetchInfiniteQuery(
    searchCatalogQueryOptions(facets, new Date().getFullYear()),
  );
}
