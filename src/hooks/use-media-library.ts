import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import {
  api,
  type Episode,
  type MediaItem,
  type MediaSchedule,
  type TitleWatchProgress,
  toMediaItem,
  type UserList,
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
  MEDIA_ROW_STALE_TIME_MS,
  titleWatchProgressQueryKey,
  TOTAL_WATCH_TIME_QUERY_KEY,
  WATCH_HISTORY_QUERY_KEY,
  WATCH_HISTORY_STALE_TIME_MS,
  WATCH_STATUSES_QUERY_KEY,
} from '@/lib/query-invalidation';
import { buildUpNextEntries, isRecentUpNextSource, pickUpNextSources } from '@/lib/up-next';
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
        // the same blocking op, so a removed title can't leave a row the
        // details self-heal would resurrect.
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
      return { previousContinueWatching, previousWatchHistory };
    },
    onSuccess: (removedRows) => {
      void invalidatePlaybackHistoryQueriesForTitle(queryClient, itemId);

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
      if (context?.previousContinueWatching !== undefined) {
        queryClient.setQueryData<WatchProgress[]>(
          CONTINUE_WATCHING_QUERY_KEY,
          context.previousContinueWatching,
        );
      }
      if (context?.previousWatchHistory !== undefined) {
        queryClient.setQueryData<WatchProgress[]>(
          WATCH_HISTORY_QUERY_KEY,
          context.previousWatchHistory,
        );
      }
      toast.error(error instanceof Error ? error.message : errorTitle);
    },
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

interface ToggleEpisodeWatchedVariables {
  episode: Episode;
  markWatched: boolean;
  /** The stored progress row — the optimistic filter removes it before
      `mutationFn` could look it up, and the delete needs its raw coordinates. */
  storedRow?: WatchProgress;
}

function watchProgressRowMatchesEpisode(row: WatchProgress, episode: Episode): boolean {
  const { season, episode: rowEpisode } = watchProgressCoordinates(row);
  return season === episode.season && rowEpisode === episode.episode;
}

// The optimistic row (onMutate) and the persisted row (mutationFn) must be
// byte-identical — one builder keeps the shape and duration math from drifting.
function buildCompletedProgressRow(
  item: MediaItem,
  episode: Episode,
  prior: WatchProgress | undefined,
): WatchProgress {
  // Preserve the real duration when known — a fabricated one inflates
  // hours-watched. Unknown duration writes a 1s complete row: ratio 1.0
  // reads as watched and earns no resume offer.
  const duration = prior && prior.duration > 0 ? prior.duration : Math.max(prior?.position ?? 0, 1);
  return {
    ...prior,
    id: item.id,
    type_: item.type,
    season: episode.season,
    episode: episode.episode,
    position: duration,
    duration,
    last_watched: Date.now(),
    title: item.title,
    poster: item.poster,
    backdrop: item.backdrop,
  };
}

