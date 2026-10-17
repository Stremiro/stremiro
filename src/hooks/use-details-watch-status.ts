import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  getOwnWatchStatus,
  setCachedWatchStatus,
  useIsItemInLibrary,
  useItemWatchStatus,
} from '@/hooks/use-media-library';
import {
  api,
  getWatchStatusErrorMessage,
  type MediaItem,
  toMediaItem,
  WATCH_STATUS_COLORS,
  WATCH_STATUS_LABELS,
  type WatchStatus,
} from '@/lib/api';
import { notifyAction } from '@/lib/notify';
import { restoreQueryArrayEntry } from '@/lib/optimistic-query';
import {
  invalidateLibraryQueries,
  LIBRARY_QUERY_KEY,
  WATCH_STATUSES_QUERY_KEY,
} from '@/lib/query-invalidation';

interface WatchStatusMutationContext {
  itemId?: string;
  previousStatus?: WatchStatus;
  previousLibraryItem?: MediaItem | null;
}

// Watch-status read + optimistic setter for the details hero chip group.
// Setting a status also writes the title into the library; clearing only
// clears the label — membership stays the user's own.
export function useDetailsWatchStatus(item: MediaItem | null | undefined) {
  const queryClient = useQueryClient();
  const itemId = item?.id;
  const { data: watchStatus = null } = useItemWatchStatus(itemId);
  const { data: isInLibrary = false } = useIsItemInLibrary(itemId);

  const watchStatusMutation = useMutation<
    MediaItem | null,
    unknown,
    WatchStatus | null,
    WatchStatusMutationContext
  >({
    mutationFn: (status) => {
      if (!item) throw new Error('Media item unavailable');
      return api.setWatchStatus(item, status);
    },
    onMutate: async (status) => {
      if (!itemId) return {};
      await queryClient.cancelQueries({ queryKey: WATCH_STATUSES_QUERY_KEY });
      const previousStatus = getOwnWatchStatus(
        queryClient.getQueryData<Record<string, WatchStatus>>(WATCH_STATUSES_QUERY_KEY),
        itemId,
      );
      setCachedWatchStatus(queryClient, itemId, status);

      // Mirror the track into the library cache before the refetch lands.
      let previousLibraryItem: MediaItem | null | undefined;
      if (status !== null && item && !isInLibrary) {
        await queryClient.cancelQueries({ queryKey: LIBRARY_QUERY_KEY });
        previousLibraryItem =
          queryClient
            .getQueryData<MediaItem[]>(LIBRARY_QUERY_KEY)
            ?.find((entry) => entry.id === itemId) ?? null;
        queryClient.setQueryData<MediaItem[]>(LIBRARY_QUERY_KEY, (old) =>
          old?.some((entry) => entry.id === item.id) ? old : [...(old ?? []), toMediaItem(item)],
        );
      }
      return { itemId, previousStatus, previousLibraryItem };
    },
    onError: (error, _status, context) => {
      if (context?.itemId !== undefined) {
        setCachedWatchStatus(queryClient, context.itemId, context.previousStatus ?? null);
        if (context.previousLibraryItem !== undefined) {
          restoreQueryArrayEntry(
            queryClient,
            LIBRARY_QUERY_KEY,
            context.itemId,
            context.previousLibraryItem,
          );
        }
      }
      notifyAction('Failed to update status', {
        tone: 'error',
        detail: getWatchStatusErrorMessage(error),
      });
    },
    onSuccess: (savedItem, status) => {
      if (savedItem) {
        queryClient.setQueryData<MediaItem[]>(LIBRARY_QUERY_KEY, (old) => [
          ...(old ?? []).filter((entry) => entry.id !== savedItem.id),
          savedItem,
        ]);
      }
      if (status === null) {
        notifyAction('Status cleared', { detail: item?.title, thumb: item?.poster });
        return;
      }
      notifyAction(WATCH_STATUS_LABELS[status], {
        detail: item?.title,
        thumb: item?.poster,
        dot: WATCH_STATUS_COLORS[status].text,
      });
    },
    onSettled: () => {
      void invalidateLibraryQueries(queryClient);
    },
  });

  // Details also needs the membership read for its library toggle.
  return { watchStatus, watchStatusMutation, isInLibrary };
}
