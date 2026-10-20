import { queryOptions } from '@tanstack/react-query';
import type {
  AddonConfig,
  AddonConfigsOp,
  AddonUrlInspection,
  AppUiPreferences,
  AppUiPreferencesPatch,
  BootstrapSnapshot,
  DataStats,
  ImportResult,
  LibraryFilters,
  MediaItem,
  ProfileLibrary,
  ProfilePreferences,
  ProfilePreferencesPatch,
  RemovedListItem,
  SmartListRules,
  StreamSelectorPreferencesPatch,
  StreamSelectorPreferencesState,
  TitleWatchProgress,
  UserList,
  UserListSummary,
  WatchStatus,
} from '@/lib/api';
import {
  type ApiCacheGroups,
  bumpWatchProgressEpoch,
  clearProviderDataCaches,
  withStreamingCacheClear,
} from '@/lib/api-cache';
import type { InvokeApi } from '@/lib/api-core';
import { trackPendingAppWrite } from '@/lib/pending-app-writes';
import type { PlayerActionId } from '@/lib/player-keybindings';
import {
  ADDON_CONFIGS_QUERY_KEY,
  ADDON_CONFIGS_STALE_TIME_MS,
  DATA_STATS_QUERY_KEY,
  DATA_STATS_STALE_TIME_MS,
} from '@/lib/query-invalidation';

interface StoreApiContext {
  safeInvoke: InvokeApi;
  caches: ApiCacheGroups;
}

/** Persist only `MediaItem` fields — a `MediaDetails` caller must not ship episode/cast/trailer arrays over IPC. */
export function toMediaItem({
  id,
  title,
  poster,
  backdrop,
  logo,
  description,
  year,
  primaryYear,
  displayYear,
  genres,
  type,
}: MediaItem): MediaItem {
  return {
    id,
    title,
    poster,
    backdrop,
    logo,
    description,
    year,
    primaryYear,
    displayYear,
    genres,
    type,
  };
}

