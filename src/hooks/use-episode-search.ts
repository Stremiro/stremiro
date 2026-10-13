import { useDebounce } from '@/hooks/use-debounce';

// Shared episode-search policy so the details pane and player episodes panel filter identically.
const EPISODE_SEARCH_DEBOUNCE_MS = 180;

/** Debounced episode-filter query: clearing applies immediately; `enabled=false` suppresses filtering but keeps the text. */
export function useEffectiveEpisodeSearch(episodeSearch: string, enabled = true): string {
  const debouncedQuery = useDebounce(episodeSearch.trim(), EPISODE_SEARCH_DEBOUNCE_MS);
  return enabled && episodeSearch.trim() ? debouncedQuery : '';
}
