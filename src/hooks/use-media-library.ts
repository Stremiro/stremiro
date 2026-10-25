import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
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
  LIBRARY_QUERY_KEY,
  LISTS_QUERY_KEY,
  LIST_SUMMARIES_QUERY_KEY,
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
import { formatEpisodeHeading, isSeriesLikeMediaType, pluralize } from '@/lib/utils';

const LIBRARY_STALE_TIME = 1000 * 60 * 5;
const WATCH_STATUSES_STALE_TIME = 1000 * 60 * 5;

export function getOwnWatchStatus(
  statuses: Record<string, WatchStatus> | undefined,
  itemId: string,
): WatchStatus | undefined {
  return statuses && Object.hasOwn(statuses, itemId) ? statuses[itemId] : undefined;
}

function patchCachedWatchStatuses(
  queryClient: QueryClient,
  ids: Iterable<string>,
  statusFor: (id: string) => WatchStatus | null,
): void {
  queryClient.setQueryData<Record<string, WatchStatus>>(WATCH_STATUSES_QUERY_KEY, (old) => {
    if (!old) return old;
    let next = old;
    for (const id of ids) {
      const status = statusFor(id);
      if ((getOwnWatchStatus(next, id) ?? null) === status) continue;
      if (next === old) next = { ...old };
      if (status === null) delete next[id];
      else next[id] = status;
    }
    return next;
  });
}

// Optimistic status write shared by the details chip group and library toggle.
export function setCachedWatchStatus(
  queryClient: QueryClient,
  itemId: string,
  status: WatchStatus | null,
): void {
  patchCachedWatchStatuses(queryClient, [itemId], () => status);
}

interface SharedCollectionQueryOptions {
  enabled?: boolean;
  staleTime?: number;
}

interface UseMediaCollectionActionsOptions {
  item?: MediaItem | null;
  isInLibrary: boolean;
}

interface ListMembershipVariables {
  item?: MediaItem | null;
  list: UserListSummary;
}

interface ToggleLibraryMutationContext {
  itemId?: string;
  previousLibraryItem?: MediaItem;
  removal?: LibraryRemovalSnapshot;
}

interface ProfileLibraryRemoval {
  queryKey: QueryKey;
  snapshot: MediaItem[];
  allIds: string[];
}

interface LibraryRemovalSnapshot {
  ids: ReadonlySet<string>;
  previousLibrary: MediaItem[];
  previousStatuses: Record<string, WatchStatus>;
  previousProfileEntries: ProfileLibraryRemoval[];
}

interface UseRemoveFromContinueWatchingOptions {
  itemId: string;
  itemTitle?: string;
  mediaType?: string | null;
}

// Undo replays the removed rows as one bounded write; the backend generation
// guard drops any saves that were in flight across the delete.
async function restoreWatchProgressRows(rows: WatchProgress[], invalidate: () => Promise<void>) {
  try {
    await api.saveWatchProgressBatch(rows);
  } catch {
    toast.error('Could not restore watch history');
  } finally {
    await invalidate();
  }
}

// Re-deletes what the mark created, then replays the rows it replaced or removed.
async function revertEpisodesWatched(
  item: MediaItem,
  episodes: readonly Episode[],
  watched: boolean,
  previousRows: WatchProgress[],
  invalidate: () => Promise<void>,
) {
  try {
    if (watched) await api.setEpisodesWatched(item, episodes, false);
    if (previousRows.length > 0) await api.saveWatchProgressBatch(previousRows);
  } catch {
    toast.error('Could not undo the season change');
  } finally {
    await invalidate();
  }
}

async function restoreContinueWatchingTitle(
  id: string,
  type: string,
  refreshRail: () => Promise<void>,
) {
  try {
    await api.setContinueWatchingDismissed(id, type, false);
  } catch {
    toast.error('Could not restore Continue Watching');
  } finally {
    await refreshRail();
  }
}

const WATCH_HISTORY_UNDO_DURATION_MS = 6000;

function toastRemovedWithUndo(
  message: string,
  canUndo: boolean,
  undo: () => Promise<void>,
  description?: string,
) {
  toast.success(message, {
    description,
    duration: WATCH_HISTORY_UNDO_DURATION_MS,
    ...(canUndo && { action: { label: 'Undo', onClick: () => void undo() } }),
  });
}

interface CachedHistoryRemoval {
  matches: (row: WatchProgress) => boolean;
  history: WatchProgress[] | undefined;
  rail: { queryKey: QueryKey; snapshot: ResumeRailEntry[] }[];
}

