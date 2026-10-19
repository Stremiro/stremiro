import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import {
  api,
  getListErrorMessage,
  type Episode,
  type LibraryFilters,
  type MediaItem,
  type ProfileLibrary,
  type ResumeRailEntry,
  type TitleWatchProgress,
  toMediaItem,
  type UserList,
  type UserListSummary,
  type WatchProgress,
  type WatchStatus,
} from '@/lib/api';
import { bumpWatchProgressEpoch, getWatchProgressEpoch } from '@/lib/api-cache';
import { notifyAction } from '@/lib/notify';
import { reinsertSnapshotRows, restoreQueryArrayEntry } from '@/lib/optimistic-query';
import { resolvePlayerRouteMediaType } from '@/lib/player-navigation';
import {
  invalidateLibraryQueries,
  invalidateListQueries,
  invalidatePlaybackHistoryQueries,
  invalidatePlaybackHistoryQueriesForTitle,
  invalidateWatchStatusQueries,
  LIBRARY_QUERY_KEY,
  LISTS_QUERY_KEY,
  LISTS_VIEW_STALE_TIME_MS,
  listSummariesQueryKey,
  PROFILE_LIBRARY_QUERY_KEY,
  profileLibraryQueryKey,
  RESUME_RAIL_QUERY_KEY,
  RESUME_SECTION_MIN_STALE_MS,
  resumeRailQueryKey,
  titleWatchProgressQueryKey,
  TOTAL_WATCH_TIME_QUERY_KEY,
  WATCH_HISTORY_QUERY_KEY,
  WATCH_HISTORY_STALE_TIME_MS,
  WATCH_STATUSES_QUERY_KEY,
} from '@/lib/query-invalidation';
import { formatEpisodeHeading, isSeriesLikeMediaType } from '@/lib/utils';

const LIBRARY_STALE_TIME = 1000 * 60 * 5;
const WATCH_STATUSES_STALE_TIME = 1000 * 60 * 5;

export function getOwnWatchStatus(
  statuses: Record<string, WatchStatus> | undefined,
  itemId: string,
): WatchStatus | undefined {
  return statuses && Object.hasOwn(statuses, itemId) ? statuses[itemId] : undefined;
}

