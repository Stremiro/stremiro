import { foldAsciiCase } from '@/lib/api-cache';
import type { BrowseGenres } from '@/lib/api';

// `all` is a frontend-only facet: it browses the movie and series catalogs in
// parallel and lets the backend's untyped text search fan out to both, so it
// is never sent over IPC as a media type.
export type SearchMediaType = 'all' | 'movie' | 'series' | 'anime';
// `new` is a UI feed: it maps to the provider `year` catalog (single pinned
// year) via yearFrom/yearTo, not a manifest catalog id.
export type SearchFeed = 'popular' | 'featured' | 'new';

export function resolveSearchUrlType(value: string | null): SearchMediaType {
  return value === 'movie' || value === 'series' || value === 'anime' ? value : 'all';
}

/** Genre menu options per type tab. `all` unions the movie and series sets —
    first spelling wins, matching `sameSearchGenre`'s fold. */
export function searchGenreOptions(
  browseGenres: BrowseGenres | undefined,
  mediaType: SearchMediaType,
): readonly string[] {
  if (!browseGenres) return [];
  if (mediaType !== 'all') return browseGenres[mediaType];
  const seen = new Set<string>();
  return [...browseGenres.movie, ...browseGenres.series].filter((genre) =>
    seen.add(foldAsciiCase(genre)),
  );
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