// `railOnly` hides a title from Continue Watching while its history stays.
async function removeCachedWatchHistory(
  queryClient: QueryClient,
  matches: (row: WatchProgress) => boolean,
  railOnly = false,
): Promise<CachedHistoryRemoval> {
  if (!railOnly) bumpWatchProgressEpoch();
  await Promise.all([
    queryClient.cancelQueries({ queryKey: [RESUME_RAIL_QUERY_KEY] }),
    !railOnly && queryClient.cancelQueries({ queryKey: WATCH_HISTORY_QUERY_KEY }),
  ]);
  const history = railOnly
    ? undefined
    : queryClient.getQueryData<WatchProgress[]>(WATCH_HISTORY_QUERY_KEY);
  // The rail cache holds one entry list per local day; filter every variant.
  const rail = queryClient
    .getQueriesData<ResumeRailEntry[]>({ queryKey: [RESUME_RAIL_QUERY_KEY] })
    .map(([queryKey, snapshot = []]) => ({
      queryKey,
      snapshot,
    }));
  if (!railOnly) {
    queryClient.setQueryData<WatchProgress[]>(WATCH_HISTORY_QUERY_KEY, (rows) =>
      rows?.filter((row) => !matches(row)),
    );
  }
  queryClient.setQueriesData<ResumeRailEntry[]>({ queryKey: [RESUME_RAIL_QUERY_KEY] }, (rows) =>
    rows?.filter((entry) => !matches(entry.row)),
  );
  return { matches, history, rail };
}

/** Whole-title identity shared by history removal and history selection. */
export function watchTitleKey(row: Pick<WatchProgress, 'id' | 'type_'>): string {
  return `${row.type_}:${row.id}`;
}

function restoreCachedWatchHistory(
  queryClient: QueryClient,
  context: CachedHistoryRemoval | undefined,
) {
  if (!context) return;
  const { matches, history, rail } = context;
  const matchesEntry = (entry: ResumeRailEntry) => matches(entry.row);
  if (history) {
    queryClient.setQueryData<WatchProgress[]>(WATCH_HISTORY_QUERY_KEY, (rows) =>
      reinsertSnapshotRows(rows ?? [], history, matches, watchTitleKey),
    );
  }
  for (const { queryKey, snapshot } of rail) {
    if (!snapshot.some(matchesEntry)) continue;
    // A refetch that already surfaced the title owns the rail entry.
    queryClient.setQueryData<ResumeRailEntry[]>(queryKey, (current) => {
      if (!current) return current;
      const presentTitles = new Set(current.map(({ row }) => watchTitleKey(row)));
      return reinsertSnapshotRows(
        current,
        snapshot,
        (entry) => matchesEntry(entry) && !presentTitles.has(watchTitleKey(entry.row)),
        resumeRailEntryKey,
      );
    });
  }
}

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