// Optimistic status write shared by the details chip group and library toggle.
export function setCachedWatchStatus(
  queryClient: QueryClient,
  itemId: string,
  status: WatchStatus | null,
): void {
  queryClient.setQueryData<Record<string, WatchStatus>>(WATCH_STATUSES_QUERY_KEY, (old) => {
    if (!old) return old;
    if (status === null) {
      if (!Object.hasOwn(old, itemId)) return old;
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

interface UseMediaCollectionActionsOptions {
  item?: MediaItem | null;
  isInLibrary: boolean;
}

interface ToggleLibraryMutationContext {
  itemId?: string;
  previousLibraryItem?: MediaItem;
  previousStatus?: WatchStatus | null;
  previousProfileEntries?: ProfileLibraryRemoval[];
}

interface ProfileLibraryRemoval {
  queryKey: QueryKey;
  snapshot: MediaItem[];
  indices: number[];
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

export function useProfileLibrary(filters: LibraryFilters) {
  const isDefault =
    !filters.query &&
    (filters.type ?? 'all') === 'all' &&
    (filters.status ?? 'all') === 'all' &&
    (filters.sort ?? 'default') === 'default';
  return useQuery({
    queryKey: profileLibraryQueryKey(filters),
    queryFn: () => api.getProfileLibrary(filters),
    staleTime: LIBRARY_STALE_TIME,
    gcTime: isDefault ? LIBRARY_STALE_TIME : 60_000,
    placeholderData: (previousData, previousQuery) => {
      const previousFilters = previousQuery?.queryKey[1] as LibraryFilters | undefined;
      // A previous status/type result must never masquerade as the newly selected filter.
      return previousFilters?.status === filters.status && previousFilters?.type === filters.type
        ? previousData
        : undefined;
    },
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
  const enabled = (options?.enabled ?? true) && Boolean(localToday) && Boolean(localTodayMs);
  const fetchGenerationRef = useRef(0);
  const observedRef = useRef(enabled);
  useEffect(() => {
    observedRef.current = enabled;
    return () => {
      observedRef.current = false;
    };
  }, [enabled]);
  return useQuery({
    queryKey: resumeRailQueryKey(localToday),
    // Do not consume signal: the IPC must finish caching after unmount.
    queryFn: () => {
      if (!localToday || !localTodayMs) {
        return Promise.reject(new Error('Local day is required to read the resume rail.'));
      }
      const generation = ++fetchGenerationRef.current;
      const progressEpoch = getWatchProgressEpoch();
      const channel = new Channel<ResumeRailEntry[]>();
      // Channel is not an EventTarget — onmessage is its only surface.
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      channel.onmessage = (snapshot) => {
        if (
          observedRef.current &&
          generation === fetchGenerationRef.current &&
          progressEpoch === getWatchProgressEpoch() &&
          queryClient.getQueryData(resumeRailQueryKey(localToday)) === undefined
        ) {
          queryClient.setQueryData(resumeRailQueryKey(localToday), snapshot);
        }
      };
      return api.getResumeRail(localToday, localTodayMs, channel);
    },
    enabled,
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

export function useListSummaries(itemId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: listSummariesQueryKey(itemId),
    queryFn: () => api.getListSummaries(itemId),
    enabled: options?.enabled,
    staleTime: LISTS_VIEW_STALE_TIME_MS,
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
    (statuses: Record<string, WatchStatus>) =>
      itemId ? (getOwnWatchStatus(statuses, itemId) ?? null) : null,
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

export function useMediaResumeEntry(
  itemId?: string,
  mediaType?: string,
  options?: SharedCollectionQueryOptions,
) {
  const selectResumeEntry = useCallback(
    (progress: TitleWatchProgress) =>
      resolvePlayerRouteMediaType(mediaType) === 'movie'
        ? progress.movieResumeEntry
        : isSeriesLikeMediaType(mediaType)
          ? progress.seriesResumeEntry
          : null,
    [mediaType],
  );

  return useQuery({
    ...titleWatchProgressQuery(itemId, options?.enabled ?? true),
    staleTime: options?.staleTime ?? WATCH_HISTORY_STALE_TIME_MS,
    select: selectResumeEntry,
  });
}

function removeCachedProfileLibraryItems(queryClient: QueryClient, ids: ReadonlySet<string>) {
  const queries = { queryKey: PROFILE_LIBRARY_QUERY_KEY };
  const previous = queryClient
    .getQueriesData<ProfileLibrary>(queries)
    .flatMap(([queryKey, data]) => {
      const indices =
        data?.items.flatMap((entry, index) => (ids.has(entry.id) ? [index] : [])) ?? [];
      return data && indices.length > 0 ? [{ queryKey, snapshot: data.items, indices }] : [];
    });
  queryClient.setQueriesData<ProfileLibrary>(queries, (current) =>
    current ? { ...current, items: current.items.filter((entry) => !ids.has(entry.id)) } : current,
  );
  return previous;
}

function restoreCachedProfileLibraryItems(
  queryClient: QueryClient,
  previous: ProfileLibraryRemoval[],
) {
  for (const { queryKey, snapshot, indices } of previous) {
    queryClient.setQueryData<ProfileLibrary>(queryKey, (current) =>
      current
        ? {
            ...current,
            items: reinsertSnapshotRows(current.items, snapshot, indices, (row) => row.id),
          }
        : current,
    );
  }
}

export function useToggleLibraryItem(options: UseToggleLibraryItemOptions) {
  const queryClient = useQueryClient();

  const mutation = useMutation<
    'added' | 'removed',
    unknown,
    UseToggleLibraryItemOptions,
    ToggleLibraryMutationContext
  >({
    mutationFn: async ({ item, isInLibrary }) => {
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
    onMutate: async ({ item, isInLibrary }) => {
      if (!item) {
        return {};
      }

      await Promise.all([
        queryClient.cancelQueries({ queryKey: LIBRARY_QUERY_KEY }),
        ...(isInLibrary
          ? [
              queryClient.cancelQueries({ queryKey: PROFILE_LIBRARY_QUERY_KEY }),
              queryClient.cancelQueries({ queryKey: WATCH_STATUSES_QUERY_KEY }),
            ]
          : []),
      ]);
      const previousLibraryItem = queryClient
        .getQueryData<MediaItem[]>(LIBRARY_QUERY_KEY)
        ?.find((entry) => entry.id === item.id);
      const previousProfileEntries = isInLibrary
        ? removeCachedProfileLibraryItems(queryClient, new Set([item.id]))
        : [];

      queryClient.setQueryData<MediaItem[]>(LIBRARY_QUERY_KEY, (old) => {
        if (!old) return old;
        if (isInLibrary) {
          return old.filter((libraryItem) => libraryItem.id !== item.id);
        }

        return [...old, toMediaItem(item)];
      });

      let previousStatus: WatchStatus | null | undefined;
      if (isInLibrary) {
        // Mirror the status clear so the details chip can't show a stale status.
        previousStatus =
          getOwnWatchStatus(
            queryClient.getQueryData<Record<string, WatchStatus>>(WATCH_STATUSES_QUERY_KEY),
            item.id,
          ) ?? null;
        setCachedWatchStatus(queryClient, item.id, null);
      }

      return { itemId: item.id, previousLibraryItem, previousStatus, previousProfileEntries };
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
        restoreCachedProfileLibraryItems(queryClient, context.previousProfileEntries ?? []);
      }

      notifyAction('Failed to update library', { tone: 'error' });
    },
    onSuccess: (action, { item }) => {
      if (!item) {
        return;
      }

      notifyAction(action === 'added' ? 'Added to Library' : 'Removed from Library', {
        detail: item.title,
        thumb: item.poster,
      });
    },
    // Removal clears the title's watch status; adding leaves it untouched.
    onSettled: (_action, _error, { isInLibrary }) =>
      invalidateLibraryQueries(queryClient, { watchStatusChanged: isInLibrary }),
  });

  return {
    ...mutation,
    mutate: () => mutation.mutate(options),
    mutateAsync: () => mutation.mutateAsync(options),
  };
}

function filterUnseenMediaItems(items: MediaItem[], ids: Set<string>): MediaItem[] {
  return items.filter((item) => {
    if (ids.has(item.id)) return false;
    ids.add(item.id);
    return true;
  });
}

function appendMissingMediaItems(current: MediaItem[], items: MediaItem[]): MediaItem[] {
  const added = filterUnseenMediaItems(items, new Set(current.map((item) => item.id)));
  return added.length > 0 ? [...current, ...added.map(toMediaItem)] : current;
}

function restoreSelectedLibraryItems(
  queryClient: QueryClient,
  ids: string[],
  previousLibrary: MediaItem[],
) {
  if (ids.length === 0) return;
  const selectedIds = new Set(ids);
  const previousLibraryById = new Map<string, MediaItem>();
  for (const item of previousLibrary) {
    if (!previousLibraryById.has(item.id)) previousLibraryById.set(item.id, item);
  }
  queryClient.setQueryData<MediaItem[]>(LIBRARY_QUERY_KEY, (current) => {
    const missingIds = new Set(selectedIds);
    const restored: MediaItem[] = [];
    for (const entry of current ?? []) {
      if (!selectedIds.has(entry.id)) {
        restored.push(entry);
        continue;
      }
      missingIds.delete(entry.id);
      const previous = previousLibraryById.get(entry.id);
      if (previous) restored.push(previous);
    }
    for (const id of missingIds) {
      const previous = previousLibraryById.get(id);
      if (previous) restored.push(previous);
    }
    return current === undefined && restored.length === 0 ? current : restored;
  });
}

function restoreSelectedWatchStatuses(
  queryClient: QueryClient,
  ids: string[],
  previousStatuses: Record<string, WatchStatus>,
) {
  queryClient.setQueryData<Record<string, WatchStatus>>(WATCH_STATUSES_QUERY_KEY, (current) => {
    if (!current && !ids.some((id) => getOwnWatchStatus(previousStatuses, id) != null))
      return current;
    const next = { ...current };
    for (const id of ids) {
      const status = getOwnWatchStatus(previousStatuses, id) ?? null;
      if (status === null) delete next[id];
      else next[id] = status;
    }
    return next;
  });
}

export function useBulkRemoveFromLibrary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.bulkRemoveFromLibrary(ids),
    onMutate: async (ids) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: LIBRARY_QUERY_KEY }),
        queryClient.cancelQueries({ queryKey: PROFILE_LIBRARY_QUERY_KEY }),
        queryClient.cancelQueries({ queryKey: WATCH_STATUSES_QUERY_KEY }),
      ]);
      const previousLibrary = queryClient.getQueryData<MediaItem[]>(LIBRARY_QUERY_KEY) ?? [];
      const previousStatuses =
        queryClient.getQueryData<Record<string, WatchStatus>>(WATCH_STATUSES_QUERY_KEY) ?? {};
      const removedIds = new Set(ids);
      const previousProfileEntries = removeCachedProfileLibraryItems(queryClient, removedIds);
      queryClient.setQueryData<MediaItem[]>(
        LIBRARY_QUERY_KEY,
        previousLibrary.filter((item) => !removedIds.has(item.id)),
      );
      queryClient.setQueryData<Record<string, WatchStatus>>(
        WATCH_STATUSES_QUERY_KEY,
        Object.fromEntries(Object.entries(previousStatuses).filter(([id]) => !removedIds.has(id))),
      );
      return { previousLibrary, previousStatuses, previousProfileEntries };
    },
    onError: (_error, ids, context) => {
      if (!context) return;
      restoreSelectedLibraryItems(queryClient, ids, context.previousLibrary);
      restoreCachedProfileLibraryItems(queryClient, context.previousProfileEntries);
      restoreSelectedWatchStatuses(queryClient, ids, context.previousStatuses);
    },
    onSettled: () => invalidateLibraryQueries(queryClient),
  });
}

export function useBulkSetWatchStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, status }: { ids: string[]; status: WatchStatus | null }) =>
      api.bulkSetWatchStatus(ids, status),
    onMutate: async ({ ids, status }) => {
      await queryClient.cancelQueries({ queryKey: WATCH_STATUSES_QUERY_KEY });
      const previousStatuses =
        queryClient.getQueryData<Record<string, WatchStatus>>(WATCH_STATUSES_QUERY_KEY) ?? {};
      const nextStatuses = { ...previousStatuses };
      for (const id of ids) {
        if (status === null) delete nextStatuses[id];
        else nextStatuses[id] = status;
      }
      queryClient.setQueryData(WATCH_STATUSES_QUERY_KEY, nextStatuses);
      return { previousStatuses };
    },
    onError: (_error, { ids }, context) => {
      if (!context) return;
      restoreSelectedWatchStatuses(queryClient, ids, context.previousStatuses);
    },
    onSettled: () => invalidateWatchStatusQueries(queryClient),
  });
}

