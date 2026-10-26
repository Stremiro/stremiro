import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import { WatchStatusIcon } from '@/components/watch-status-icon';

import {
  getOwnWatchStatus,
  reconcileCollectionQueries,
  removeCachedProfileLibraryItems,
  setCachedLibraryMembership,
  setCachedWatchStatus,
  useIsItemInLibrary,
  useItemWatchStatus,
} from '@/hooks/use-media-library';
import {
  api,
  getWatchStatusErrorMessage,
  type MediaItem,
  WATCH_STATUS_LABELS,
  type WatchStatus,
} from '@/lib/api';
import { notifyAction } from '@/lib/notify';
import { restoreQueryArrayEntry } from '@/lib/optimistic-query';
import {
  LIBRARY_QUERY_KEY,
  PROFILE_LIBRARY_QUERY_KEY,
  WATCH_STATUSES_QUERY_KEY,
} from '@/lib/query-invalidation';
import { queryNeedsRetry } from '@/lib/utils';

interface WatchStatusMutationContext {
  itemId?: string;
  previousStatus?: WatchStatus;
  addedToLibrary?: boolean;
  wasInLibrary?: boolean;
}

// Watch-status read + optimistic setter for the details hero chip group.
// Setting a status saves the title to the library; clearing it removes the
// title again only when the status was what saved it (Rust tracks that).
export function useDetailsWatchStatus(
  mediaItem: MediaItem | null | undefined,
  routeItemId: string,
) {
  const queryClient = useQueryClient();
  const currentItemId = mediaItem?.id ?? routeItemId;
  const watchStatusQuery = useItemWatchStatus(currentItemId);
  const libraryQuery = useIsItemInLibrary(currentItemId);
  const watchStatus = watchStatusQuery.data;
  const isInLibrary = libraryQuery.data === true;
  const mutationKey = ['library-membership', currentItemId] as const;

  const watchStatusMutation = useMutation<
    MediaItem | null,
    unknown,
    { item: MediaItem | null | undefined; status: WatchStatus | null },
    WatchStatusMutationContext
  >({
    mutationKey,
    mutationFn: ({ item, status }) => {
      if (!item) throw new Error('Media item unavailable');
      return api.setWatchStatus(item, status);
    },
    onMutate: async ({ item, status }) => {
      const itemId = item?.id;
      if (!itemId) return {};
      await Promise.all([
        queryClient.cancelQueries({ queryKey: WATCH_STATUSES_QUERY_KEY }),
        queryClient.cancelQueries({ queryKey: LIBRARY_QUERY_KEY }),
      ]);
      const previousLibrary = queryClient.getQueryData<MediaItem[]>(LIBRARY_QUERY_KEY);
      const wasInLibrary = previousLibrary?.some((entry) => entry.id === itemId);
      const previousStatus = getOwnWatchStatus(
        queryClient.getQueryData<Record<string, WatchStatus>>(WATCH_STATUSES_QUERY_KEY),
        itemId,
      );
      setCachedWatchStatus(queryClient, itemId, status);

      const addedToLibrary = status !== null && !!previousLibrary && !wasInLibrary;
      if (addedToLibrary) setCachedLibraryMembership(queryClient, item, true);
      return { itemId, previousStatus, addedToLibrary, wasInLibrary };
    },
    onError: (error, _status, context) => {
      if (context?.itemId !== undefined) {
        setCachedWatchStatus(queryClient, context.itemId, context.previousStatus ?? null);
        if (context.addedToLibrary) {
          restoreQueryArrayEntry(queryClient, LIBRARY_QUERY_KEY, context.itemId, null);
        }
      }
      notifyAction('Failed to update status', {
        tone: 'error',
        detail: getWatchStatusErrorMessage(error),
      });
    },
    onSuccess: async (libraryItem, { item, status }, context) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: LIBRARY_QUERY_KEY }),
        ...(!libraryItem
          ? [queryClient.cancelQueries({ queryKey: PROFILE_LIBRARY_QUERY_KEY })]
          : []),
      ]);
      if (!libraryItem && context.itemId) {
        removeCachedProfileLibraryItems(queryClient, new Set([context.itemId]));
      }
      if (item) setCachedLibraryMembership(queryClient, libraryItem ?? item, libraryItem !== null);
      if (status === null) {
        notifyAction(
          !libraryItem && context.wasInLibrary ? 'Removed from Library' : 'Status cleared',
          { detail: item?.title, thumb: item?.poster },
        );
        return;
      }
      notifyAction(WATCH_STATUS_LABELS[status], {
        detail: item?.title,
        thumb: item?.poster,
        icon: createElement(WatchStatusIcon, { status, className: 'size-4' }),
      });
    },
    onSettled: (_data, error) =>
      reconcileCollectionQueries(queryClient, 'library-membership', error != null),
  });
  const statusPending =
    watchStatusMutation.isPending && watchStatusMutation.variables?.item?.id === currentItemId;

  // Details also needs the membership read for its library toggle.
  return {
    isReady: watchStatusQuery.isSuccess && libraryQuery.isSuccess,
    hasError: queryNeedsRetry(watchStatusQuery) || queryNeedsRetry(libraryQuery),
    isFetching: watchStatusQuery.isFetching || libraryQuery.isFetching,
    refetch: () => Promise.all([watchStatusQuery.refetch(), libraryQuery.refetch()]),
    watchStatus: statusPending ? watchStatusMutation.variables.status : watchStatus,
    watchStatusMutation: {
      ...watchStatusMutation,
      mutate: (status: WatchStatus | null) => {
        if (queryClient.isMutating({ mutationKey, exact: true }) === 0) {
          watchStatusMutation.mutate({ item: mediaItem, status });
        }
      },
    },
    isInLibrary: isInLibrary || (statusPending && watchStatusMutation.variables.status !== null),
  };
}
