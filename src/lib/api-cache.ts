const API_CACHE_MAX_ENTRIES = 200;

export const BEST_STREAM_CACHE_TTL_MS = 1000 * 60 * 8;

// UI query keys use the Rust `normalize_query` bound.
const SEARCH_QUERY_MAX_CHARS = 120;

// Canonical search text shared by cache keys and the IPC payload so the two
// can never drift. The bound counts Unicode scalars like Rust `chars()`
// — a UTF-16 slice could split a surrogate pair and diverge key vs sent.
export function canonicalizeSearchText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= SEARCH_QUERY_MAX_CHARS) return trimmed;
  let end = 0;
  let characters = 0;
  for (const character of trimmed) {
    end += character.length;
    if (++characters === SEARCH_QUERY_MAX_CHARS) break;
  }
  return trimmed.slice(0, end);
}

// ASCII-only fold matching the backend's `to_ascii_lowercase`/`eq_ignore_ascii_case`.
export function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

type TimedCacheEntry<T> = { value: T; expiresAt: number };

export interface RequestCache<T> {
  ttlMs: number;
  values: Map<string, TimedCacheEntry<T>>;
  inFlight: Map<string, Promise<T>>;
  clear: () => void;
}

export interface ApiCacheGroups {
  bestStream: { clear: () => void };
}

export function createRequestCache<T>(ttlMs: number): RequestCache<T> {
  const values = new Map<string, TimedCacheEntry<T>>();
  const inFlight = new Map<string, Promise<T>>();

  const cache: RequestCache<T> = {
    ttlMs,
    values,
    inFlight,
    clear: () => {
      // Dropping in-flight ownership stops late responses from repopulating.
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

function setTimedCache<T>(
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
function getTimedCache<T>(cache: Map<string, TimedCacheEntry<T>>, key: string): T | undefined {
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

  const request = load()
    .then((result) => {
      // Only the key's current owner publishes: a clear or a prime since this
      // request started revokes it, so a late response cannot overwrite either.
      if (cache.inFlight.get(cacheKey) === request) {
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

/** Seeds a known result and revokes any older in-flight publisher for the key. */
export function primeCachedRequest<T>(cache: RequestCache<T>, cacheKey: string, value: T): void {
  cache.inFlight.delete(cacheKey);
  setTimedCache(cache.values, cacheKey, value, cache.ttlMs);
}

// Streaming writes always clear the best-stream cache — re-ranks and
// cooldowns server-side must not be re-served from TTL. The invariant lives
// here so call sites can't forget the tail.
export function withStreamingCacheClear<T>(
  caches: ApiCacheGroups,
  request: Promise<T>,
): Promise<T> {
  return request.then((result) => {
    clearProviderDataCaches(caches);
    return result;
  });
}

export function clearProviderDataCaches(caches: ApiCacheGroups) {
  caches.bestStream.clear();
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