export function useBulkAddToList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ listId, itemIds }: { listId: string; itemIds: string[] }) =>
      api.bulkAddToList(listId, itemIds),
    onMutate: async ({ listId, itemIds }) => {
      const selectedIds = new Set(itemIds);
      const items = (queryClient.getQueryData<MediaItem[]>(LIBRARY_QUERY_KEY) ?? []).filter(
        (item) => selectedIds.has(item.id),
      );
      await queryClient.cancelQueries({ queryKey: LISTS_QUERY_KEY });
      const previousLists = queryClient.getQueryData<UserList[]>(LISTS_QUERY_KEY) ?? [];
      queryClient.setQueryData<UserList[]>(
        LISTS_QUERY_KEY,
        previousLists.map((list) => {
          if (list.id !== listId) return list;
          const additions = filterUnseenMediaItems(items, new Set(list.item_ids));
          return {
            ...list,
            item_ids: [...list.item_ids, ...additions.map((item) => item.id)],
            items: appendMissingMediaItems(list.items ?? [], additions),
          };
        }),
      );
      return { previousList: previousLists.find((list) => list.id === listId), selectedIds };
    },
    onError: (_error, { listId }, context) => {
      const previousList = context?.previousList;
      if (!previousList) return;
      const previousIds = new Set(previousList.item_ids);
      const addedIds = new Set([...context.selectedIds].filter((id) => !previousIds.has(id)));
      queryClient.setQueryData<UserList[]>(LISTS_QUERY_KEY, (current) =>
        current?.map((list) =>
          list.id === listId
            ? {
                ...list,
                item_ids: list.item_ids.filter((id) => !addedIds.has(id)),
                items: list.items?.filter((entry) => !addedIds.has(entry.id)),
              }
            : list,
        ),
      );
    },
    onSettled: () => invalidateListQueries(queryClient),
  });
}