export function useProfileLibrary(filters: LibraryFilters, options?: { enabled?: boolean }) {
  const isDefault =
    !filters.query &&
    (filters.type ?? 'all') === 'all' &&
    (filters.status ?? 'all') === 'all' &&
    (filters.sort ?? 'default') === 'default';
  return useQuery({
    queryKey: profileLibraryQueryKey(filters),
    queryFn: () => api.getProfileLibrary(filters),
    enabled: options?.enabled,
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
  return useQuery({
    queryKey: resumeRailQueryKey(localToday),
    // Keep caching after unmount; only the current fetch may publish channel snapshots.
    queryFn: () => {
      if (!localToday || !localTodayMs) {
        return Promise.reject(new Error('Local day is required to read the resume rail.'));
      }
      const query = queryClient.getQueryCache().find({
        queryKey: resumeRailQueryKey(localToday),
        exact: true,
      });
      const request = query?.promise;
      const progressEpoch = getWatchProgressEpoch();
      const channel = new Channel<ResumeRailEntry[]>();
      // Channel is not an EventTarget — onmessage is its only surface.
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      channel.onmessage = (snapshot) => {
        if (
          query?.promise === request &&
          query?.state.fetchStatus === 'fetching' &&
          progressEpoch === getWatchProgressEpoch() &&
          queryClient.getQueryData(resumeRailQueryKey(localToday)) === undefined
        ) {
          queryClient.setQueryData(resumeRailQueryKey(localToday), snapshot);
        }
      };
      return api.getResumeRail(localToday, localTodayMs, channel).finally(() => {
        // eslint-disable-next-line unicorn/prefer-add-event-listener
        channel.onmessage = () => undefined;
      });
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
  return useQuery({
    queryKey: LIBRARY_QUERY_KEY,
    queryFn: api.getLibrary,
    enabled: (options?.enabled ?? true) && Boolean(itemId),
    staleTime: options?.staleTime ?? LIBRARY_STALE_TIME,
    select: (library: MediaItem[]) => Boolean(itemId && getLibraryIdSet(library).has(itemId)),
  });
}

/// Library toggle state for cards and the hero; a known override skips the membership query.
export function useLibraryMembership(itemId?: string, override?: boolean) {
  const { data, isError } = useIsItemInLibrary(itemId, { enabled: override === undefined });
  const isInLibrary = override ?? data ?? false;
  const libraryReady = override !== undefined || data !== undefined;
  const libraryActionLabel = libraryReady
    ? isInLibrary
      ? 'Remove from Library'
      : 'Add to Library'
    : isError
      ? 'Library unavailable'
      : 'Loading Library…';
  return { isInLibrary, libraryActionLabel, libraryError: isError, libraryReady };
}

export function useItemWatchStatus(itemId?: string, options?: SharedCollectionQueryOptions) {
  return useQuery({
    queryKey: WATCH_STATUSES_QUERY_KEY,
    queryFn: api.getAllWatchStatuses,
    enabled: (options?.enabled ?? true) && Boolean(itemId),
    staleTime: options?.staleTime ?? WATCH_STATUSES_STALE_TIME,
    select: (statuses: Record<string, WatchStatus>) =>
      itemId ? (getOwnWatchStatus(statuses, itemId) ?? null) : null,
  });
}

export function useMediaResumeEntry(
  itemId?: string,
  mediaType?: string,
  options?: SharedCollectionQueryOptions,
) {
  return useQuery({
    ...titleWatchProgressQuery(itemId, options?.enabled ?? true),
    staleTime: options?.staleTime ?? WATCH_HISTORY_STALE_TIME_MS,
    select: (progress: TitleWatchProgress) =>
      resolvePlayerRouteMediaType(mediaType) === 'movie'
        ? progress.movieResumeEntry
        : isSeriesLikeMediaType(mediaType)
          ? progress.seriesResumeEntry
          : null,
  });
}

export function removeCachedProfileLibraryItems(
  queryClient: QueryClient,
  ids: ReadonlySet<string>,
) {
  const queries = { queryKey: PROFILE_LIBRARY_QUERY_KEY };
  const previous = queryClient
    .getQueriesData<ProfileLibrary>(queries)
    .flatMap(([queryKey, data]) =>
      data?.allIds.some((id) => ids.has(id))
        ? [{ queryKey, snapshot: data.items, allIds: data.allIds }]
        : [],
    );
  queryClient.setQueriesData<ProfileLibrary>(queries, (current) =>
    current
      ? {
          ...current,
          items: current.items.filter((entry) => !ids.has(entry.id)),
          allIds: current.allIds.filter((id) => !ids.has(id)),
        }
      : current,
  );
  return previous;
}

function restoreCachedProfileLibraryItems(
  queryClient: QueryClient,
  previous: ProfileLibraryRemoval[],
  ids: ReadonlySet<string>,
) {
  const matchesItem = (row: MediaItem) => ids.has(row.id);
  const matchesId = (id: string) => ids.has(id);
  for (const { queryKey, snapshot, allIds } of previous) {
    queryClient.setQueryData<ProfileLibrary>(queryKey, (current) =>
      current
        ? {
            ...current,
            items: reinsertSnapshotRows(current.items, snapshot, matchesItem, (row) => row.id),
            allIds: reinsertSnapshotRows(current.allIds, allIds, matchesId, (id) => id),
          }
        : current,
    );
  }
}

export function setCachedLibraryMembership(
  queryClient: QueryClient,
  item: MediaItem,
  saved: boolean,
) {
  queryClient.setQueryData<MediaItem[]>(LIBRARY_QUERY_KEY, (old) => {
    if (!old) return old;
    if (!saved) return old.filter((entry) => entry.id !== item.id);
    return old.some((entry) => entry.id === item.id)
      ? old.map((entry) => (entry.id === item.id ? toMediaItem(item) : entry))
      : [...old, toMediaItem(item)];
  });
}

async function removeCachedLibraryItems(
  queryClient: QueryClient,
  ids: ReadonlySet<string>,
): Promise<LibraryRemovalSnapshot> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: LIBRARY_QUERY_KEY }),
    queryClient.cancelQueries({ queryKey: PROFILE_LIBRARY_QUERY_KEY }),
    queryClient.cancelQueries({ queryKey: WATCH_STATUSES_QUERY_KEY }),
  ]);
  const previousLibrary = queryClient.getQueryData<MediaItem[]>(LIBRARY_QUERY_KEY) ?? [];
  const previousStatuses =
    queryClient.getQueryData<Record<string, WatchStatus>>(WATCH_STATUSES_QUERY_KEY) ?? {};
  const previousProfileEntries = removeCachedProfileLibraryItems(queryClient, ids);
  queryClient.setQueryData<MediaItem[]>(LIBRARY_QUERY_KEY, (current) =>
    current?.filter((item) => !ids.has(item.id)),
  );
  patchCachedWatchStatuses(queryClient, ids, () => null);
  return { ids, previousLibrary, previousStatuses, previousProfileEntries };
}