// Per-episode watched toggle. Watched writes an EOF-shaped row; unwatched
// deletes on the stored row's own coordinates — `build_history_key` uses raw
// `season`/`episode`, which differ from absolute coords on remapped anime.
export function useToggleEpisodeWatched({ item }: UseToggleEpisodeWatchedOptions) {
  const queryClient = useQueryClient();
  const itemId = item?.id;
  const progressKey = titleWatchProgressQueryKey(itemId);

  return useMutation<
    void,
    unknown,
    ToggleEpisodeWatchedVariables,
    { previous?: TitleWatchProgress }
  >({
    mutationFn: async ({ episode, markWatched, storedRow }) => {
      if (!item) {
        throw new Error('Media item unavailable');
      }

      if (!markWatched) {
        await api.removeFromWatchHistory(
          item.id,
          item.type,
          storedRow?.season ?? episode.season,
          storedRow?.episode ?? episode.episode,
        );
        return;
      }

      await api.saveWatchProgress(buildCompletedProgressRow(item, episode, storedRow));
    },
    onMutate: async ({ episode, markWatched }) => {
      if (!itemId || !item) return {};
      // const binding so the narrowed non-null item flows into the updater.
      const currentItem = item;
      await queryClient.cancelQueries({ queryKey: progressKey });
      const previous = queryClient.getQueryData<TitleWatchProgress>(progressKey);

      queryClient.setQueryData<TitleWatchProgress>(progressKey, (old) => {
        if (!old) return old;
        const matches = (row: WatchProgress) => watchProgressRowMatchesEpisode(row, episode);
        if (!markWatched) {
          return {
            history: old.history.filter((row) => !matches(row)),
            continueWatching: old.continueWatching.filter((row) => !matches(row)),
          };
        }
        const prior = old.history.find(matches);
        const row = buildCompletedProgressRow(currentItem, episode, prior);
        return {
          history: old.history.some(matches)
            ? old.history.map((existing) => (matches(existing) ? row : existing))
            : [row, ...old.history],
          continueWatching: old.continueWatching.filter((existing) => !matches(existing)),
        };
      });

      return { previous };
    },
    onSuccess: (_data, { episode, markWatched }) => {
      notifyAction(markWatched ? 'Marked as watched' : 'Marked as unwatched', {
        detail: formatEpisodeHeading(episode.season, episode.episode, episode.title),
        thumb: item?.poster,
      });
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
    onSettled: () => {
      void invalidatePlaybackHistoryQueriesForTitle(queryClient, itemId);
    },
  });
}

// Next aired episode for recently finished series. Schedules ride the shared
// calendar cache; derive rows from current history so cached schedules cannot
// retain an old title, artwork, timestamp, or preferred release family.
export function useUpNextEntries(
  continueWatching: readonly WatchProgress[],
  options?: SharedCollectionQueryOptions,
) {
  const { data: history, dataUpdatedAt: historyUpdatedAt } = useWatchHistory(options);
  const { data: statuses } = useWatchStatuses(options);
  const sources = useMemo(
    () => pickUpNextSources(history, continueWatching, statuses),
    [history, continueWatching, statuses],
  );
  const scheduleRequests = useMemo(
    () =>
      sources
        .filter((row) => isRecentUpNextSource(row, historyUpdatedAt))
        .map((row) => ({ mediaType: row.type_, id: row.id })),
    [sources, historyUpdatedAt],
  );
  const selectEntries = useCallback(
    (schedules: MediaSchedule[]) => {
      const now = Date.now();
      return buildUpNextEntries(
        sources.filter((row) => isRecentUpNextSource(row, now)),
        schedules,
        now,
      );
    },
    [sources],
  );

  return useQuery({
    // Schedules depend on title identity; episode progress only changes select.
    queryKey: [...CONTINUE_WATCHING_QUERY_KEY, 'up-next', scheduleRequests],
    queryFn: () => api.getMediaSchedules(scheduleRequests),
    select: selectEntries,
    enabled: (options?.enabled ?? true) && scheduleRequests.length > 0,
    staleTime: MEDIA_ROW_STALE_TIME_MS,
  });
}

export interface SeasonWatchedTarget {
  episode: Episode;
  storedRow?: WatchProgress;
}

// Mirrors `MAX_WATCH_PROGRESS_BATCH_ROWS` in watch_history_commands.rs.
const WATCH_PROGRESS_BATCH_MAX_ROWS = 500;

// Season-level "mark watched": EOF-shaped rows in bounded batch writes. Stamps
// ascend in episode order so recency-ordered surfaces read the last episode
// as the latest watch.
export function useMarkSeasonWatched({ item }: UseToggleEpisodeWatchedOptions) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (targets: readonly SeasonWatchedTarget[]) => {
      if (!item) {
        throw new Error('Media item unavailable');
      }
      const oldestStamp = Date.now() - targets.length;
      const rows = targets.map(({ episode, storedRow }, index) => ({
        ...buildCompletedProgressRow(item, episode, storedRow),
        last_watched: oldestStamp + index + 1,
      }));
      const batches = Array.from(
        { length: Math.ceil(rows.length / WATCH_PROGRESS_BATCH_MAX_ROWS) },
        (_, index) =>
          rows.slice(
            index * WATCH_PROGRESS_BATCH_MAX_ROWS,
            (index + 1) * WATCH_PROGRESS_BATCH_MAX_ROWS,
          ),
      );
      await Promise.all(batches.map((batch) => api.saveWatchProgressBatch(batch)));
    },
    onSuccess: (_data, targets) => {
      notifyAction('Season marked as watched', {
        detail: `${targets.length} episode${targets.length === 1 ? '' : 's'}`,
        thumb: item?.poster,
      });
    },
    onError: (error) => {
      notifyAction('Failed to update watch history', {
        tone: 'error',
        detail: error instanceof Error ? error.message : undefined,
      });
    },
    onSettled: () => {
      void invalidatePlaybackHistoryQueriesForTitle(queryClient, item?.id);
    },
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