export function useBulkRemoveFromList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ listId, itemIds }: { listId: string; itemIds: string[] }) =>
      api.bulkRemoveFromList(listId, itemIds),
    onMutate: async ({ listId, itemIds }) => {
      await queryClient.cancelQueries({ queryKey: LISTS_QUERY_KEY });
      const previous = queryClient
        .getQueryData<UserList[]>(LISTS_QUERY_KEY)
        ?.find((list) => list.id === listId);
      const ids = new Set(itemIds);
      queryClient.setQueryData<UserList[]>(LISTS_QUERY_KEY, (lists) =>
        lists?.map((list) =>
          list.id === listId
            ? {
                ...list,
                item_ids: list.item_ids.filter((id) => !ids.has(id)),
                items: list.items?.filter((item) => !ids.has(item.id)),
              }
            : list,
        ),
      );
      return { previous, ids };
    },
    onError: (error, { listId }, context) => {
      const previous = context?.previous;
      if (previous) {
        const indices = previous.item_ids.flatMap((id, index) =>
          context.ids.has(id) ? [index] : [],
        );
        const itemIndices =
          previous.items?.flatMap((item, index) => (context.ids.has(item.id) ? [index] : [])) ?? [];
        queryClient.setQueryData<UserList[]>(LISTS_QUERY_KEY, (lists) =>
          lists?.map((list) =>
            list.id === listId
              ? {
                  ...list,
                  item_ids: reinsertSnapshotRows(
                    list.item_ids,
                    previous.item_ids,
                    indices,
                    (id) => id,
                  ),
                  items: reinsertSnapshotRows(
                    list.items ?? [],
                    previous.items ?? [],
                    itemIndices,
                    (item) => item.id,
                  ),
                }
              : list,
          ),
        );
      }
      toast.error(getListErrorMessage(error) ?? 'Failed to remove titles from list');
    },
    onSuccess: (entries, { listId }) => {
      toast.success(`Removed ${entries.length} title${entries.length === 1 ? '' : 's'} from list`, {
        duration: WATCH_HISTORY_UNDO_DURATION_MS,
        ...(entries.length > 0 && {
          action: {
            label: 'Undo',
            onClick: () => {
              void (async () => {
                try {
                  await api.restoreListItems(listId, entries);
                } catch (error) {
                  toast.error(getListErrorMessage(error) ?? 'Could not restore list titles');
                } finally {
                  await invalidateListQueries(queryClient);
                }
              })();
            },
          },
        }),
      });
    },
    onSettled: () => invalidateListQueries(queryClient),
  });
}