function restoreCachedWatchStatuses(
  queryClient: QueryClient,
  ids: Iterable<string>,
  previousStatuses: Record<string, WatchStatus>,
) {
  patchCachedWatchStatuses(
    queryClient,
    ids,
    (id) => getOwnWatchStatus(previousStatuses, id) ?? null,
  );
}

function restoreCachedLibraryItems(
  queryClient: QueryClient,
  { ids, previousLibrary, previousStatuses, previousProfileEntries }: LibraryRemovalSnapshot,
) {
  const matchesItem = (row: MediaItem) => ids.has(row.id);
  queryClient.setQueryData<MediaItem[]>(LIBRARY_QUERY_KEY, (current) =>
    current
      ? reinsertSnapshotRows(current, previousLibrary, matchesItem, (row) => row.id)
      : current,
  );
  restoreCachedProfileLibraryItems(queryClient, previousProfileEntries, ids);
  restoreCachedWatchStatuses(queryClient, ids, previousStatuses);
}

export function useToggleLibraryItem(options: UseMediaCollectionActionsOptions) {
  const queryClient = useQueryClient();
  const mutationKey = ['library-membership', options.item?.id] as const;
  const pending = useMutationState({
    filters: { mutationKey, exact: true, status: 'pending' },
    select: (mutation) => mutation.state.variables as UseMediaCollectionActionsOptions,
  });

  const mutation = useMutation<
    MediaItem | null,
    unknown,
    UseMediaCollectionActionsOptions,
    ToggleLibraryMutationContext
  >({
    mutationKey,
    mutationFn: async ({ item, isInLibrary }) => {
      if (!item) {
        throw new Error('Media item unavailable');
      }

      if (isInLibrary) {
        // `remove_from_library` also clears the status in the same op.
        await api.removeFromLibrary(item.id);
        return null;
      }

      return api.addToLibrary(item);
    },
    onMutate: async ({ item, isInLibrary }) => {
      if (!item) {
        return {};
      }

      // Removal also clears the status, so the details chip can't show a stale one.
      if (isInLibrary) {
        return {
          itemId: item.id,
          removal: await removeCachedLibraryItems(queryClient, new Set([item.id])),
        };
      }
      await queryClient.cancelQueries({ queryKey: LIBRARY_QUERY_KEY });
      const previousLibraryItem = queryClient
        .getQueryData<MediaItem[]>(LIBRARY_QUERY_KEY)
        ?.find((entry) => entry.id === item.id);
      setCachedLibraryMembership(queryClient, item, true);
      return { itemId: item.id, previousLibraryItem };
    },
    onError: (_error, _variables, context) => {
      if (context?.removal) restoreCachedLibraryItems(queryClient, context.removal);
      else if (context?.itemId !== undefined) {
        restoreQueryArrayEntry(
          queryClient,
          LIBRARY_QUERY_KEY,
          context.itemId,
          context.previousLibraryItem,
        );
      }

      notifyAction('Failed to update library', { tone: 'error' });
    },
    onSuccess: async (savedItem, { item }) => {
      if (!item) {
        return;
      }

      await queryClient.cancelQueries({ queryKey: LIBRARY_QUERY_KEY });
      setCachedLibraryMembership(queryClient, savedItem ?? item, savedItem !== null);
      notifyAction(savedItem ? 'Added to Library' : 'Removed from Library', {
        detail: item.title,
        thumb: item.poster,
      });
    },
    onSettled: (_data, error, { isInLibrary }) =>
      reconcileCollectionQueries(queryClient, 'library-membership', error != null, isInLibrary),
  });

  return {
    ...mutation,
    isPending: pending.length > 0,
    mutate: () => {
      if (queryClient.isMutating({ mutationKey, exact: true }) === 0) {
        mutation.mutate(options);
      }
    },
    mutateAsync: () => mutation.mutateAsync(options),
  };
}

