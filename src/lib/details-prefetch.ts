import type { QueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { resolvePlayerRouteMediaType } from '@/lib/player-navigation';
import {
  detailsCardQueryKey,
  detailsQueryKey,
  DETAILS_GC_TIME_MS,
  DETAILS_STALE_TIME_MS,
  titleWatchProgressQueryKey,
} from '@/lib/query-invalidation';
import { isSeriesLikeMediaType } from '@/lib/utils';

interface PrefetchDetailsRouteDataOptions {
  mediaId: string;
  mediaType?: string | null;
}

// Guard on cached data, not query state: a state entry also exists for a
// previously failed fetch, and prefetching past it is what makes a
// transient error retryable instead of blocking until GC evicts it.
function prefetchQueryOnce(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  queryFn: () => Promise<unknown>,
) {
  if (queryClient.getQueryData(queryKey) !== undefined) {
    return;
  }
  void queryClient.prefetchQuery({
    queryKey,
    queryFn,
    staleTime: DETAILS_STALE_TIME_MS,
    gcTime: DETAILS_GC_TIME_MS,
  });
}

export function prefetchDetailsRouteData(
  queryClient: QueryClient,
  { mediaId, mediaType }: PrefetchDetailsRouteDataOptions,
) {
  const normalizedId = mediaId.trim();
  if (!normalizedId) {
    return;
  }

  const routeType = resolvePlayerRouteMediaType(mediaType);

  void import('@/pages/details').catch(() => undefined);

  // Card payload only: hover intent must stay cheap. The details route
  // fetches the full episode payload once on commit.
  prefetchQueryOnce(queryClient, detailsCardQueryKey(routeType, normalizedId), () =>
    api.getMediaCardDetails(routeType, normalizedId),
  );

  // The same resume snapshot feeds the details Continue label, the card
  // overlay's primary button, and the hero slide — a local read, so warming
  // it keeps every one of them from flipping Play→Resume after first paint.
  prefetchQueryOnce(queryClient, titleWatchProgressQueryKey(normalizedId), () =>
    api.getTitleWatchProgress(normalizedId),
  );
}

/**
 * The full details payload (episode list + imdb anchor). The player's
 * episode-mapping gate waits on this for series-like titles, so resume
 * clicks prefetch it in parallel with the playback plan instead of
 * serializing the fetch behind the mount. Movies resolve without episode
 * context and skip the heavier payload entirely.
 */
export function prefetchFullDetailsData(
  queryClient: QueryClient,
  { mediaId, mediaType }: PrefetchDetailsRouteDataOptions,
) {
  const normalizedId = mediaId.trim();
  if (!normalizedId) {
    return;
  }
  // The kitsu check covers legacy history rows whose saved type predates
  // the anime type — the backend still routes them through episode mapping.
  if (!isSeriesLikeMediaType(mediaType) && !normalizedId.startsWith('kitsu:')) {
    return;
  }

  // Legacy kitsu: history rows play through the anime route; the player's
  // details query keys on the resolved route type, not the saved type.
  const routeType = normalizedId.startsWith('kitsu:')
    ? 'anime'
    : resolvePlayerRouteMediaType(mediaType);

  prefetchQueryOnce(queryClient, detailsQueryKey(routeType, normalizedId), () =>
    api.getMediaDetails(routeType, normalizedId),
  );
}
