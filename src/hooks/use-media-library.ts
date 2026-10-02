import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { useLocalDay } from '@/hooks/use-local-day';
import {
  api,
  type Episode,
  type MediaItem,
  type TitleWatchProgress,
  toMediaItem,
  type UserList,
  type UpNextCandidate,
  type WatchProgress,
  type WatchStatus,
} from '@/lib/api';
import { watchProgressCoordinates } from '@/lib/history-playback';
import { notifyAction } from '@/lib/notify';
import {
  CONTINUE_WATCHING_QUERY_KEY,
  invalidateLibraryQueries,
  invalidateListQueries,
  invalidatePlaybackHistoryQueriesForTitle,
  invalidateWatchStatusQueries,
  LIBRARY_QUERY_KEY,
  LISTS_QUERY_KEY,
  LISTS_VIEW_STALE_TIME_MS,
  titleWatchProgressQueryKey,
  TOTAL_WATCH_TIME_QUERY_KEY,
  UP_NEXT_ENTRIES_QUERY_KEY,
  WATCH_HISTORY_QUERY_KEY,
  WATCH_HISTORY_STALE_TIME_MS,
  WATCH_STATUSES_QUERY_KEY,
} from '@/lib/query-invalidation';
import { buildUpNextEntries } from '@/lib/up-next';
import { formatEpisodeHeading } from '@/lib/utils';

const LIBRARY_STALE_TIME = 1000 * 60 * 5;
const CONTINUE_WATCHING_STALE_TIME = 1000 * 30;
const WATCH_STATUSES_STALE_TIME = 1000 * 60 * 5;

interface SharedCollectionQueryOptions {
  enabled?: boolean;
  staleTime?: number;
}

interface UseLatestWatchHistoryEntryOptions {
  enabled?: boolean;
}

interface UseMediaCollectionActionsOptions {
  item: MediaItem;
  isInLibrary: boolean;
  itemListIds?: string[];
  lists?: UserList[];
}

interface ToggleLibraryMutationContext {
  previousLibrary?: MediaItem[];
  previousStatuses?: Record<string, WatchStatus>;
}

interface UseToggleLibraryItemOptions {
  item?: MediaItem | null;
  isInLibrary: boolean;
}

interface UseRemoveFromContinueWatchingOptions {
  itemId: string;
  itemTitle?: string;
  mediaType?: string | null;
}

// Undo restore: the batch command replays the remove as one bounded write —
// the generation guard only drops saves that were in flight across the delete.
async function restoreWatchProgressRows(
  queryClient: QueryClient,
  itemId: string,
  rows: WatchProgress[],
) {
  try {
    await api.saveWatchProgressBatch(rows);
  } catch {
    toast.error('Could not restore watch history');
    return;
  }
  await invalidatePlaybackHistoryQueriesForTitle(queryClient, itemId);
}

const WATCH_HISTORY_UNDO_DURATION_MS = 6000;

// Shared per-array index — the first card builds the set once per fetch and
// the rest reuse it.
const libraryIdSetCache = new WeakMap<MediaItem[], Set<string>>();

function getLibraryIdSet(library: MediaItem[]): Set<string> {
  let cached = libraryIdSetCache.get(library);
  if (!cached) {
    cached = new Set(library.map((item) => item.id));
    libraryIdSetCache.set(library, cached);
  }
  return cached;
}

function buildOtherListsDescription(
  lists: UserList[] | undefined,
  itemListIds: string[] | undefined,
  addedListId: string,
) {
  const alreadyIn = lists?.filter(
    (list) => list.id !== addedListId && itemListIds?.includes(list.id),
  );

  if (!alreadyIn || alreadyIn.length === 0) {
    return null;
  }

  const names = alreadyIn.map((list) => `"${list.name}"`).join(', ');
  return `Also in ${names}`;
}

function resolveSharedCollectionQueryOptions(
  options: SharedCollectionQueryOptions | undefined,
  defaultStaleTime: number,
) {
  return {
    enabled: options?.enabled,
    staleTime: options?.staleTime ?? defaultStaleTime,
  };
}

export function useLibraryItems(options?: SharedCollectionQueryOptions) {
  return useQuery({
    queryKey: LIBRARY_QUERY_KEY,
    queryFn: api.getLibrary,
    ...resolveSharedCollectionQueryOptions(options, LIBRARY_STALE_TIME),
  });
}