function appendMissingMediaItems(current: MediaItem[], items: MediaItem[]): MediaItem[] {
  const ids = new Set(current.map((item) => item.id));
  const added = items.filter((item) => {
    if (ids.has(item.id)) return false;
    ids.add(item.id);
    return true;
  });
  return added.length > 0 ? [...current, ...added.map(toMediaItem)] : current;
}

function cancelListQueries(queryClient: QueryClient) {
  return Promise.all([
    queryClient.cancelQueries({ queryKey: LISTS_QUERY_KEY }),
    queryClient.cancelQueries({ queryKey: LIST_SUMMARIES_QUERY_KEY }),
  ]);
}

function setCachedListSummaries(
  queryClient: QueryClient,
  listId: string,
  ids: ReadonlySet<string>,
  added: boolean,
  queryKeys = queryClient
    .getQueriesData<UserListSummary[]>({ queryKey: LIST_SUMMARIES_QUERY_KEY })
    .flatMap(([queryKey, rows]) => (rows?.some((row) => row.id === listId) ? [queryKey] : [])),
) {
  for (const queryKey of ids.size === 0 ? [] : queryKeys) {
    queryClient.setQueryData<UserListSummary[]>(queryKey, (rows) =>
      rows?.map((summary) =>
        summary.id === listId
          ? {
              ...summary,
              item_count: Math.max(0, summary.item_count + (added ? ids.size : -ids.size)),
              contains_item: ids.has(queryKey[1] as string) ? added : summary.contains_item,
            }
          : summary,
      ),
    );
  }
  return queryKeys;
}

function setCachedListItems(
  queryClient: QueryClient,
  listId: string,
  ids: ReadonlySet<string>,
  items?: MediaItem[],
  membershipKnown = false,
) {
  const previous = queryClient
    .getQueryData<UserList[]>(LISTS_QUERY_KEY)
    ?.find((list) => list.id === listId);
  const added = items !== undefined;
  const previousIds = previous && new Set(previous.item_ids);
  const changedIds = new Set(
    [...ids].filter((id) => (previousIds ? previousIds.has(id) !== added : membershipKnown)),
  );
  queryClient.setQueryData<UserList[]>(LISTS_QUERY_KEY, (lists) =>
    lists?.map((list) =>
      list.id !== listId
        ? list
        : {
            ...list,
            item_ids: added
              ? [...list.item_ids, ...changedIds]
              : list.item_ids.filter((id) => !ids.has(id)),
            items: added
              ? appendMissingMediaItems(list.items ?? [], items)
              : list.items?.filter((item) => !ids.has(item.id)),
          },
    ),
  );
  const summaryKeys = setCachedListSummaries(queryClient, listId, changedIds, added);
  return { previous, ids: changedIds, added, summaryKeys };
}

function restoreCachedListItems(
  queryClient: QueryClient,
  listId: string,
  context: ReturnType<typeof setCachedListItems> | undefined,
) {
  if (!context) return;
  const { previous, ids, added } = context;
  if (previous) {
    const matchesId = (id: string) => ids.has(id);
    const matchesItem = (item: MediaItem) => ids.has(item.id);
    queryClient.setQueryData<UserList[]>(LISTS_QUERY_KEY, (lists) =>
      lists?.map((list) =>
        list.id !== listId
          ? list
          : {
              ...list,
              item_ids: added
                ? list.item_ids.filter((id) => !ids.has(id))
                : reinsertSnapshotRows(list.item_ids, previous.item_ids, matchesId, (id) => id),
              items: added
                ? list.items?.filter((item) => !ids.has(item.id))
                : reinsertSnapshotRows(
                    list.items ?? [],
                    previous.items ?? [],
                    matchesItem,
                    (item) => item.id,
                  ),
            },
      ),
    );
  }
  setCachedListSummaries(queryClient, listId, ids, !added, context.summaryKeys);
}

export function useBulkRemoveFromLibrary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['library-membership', 'bulk-remove'],
    mutationFn: (ids: string[]) => api.bulkRemoveFromLibrary(ids),
    onMutate: (ids) => removeCachedLibraryItems(queryClient, new Set(ids)),
    onError: (_error, _ids, context) => {
      if (context) restoreCachedLibraryItems(queryClient, context);
    },
    onSettled: (_data, error) =>
      reconcileCollectionQueries(queryClient, 'library-membership', error != null),
  });
}

