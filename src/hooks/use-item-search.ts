import { useQuery } from '@tanstack/react-query';
import { useDebounce } from '@/hooks/use-debounce';
import { api } from '@/lib/api';

const ITEM_SEARCH_DEBOUNCE_MS = 180;
const itemListIds = new WeakMap<object, number>();
let nextItemListId = 0;

function getItemListId(items: object): number {
  let id = itemListIds.get(items);
  if (id === undefined) {
    id = ++nextItemListId;
    itemListIds.set(items, id);
  }
  return id;
}

export function useItemSearch<T>(
  items: T[],
  query: string,
  enabled: boolean,
  searchKey: string,
  searchIndices: (items: T[], query: string) => Promise<number[]>,
  matchKey?: (item: T) => string,
) {
  const debouncedQuery = useDebounce(query.trim(), ITEM_SEARCH_DEBOUNCE_MS);
  const requestedSearch = enabled && query.trim() ? debouncedQuery : '';
  const listId = getItemListId(items);
  const { data, isError, isFetched, isFetching, isLoading, isPlaceholderData, refetch } = useQuery({
    queryKey: [searchKey, listId, requestedSearch],
    queryFn: async () => {
      const indices = await searchIndices(items, requestedSearch);
      return { query: requestedSearch, items: indices.map((index) => items[index]) };
    },
    enabled: requestedSearch.length > 0,
    placeholderData: (previousData, previousQuery) => {
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
      Boolean(requestedSearch) &&
      !isError &&
      (isPlaceholderData || effectiveSearch !== requestedSearch),
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
      api.searchTitles(
        submittedItems.map((item) => item.title),
        submittedQuery,
      ),
    (item) => item.title,
  );
}