export function createStoreApi({ safeInvoke, caches }: StoreApiContext) {
  const getAddonConfigs = () => safeInvoke<AddonConfig[]>('get_addon_configs');
  const getLaunchAtLogin = () => safeInvoke<boolean>('get_launch_at_login');
  const getDataStats = () => safeInvoke<DataStats>('get_data_stats');
  const write: InvokeApi = (command, args) => trackPendingAppWrite(safeInvoke(command, args));
  // Preference reads issued while the startup snapshot is in flight reuse it instead of a second IPC.
  let pendingBootstrap: Promise<BootstrapSnapshot | undefined> | undefined;

  return {
    getAddonConfigs,
    addonConfigsQueryOptions: () =>
      queryOptions({
        queryKey: ADDON_CONFIGS_QUERY_KEY,
        queryFn: getAddonConfigs,
        staleTime: ADDON_CONFIGS_STALE_TIME_MS,
      }),
    getAddonUrl: (id: string) => safeInvoke<string>('get_addon_url', { id }),
    inspectAddonUrl: (url: string) => safeInvoke<AddonUrlInspection>('inspect_addon_url', { url }),
    updateAddonConfigs: (op: AddonConfigsOp) =>
      // Track the full write incl. cache-clear so a close/export during save waits on it — and sees failure.
      trackPendingAppWrite(
        (async () => {
          try {
            return await safeInvoke<AddonConfig[]>('update_addon_configs', { op });
          } finally {
            // A failed save may still have applied the registry in memory.
            clearProviderDataCaches(caches);
          }
        })(),
      ),
    getAppUiPreferences: () => safeInvoke<AppUiPreferences>('get_app_ui_preferences'),
    getDefaultPlayerKeybindings: () =>
      safeInvoke<Record<string, string[]>>('get_default_player_keybindings'),
    bindPlayerKeybinding: (
      overrides: Readonly<Record<string, string[]>>,
      action: PlayerActionId,
      slot: number,
      key: string | null,
    ) =>
      safeInvoke<Record<string, string[]>>('bind_player_keybinding', {
        overrides,
        action,
        slot,
        key,
      }),
    getBootstrapSnapshot: () => {
      const request = safeInvoke<BootstrapSnapshot>('get_bootstrap_snapshot');
      const pending = request
        .catch(() => undefined)
        .finally(() => {
          if (pendingBootstrap === pending) pendingBootstrap = undefined;
        });
      pendingBootstrap = pending;
      return request;
    },
    pendingBootstrapSnapshot: () => pendingBootstrap,
    launchAtLoginQueryOptions: () =>
      queryOptions({
        queryKey: ['launch-at-login'] as const,
        queryFn: getLaunchAtLogin,
        staleTime: 30_000,
        refetchOnWindowFocus: true,
      }),
    setLaunchAtLogin: (enabled: boolean) => write<boolean>('set_launch_at_login', { enabled }),
    hideMainWindowToTray: () => safeInvoke<void>('hide_main_window_to_tray'),
    closeMainWindowToTray: () => safeInvoke<boolean>('close_main_window_to_tray'),
    markFrontendQuitReady: () => safeInvoke<void>('mark_frontend_quit_ready'),
    saveAppUiPreferences: (patch: AppUiPreferencesPatch) =>
      safeInvoke<AppUiPreferences>('save_app_ui_preferences', {
        patch,
      }),
    getProfilePreferences: () => safeInvoke<ProfilePreferences>('get_profile_preferences'),
    saveProfilePreferences: (patch: ProfilePreferencesPatch) =>
      safeInvoke<ProfilePreferences>('save_profile_preferences', {
        patch,
      }),
    setProfileAvatarFromBytes: async (file: Blob) => {
      const bytes = new Uint8Array(
        await file.arrayBuffer().catch(() => {
          throw new Error("Couldn't read that image — try a PNG, JPEG, or WebP");
        }),
      );
      return safeInvoke<ProfilePreferences>('set_profile_avatar_from_bytes', bytes, {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    },
    clearProfileAvatar: () => safeInvoke<ProfilePreferences>('clear_profile_avatar'),
    getStreamSelectorPreferences: () =>
      safeInvoke<StreamSelectorPreferencesState>('get_stream_selector_preferences'),
    // Display filters only: ranking never reads them, so resolved winners stay cached.
    patchStreamSelectorPreferences: (patch: StreamSelectorPreferencesPatch) =>
      safeInvoke<StreamSelectorPreferencesState>('patch_stream_selector_preferences', {
        patch,
      }),
    addToLibrary: (item: MediaItem) =>
      write<MediaItem>('add_to_library', { item: toMediaItem(item) }),
    removeFromLibrary: (id: string) => write<void>('remove_from_library', { id }),
    bulkRemoveFromLibrary: async (ids: string[]): Promise<number> => {
      if (ids.length === 0) return 0;
      return write<number>('bulk_remove_from_library', { ids });
    },
    getLibrary: () => safeInvoke<MediaItem[]>('get_library'),
    getLibraryGenres: () => safeInvoke<string[]>('get_library_genres'),
    getProfileLibrary: (filters: LibraryFilters) =>
      safeInvoke<ProfileLibrary>('get_profile_library', { filters }),
    createList: (name: string, icon?: string, rules?: SmartListRules) =>
      write<UserList>('create_list', { name, icon, rules }),
    deleteList: (listId: string) => write<void>('delete_list', { listId }),
    renameList: (listId: string, name: string, icon?: string, rules?: SmartListRules) =>
      write<void>('rename_list', { listId, name, icon, rules }),
    addToList: (listId: string, item: MediaItem) =>
      write<UserListSummary>('add_to_list', { listId, item: toMediaItem(item) }),
    bulkAddToList: (listId: string, itemIds: string[]) =>
      write<number>('bulk_add_to_list', { listId, itemIds }),
    removeFromList: (listId: string, itemId: string) =>
      write<void>('remove_from_list', { listId, itemId }),
    bulkRemoveFromList: (listId: string, itemIds: string[]) =>
      write<RemovedListItem[]>('bulk_remove_from_list', { listId, itemIds }),
    restoreListItems: (listId: string, entries: RemovedListItem[]) =>
      write<void>('restore_list_items', { listId, entries }),
    getLists: () => safeInvoke<UserList[]>('get_lists'),
    getListSummaries: (itemId?: string) =>
      safeInvoke<UserListSummary[]>('get_list_summaries', { itemId: itemId ?? null }),
    reorderListItems: (listId: string, itemIds: string[]) =>
      write<void>('reorder_list_items', { listId, itemIds }),
    reorderLists: (listIds: string[]) => write<void>('reorder_lists', { listIds }),
    setWatchStatus: (item: MediaItem, status: WatchStatus | null) =>
      write<MediaItem | null>('set_watch_status', { item: toMediaItem(item), status }),
    bulkSetWatchStatus: (ids: string[], status: WatchStatus | null) =>
      write<number>('bulk_set_watch_status', { ids, status }),
    setEpisodesWatched: (
      item: MediaItem,
      episodes: readonly { season: number; episode: number }[],
      watched: boolean,
    ) => {
      bumpWatchProgressEpoch();
      return write<TitleWatchProgress>('set_episodes_watched', {
        item: toMediaItem(item),
        episodes: episodes.map(({ season, episode }) => ({ season, episode })),
        watched,
      });
    },
    getAllWatchStatuses: () => safeInvoke<Record<string, WatchStatus>>('get_all_watch_statuses'),
    dataStatsQueryOptions: () =>
      queryOptions({
        queryKey: DATA_STATS_QUERY_KEY,
        queryFn: getDataStats,
        staleTime: DATA_STATS_STALE_TIME_MS,
      }),
    // Bump before the IPC lands — a queued progress save must not resurrect a wiped row.
    clearWatchHistory: () => {
      bumpWatchProgressEpoch();
      return trackPendingAppWrite(
        withStreamingCacheClear(caches, safeInvoke<void>('clear_watch_history')),
      );
    },
    clearLibrary: () => write<void>('clear_library'),
    clearAllLists: () => write<void>('clear_all_lists'),
    clearAllWatchStatuses: () => write<void>('clear_all_watch_statuses'),
    exportAppDataToFile: () => write<boolean>('export_app_data_to_file'),
    // Bump on both edges: a prefetch bundle started before or during the import
    // must not publish a pre-import resume snapshot.
    importAppDataFromFile: () => {
      bumpWatchProgressEpoch();
      return trackPendingAppWrite(
        safeInvoke<ImportResult | null>('import_app_data_from_file').finally(() => {
          bumpWatchProgressEpoch();
          clearProviderDataCaches(caches);
        }),
      );
    },
  };
}