export function useBulkSetWatchStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['library-membership', 'bulk-status'],
    mutationFn: ({ ids, status }: { ids: string[]; status: WatchStatus | null }) =>
      api.bulkSetWatchStatus(ids, status),
    onMutate: async ({ ids, status }) => {
      await queryClient.cancelQueries({ queryKey: WATCH_STATUSES_QUERY_KEY });
      const previousStatuses =
        queryClient.getQueryData<Record<string, WatchStatus>>(WATCH_STATUSES_QUERY_KEY) ?? {};
      patchCachedWatchStatuses(queryClient, ids, () => status);
      return { previousStatuses };
    },
    onError: (_error, { ids }, context) => {
      if (context) restoreCachedWatchStatuses(queryClient, ids, context.previousStatuses);
    },
    onSettled: (_data, error) =>
      reconcileCollectionQueries(queryClient, 'library-membership', error != null),
  });
}

export function useBulkAddToList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['list-membership', 'bulk-add'],
    mutationFn: ({ listId, itemIds }: { listId: string; itemIds: string[] }) =>
      api.bulkAddToList(listId, itemIds),
    onMutate: async ({ listId, itemIds }) => {
      const selectedIds = new Set(itemIds);
      const itemsById = new Map<string, MediaItem>();
      const snapshots = [
        queryClient.getQueryData<MediaItem[]>(LIBRARY_QUERY_KEY) ?? [],
        ...queryClient
          .getQueriesData<ProfileLibrary>({ queryKey: PROFILE_LIBRARY_QUERY_KEY })
          .map(([, data]) => data?.items ?? []),
      ];
      for (const snapshot of snapshots) {
        for (const item of snapshot) {
          if (selectedIds.has(item.id)) itemsById.set(item.id, item);
        }
      }
      const items = [...itemsById.values()];
      await cancelListQueries(queryClient);
      return setCachedListItems(queryClient, listId, new Set(items.map((item) => item.id)), items);
    },
    onError: (_error, { listId }, context) => {
      restoreCachedListItems(queryClient, listId, context);
    },
    onSettled: () => reconcileCollectionQueries(queryClient, 'list-membership'),
  });
}

export function useBulkRemoveFromList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['list-membership', 'bulk-remove'],
    mutationFn: ({ listId, itemIds }: { listId: string; itemIds: string[] }) =>
      api.bulkRemoveFromList(listId, itemIds),
    onMutate: async ({ listId, itemIds }) => {
      await cancelListQueries(queryClient);
      return setCachedListItems(queryClient, listId, new Set(itemIds));
    },
    onError: (error, { listId }, context) => {
      restoreCachedListItems(queryClient, listId, context);
      toast.error(getListErrorMessage(error) ?? 'Failed to remove titles from list');
    },
    onSuccess: (entries, { listId }) => {
      toastRemovedWithUndo(
        `Removed ${pluralize(entries.length, 'title')} from list`,
        entries.length > 0,
        async () => {
          await api
            .restoreListItems(listId, entries)
            .catch((error: unknown) => {
              toast.error(getListErrorMessage(error) ?? 'Could not restore list titles');
            })
            .finally(() => invalidateListQueries(queryClient));
        },
      );
    },
    onSettled: () => reconcileCollectionQueries(queryClient, 'list-membership'),
  });
}

export function useBulkRemoveFromWatchHistory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (items: { id: string; type: string }[]) => api.bulkRemoveFromWatchHistory(items),
    onMutate: (items) => {
      const ids = new Set(items.map((item) => `${item.type}:${item.id}`));
      return removeCachedWatchHistory(queryClient, (row) => ids.has(watchTitleKey(row)));
    },
    onError: (_error, _items, context) => {
      restoreCachedWatchHistory(queryClient, context);
      toast.error('Failed to remove titles from history');
    },
    onSuccess: (rows, items) => {
      toastRemovedWithUndo(
        `Removed ${pluralize(items.length, 'title')} from history`,
        rows.length > 0,
        () => restoreWatchProgressRows(rows, () => invalidatePlaybackHistoryQueries(queryClient)),
      );
    },
    onSettled: () => invalidatePlaybackHistoryQueries(queryClient),
  });
}

interface UseRemoveTitleWatchHistoryOptions extends UseRemoveFromContinueWatchingOptions {
  errorTitle: string;
}

function resumeRailEntryKey({ row }: ResumeRailEntry): string {
  return `${watchTitleKey(row)}:${row.season ?? ''}:${row.episode ?? ''}`;
}

