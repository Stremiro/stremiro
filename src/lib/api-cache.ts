import type { BestResolvedStream } from '@/lib/api';

const API_CACHE_MAX_ENTRIES = 200;

type CacheLifetime = { cacheTtlMs: number };
const resultExpirations = new WeakMap<CacheLifetime, { expiresAt: number; refreshAt: number }>();

export function getCachedResultRefreshDelayMs(result: CacheLifetime): number {
  return Math.max(0, (resultExpirations.get(result)?.refreshAt ?? 0) - performance.now());
}

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
  return trimmed.slice(0, end).trimEnd();
}

// ASCII-only fold matching the backend's `to_ascii_lowercase`/`eq_ignore_ascii_case`.
export function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

const bestStreamValues = new Map<string, { value: BestResolvedStream; expiresAt: number }>();
const bestStreamInFlight = new Map<string, Promise<BestResolvedStream>>();

function pruneTimedCache() {
  const now = performance.now();

  for (const [key, entry] of bestStreamValues) {
    if (entry.expiresAt <= now) bestStreamValues.delete(key);
  }

  while (bestStreamValues.size > API_CACHE_MAX_ENTRIES) {
    const oldestKey = bestStreamValues.keys().next().value;
    if (!oldestKey) break;
    bestStreamValues.delete(oldestKey);
  }
}

function setTimedCache(key: string, value: BestResolvedStream) {
  const ttlMs = value.cacheTtlMs;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    bestStreamValues.delete(key);
    return;
  }
  // Reusing a resolved result must not restart its remaining pool lifetime.
  let expiration = resultExpirations.get(value);
  if (!expiration) {
    const expiresAt = performance.now() + ttlMs;
    expiration = { expiresAt, refreshAt: expiresAt };
    resultExpirations.set(value, expiration);
  }
  bestStreamValues.set(key, { value, expiresAt: expiration.expiresAt });
  pruneTimedCache();
}

function getTimedCache(key: string): BestResolvedStream | undefined {
  const now = performance.now();
  const cached = bestStreamValues.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= now) {
    bestStreamValues.delete(key);
    return undefined;
  }

  return cached.value;
}

interface CachedRequestAbort {
  signal: AbortSignal;
  /** Stops the backend work started under `requestId`. */
  cancel: (requestId: string) => void;
}

interface AbortableInFlight {
  requestId: string;
  /** Signalled callers still waiting on the shared request. */
  waiting: number;
  /** A caller without a signal joined — the request must run to completion. */
  pinned: boolean;
  /** Settled or cancelled — nothing left to cancel. */
  done: boolean;
}

const abortableInFlight = new WeakMap<Promise<unknown>, AbortableInFlight>();

/**
 * Shares one in-flight load per key. With `abort`, the backend work is cancelled
 * once every caller that joined has aborted; any caller without a signal pins it.
 */
export function runBestStreamRequest(
  cacheKey: string,
  load: (requestId?: string) => Promise<BestResolvedStream>,
  abort?: CachedRequestAbort,
): Promise<BestResolvedStream> {
  if (abort?.signal.aborted) return Promise.reject(abort.signal.reason);
  const cached = getTimedCache(cacheKey);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }

  let request = bestStreamInFlight.get(cacheKey);
  if (!request) {
    const abortable: AbortableInFlight | undefined = abort && {
      requestId: crypto.randomUUID(),
      waiting: 0,
      pinned: false,
      done: false,
    };
    // Rust measures the TTL before the response crosses IPC; anchor it at request start, never later.
    const requestedAt = performance.now();
    const started = load(abortable?.requestId)
      .then((result) => {
        if (!resultExpirations.has(result)) {
          resultExpirations.set(result, {
            expiresAt: requestedAt + result.cacheTtlMs,
            // Renewal waits for the source pool; cache validity stays conservative.
            refreshAt: performance.now() + result.cacheTtlMs,
          });
        }
        // Only the key's current owner publishes — a clear/prime since request start revokes it.
        if (bestStreamInFlight.get(cacheKey) === started) {
          setTimedCache(cacheKey, result);
        }
        return result;
      })
      .finally(() => {
        if (abortable) abortable.done = true;
        if (bestStreamInFlight.get(cacheKey) === started) {
          bestStreamInFlight.delete(cacheKey);
        }
      });
    bestStreamInFlight.set(cacheKey, started);
    if (abortable) abortableInFlight.set(started, abortable);
    request = started;
  }

  const abortable = abortableInFlight.get(request);
  if (!abort) {
    if (abortable) abortable.pinned = true;
    return request;
  }
  return joinAbortable(cacheKey, request, abortable, abort);
}

function joinAbortable(
  cacheKey: string,
  request: Promise<BestResolvedStream>,
  abortable: AbortableInFlight | undefined,
  { signal, cancel }: CachedRequestAbort,
): Promise<BestResolvedStream> {
  if (abortable) abortable.waiting += 1;
  return new Promise<BestResolvedStream>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason);
      if (!abortable) return;
      abortable.waiting -= 1;
      // Deferred so a same-commit effect re-run can rejoin instead of restarting the work.
      queueMicrotask(() => {
        if (abortable.waiting > 0 || abortable.pinned || abortable.done) return;
        abortable.done = true;
        if (bestStreamInFlight.get(cacheKey) === request) bestStreamInFlight.delete(cacheKey);
        cancel(abortable.requestId);
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    request.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Seeds a known result and revokes any older in-flight publisher for the key. */
export function primeBestStreamRequest(cacheKey: string, value: BestResolvedStream): void {
  bestStreamInFlight.delete(cacheKey);
  setTimedCache(cacheKey, value);
}

// Streaming writes always clear the best-stream cache — server re-ranks/cooldowns must not be re-served from TTL.
export function withStreamingCacheClear<T>(request: Promise<T>): Promise<T> {
  return request.finally(clearProviderDataCaches);
}

export function clearProviderDataCaches() {
  // Dropping in-flight ownership stops late responses from repopulating.
  bestStreamValues.clear();
  bestStreamInFlight.clear();
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
