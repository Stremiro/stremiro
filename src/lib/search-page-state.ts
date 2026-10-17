import { foldAsciiCase } from '@/lib/api-cache';
import type { BrowseGenres } from '@/lib/api';
import { nonBlank } from '@/lib/utils';

// `all` is a frontend-only facet: it browses the movie and series catalogs in
// parallel and lets the backend's untyped text search fan out to both, so it
// is never sent over IPC as a media type.
export type SearchMediaType = 'all' | 'movie' | 'series' | 'anime';
// `new` is a UI feed: it maps to the provider `year` catalog (single pinned
// year) via yearFrom/yearTo, not a manifest catalog id.
export type SearchFeed = 'popular' | 'featured' | 'new';

function resolveSearchUrlType(value: string | null): SearchMediaType {
  return value === 'movie' || value === 'series' || value === 'anime' ? value : 'all';
}

/** Genre menu options per type tab. The `all` union is computed in the
    backend payload (movie then series, first spelling wins) so the menu
    never re-folds here. */
export function searchGenreOptions(
  browseGenres: BrowseGenres | undefined,
  mediaType: SearchMediaType,
): readonly string[] {
  return browseGenres ? browseGenres[mediaType] : [];
}

function resolveSearchUrlFeed(value: string | null): SearchFeed {
  return value === 'featured' || value === 'new' ? value : 'popular';
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

export interface SearchFacets {
  query: string;
  type: SearchMediaType;
  feed: SearchFeed;
  genre?: string;
}

export function readSearchFacets(params: URLSearchParams): SearchFacets {
  return {
    query: params.get('q') ?? '',
    type: resolveSearchUrlType(params.get('type')),
    feed: resolveSearchUrlFeed(params.get('feed')),
    genre: nonBlank(params.get('genre')),
  };
}

// Session-only memory of the last Search URL so the sidebar and `/` reopen it.
let lastSearchParams = '';

export function rememberSearchParams(params: URLSearchParams): void {
  lastSearchParams = params.toString();
}

export function lastSearchPath(): string {
  return lastSearchParams ? `/search?${lastSearchParams}` : '/search';
}

export function lastSearchFacets(): SearchFacets {
  return readSearchFacets(new URLSearchParams(lastSearchParams));
}
