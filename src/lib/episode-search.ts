import type { Episode } from '@/lib/api';

// Shared episode-search policy: the details pane and the player episodes
// panel filter the same fields on the same debounce so the two surfaces can
// never drift on what "search episodes" means.
export const EPISODE_SEARCH_DEBOUNCE_MS = 180;
export const EPISODE_SEARCH_MIN_COUNT = 5;

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