export function useWatchStatuses(options?: SharedCollectionQueryOptions) {
  return useQuery({
    queryKey: WATCH_STATUSES_QUERY_KEY,
    queryFn: api.getAllWatchStatuses,
    ...resolveSharedCollectionQueryOptions(options, WATCH_STATUSES_STALE_TIME),
  });
}

export function useWatchHistory(options?: SharedCollectionQueryOptions) {
  return useQuery({
    queryKey: WATCH_HISTORY_QUERY_KEY,
    queryFn: api.getWatchHistory,
    ...resolveSharedCollectionQueryOptions(options, WATCH_HISTORY_STALE_TIME_MS),
  });
}

export function useContinueWatching(options?: SharedCollectionQueryOptions) {
  return useQuery({
    queryKey: CONTINUE_WATCHING_QUERY_KEY,
    queryFn: api.getContinueWatching,
    ...resolveSharedCollectionQueryOptions(options, CONTINUE_WATCHING_STALE_TIME),
  });
}

/// Total seconds watched across every raw history row — the collapsed
/// history queries would drop per-episode rows.
export function useTotalWatchTime(options?: SharedCollectionQueryOptions) {
  return useQuery({
    queryKey: TOTAL_WATCH_TIME_QUERY_KEY,
    queryFn: api.getTotalWatchTimeSecs,
    ...resolveSharedCollectionQueryOptions(options, WATCH_HISTORY_STALE_TIME_MS),
  });
}

export function useLists(options?: SharedCollectionQueryOptions) {
  return useQuery({
    queryKey: LISTS_QUERY_KEY,
    queryFn: api.getLists,
    // The shared 30s view policy is the default so callers can't drift on freshness.
    ...resolveSharedCollectionQueryOptions(options, LISTS_VIEW_STALE_TIME_MS),
  });
}

/// Shared identity for the per-title resume query — both hooks read the same
/// key/fn so a `select` variant never forks the cache.
function titleWatchProgressQuery(itemId: string | undefined, enabled: boolean) {
  return {
    queryKey: titleWatchProgressQueryKey(itemId),
    queryFn: () =>
      itemId
        ? api.getTitleWatchProgress(itemId)
        : Promise.reject(new Error('Item ID is required to read title progress.')),
    enabled: enabled && Boolean(itemId),
  };
}

/// Per-title resume snapshot scoped by media id — one indexed read instead
/// of the full-history scans behind `useWatchHistory`/`useContinueWatching`.
export function useTitleWatchProgress(itemId?: string, options?: SharedCollectionQueryOptions) {
  return useQuery({
    ...titleWatchProgressQuery(itemId, options?.enabled ?? true),
    staleTime: options?.staleTime ?? WATCH_HISTORY_STALE_TIME_MS,
  });
}

export function useIsItemInLibrary(itemId?: string, options?: SharedCollectionQueryOptions) {
  const selectMembership = useCallback(
    (library: MediaItem[]) => Boolean(itemId && getLibraryIdSet(library).has(itemId)),
    [itemId],
  );

  return useQuery({
    queryKey: LIBRARY_QUERY_KEY,
    queryFn: api.getLibrary,
    enabled: (options?.enabled ?? true) && Boolean(itemId),
    staleTime: options?.staleTime ?? LIBRARY_STALE_TIME,
    select: selectMembership,
  });
}

export function useItemWatchStatus(itemId?: string, options?: SharedCollectionQueryOptions) {
  const selectWatchStatus = useCallback(
    (statuses: Record<string, WatchStatus>) => (itemId ? (statuses[itemId] ?? null) : null),
    [itemId],
  );

  return useQuery({
    queryKey: WATCH_STATUSES_QUERY_KEY,
    queryFn: api.getAllWatchStatuses,
    enabled: (options?.enabled ?? true) && Boolean(itemId),
    staleTime: options?.staleTime ?? WATCH_STATUSES_STALE_TIME,
    select: selectWatchStatus,
  });
}

