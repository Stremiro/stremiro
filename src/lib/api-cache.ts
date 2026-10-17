const API_CACHE_MAX_ENTRIES = 200;

type CacheLifetime = { cacheTtlMs: number };
const resultExpirations = new WeakMap<CacheLifetime, number>();

// UI query keys use the Rust `normalize_query` bound.
const SEARCH_QUERY_MAX_CHARS = 120;

// Canonical search text shared by cache keys and IPC payload. Bound counts Unicode
// scalars like Rust `chars()` — a UTF-16 slice could split a surrogate pair.
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
  values: Map<string, TimedCacheEntry<T>>;
  inFlight: Map<string, Promise<T>>;
  clear: () => void;
}

export interface ApiCacheGroups {
  bestStream: { clear: () => void };
}

export function createRequestCache<T>(): RequestCache<T> {
  const values = new Map<string, TimedCacheEntry<T>>();
  const inFlight = new Map<string, Promise<T>>();

  const cache: RequestCache<T> = {
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
  const now = performance.now();

  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }

  while (cache.size > API_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function setTimedCache<T extends CacheLifetime>(
  cache: Map<string, TimedCacheEntry<T>>,
  key: string,
  value: T,
) {
  const ttlMs = value.cacheTtlMs;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    cache.delete(key);
    return;
  }
  // Reusing a resolved result must not restart its remaining pool lifetime.
  const expiresAt = resultExpirations.get(value) ?? performance.now() + ttlMs;
  resultExpirations.set(value, expiresAt);
  cache.set(key, { value, expiresAt });
  pruneTimedCache(cache);
}

// Miss is `undefined`, not falsy — valid falsy payloads (false, 0, '') still serve from cache.
function getTimedCache<T>(cache: Map<string, TimedCacheEntry<T>>, key: string): T | undefined {
  const now = performance.now();
  const cached = cache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }

  return cached.value;
}

export function runCachedRequest<T extends CacheLifetime>(
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

  // Rust measures the TTL before the response crosses IPC; anchor it at request start, never later.
  const requestedAt = performance.now();
  const request = load()
    .then((result) => {
      if (!resultExpirations.has(result)) {
        resultExpirations.set(result, requestedAt + result.cacheTtlMs);
      }
      // Only the key's current owner publishes — a clear/prime since request start revokes it.
      if (cache.inFlight.get(cacheKey) === request) {
        setTimedCache(cache.values, cacheKey, result);
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
export function primeCachedRequest<T extends CacheLifetime>(
  cache: RequestCache<T>,
  cacheKey: string,
  value: T,
): void {
  cache.inFlight.delete(cacheKey);
  setTimedCache(cache.values, cacheKey, value);
}

// Streaming writes always clear the best-stream cache — server re-ranks/cooldowns must not be re-served from TTL.
export function withStreamingCacheClear<T>(
  caches: ApiCacheGroups,
  request: Promise<T>,
): Promise<T> {
  return request.finally(() => clearProviderDataCaches(caches));
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
  // Structural encoding, not a join — `normalize_media_id` permits `|` in ids, so joined keys can alias.
  return JSON.stringify([
    type.trim().toLowerCase(),
    id.trim(),
    season ?? null,
    episode ?? null,
    absoluteEpisode ?? null,
  ]);
}

// Watch-history delete epoch mirroring the backend's history generation: a save queued before
// a remove/clear must not resurrect the row — the persistence hook snapshots at enqueue and skips crossed writes.
let watchProgressEpoch = 0;
export function getWatchProgressEpoch(): number {
  return watchProgressEpoch;
}
export function bumpWatchProgressEpoch(): void {
  watchProgressEpoch += 1;
}

// Save revisions fence stale snapshots without discarding queued progress writes.
let watchProgressSnapshotRevision = 0;
export function getWatchProgressSnapshotRevision(): number {
  return watchProgressSnapshotRevision;
}
export function bumpWatchProgressSnapshotRevision(): void {
  watchProgressSnapshotRevision += 1;
}
