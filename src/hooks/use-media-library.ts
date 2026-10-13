import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import {
  api,
  type Episode,
  type MediaItem,
  type ResumeRailEntry,
  type TitleWatchProgress,
  toMediaItem,
  type UserList,
  type WatchProgress,
  type WatchStatus,
} from '@/lib/api';
import { watchProgressCoordinates } from '@/lib/history-playback';
import { notifyAction } from '@/lib/notify';
import { restoreQueryArrayEntry } from '@/lib/optimistic-query';
import {
  invalidateLibraryQueries,
  invalidateListQueries,
  invalidatePlaybackHistoryQueriesForTitle,
  LIBRARY_QUERY_KEY,
  LISTS_QUERY_KEY,
  LISTS_VIEW_STALE_TIME_MS,
  RESUME_RAIL_QUERY_KEY,
  RESUME_SECTION_MIN_STALE_MS,
  resumeRailQueryKey,
  titleWatchProgressQueryKey,
  TOTAL_WATCH_TIME_QUERY_KEY,
  WATCH_HISTORY_QUERY_KEY,
  WATCH_HISTORY_STALE_TIME_MS,
  WATCH_STATUSES_QUERY_KEY,
} from '@/lib/query-invalidation';
import { formatEpisodeHeading } from '@/lib/utils';

const LIBRARY_STALE_TIME = 1000 * 60 * 5;
const WATCH_STATUSES_STALE_TIME = 1000 * 60 * 5;

// Optimistic status write shared by the details chip group and library toggle.
export function setCachedWatchStatus(
  queryClient: QueryClient,
  itemId: string,
  status: WatchStatus | null,
): void {
  queryClient.setQueryData<Record<string, WatchStatus>>(WATCH_STATUSES_QUERY_KEY, (old) => {
    if (status === null) {
      if (!old || !(itemId in old)) return old;
      const next = { ...old };
      delete next[itemId];
      return next;
    }
    return { ...old, [itemId]: status };
  });
}

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
  itemId?: string;
  previousLibraryItem?: MediaItem;
  previousStatus?: WatchStatus | null;
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

// Undo replays the removed rows as one bounded write; the backend generation
// guard drops any saves that were in flight across the delete.
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

// Shared per-array index built once per fetch, reused by all cards.
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

/// Merged home rail: Rust interleaves continue-watching and Up Next from one
/// snapshot; the channel delivers the local half before schedule fetches resolve.
export function useResumeRail(
  localToday: string | undefined,
  localTodayMs: number | undefined,
  options?: SharedCollectionQueryOptions,
) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: resumeRailQueryKey(localToday),
    queryFn: ({ signal }) => {
      if (!localToday || !localTodayMs) {
        return Promise.reject(new Error('Local day is required to read the resume rail.'));
      }
      const channel = new Channel<ResumeRailEntry[]>();
      // Channel is not an EventTarget — onmessage is its only surface.
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      channel.onmessage = (snapshot) => {
        if (!signal.aborted) {
          queryClient.setQueryData(resumeRailQueryKey(localToday), snapshot);
        }
      };
      return api.getResumeRail(localToday, localTodayMs, channel);
    },
    enabled: (options?.enabled ?? true) && Boolean(localToday) && Boolean(localTodayMs),
    staleTime: options?.staleTime ?? RESUME_SECTION_MIN_STALE_MS,
  });
}

/// Saved playback seconds across canonical episodes.
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

/// Shared key/fn for the per-title resume query so `select` variants never fork the cache.
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

/// Per-title resume snapshot — one indexed read instead of full-history scans.
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
  // `latestEntry` is the backend's `history[0]` pick (`last_watched` DESC).
  const selectLatestEntry = useCallback((progress: TitleWatchProgress) => progress.latestEntry, []);

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
        // `remove_from_library` also clears the status in the same op.
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
      const previousLibraryItem = queryClient
        .getQueryData<MediaItem[]>(LIBRARY_QUERY_KEY)
        ?.find((entry) => entry.id === item.id);

      queryClient.setQueryData<MediaItem[]>(LIBRARY_QUERY_KEY, (old) => {
        if (isInLibrary) {
          return old?.filter((libraryItem) => libraryItem.id !== item.id) ?? [];
        }

        return [...(old ?? []), toMediaItem(item)];
      });

      let previousStatus: WatchStatus | null | undefined;
      if (isInLibrary) {
        // Mirror the status clear so the details chip can't show a stale status.
        await queryClient.cancelQueries({ queryKey: WATCH_STATUSES_QUERY_KEY });
        previousStatus =
          queryClient.getQueryData<Record<string, WatchStatus>>(WATCH_STATUSES_QUERY_KEY)?.[
            item.id
          ] ?? null;
        setCachedWatchStatus(queryClient, item.id, null);
      }

      return { itemId: item.id, previousLibraryItem, previousStatus };
    },
    onError: (_error, _variables, context) => {
      if (context?.itemId !== undefined) {
        restoreQueryArrayEntry(
          queryClient,
          LIBRARY_QUERY_KEY,
          context.itemId,
          context.previousLibraryItem,
        );
        if (context.previousStatus !== undefined) {
          setCachedWatchStatus(queryClient, context.itemId, context.previousStatus);
        }
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
    },
  });
}

