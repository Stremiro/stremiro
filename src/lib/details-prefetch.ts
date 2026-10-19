import type { QueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { getWatchProgressEpoch, getWatchProgressSnapshotRevision } from '@/lib/api-cache';
import { resolvePlayerRouteMediaType } from '@/lib/player-navigation';
import { routeChunks } from '@/lib/route-chunks';
import {
  detailsCardQueryKey,
  detailsQueryKey,
  getDiscoveryEpoch,
  titleWatchProgressQueryKey,
} from '@/lib/query-invalidation';
import { isSeriesLikeMediaType } from '@/lib/utils';

interface PrefetchDetailsRouteDataOptions {
  mediaId: string;
  mediaType?: string | null;
}

// One bundle invoke per title at a time (in-flight leader pattern): the
// resolved-data guard can't see an in-flight call, so followers share the leader.
const detailsPrefetchInFlight = new Map<string, Promise<void>>();

export function prefetchDetailsRouteData(
  queryClient: QueryClient,
  {
    mediaId,
    mediaType,
    warmChunk = true,
  }: PrefetchDetailsRouteDataOptions & { warmChunk?: boolean },
) {
  const normalizedId = mediaId.trim();
  if (!normalizedId) {
    return;
  }

  const routeType = resolvePlayerRouteMediaType(mediaType);

  if (warmChunk) void routeChunks.details().catch(() => undefined);

  // One IPC warms both reads: the episode-free card payload (hover stays cheap;
  // the route fetches the full payload on commit) plus the resume snapshot.
  const detailsKey = detailsCardQueryKey(routeType, normalizedId);
  const progressKey = titleWatchProgressQueryKey(normalizedId);
  const detailsState = queryClient.getQueryState(detailsKey);
  const fullDetailsState = queryClient.getQueryState(detailsQueryKey(routeType, normalizedId));
  const progressState = queryClient.getQueryState(progressKey);
  if (
    (detailsState?.data !== undefined ||
      detailsState?.fetchStatus === 'fetching' ||
      fullDetailsState?.data !== undefined ||
      fullDetailsState?.fetchStatus === 'fetching') &&
    (progressState?.data !== undefined || progressState?.fetchStatus === 'fetching')
  ) {
    return;
  }

  const inFlightKey = `${routeType}:${normalizedId}`;
  if (detailsPrefetchInFlight.has(inFlightKey)) {
    return;
  }

  // Cached-data guard re-checked at write time so a mount-time
  // fetch that landed first wins. A failed/absent details half leaves the
  // mounted query's own fetch; a failed bundle leaves no state entry, so the
  // next hover retries instead of blocking until GC.
  const progressEpoch = getWatchProgressEpoch();
  const progressRevision = getWatchProgressSnapshotRevision();
  const discoveryEpoch = getDiscoveryEpoch();
  const request = api
    .getDetailsPrefetchBundle(routeType, normalizedId)
    .then((bundle) => {
      if (discoveryEpoch !== getDiscoveryEpoch()) return;
      if (bundle.details && queryClient.getQueryData(detailsKey) === undefined) {
        queryClient.setQueryData(detailsKey, bundle.details);
      }
      if (
        progressEpoch === getWatchProgressEpoch() &&
        progressRevision === getWatchProgressSnapshotRevision() &&
        queryClient.getQueryData(progressKey) === undefined
      ) {
        queryClient.setQueryData(progressKey, bundle.progress);
      }
    })
    .catch(() => undefined)
    .finally(() => {
      if (detailsPrefetchInFlight.get(inFlightKey) === request) {
        detailsPrefetchInFlight.delete(inFlightKey);
      }
    });
  detailsPrefetchInFlight.set(inFlightKey, request);
}

/**
 * Full details payload (episodes + imdb anchor) for series-like titles — the
 * player's episode-mapping gate waits on it, so resume clicks prefetch in
 * parallel. Movies skip it.
 */
export function prefetchFullDetailsData(
  queryClient: QueryClient,
  { mediaId, mediaType }: PrefetchDetailsRouteDataOptions,
) {
  const normalizedId = mediaId.trim();
  if (!normalizedId) {
    return;
  }
  // Legacy kitsu: history rows predate the anime type but still need episode mapping.
  if (!isSeriesLikeMediaType(mediaType) && !normalizedId.startsWith('kitsu:')) {
    return;
  }

  // Legacy kitsu: rows play through the anime route; the player's details query
  // keys on the resolved route type, not the saved type.
  const routeType = normalizedId.startsWith('kitsu:')
    ? 'anime'
    : resolvePlayerRouteMediaType(mediaType);

  const options = api.detailsQueryOptions(routeType, normalizedId);
  if (queryClient.getQueryData(options.queryKey) === undefined) {
    void queryClient.prefetchQuery(options);
  }
}
