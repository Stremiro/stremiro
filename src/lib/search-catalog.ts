import { infiniteQueryOptions, type QueryClient } from '@tanstack/react-query';

import { api, type AllBrowseCursors, type MediaItem, type SearchCatalogPage } from '@/lib/api';
import { canonicalizeSearchText, foldAsciiCase } from '@/lib/api-cache';
import {
  SEARCH_CATALOG_GC_TIME_MS,
  SEARCH_CATALOG_QUERY_KEY,
  SEARCH_CATALOG_STALE_TIME_MS,
} from '@/lib/query-invalidation';
import type { SearchFacets } from '@/lib/search-page-state';

interface CatalogPageSummary {
  items: MediaItem[];
  lastPageAddedTypes: Set<MediaItem['type']>;
}

// Key the whole immutable pages array so middle-page refetches invalidate the summary.
const pageSummaries = new WeakMap<readonly SearchCatalogPage[], CatalogPageSummary>();
const itemKeys = new WeakMap<Pick<MediaItem, 'id' | 'type'>, string>();

export function searchCatalogKey(item: Pick<MediaItem, 'id' | 'type'>): string {
  let cached = itemKeys.get(item);
  if (!cached) {
    cached = `${foldAsciiCase(item.type.trim())}:${foldAsciiCase(item.id.trim())}`;
    itemKeys.set(item, cached);
  }
  return cached;
}

function getCatalogPageSummary(pages: readonly SearchCatalogPage[]): CatalogPageSummary {
  const cached = pageSummaries.get(pages);
  if (cached) return cached;

  const seen = new Set<string>();
  const items: MediaItem[] = [];
  const lastPageAddedTypes = new Set<MediaItem['type']>();
  const lastIndex = pages.length - 1;
  pages.forEach((page, index) => {
    for (const item of page.items) {
      const key = searchCatalogKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (index === lastIndex) lastPageAddedTypes.add(item.type);
    }
  });

  const summary = { items, lastPageAddedTypes };
  pageSummaries.set(pages, summary);
  return summary;
}

export function searchCatalogQueryOptions(facets: SearchFacets, localYear: number) {
  // The UI key and request share the same bounded text; Rust validates it.
  const normalizedQuery = canonicalizeSearchText(facets.query);
  const normalizedGenre = canonicalizeSearchText(facets.genre);
  // Feeds pick a browse catalog; text search always hits the search catalog,
  // so a feed must neither filter it nor split its cache key.
  const browseFeed = normalizedQuery ? undefined : facets.feed;
  const newFeedYear = browseFeed === 'new' ? localYear : undefined;
  // `all` with no query merges both browse catalogs; with a query the backend
  // already fans out to the movie and series search catalogs on its own.
  const allBrowse = facets.type === 'all' && !normalizedQuery;

  return infiniteQueryOptions({
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
        skip: typeof pageParam === 'number' && pageParam > 0 ? pageParam : undefined,
        allCursors: allBrowse ? (pageParam as AllBrowseCursors) : undefined,
      });
    },
    initialPageParam: (allBrowse ? { movie: 0, series: 0 } : 0) as number | AllBrowseCursors,
    getNextPageParam: (lastPage, allPages, lastPageParam) => {
      if (!allBrowse) {
        return nextCatalogSkip(lastPage, allPages, lastPageParam as number);
      }
      const previousCursors = lastPageParam as AllBrowseCursors;
      const cursors = {
        movie: nextCatalogSkip(lastPage, allPages, previousCursors.movie, 'movie'),
        series: nextCatalogSkip(lastPage, allPages, previousCursors.series, 'series'),
      };
      return cursors.movie !== undefined || cursors.series !== undefined ? cursors : undefined;
    },
    staleTime: SEARCH_CATALOG_STALE_TIME_MS,
    gcTime: SEARCH_CATALOG_GC_TIME_MS,
  });
}

// Intent prefetch on hover/focus; staleTime keeps a fresh cached facet free.
export function prefetchSearchCatalog(queryClient: QueryClient, facets: SearchFacets): void {
  void queryClient.prefetchInfiniteQuery(
    searchCatalogQueryOptions(facets, new Date().getFullYear()),
  );
}

export function flattenCatalogPages(pages: readonly SearchCatalogPage[]): MediaItem[] {
  return getCatalogPageSummary(pages).items;
}

function nextCatalogSkip(
  lastPage: SearchCatalogPage,
  allPages: SearchCatalogPage[],
  lastPageParam: number | undefined,
  mediaType?: MediaItem['type'],
): number | undefined {
  if (lastPageParam === undefined) return undefined;
  const nextSkip = mediaType ? lastPage.allCursors?.[mediaType] : lastPage.nextSkip;
  // All browse retains the same cursor only when a branch failed and needs a retry.
  if (mediaType && nextSkip === lastPageParam) return nextSkip;
  // Rust emits `Option<u32>`; only a non-advancing (saturated) cursor needs a guard.
  if (nextSkip == null || nextSkip <= lastPageParam) {
    return undefined;
  }

  // A page with no unseen titles ends pagination despite an advancing source cursor.
  const { lastPageAddedTypes } = getCatalogPageSummary(allPages);
  const addsItems = mediaType ? lastPageAddedTypes.has(mediaType) : lastPageAddedTypes.size > 0;
  return addsItems ? nextSkip : undefined;
}
