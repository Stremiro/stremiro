import { useDebounce } from '@/hooks/use-debounce';
import type { Episode } from '@/lib/api';

// Shared episode-search policy: the details pane and the player episodes
// panel filter the same fields on the same debounce so the two surfaces can
// never drift on what "search episodes" means.
export const EPISODE_SEARCH_DEBOUNCE_MS = 180;
export const EPISODE_SEARCH_MIN_COUNT = 5;

/** Debounced search query the episode surfaces filter on. A cleared field
    applies immediately — the stale debounced value must not keep filtering
    fresh rows for a debounce window — and `enabled=false` (the field hidden
    under the row-count threshold) suppresses filtering entirely while the
    text is kept for when the field returns. */
export function useEffectiveEpisodeSearch(episodeSearch: string, enabled = true): string {
  const debouncedQuery = useDebounce(episodeSearch.trim(), EPISODE_SEARCH_DEBOUNCE_MS);
  return enabled && episodeSearch.trim() ? debouncedQuery : '';
}

export function filterEpisodesBySearchQuery(
  episodes: Episode[],
  debouncedQuery: string,
): Episode[] {
  if (!debouncedQuery) return episodes;
  const normalizedQuery = debouncedQuery.toLowerCase();
  return episodes.filter(
    (episode) =>
      String(episode.episode).includes(normalizedQuery) ||
      episode.title?.toLowerCase().includes(normalizedQuery) ||
      episode.overview?.toLowerCase().includes(normalizedQuery),
  );
}
