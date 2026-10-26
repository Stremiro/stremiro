import { useItemSearch } from '@/hooks/use-item-search';
import { api, type Episode } from '@/lib/api';

export const EPISODE_SEARCH_MIN_COUNT = 5;

export function useEpisodeSearch(episodes: Episode[], episodeSearch: string, enabled = true) {
  return useItemSearch(episodes, episodeSearch, enabled, 'episode-search', api.searchEpisodes);
}