export function useLatestWatchHistoryEntry(
  itemId?: string,
  options?: UseLatestWatchHistoryEntryOptions,
) {
  // `history` arrives `last_watched` DESC — the latest entry is the first row.
  const selectLatestEntry = useCallback((progress: TitleWatchProgress) => progress.history[0], []);

  return useQuery({
    ...titleWatchProgressQuery(itemId, options?.enabled ?? true),
    staleTime: WATCH_HISTORY_STALE_TIME_MS,
    select: selectLatestEntry,
  });
}

export function useToggleLibraryItem({ item, isInLibrary }: UseToggleLibraryItemOptions) {
  const queryClient = useQueryClient();

  return useMutation<'added' | 'removed', unknown, void, ToggleLibraryMutationContext>({
    mutationFn: async () => {
      if (!item) {
        throw new Error('Media item unavailable');
      }

      if (isInLibrary) {
        // Status is a library attribute: `remove_from_library` clears it in
        // the same blocking op, so a removed title can't leave an invisible row.
        await api.removeFromLibrary(item.id);
        return 'removed' as const;
      }

      await api.addToLibrary(item);
      return 'added' as const;
    },
    onMutate: async () => {
      if (!item) {
        return {};
      }

      await queryClient.cancelQueries({ queryKey: LIBRARY_QUERY_KEY });
      const previousLibrary = queryClient.getQueryData<MediaItem[]>(LIBRARY_QUERY_KEY);

      queryClient.setQueryData<MediaItem[]>(LIBRARY_QUERY_KEY, (old) => {
        if (isInLibrary) {
          return old?.filter((libraryItem) => libraryItem.id !== item.id) ?? [];
        }

        return [...(old ?? []), toMediaItem(item)];
      });

      let previousStatuses: Record<string, WatchStatus> | undefined;
      if (isInLibrary) {
        // Mirror the status clear so the details chip can't show a stale status.
        await queryClient.cancelQueries({ queryKey: WATCH_STATUSES_QUERY_KEY });
        previousStatuses =
          queryClient.getQueryData<Record<string, WatchStatus>>(WATCH_STATUSES_QUERY_KEY);
        queryClient.setQueryData<Record<string, WatchStatus>>(WATCH_STATUSES_QUERY_KEY, (old) => {
          if (!old || !(item.id in old)) return old;
          const next = { ...old };
          delete next[item.id];
          return next;
        });
      }

      return { previousLibrary, previousStatuses };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousLibrary !== undefined) {
        queryClient.setQueryData<MediaItem[]>(LIBRARY_QUERY_KEY, context.previousLibrary);
      }
      if (context?.previousStatuses !== undefined) {
        queryClient.setQueryData<Record<string, WatchStatus>>(
          WATCH_STATUSES_QUERY_KEY,
          context.previousStatuses,
        );
      }

      notifyAction('Failed to update library', { tone: 'error' });
    },
    onSuccess: (action) => {
      if (!item) {
        return;
      }

      notifyAction(action === 'added' ? 'Added to Library' : 'Removed from Library', {
        detail: item.title,
        thumb: item.poster,
      });
    },
    onSettled: () => {
      void invalidateLibraryQueries(queryClient);
      void invalidateWatchStatusQueries(queryClient);
    },
  });
}

interface UseRemoveTitleWatchHistoryOptions extends UseRemoveFromContinueWatchingOptions {
  toastTitle: string;
  errorTitle: string;
}

