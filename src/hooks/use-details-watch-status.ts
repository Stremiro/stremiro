import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useIsItemInLibrary, useItemWatchStatus } from '@/hooks/use-media-library';
import {
  api,
  type MediaItem,
  toMediaItem,
  WATCH_STATUS_COLORS,
  WATCH_STATUS_LABELS,
  type WatchStatus,
} from '@/lib/api';
import { notifyAction } from '@/lib/notify';
import {
  invalidateLibraryQueries,
  invalidateWatchStatusQueries,
  LIBRARY_QUERY_KEY,
  WATCH_STATUSES_QUERY_KEY,
} from '@/lib/query-invalidation';

interface WatchStatusMutationContext {
  previousStatuses?: Record<string, WatchStatus>;
  previousLibrary?: MediaItem[];
}

// Watch-status read + optimistic setter for the details hero chip group.
// A status is tracking intent: setting one also writes the title into the
// library (the profile's only enumeration surface). Clearing a status only
// clears the label; library membership stays the user's own.
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
      const previousStatuses =
        queryClient.getQueryData<Record<string, WatchStatus>>(WATCH_STATUSES_QUERY_KEY);
      queryClient.setQueryData<Record<string, WatchStatus>>(WATCH_STATUSES_QUERY_KEY, (old) => {
        const next = { ...old };
        if (status === null) delete next[itemId];
        else next[itemId] = status;
        return next;
      });

      // Mirror the track into the library cache so the profile reflects it
      // before the refetch lands.
      let previousLibrary: MediaItem[] | undefined;
      if (status !== null && item && !isInLibrary) {
        await queryClient.cancelQueries({ queryKey: LIBRARY_QUERY_KEY });
        previousLibrary = queryClient.getQueryData<MediaItem[]>(LIBRARY_QUERY_KEY);
        queryClient.setQueryData<MediaItem[]>(LIBRARY_QUERY_KEY, (old) =>
          old?.some((entry) => entry.id === item.id) ? old : [...(old ?? []), toMediaItem(item)],
        );
      }
      return { previousStatuses, previousLibrary };
    },
    onError: (_err, _status, context) => {
      if (context?.previousStatuses !== undefined) {
        queryClient.setQueryData<Record<string, WatchStatus>>(
          WATCH_STATUSES_QUERY_KEY,
          context.previousStatuses,
        );
      }
      if (context?.previousLibrary !== undefined) {
        queryClient.setQueryData<MediaItem[]>(LIBRARY_QUERY_KEY, context.previousLibrary);
      }
      notifyAction('Failed to update status', { tone: 'error' });
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
      void invalidateWatchStatusQueries(queryClient);
      void invalidateLibraryQueries(queryClient);
    },
  });

  // Expose the membership read too: the details page needs it for the
  // library toggle, and a second observer would duplicate this one.
  return { watchStatus, watchStatusMutation, isInLibrary };
}
