import type { Episode } from '@/lib/api';

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