export function useBulkRemoveFromWatchHistory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (items: { id: string; type: string }[]) => api.bulkRemoveFromWatchHistory(items),
    onMutate: async (items) => {
      bumpWatchProgressEpoch();
      await Promise.all([
        queryClient.cancelQueries({ queryKey: WATCH_HISTORY_QUERY_KEY }),
        queryClient.cancelQueries({ queryKey: [RESUME_RAIL_QUERY_KEY] }),
      ]);
      const ids = new Set(items.map((item) => `${item.type}:${item.id}`));
      const matches = (row: WatchProgress) => ids.has(`${row.type_}:${row.id}`);
      const history = queryClient.getQueryData<WatchProgress[]>(WATCH_HISTORY_QUERY_KEY);
      const historyIndices = history?.flatMap((row, index) => (matches(row) ? [index] : [])) ?? [];
      const rail = queryClient
        .getQueriesData<ResumeRailEntry[]>({ queryKey: [RESUME_RAIL_QUERY_KEY] })
        .map(([queryKey, snapshot = []]) => ({
          queryKey,
          snapshot,
          indices: snapshot.flatMap((entry, index) => (matches(entry.row) ? [index] : [])),
        }));
      queryClient.setQueryData<WatchProgress[]>(WATCH_HISTORY_QUERY_KEY, (rows) =>
        rows?.filter((row) => !matches(row)),
      );
      queryClient.setQueriesData<ResumeRailEntry[]>({ queryKey: [RESUME_RAIL_QUERY_KEY] }, (rows) =>
        rows?.filter((entry) => !matches(entry.row)),
      );
      return { history, historyIndices, rail };
    },
    onError: (_error, _items, context) => {
      if (context?.history) {
        queryClient.setQueryData<WatchProgress[]>(WATCH_HISTORY_QUERY_KEY, (rows) =>
          reinsertSnapshotRows(
            rows ?? [],
            context.history!,
            context.historyIndices,
            (row) => `${row.type_}:${row.id}`,
          ),
        );
      }
      for (const { queryKey, snapshot, indices } of context?.rail ?? []) {
        queryClient.setQueryData<ResumeRailEntry[]>(queryKey, (rows) =>
          reinsertSnapshotRows(rows ?? [], snapshot, indices, resumeRailEntryKey),
        );
      }
      toast.error('Failed to remove titles from history');
    },
    onSuccess: (rows, items) => {
      toast.success(`Removed ${items.length} title${items.length === 1 ? '' : 's'} from history`, {
        duration: WATCH_HISTORY_UNDO_DURATION_MS,
        ...(rows.length > 0 && {
          action: {
            label: 'Undo',
            onClick: () => {
              void (async () => {
                try {
                  await api.saveWatchProgressBatch(rows);
                } catch {
                  toast.error('Could not restore watch history');
                } finally {
                  await invalidatePlaybackHistoryQueries(queryClient);
                }
              })();
            },
          },
        }),
      });
    },
    onSettled: () => invalidatePlaybackHistoryQueries(queryClient),
  });
}

