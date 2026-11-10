import { useQuery } from '@tanstack/react-query';
import { useDebounce } from '@/hooks/use-debounce';
import { api, type Episode } from '@/lib/api';
import { createObjectIdentity } from '@/lib/utils';

export const ITEM_SEARCH_DEBOUNCE_MS = 180;
const getItemListId = createObjectIdentity();

// `items` is identity-keyed by `getItemListId`, so a stable array re-submits an
// identical title list per keystroke — cache the strip on the array itself.
const searchedTitleLists = new WeakMap<readonly { title: string }[], string[]>();

function itemTitles(items: readonly { title: string }[]): string[] {
  let titles = searchedTitleLists.get(items);
  if (!titles) searchedTitleLists.set(items, (titles = items.map((item) => item.title)));
  return titles;
}

function useItemSearch<T>(
  items: T[],
  query: string,
  enabled: boolean,
  searchKey: string,
  searchIndices: (items: T[], query: string) => Promise<number[]>,
  matchKey?: (item: T) => string,
) {
  const trimmedQuery = query.trim();
  const debouncedQuery = useDebounce(trimmedQuery, ITEM_SEARCH_DEBOUNCE_MS);
  const requestedSearch = enabled && trimmedQuery ? debouncedQuery : '';
  const listId = requestedSearch ? getItemListId(items) : 0;
  const { data, isError, isFetched, isFetching, isLoading, isPlaceholderData, refetch } = useQuery({
    queryKey: [searchKey, listId, requestedSearch],
    queryFn: async () => {
      const indices = await searchIndices(items, requestedSearch);
      return {
        query: requestedSearch,
        items: indices.map((index) => items[index]).filter((item): item is T => item !== undefined),
      };
    },
    enabled: requestedSearch.length > 0,
    placeholderData: (previousData, previousQuery) => {
      if (!requestedSearch) return undefined;
      if (previousQuery?.queryKey[1] === listId) return previousData;
      if (!matchKey || !previousData) return undefined;
      // Keyed by value, not identity: a refetch may recreate row objects, and a match depends only on the key.
      const previousMatchedKeys = new Set(previousData.items.map(matchKey));
      return {
        query: previousData.query,
        items: items.filter((item) => previousMatchedKeys.has(matchKey(item))),
      };
    },
    structuralSharing: false,
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });
  const applied = requestedSearch ? data : undefined;
  const effectiveSearch = applied?.query ?? '';
  return {
    effectiveSearch,
    filteredItems: applied?.items ?? items,
    searchError:
      Boolean(requestedSearch) && (isError || (isFetched && (isLoading || isPlaceholderData))),
    isSearchFetching: Boolean(requestedSearch) && isFetching,
    retrySearch: () => void refetch(),
    isSearchPending:
      enabled &&
      Boolean(trimmedQuery) &&
      !isError &&
      (isPlaceholderData || effectiveSearch !== trimmedQuery),
  };
}

export function useTitleSearch<T extends { title: string }>(
  items: T[],
  query: string,
  enabled = true,
) {
  return useItemSearch(
    items,
    query,
    enabled,
    'title-search',
    (submittedItems, submittedQuery) =>
      api.searchTitles(itemTitles(submittedItems), submittedQuery),
    (item) => item.title,
  );
}

export const EPISODE_SEARCH_MIN_COUNT = 5;

export function useEpisodeSearch(episodes: Episode[], episodeSearch: string, enabled = true) {
  return useItemSearch(episodes, episodeSearch, enabled, 'episode-search', api.searchEpisodes);
}