// Whole-title history delete: collapsed surfaces render one row per title —
// deleting only the displayed row lets it resurface under a different episode.
function useRemoveTitleWatchHistory({
  itemId,
  itemTitle,
  mediaType,
  errorTitle,
}: UseRemoveTitleWatchHistoryOptions) {
  const queryClient = useQueryClient();
  const normalizedMediaType = mediaType?.trim();
  const matchesTitle = (entry: WatchProgress) =>
    entry.id === itemId && entry.type_ === normalizedMediaType;

  return useMutation({
    mutationFn: async () => {
      if (!normalizedMediaType) {
        throw new Error('Playback history metadata unavailable');
      }

      // Returns the exact removed rows — the Undo snapshot needs no extra read.
      return api.removeAllFromWatchHistory(itemId, normalizedMediaType);
    },
    onMutate: () => removeCachedWatchHistory(queryClient, matchesTitle),
    onSuccess: (removedRows) => {
      toastRemovedWithUndo(
        'Removed from watch history',
        removedRows.length > 0,
        () =>
          restoreWatchProgressRows(removedRows, () =>
            invalidatePlaybackHistoryQueriesForTitle(queryClient, itemId),
          ),
        itemTitle,
      );
    },
    onError: (error, _variables, context) => {
      restoreCachedWatchHistory(queryClient, context);
      toast.error(error instanceof Error ? error.message : errorTitle);
    },
    onSettled: () => invalidatePlaybackHistoryQueriesForTitle(queryClient, itemId),
  });
}

// Rail-only dismissal: Rust hides the title until newer progress lands; history,
// Details resume, and profile tabs keep it.
export function useRemoveFromContinueWatching({
  itemId,
  itemTitle,
  mediaType,
}: UseRemoveFromContinueWatchingOptions) {
  const queryClient = useQueryClient();
  const normalizedMediaType = mediaType?.trim();
  const refreshRail = () => queryClient.invalidateQueries({ queryKey: [RESUME_RAIL_QUERY_KEY] });

  return useMutation({
    mutationFn: async () => {
      if (!normalizedMediaType) {
        throw new Error('Playback history metadata unavailable');
      }
      await api.setContinueWatchingDismissed(itemId, normalizedMediaType, true);
      return normalizedMediaType;
    },
    onMutate: () =>
      removeCachedWatchHistory(
        queryClient,
        (entry) => entry.id === itemId && entry.type_ === normalizedMediaType,
        true,
      ),
    onSuccess: (dismissedType, _variables, context) => {
      toastRemovedWithUndo(
        'Removed from Continue Watching',
        true,
        () => {
          restoreCachedWatchHistory(queryClient, context);
          return restoreContinueWatchingTitle(itemId, dismissedType, refreshRail);
        },
        itemTitle,
      );
    },
    onError: (error, _variables, context) => {
      restoreCachedWatchHistory(queryClient, context);
      toast.error(
        error instanceof Error ? error.message : 'Failed to remove from Continue Watching',
      );
    },
    onSettled: refreshRail,
  });
}

