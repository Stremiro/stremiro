import { foldAsciiCase } from '@/lib/api-cache';
import { nonBlank } from '@/lib/utils';

// `all` omits the IPC media type so Rust fetches both movie and series catalogs.
export type SearchMediaType = 'all' | 'movie' | 'series' | 'anime';
// `new` pins yearFrom/yearTo instead of naming a provider catalog.
export type SearchFeed = 'popular' | 'featured' | 'new';

// Match Rust's ASCII-only genre comparison.
export function sameSearchGenre(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && foldAsciiCase(a) === foldAsciiCase(b);
}

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
  const type = params.get('type');
  const feed = params.get('feed');
  return {
    query: params.get('q') ?? '',
    type: type === 'movie' || type === 'series' || type === 'anime' ? type : 'all',
    feed: feed === 'featured' || feed === 'new' ? feed : 'popular',
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