interface UseRemoveTitleWatchHistoryOptions extends UseRemoveFromContinueWatchingOptions {
  toastTitle: string;
  errorTitle: string;
}

function resumeRailEntryKey({ row }: ResumeRailEntry): string {
  return `${row.type_}:${row.id}:${row.season ?? ''}:${row.episode ?? ''}`;
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
  const normalizedMediaType = mediaType?.trim();
  const matchesTitle = (entry: WatchProgress) =>
    entry.id === itemId && entry.type_ === normalizedMediaType;
  const withoutTitle = (rows?: WatchProgress[]) => rows?.filter((entry) => !matchesTitle(entry));

  return useMutation({
    mutationFn: async () => {
      if (!normalizedMediaType) {
        throw new Error('Playback history metadata unavailable');
      }

      // Returns the exact removed rows — the Undo snapshot needs no extra read.
      return api.removeAllFromWatchHistory(itemId, normalizedMediaType);
    },
    onMutate: async () => {
      bumpWatchProgressEpoch();
      await Promise.all([
        queryClient.cancelQueries({ queryKey: [RESUME_RAIL_QUERY_KEY] }),
        queryClient.cancelQueries({ queryKey: WATCH_HISTORY_QUERY_KEY }),
      ]);
      const previousWatchHistory =
        queryClient.getQueryData<WatchProgress[]>(WATCH_HISTORY_QUERY_KEY);
      const historyIndices =
        previousWatchHistory?.flatMap((row, index) => (matchesTitle(row) ? [index] : [])) ?? [];
      const removedResumeEntries = queryClient
        .getQueriesData<ResumeRailEntry[]>({ queryKey: [RESUME_RAIL_QUERY_KEY] })
        .map(([queryKey, rows = []]) => ({
          queryKey,
          snapshot: rows,
          indices: rows.flatMap((entry, index) => (matchesTitle(entry.row) ? [index] : [])),
        }));
      // The rail cache holds ResumeRailEntry rows keyed per local day; filter all variants.
      queryClient.setQueriesData<ResumeRailEntry[]>(
        { queryKey: [RESUME_RAIL_QUERY_KEY] },
        (rows?: ResumeRailEntry[]) => rows?.filter((entry) => !matchesTitle(entry.row)),
      );
      queryClient.setQueryData<WatchProgress[]>(WATCH_HISTORY_QUERY_KEY, withoutTitle);
      return {
        previousWatchHistory,
        historyIndices,
        removedResumeEntries,
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
      const previousWatchHistory = context?.previousWatchHistory;
      if (previousWatchHistory !== undefined) {
        queryClient.setQueryData<WatchProgress[]>(WATCH_HISTORY_QUERY_KEY, (current) =>
          reinsertSnapshotRows(
            current ?? [],
            previousWatchHistory,
            context?.historyIndices ?? [],
            (row) => `${row.type_}:${row.id}`,
          ),
        );
      }
      for (const { queryKey, snapshot, indices } of context?.removedResumeEntries ?? []) {
        if (indices.length === 0) continue;
        queryClient.setQueryData<ResumeRailEntry[]>(queryKey, (current) =>
          !current || current.some((entry) => matchesTitle(entry.row))
            ? current
            : reinsertSnapshotRows(current, snapshot, indices, resumeRailEntryKey),
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
    toastTitle: 'Removed from watch history',
    errorTitle: 'Failed to remove from Continue Watching',
  });
}

// Per-title delete for the profile tabs — same whole-title semantics as the rail.
export function useRemoveFromWatchHistory(options: UseRemoveFromContinueWatchingOptions) {
  return useRemoveTitleWatchHistory({
    ...options,
    toastTitle: 'Removed from watch history',
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
      const targetCoords = new Set(
        episodes.map((episode) => `${episode.season}:${episode.episode}`),
      );
      const keep = (row: WatchProgress) => {
        return !(
          row.id === item?.id &&
          row.absolute_season != null &&
          row.absolute_episode != null &&
          targetCoords.has(`${row.absolute_season}:${row.absolute_episode}`)
        );
      };
      // The selected single-row picks follow their source list's rule:
      // resume rows always re-check `keep`; history heads only on unwatch.
      const keepResumeEntry = (row?: WatchProgress) => (row && !keep(row) ? undefined : row);
      const keepHistoryEntry = (row?: WatchProgress) => (watched ? row : keepResumeEntry(row));
      queryClient.setQueryData<TitleWatchProgress>(progressKey, (old) => {
        if (!old) return old;
        return {
          ...old,
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

const listMembershipReconciliationTimers = new WeakMap<
  QueryClient,
  ReturnType<typeof setTimeout>
>();

export function useMediaCollectionActions({ item, isInLibrary }: UseMediaCollectionActionsOptions) {
  const queryClient = useQueryClient();
  const toggleLibrary = useToggleLibraryItem({ item, isInLibrary });
  const summariesKey = listSummariesQueryKey(item?.id);
  const membershipMutationKey = ['list-membership', item?.id] as const;
  const pendingListIds = useMutationState({
    filters: { mutationKey: membershipMutationKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as UserListSummary).id,
  });

  const toggleListMembership = useMutation({
    mutationKey: membershipMutationKey,
    mutationFn: async (list: UserListSummary) => {
      if (!item) throw new Error('Media item unavailable');
      if (list.contains_item) {
        await api.removeFromList(list.id, item.id);
        return { action: 'removed' as const, list };
      }

      await api.addToList(list.id, item);
      return { action: 'added' as const, list };
    },
    onMutate: async (list) => {
      await queryClient.cancelQueries({ queryKey: summariesKey, exact: true });
      const previous = queryClient
        .getQueryData<UserListSummary[]>(summariesKey)
        ?.find((summary) => summary.id === list.id);
      queryClient.setQueryData<UserListSummary[]>(summariesKey, (old) =>
        old?.map((summary) =>
          summary.id === list.id
            ? {
                ...summary,
                contains_item: !list.contains_item,
                item_count: summary.item_count + (list.contains_item ? -1 : 1),
              }
            : summary,
        ),
      );
      return { previous };
    },
    onSuccess: ({ action, list }) => {
      if (!item) return;
      if (action === 'added') {
        notifyAction(`Added to "${list.name}"`, {
          detail: item.title,
          thumb: item.poster,
        });
        return;
      }

      notifyAction(`Removed from "${list.name}"`, { detail: item.title, thumb: item.poster });
    },
    onError: (error, list, context) => {
      const previous = context?.previous;
      if (previous) {
        queryClient.setQueryData<UserListSummary[]>(summariesKey, (old) =>
          old?.map((summary) => (summary.id === list.id ? previous : summary)),
        );
      }
      notifyAction('Failed to update list', {
        tone: 'error',
        detail: getListErrorMessage(error),
      });
    },
    onSettled: () => {
      // TanStack still counts this mutation as pending here; coalesce after settlement.
      clearTimeout(listMembershipReconciliationTimers.get(queryClient));
      listMembershipReconciliationTimers.set(
        queryClient,
        setTimeout(() => {
          listMembershipReconciliationTimers.delete(queryClient);
          if (queryClient.isMutating({ mutationKey: ['list-membership'] }) === 0) {
            void invalidateListQueries(queryClient);
          }
        }, 0),
      );
    },
  });

  const addItemToNewList = useCallback(
    async (list: UserList) => {
      if (!item || list.rules) return;
      try {
        const summary = await api.addToList(list.id, item);
        queryClient.setQueryData<UserListSummary[]>(listSummariesQueryKey(item.id), (old) => {
          return old?.some((entry) => entry.id === list.id)
            ? old.map((entry) => (entry.id === list.id ? summary : entry))
            : [...(old ?? []), summary];
        });
        notifyAction(`Added to "${list.name}"`, {
          detail: item.title,
          thumb: item.poster,
        });
      } catch (error) {
        notifyAction(`List created, but couldn't add "${item.title}"`, {
          detail: getListErrorMessage(error) ?? `Try adding it to "${list.name}" again.`,
          tone: 'error',
        });
      }
    },
    [item, queryClient],
  );

  return {
    addItemToNewList,
    toggleLibrary,
    toggleListMembership,
    pendingListIds,
  };
}