// Shared whole-title history delete: collapsed surfaces render one row per
// title — deleting only the displayed row lets it resurface under a different
// episode. Optimistic filters keep the caches coherent; Undo replays the
// exact rows the delete returned.
function useRemoveTitleWatchHistory({
  itemId,
  itemTitle,
  mediaType,
  toastTitle,
  errorTitle,
}: UseRemoveTitleWatchHistoryOptions) {
  const queryClient = useQueryClient();
  const withoutTitle = (rows?: WatchProgress[]) => rows?.filter((entry) => entry.id !== itemId);
  const restore = (current: WatchProgress[] | undefined, removed: WatchProgress[]) =>
    current?.some((entry) => entry.id === itemId)
      ? current
      : [...(current ?? []), ...removed].toSorted((a, b) => b.last_watched - a.last_watched);

  return useMutation({
    mutationFn: async () => {
      const normalizedMediaType = mediaType?.trim();
      if (!normalizedMediaType) {
        throw new Error('Playback history metadata unavailable');
      }

      // The delete returns the exact rows it removed — the Undo snapshot
      // needs no extra read.
      return api.removeAllFromWatchHistory(itemId, normalizedMediaType);
    },
    onMutate: async () => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: CONTINUE_WATCHING_QUERY_KEY }),
        queryClient.cancelQueries({ queryKey: WATCH_HISTORY_QUERY_KEY }),
      ]);
      const previousContinueWatching = queryClient.getQueryData<WatchProgress[]>(
        CONTINUE_WATCHING_QUERY_KEY,
      );
      const previousWatchHistory =
        queryClient.getQueryData<WatchProgress[]>(WATCH_HISTORY_QUERY_KEY);
      queryClient.setQueryData<WatchProgress[]>(CONTINUE_WATCHING_QUERY_KEY, withoutTitle);
      queryClient.setQueryData<WatchProgress[]>(WATCH_HISTORY_QUERY_KEY, withoutTitle);
      return {
        removedContinueWatching: previousContinueWatching?.filter((entry) => entry.id === itemId),
        removedWatchHistory: previousWatchHistory?.filter((entry) => entry.id === itemId),
      };
    },
    onSuccess: (removedRows) => {
      toast.success(toastTitle, {
        description: itemTitle,
        duration: WATCH_HISTORY_UNDO_DURATION_MS,
        ...(removedRows.length > 0 && {
          action: {
            label: 'Undo',
            onClick: () => void restoreWatchProgressRows(queryClient, itemId, removedRows),
          },
        }),
      });
    },
    onError: (error, _variables, context) => {
      const removedContinueWatching = context?.removedContinueWatching;
      const removedWatchHistory = context?.removedWatchHistory;
      if (removedContinueWatching !== undefined) {
        queryClient.setQueryData<WatchProgress[]>(CONTINUE_WATCHING_QUERY_KEY, (current) =>
          restore(current, removedContinueWatching),
        );
      }
      if (removedWatchHistory !== undefined) {
        queryClient.setQueryData<WatchProgress[]>(WATCH_HISTORY_QUERY_KEY, (current) =>
          restore(current, removedWatchHistory),
        );
      }
      toast.error(error instanceof Error ? error.message : errorTitle);
    },
    onSettled: () => invalidatePlaybackHistoryQueriesForTitle(queryClient, itemId),
  });
}

export function useRemoveFromContinueWatching(options: UseRemoveFromContinueWatchingOptions) {
  return useRemoveTitleWatchHistory({
    ...options,
    toastTitle: 'Removed from Continue Watching',
    errorTitle: 'Failed to remove from Continue Watching',
  });
}

// Per-title delete for the profile tabs — the same whole-title semantics as
// the home rail.
export function useRemoveFromWatchHistory(options: UseRemoveFromContinueWatchingOptions) {
  return useRemoveTitleWatchHistory({
    ...options,
    toastTitle: 'Removed from history',
    errorTitle: 'Failed to remove from history',
  });
}

interface UseToggleEpisodeWatchedOptions {
  item?: MediaItem | null;
}

interface EpisodesWatchedVariables {
  episodes: readonly Episode[];
  watched: boolean;
}

function watchProgressRowMatchesEpisode(row: WatchProgress, episode: Episode): boolean {
  const { season, episode: rowEpisode } = watchProgressCoordinates(row);
  return season === episode.season && rowEpisode === episode.episode;
}