// Per-title delete for the profile tabs; deletes every row of the title.
export function useRemoveFromWatchHistory(options: UseRemoveFromContinueWatchingOptions) {
  return useRemoveTitleWatchHistory({
    ...options,
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
    [TitleWatchProgress, WatchProgress[]],
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
    onSuccess: ([progress, previousRows], { episodes, watched }) => {
      queryClient.setQueryData<TitleWatchProgress>(progressKey, progress);
      if (seasonAction && item) {
        toastRemovedWithUndo(
          watched ? 'Season marked as watched' : 'Season marked as unwatched',
          true,
          () =>
            revertEpisodesWatched(item, episodes, watched, previousRows, () =>
              invalidatePlaybackHistoryQueriesForTitle(queryClient, item.id),
            ),
          pluralize(episodes.length, 'episode'),
        );
        return;
      }
      const episode = episodes[0];
      notifyAction(watched ? 'Marked as watched' : 'Marked as unwatched', {
        detail: episode && formatEpisodeHeading(episode.season, episode.episode, episode.title),
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

const collectionReconciliationTimers = new WeakMap<
  QueryClient,
  {
    timer: ReturnType<typeof setTimeout>;
    library: boolean;
    refetchLibrary: boolean;
    watchStatusChanged: boolean;
  }
>();

export function reconcileCollectionQueries(
  queryClient: QueryClient,
  mutationKey: 'library-membership' | 'list-membership',
  refetchLibrary = false,
  watchStatusChanged = true,
) {
  const previous = collectionReconciliationTimers.get(queryClient);
  clearTimeout(previous?.timer);
  const pending = {
    library: mutationKey === 'library-membership' || previous?.library === true,
    refetchLibrary: refetchLibrary || previous?.refetchLibrary === true,
    watchStatusChanged:
      previous?.watchStatusChanged === true ||
      (mutationKey === 'library-membership' && watchStatusChanged),
    timer: setTimeout(() => {
      // Mutation callbacks finish before TanStack drops their pending status.
      if (
        queryClient.isMutating({
          predicate: (mutation) =>
            mutation.options.mutationKey?.[0] === 'library-membership' ||
            mutation.options.mutationKey?.[0] === 'list-membership',
        }) > 0
      )
        return;
      collectionReconciliationTimers.delete(queryClient);
      void (pending.library
        ? invalidateLibraryQueries(queryClient, {
            watchStatusChanged: pending.watchStatusChanged,
            refetchLibrary:
              pending.refetchLibrary ||
              queryClient.getQueryData(LIBRARY_QUERY_KEY) === undefined ||
              queryClient.getQueryState(LIBRARY_QUERY_KEY)?.isInvalidated,
          })
        : invalidateListQueries(queryClient));
    }, 0),
  };
  collectionReconciliationTimers.set(queryClient, pending);
}

export function useMediaCollectionActions({ item, isInLibrary }: UseMediaCollectionActionsOptions) {
  const queryClient = useQueryClient();
  const toggleLibrary = useToggleLibraryItem({ item, isInLibrary });
  const membershipMutationKey = ['list-membership', item?.id] as const;
  const pendingListIds = useMutationState({
    filters: { mutationKey: membershipMutationKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as ListMembershipVariables).list.id,
  });

  const toggleListMembership = useMutation({
    mutationKey: membershipMutationKey,
    mutationFn: async ({ item: selectedItem, list }: ListMembershipVariables) => {
      if (!selectedItem) throw new Error('Media item unavailable');
      if (list.contains_item) {
        await api.removeFromList(list.id, selectedItem.id);
        return { action: 'removed' as const, list };
      }

      const summary = await api.addToList(list.id, selectedItem);
      return { action: 'added' as const, list: summary };
    },
    onMutate: async ({ item: selectedItem, list }) => {
      await cancelListQueries(queryClient);
      return selectedItem
        ? setCachedListItems(
            queryClient,
            list.id,
            new Set([selectedItem.id]),
            list.contains_item ? undefined : [selectedItem],
            true,
          )
        : undefined;
    },
    onSuccess: async ({ action, list }, { item: selectedItem }) => {
      const summariesKey = listSummariesQueryKey(selectedItem?.id);
      await queryClient.cancelQueries({ queryKey: summariesKey, exact: true });
      queryClient.setQueryData<UserListSummary[]>(summariesKey, (old) =>
        old?.map((summary) =>
          summary.id === list.id
            ? action === 'added' &&
              queryClient.isMutating({ mutationKey: ['list-membership'] }) === 1
              ? list
              : { ...summary, contains_item: action === 'added' }
            : summary,
        ),
      );
      if (!selectedItem) return;
      notifyAction(`${action === 'added' ? 'Added to' : 'Removed from'} "${list.name}"`, {
        detail: selectedItem.title,
        thumb: selectedItem.poster,
      });
    },
    onError: (error, { list }, context) => {
      restoreCachedListItems(queryClient, list.id, context);
      notifyAction('Failed to update list', {
        tone: 'error',
        detail: getListErrorMessage(error),
      });
    },
    onSettled: () => reconcileCollectionQueries(queryClient, 'list-membership'),
  });

  const addItemToNewList = async (list: UserList) => {
    if (!item || list.rules) return;
    try {
      const summary = await api.addToList(list.id, item);
      queryClient.setQueryData<UserListSummary[]>(listSummariesQueryKey(item.id), (old) => {
        return old?.some((entry) => entry.id === list.id)
          ? old.map((entry) => (entry.id === list.id ? summary : entry))
          : old && [...old, summary];
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
  };

  return {
    addItemToNewList,
    toggleLibrary,
    toggleListMembership: {
      ...toggleListMembership,
      mutate: (list: UserListSummary) => {
        const pending = queryClient.isMutating({
          mutationKey: membershipMutationKey,
          predicate: (mutation) =>
            (mutation.state.variables as ListMembershipVariables).list.id === list.id,
        });
        if (pending === 0) toggleListMembership.mutate({ item, list });
      },
    },
    pendingListIds,
  };
}
