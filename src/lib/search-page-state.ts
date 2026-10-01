import type { AddonConfig } from '@/lib/api';
import { foldAsciiCase } from '@/lib/api-cache';

export type SearchMediaType = 'movie' | 'series' | 'anime';
// `new` is a UI feed: it maps to the provider `year` catalog (single pinned
// year) via yearFrom/yearTo, not a manifest catalog id.
export type SearchFeed = 'popular' | 'featured' | 'new';

export function resolveSearchUrlType(value: string | null): SearchMediaType {
  return value === 'series' || value === 'anime' ? value : 'movie';
}

export function resolveSearchUrlFeed(value: string | null): SearchFeed {
  return value === 'featured' || value === 'new' ? value : 'popular';
}

export function resolveSearchUrlGenre(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** ASCII-folded genre equality — the single comparison the menu checkmark,
    the URL toggle-off, and the deep-link dedupe share so casing can't drift
    (mirrors the backend's ASCII-folding match). */
export function sameSearchGenre(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && foldAsciiCase(a) === foldAsciiCase(b);
}

/** Genre badge → filtered search route — one owner so call sites can't drift
    on param names or encoding. */
export function searchGenrePath(mediaType: string, genre: string): string {
  return `/search?type=${mediaType}&genre=${encodeURIComponent(genre)}`;
}

// Cinemeta's declared genre sets (guide §1). Only used when no enabled addon
// manifest enumerates genre options — the manifest options are the source of
// truth whenever they exist.
const MOVIE_GENRE_FALLBACK = [
  'Action',
  'Adventure',
  'Animation',
  'Biography',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'History',
  'Horror',
  'Mystery',
  'Romance',
  'Sci-Fi',
  'Sport',
  'Thriller',
  'War',
  'Western',
] as const;
const SERIES_ONLY_GENRES = ['Game-Show', 'Reality-TV', 'Talk-Show'] as const;
const ANIME_CATEGORY_GENRE = 'animation';

function isYearOption(value: string): boolean {
  // The `year` catalog's required `genre` extra enumerates years, not genres.
  return /^\d{4}$/.test(value);
}

/**
 * Union of manifest-declared `genre` extra options across enabled addons for
 * the catalog type behind the active tab (anime browses `series`). Numeric
 * options are year-catalog values, not genres, and are dropped. Falls back to
 * Cinemeta's declared list so the menu stays populated while manifests
 * classify.
 */
export function collectSearchGenreOptions(
  addons: readonly AddonConfig[],
  mediaType: SearchMediaType,
): string[] {
  const catalogType = mediaType === 'movie' ? 'movie' : 'series';
  const seen = new Set<string>();
  const options: string[] = [];

  for (const addon of addons) {
    if (!addon.enabled) {
      continue;
    }
    for (const catalog of addon.capabilities?.catalogs ?? []) {
      if (foldAsciiCase(catalog.type.trim()) !== catalogType) {
        continue;
      }
      for (const extra of catalog.extras ?? []) {
        if (foldAsciiCase(extra.name.trim()) !== 'genre') {
          continue;
        }
        for (const option of extra.options ?? []) {
          const trimmed = option.trim();
          if (!trimmed || isYearOption(trimmed)) {
            continue;
          }
          const folded = foldAsciiCase(trimmed);
          if (!seen.has(folded)) {
            seen.add(folded);
            options.push(trimmed);
          }
        }
      }
    }
  }

  const resolved =
    options.length > 0
      ? options
      : catalogType === 'series'
        ? [...MOVIE_GENRE_FALLBACK, ...SERIES_ONLY_GENRES]
        : [...MOVIE_GENRE_FALLBACK];

  // Anime already means "series + Animation"; the marker genre is implied, so
  // offering it as a menu entry would be a no-op filter.
  return mediaType === 'anime'
    ? resolved.filter((genre) => foldAsciiCase(genre) !== ANIME_CATEGORY_GENRE)
    : resolved;
}