// Mutation variables paint instant watched checks; only Rust creates durable
// completion rows, chooses runtimes and stamps recency.
function useEpisodesWatchedMutation(item: MediaItem | null | undefined, seasonAction: boolean) {
  const queryClient = useQueryClient();
  const progressKey = titleWatchProgressQueryKey(item?.id);
  return useMutation<
    TitleWatchProgress,
    unknown,
    EpisodesWatchedVariables,
    { previous?: TitleWatchProgress }
  >({
    mutationFn: ({ episodes, watched }) => {
      if (!item) throw new Error('Media item unavailable');
      return api.setEpisodesWatched(item, episodes, watched);
    },
    onMutate: async ({ episodes, watched }) => {
      await queryClient.cancelQueries({ queryKey: progressKey });
      const previous = queryClient.getQueryData<TitleWatchProgress>(progressKey);
      const keep = (row: WatchProgress) =>
        !episodes.some((episode) => watchProgressRowMatchesEpisode(row, episode));
      queryClient.setQueryData<TitleWatchProgress>(progressKey, (old) => {
        if (!old) return old;
        return {
          history: watched ? old.history : old.history.filter(keep),
          continueWatching: old.continueWatching.filter(keep),
        };
      });
      return { previous };
    },
    onSuccess: (progress, { episodes, watched }) => {
      queryClient.setQueryData<TitleWatchProgress>(progressKey, progress);
      const episode = episodes[0];
      notifyAction(
        seasonAction
          ? 'Season marked as watched'
          : watched
            ? 'Marked as watched'
            : 'Marked as unwatched',
        {
          detail: seasonAction
            ? `${episodes.length} episode${episodes.length === 1 ? '' : 's'}`
            : episode && formatEpisodeHeading(episode.season, episode.episode, episode.title),
          thumb: item?.poster,
        },
      );
    },
    onError: (error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData<TitleWatchProgress>(progressKey, context.previous);
      }
      notifyAction('Failed to update watch history', {
        tone: 'error',
        detail: error instanceof Error ? error.message : undefined,
      });
    },
    onSettled: () => invalidatePlaybackHistoryQueriesForTitle(queryClient, item?.id),
  });
}

export function useToggleEpisodeWatched({ item }: UseToggleEpisodeWatchedOptions) {
  return useEpisodesWatchedMutation(item, false);
}

export function useMarkSeasonWatched({ item }: UseToggleEpisodeWatchedOptions) {
  return useEpisodesWatchedMutation(item, true);
}

// Rust returns only the next aired episode for each eligible title.
export function useUpNextEntries(
  continueWatching: readonly WatchProgress[],
  options?: SharedCollectionQueryOptions,
) {
  const localToday = format(useLocalDay(), 'yyyy-MM-dd');
  const selectEntries = useCallback(
    (candidates: UpNextCandidate[]) => {
      const resumable = new Set(continueWatching.map((row) => row.id));
      return buildUpNextEntries(
        candidates.filter(({ row }) => !resumable.has(row.id)),
        Date.now(),
      );
    },
    [continueWatching],
  );

  return useQuery({
    queryKey: [...UP_NEXT_ENTRIES_QUERY_KEY, localToday],
    queryFn: () => api.getUpNextEntries(localToday),
    select: selectEntries,
    ...resolveSharedCollectionQueryOptions(options, WATCH_HISTORY_STALE_TIME_MS),
  });
}

export function useMediaCollectionActions({
  item,
  isInLibrary,
  itemListIds,
  lists,
}: UseMediaCollectionActionsOptions) {
  const queryClient = useQueryClient();
  const toggleLibrary = useToggleLibraryItem({ item, isInLibrary });

  const toggleListMembership = useMutation({
    mutationFn: async (list: UserList) => {
      if (itemListIds?.includes(list.id)) {
        await api.removeFromList(list.id, item.id);
        return { action: 'removed' as const, list };
      }

      await api.addToList(list.id, item);
      return { action: 'added' as const, list };
    },
    onSuccess: ({ action, list }) => {
      void invalidateListQueries(queryClient);

      if (action === 'added') {
        notifyAction(`Added to "${list.name}"`, {
          detail: buildOtherListsDescription(lists, itemListIds, list.id) ?? item.title,
          thumb: item.poster,
        });
        return;
      }

      notifyAction(`Removed from "${list.name}"`, { detail: item.title, thumb: item.poster });
    },
    onError: () => {
      notifyAction('Failed to update list', { tone: 'error' });
    },
  });

  const addItemToNewList = useCallback(
    async (list: UserList) => {
      try {
        await api.addToList(list.id, item);
        await invalidateListQueries(queryClient);
        notifyAction(`Added to "${list.name}"`, {
          detail: buildOtherListsDescription(lists, itemListIds, list.id) ?? item.title,
          thumb: item.poster,
        });
      } catch {
        // The list was created successfully; membership can still be retried manually.
      }
    },
    [item, itemListIds, lists, queryClient],
  );

  return {
    addItemToNewList,
    toggleLibrary,
    toggleListMembership,
  };
}
