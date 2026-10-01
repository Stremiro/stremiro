import { api, type MediaItem } from '@/lib/api';
import type { SearchMediaType } from '@/lib/search-page-state';

const MAX_SIMILAR_TITLES = 20;
/** Fewer matches than this reads as filler — the rail hides instead. */
export const MIN_SIMILAR_TITLES = 4;
const MAX_SEED_GENRES = 2;
const YEAR_SPAN = 25;
const RANK_SPAN = 50;

function primaryYear(year: string | undefined): number | undefined {
  const match = year ? /\d{4}/.exec(year) : null;
  return match ? Number(match[0]) : undefined;
}

function lowerGenres(item: MediaItem): Set<string> {
  return new Set(item.genres?.map((genre) => genre.trim().toLowerCase()).filter(Boolean));
}

/** Ranking depends on the full metadata, not just the catalog seed filters. */
export function similarTitlesSourceKey(item: MediaItem): string {
  return JSON.stringify([item.year ?? '', [...lowerGenres(item)].toSorted()]);
}

/** Animated series browse the anime catalog so recommendations stay animated. */
export function similarTitlesMediaType(item: MediaItem): SearchMediaType {
  if (item.type === 'movie') return 'movie';
  return lowerGenres(item).has('animation') ? 'anime' : 'series';
}

/** Unique source genres the catalog can filter by, using its declared spelling. */
export function similarTitlesSeedGenres(
  genres: readonly string[] | undefined,
  supported: readonly string[],
): string[] {
  const supportedGenres = new Map(
    supported.map((genre) => [genre.trim().toLowerCase(), genre.trim()]),
  );
  const seeds = new Set<string>();
  for (const genre of genres ?? []) {
    const supportedGenre = supportedGenres.get(genre.trim().toLowerCase());
    if (supportedGenre) seeds.add(supportedGenre);
    if (seeds.size >= MAX_SEED_GENRES) break;
  }
  return [...seeds];
}

/**
 * Genre overlap (Jaccard) comes first; era and catalog popularity only break
 * equal-overlap ties. A recent popular title must not outrank a closer match.
 */
export function rankSimilarTitles(
  source: MediaItem,
  candidateLists: readonly (readonly MediaItem[])[],
): MediaItem[] {
  const sourceGenres = lowerGenres(source);
  if (sourceGenres.size === 0) return [];
  const sourceYear = primaryYear(source.year);
  const sourceAnimated = sourceGenres.has('animation');
  const best = new Map<string, { item: MediaItem; genreScore: number; score: number }>();

  for (const list of candidateLists) {
    list.forEach((candidate, index) => {
      if (candidate.id === source.id || candidate.type !== source.type) return;
      const genres = lowerGenres(candidate);
      if (genres.has('animation') !== sourceAnimated) return;
      let shared = 0;
      for (const genre of genres) if (sourceGenres.has(genre)) shared += 1;
      if (shared === 0) return;

      const genreScore = shared / (sourceGenres.size + genres.size - shared);
      const year = primaryYear(candidate.year);
      const yearScore =
        sourceYear !== undefined && year !== undefined
          ? 1 - Math.min(Math.abs(sourceYear - year), YEAR_SPAN) / YEAR_SPAN
          : 0.5;
      const rankScore = 1 - Math.min(index, RANK_SPAN) / RANK_SPAN;
      const score = genreScore * 0.6 + yearScore * 0.25 + rankScore * 0.15;

      const existing = best.get(candidate.id);
      if (
        !existing ||
        genreScore > existing.genreScore ||
        (genreScore === existing.genreScore && score > existing.score)
      ) {
        best.set(candidate.id, { item: candidate, genreScore, score });
      }
    });
  }

  return [...best.values()]
    .toSorted((a, b) => b.genreScore - a.genreScore || b.score - a.score)
    .slice(0, MAX_SIMILAR_TITLES)
    .map((entry) => entry.item);
}

/** One shared-cache page per seed widens the pool without another request:
    the old intersection + first-seed pair never found second-seed-only matches. */
export async function fetchSimilarTitles(
  source: MediaItem,
  mediaType: SearchMediaType,
  seedGenres: readonly string[],
): Promise<MediaItem[]> {
  if (seedGenres.length === 0) return [];
  const pages = await Promise.allSettled(
    seedGenres
      .slice(0, MAX_SEED_GENRES)
      .map((genre) => api.querySearchCatalogPage({ mediaType, genres: [genre] })),
  );
  const lists = pages.flatMap((page) => (page.status === 'fulfilled' ? [page.value.items] : []));
  if (lists.length === 0 && pages[0]?.status === 'rejected') throw pages[0].reason;
  return rankSimilarTitles(source, lists);
}
