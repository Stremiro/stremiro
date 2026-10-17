import { useItemSearch } from '@/hooks/use-item-search';
import { api, type Episode } from '@/lib/api';

export const EPISODE_SEARCH_MIN_COUNT = 5;

/** `effectiveEpisodeSearch` is the query `filteredEpisodes` answers, which lags the requested one while Rust searches. */
export function useEpisodeSearch(episodes: Episode[], episodeSearch: string, enabled = true) {
  const {
    effectiveSearch,
    filteredItems,
    searchError,
    isSearchFetching,
    retrySearch,
    isSearchPending,
  } = useItemSearch(episodes, episodeSearch, enabled, 'episode-search', api.searchEpisodes);
  return {
    effectiveEpisodeSearch: effectiveSearch,
    filteredEpisodes: filteredItems,
    searchError,
    isSearchFetching,
    retrySearch,
    isSearchPending,
  };
}
