import type { Episode } from '@/lib/api';

export const EPISODE_SEARCH_MIN_COUNT = 5;

export function filterEpisodesBySearchQuery(
  episodes: Episode[],
  debouncedQuery: string,
): Episode[] {
  const normalizedQuery = debouncedQuery.trim().toLowerCase();
  if (!normalizedQuery) return episodes;
  const coordinates = /^(?:s(\d+)\s*e(\d+)|(\d+)\s*x\s*(\d+))$/.exec(normalizedQuery);
  const episodeOnly = /^(?:e|ep|episode)\s*(\d+)$/.exec(normalizedQuery);
  const seasonNumber = coordinates ? Number(coordinates[1] ?? coordinates[3]) : null;
  const episodeNumber = coordinates
    ? Number(coordinates[2] ?? coordinates[4])
    : episodeOnly
      ? Number(episodeOnly[1])
      : null;
  return episodes.filter(
    (episode) =>
      (episodeNumber !== null &&
        episode.episode === episodeNumber &&
        (seasonNumber === null || episode.season === seasonNumber)) ||
      String(episode.episode).includes(normalizedQuery) ||
      episode.title?.toLowerCase().includes(normalizedQuery) ||
      episode.overview?.toLowerCase().includes(normalizedQuery),
  );
}