interface UseRemoveTitleWatchHistoryOptions extends UseRemoveFromContinueWatchingOptions {
  toastTitle: string;
  errorTitle: string;
}

// Whole-title history delete: collapsed surfaces render one row per title —
// deleting only the displayed row lets it resurface under a different episode.
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

      // Returns the exact removed rows — the Undo snapshot needs no extra read.
      return api.removeAllFromWatchHistory(itemId, normalizedMediaType);
    },
    onMutate: async () => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: [RESUME_RAIL_QUERY_KEY] }),
        queryClient.cancelQueries({ queryKey: WATCH_HISTORY_QUERY_KEY }),
      ]);
      const previousWatchHistory =
        queryClient.getQueryData<WatchProgress[]>(WATCH_HISTORY_QUERY_KEY);
      // The rail cache holds ResumeRailEntry rows keyed per local day; filter all variants.
      queryClient.setQueriesData<ResumeRailEntry[]>(
        { queryKey: [RESUME_RAIL_QUERY_KEY] },
        (rows?: ResumeRailEntry[]) => rows?.filter((entry) => entry.row.id !== itemId),
      );
      queryClient.setQueryData<WatchProgress[]>(WATCH_HISTORY_QUERY_KEY, withoutTitle);
      return {
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
      const removedWatchHistory = context?.removedWatchHistory;
      // The rail order isn't last_watched-sorted; a refetch restores truth.
      void queryClient.invalidateQueries({ queryKey: [RESUME_RAIL_QUERY_KEY] });
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

// Per-title delete for the profile tabs — same whole-title semantics as the rail.
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

// Variables paint instant watched checks; only Rust creates durable rows.
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
        // The mirrored single-row picks follow their source list's rule:
        // resume rows always re-check `keep`; history heads only on unwatch.
        const keepResumeEntry = (row?: WatchProgress) => (row && !keep(row) ? undefined : row);
        const keepHistoryEntry = (row?: WatchProgress) => (watched ? row : keepResumeEntry(row));
        return {
          ...old,
          history: watched ? old.history : old.history.filter(keep),
          continueWatching: old.continueWatching.filter(keep),
          // Unwatch drops episode map rows too; the spoiler ceiling stays stale
          // (over-masking is safe) until Rust rebuilds it.
          episodeProgress: watched
            ? old.episodeProgress
            : Object.fromEntries(
                Object.entries(old.episodeProgress).filter(([, row]) => keep(row)),
              ),
          seriesResumeEntry: keepResumeEntry(old.seriesResumeEntry),
          movieResumeEntry: keepResumeEntry(old.movieResumeEntry),
          latestSeriesEntry: keepHistoryEntry(old.latestSeriesEntry),
          latestMovieEntry: keepHistoryEntry(old.latestMovieEntry),
          latestEntry: keepHistoryEntry(old.latestEntry),
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
    onSettled: (_progress, error) =>
      invalidatePlaybackHistoryQueriesForTitle(queryClient, item?.id, {
        refetchTitleProgress: error != null,
      }),
  });
}

export function useToggleEpisodeWatched({ item }: UseToggleEpisodeWatchedOptions) {
  return useEpisodesWatchedMutation(item, false);
}

export function useMarkSeasonWatched({ item }: UseToggleEpisodeWatchedOptions) {
  return useEpisodesWatchedMutation(item, true);
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
        notifyAction(`Added to "${list.name}"`, {
          detail: buildOtherListsDescription(lists, itemListIds, list.id) ?? item.title,
          thumb: item.poster,
        });
      } catch {
        notifyAction(`List created, but couldn't add "${item.title}"`, {
          detail: `Try adding it to "${list.name}" again.`,
          tone: 'error',
        });
      }
    },
    [item, itemListIds, lists],
  );

  return {
    addItemToNewList,
    toggleLibrary,
    toggleListMembership,
  };
}
