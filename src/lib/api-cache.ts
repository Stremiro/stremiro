const API_CACHE_MAX_ENTRIES = 200;

export const BEST_STREAM_CACHE_TTL_MS = 1000 * 60 * 8;
export const MEDIA_SCHEDULE_CACHE_TTL_MS = 1000 * 60 * 30;
export const SEARCH_CACHE_TTL_MS = 1000 * 60 * 2;

// Mirrors the Rust `normalize_query` bound (MAX_SEARCH_QUERY_CHARS) and
// `MAX_GENRE_FILTERS` cap: canonicalizing here means the sent payload is
// already exactly what the backend ranks against.
const SEARCH_QUERY_MAX_CHARS = 120;
const SEARCH_GENRE_MAX_COUNT = 6;

// Canonical search text shared by cache keys and the IPC payload so the two
// can never drift. The bound counts Unicode scalars like Rust `chars()`
// — a UTF-16 slice could split a surrogate pair and diverge key vs sent.
export function canonicalizeSearchText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return Array.from(trimmed).slice(0, SEARCH_QUERY_MAX_CHARS).join('');
}

// ASCII-only fold matching the backend's `to_ascii_lowercase`/`eq_ignore_ascii_case`.
export function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

// Canonical genre list: per-genre text canonicalization plus the backend's
// case-insensitive dedupe and count cap, so the sent list is the effective
// filter rather than a superset of it.
export function canonicalizeSearchGenres(
  genres: readonly string[] | undefined,
): string[] | undefined {
  if (!genres?.length) return undefined;

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const genre of genres) {
    if (normalized.length >= SEARCH_GENRE_MAX_COUNT) break;
    const canonical = canonicalizeSearchText(genre);
    if (!canonical) continue;
    const dedupeKey = foldAsciiCase(canonical);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(canonical);
  }

  return normalized.length > 0 ? normalized : undefined;
}

type TimedCacheEntry<T> = { value: T; expiresAt: number };

export interface RequestCache<T> {
  ttlMs: number;
  values: Map<string, TimedCacheEntry<T>>;
  inFlight: Map<string, Promise<T>>;
  generation: number;
  clear: () => void;
}

export interface ApiCacheGroups {
  bestStream: { clear: () => void };
  mediaSchedule: { clear: () => void };
  searchCatalog: { clear: () => void };
}

export function createRequestCache<T>(ttlMs: number): RequestCache<T> {
  const values = new Map<string, TimedCacheEntry<T>>();
  const inFlight = new Map<string, Promise<T>>();

  const cache: RequestCache<T> = {
    ttlMs,
    values,
    inFlight,
    generation: 0,
    clear: () => {
      // Generation first so late in-flight responses cannot repopulate.
      cache.generation += 1;
      values.clear();
      inFlight.clear();
    },
  };

  return cache;
}

function pruneTimedCache<T>(cache: Map<string, TimedCacheEntry<T>>) {
  const now = Date.now();

  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }

  while (cache.size > API_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

export function setTimedCache<T>(
  cache: Map<string, TimedCacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  pruneTimedCache(cache);
}

// Miss is `undefined`, not a falsy check, so a valid falsy payload
// (e.g. `false`, `0`, `''`) is served from cache instead of re-fetched.
export function getTimedCache<T>(
  cache: Map<string, TimedCacheEntry<T>>,
  key: string,
): T | undefined {
  const now = Date.now();
  const cached = cache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }

  return cached.value;
}

export function runCachedRequest<T>(
  cache: RequestCache<T>,
  cacheKey: string,
  load: () => Promise<T>,
): Promise<T> {
  const cached = getTimedCache(cache.values, cacheKey);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }

  const inFlight = cache.inFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const startGeneration = cache.generation;
  const request = load()
    .then((result) => {
      // Cleared generation revokes repopulation; mirrors backend guard.
      if (cache.generation === startGeneration) {
        setTimedCache(cache.values, cacheKey, result, cache.ttlMs);
      }
      return result;
    })
    .finally(() => {
      if (cache.inFlight.get(cacheKey) === request) {
        cache.inFlight.delete(cacheKey);
      }
    });

  cache.inFlight.set(cacheKey, request);
  return request;
}

function clearCacheGroups(...caches: Array<{ clear: () => void }>) {
  for (const cache of caches) {
    cache.clear();
  }
}

function clearStreamingCaches(caches: ApiCacheGroups) {
  clearCacheGroups(caches.bestStream);
}

// Streaming writes always clear the best-stream cache — re-ranks and
// cooldowns server-side must not be re-served from TTL. The invariant lives
// here so call sites can't forget the tail.
export function withStreamingCacheClear<T>(
  caches: ApiCacheGroups,
  request: Promise<T>,
): Promise<T> {
  return request.then((result) => {
    clearStreamingCaches(caches);
    return result;
  });
}

function clearSearchCaches(caches: ApiCacheGroups) {
  clearCacheGroups(caches.searchCatalog);
}

export function clearProviderDataCaches(caches: ApiCacheGroups) {
  clearStreamingCaches(caches);
  clearCacheGroups(caches.mediaSchedule);
  clearSearchCaches(caches);
}

export function buildStreamCacheKey(
  type: string,
  id: string,
  season?: number,
  episode?: number,
  absoluteEpisode?: number,
): string {
  // Structural encoding, not a delimiter join: `normalize_media_id` permits
  // `|` in ids, so a joined key can alias distinct tuples.
  return JSON.stringify([
    type.trim().toLowerCase(),
    id.trim(),
    season ?? null,
    episode ?? null,
    absoluteEpisode ?? null,
  ]);
}

export function buildMediaDetailsCacheKey(type: string, id: string): string {
  // Structural encoding like buildStreamCacheKey: `normalize_media_id`
  // permits `|` in ids, so a joined key can alias distinct pairs.
  return JSON.stringify([type.trim().toLowerCase(), id.trim()]);
}

// Watch-history delete epoch: a `saveWatchProgress` write queued before a
// remove/clear must not resurrect the row once the delete lands. The
// backend bumps its own history generation on destructive writes; this
// mirrors it for the frontend's serialized save queue — the persistence
// hook snapshots the epoch at enqueue and skips writes that crossed one.
let watchProgressEpoch = 0;
export function getWatchProgressEpoch(): number {
  return watchProgressEpoch;
}
export function bumpWatchProgressEpoch(): void {
  watchProgressEpoch += 1;
}
