import type { MediaDetails, MediaSchedule, SearchCatalogPage, SearchCatalogQuery } from '@/lib/api';
import {
  buildMediaDetailsCacheKey,
  canonicalizeSearchGenres,
  canonicalizeSearchText,
  getTimedCache,
  type RequestCache,
  runCachedRequest,
  setTimedCache,
} from '@/lib/api-cache';
import type { InvokeApi } from '@/lib/api-core';

interface DiscoveryApiContext {
  safeInvoke: InvokeApi;
  mediaScheduleCache: RequestCache<MediaSchedule>;
  searchCatalogCache: RequestCache<SearchCatalogPage>;
}

export function createDiscoveryApi({
  safeInvoke,
  mediaScheduleCache,
  searchCatalogCache,
}: DiscoveryApiContext) {
  // In-flight dedup for schedule batches: surfaces asking for overlapping
  // items share the pending per-item work. Lives outside
  // RequestCache.inFlight because each entry resolves a per-item view of a
  // shared batch (`MediaSchedule | undefined`), not the cache's value type —
  // but it must still die with the cache, so clear() is composed to drop
  // joins that would hand pre-clear data to post-clear callers.
  const scheduleRequests = new Map<string, Promise<MediaSchedule | undefined>>();
  const baseScheduleClear = mediaScheduleCache.clear;
  mediaScheduleCache.clear = () => {
    scheduleRequests.clear();
    baseScheduleClear();
  };
  const querySearchCatalogPage = ({
    query,
    mediaType,
    feed,
    genres,
    yearFrom,
    yearTo,
    skip,
  }: SearchCatalogQuery) => {
    // Canonicalize once: the cache key and the IPC payload read the same
    // values, so a key can never alias a request it did not send.
    const sentQuery = canonicalizeSearchText(query);
    const sentGenres = canonicalizeSearchGenres(genres);
    const sentMediaType =
      typeof mediaType === 'string' && mediaType.trim() ? mediaType.trim() : undefined;
    const sentFeed = typeof feed === 'string' && feed.trim() ? feed.trim() : undefined;
    const sentSkip =
      typeof skip === 'number' && Number.isInteger(skip) && skip > 0 ? skip : undefined;
    const sentYearFrom =
      typeof yearFrom === 'number' && Number.isInteger(yearFrom) ? yearFrom : undefined;
    const sentYearTo = typeof yearTo === 'number' && Number.isInteger(yearTo) ? yearTo : undefined;

    // Structural key, not a delimiter join — a genre containing `|` would
    // alias different lists under `join('|')`.
    const cacheKey = JSON.stringify([
      sentQuery ?? null,
      sentMediaType ?? null,
      sentFeed ?? null,
      sentGenres ?? null,
      sentYearFrom ?? null,
      sentYearTo ?? null,
      sentSkip ?? 0,
    ]);

    return runCachedRequest(searchCatalogCache, cacheKey, () =>
      safeInvoke<SearchCatalogPage>('query_search_catalog', {
        request: {
          query: sentQuery,
          mediaType: sentMediaType,
          feed: sentFeed,
          genres: sentGenres,
          yearFrom: sentYearFrom,
          yearTo: sentYearTo,
          skip: sentSkip,
        },
      }),
    );
  };

  // Details payloads are React-Query-owned end to end: every caller already
  // holds the canonical detailsQueryKey, so a second in-memory cache here
  // would double-retain episodes and mask invalidations.
  const getMediaDetails = (type: string, id: string) =>
    safeInvoke<MediaDetails>('get_media_details', {
      mediaType: type.trim(),
      id: id.trim(),
      includeEpisodes: true,
    });

  // Card variant without episodes; full payload loads on commit.
  const getMediaCardDetails = (type: string, id: string) =>
    safeInvoke<MediaDetails>('get_media_details', {
      mediaType: type.trim(),
      id: id.trim(),
      includeEpisodes: false,
    });

  const getMediaSchedules = async (items: Array<{ mediaType: string; id: string }>) => {
    const normalizedItems: Array<{ cacheKey: string; id: string; mediaType: string }> = [];
    const seenCacheKeys = new Set<string>();

    for (const item of items) {
      const normalizedType = item.mediaType.trim();
      const normalizedId = item.id.trim();

      if (!normalizedType || !normalizedId) {
        continue;
      }

      const cacheKey = buildMediaDetailsCacheKey(normalizedType, normalizedId);
      if (seenCacheKeys.has(cacheKey)) {
        continue;
      }

      seenCacheKeys.add(cacheKey);
      normalizedItems.push({ cacheKey, id: normalizedId, mediaType: normalizedType });
    }

    if (normalizedItems.length === 0) {
      return [];
    }

    const schedulesByCacheKey = new Map<string, MediaSchedule>();
    const missingItems: Array<{ cacheKey: string; id: string; mediaType: string }> = [];

    for (const item of normalizedItems) {
      const cachedSchedule = getTimedCache(mediaScheduleCache.values, item.cacheKey);
      if (cachedSchedule !== undefined) {
        schedulesByCacheKey.set(item.cacheKey, cachedSchedule);
        continue;
      }

      missingItems.push(item);
    }

    if (missingItems.length > 0) {
      const startGeneration = mediaScheduleCache.generation;
      const toFetch = missingItems.filter((item) => !scheduleRequests.has(item.cacheKey));

      if (toFetch.length > 0) {
        const batchPromise = safeInvoke<MediaSchedule[]>('get_media_schedules', {
          items: toFetch.map(({ id, mediaType }) => ({ id, mediaType })),
        });
        // Index the batch once so per-waiter lookups don't scan it.
        const indexedBatch = batchPromise.then((schedules) => {
          const byKey = new Map<string, MediaSchedule>();
          for (const schedule of schedules) {
            const cacheKey = buildMediaDetailsCacheKey(schedule.type, schedule.id);
            byKey.set(cacheKey, schedule);
            // Concurrent clear revokes repopulation.
            if (mediaScheduleCache.generation === startGeneration) {
              setTimedCache(
                mediaScheduleCache.values,
                cacheKey,
                schedule,
                mediaScheduleCache.ttlMs,
              );
            }
          }
          return byKey;
        });
        // Per-item views preserve failures for every joining caller. Observe
        // unused rejections too: a batch can fail for items nobody joined.
        for (const item of toFetch) {
          const itemPromise = indexedBatch
            .then((byKey) => byKey.get(item.cacheKey))
            .finally(() => {
              if (scheduleRequests.get(item.cacheKey) === itemPromise) {
                scheduleRequests.delete(item.cacheKey);
              }
            });
          void itemPromise.catch(() => {});
          scheduleRequests.set(item.cacheKey, itemPromise);
        }
      }

      await Promise.all(
        missingItems.map(async (item) => {
          const schedule = await scheduleRequests.get(item.cacheKey);
          if (schedule) schedulesByCacheKey.set(item.cacheKey, schedule);
        }),
      );
    }

    return normalizedItems.flatMap((item) => {
      const schedule = schedulesByCacheKey.get(item.cacheKey);
      return schedule ? [schedule] : [];
    });
  };

  return {
    querySearchCatalogPage,
    getMediaDetails,
    getMediaCardDetails,
    getMediaSchedules,
  };
}
