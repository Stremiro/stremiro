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
  const write: InvokeApi = (command, args) => trackPendingAppWrite(safeInvoke(command, args));

  return {
    getAddonConfigs,
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
    getBootstrapSnapshot: () => safeInvoke<BootstrapSnapshot>('get_bootstrap_snapshot'),
    getLaunchAtLogin: () => safeInvoke<boolean>('get_launch_at_login'),
    setLaunchAtLogin: (enabled: boolean) => write<boolean>('set_launch_at_login', { enabled }),
    hideMainWindowToTray: () => safeInvoke<void>('hide_main_window_to_tray'),
    closeMainWindowToTray: () => safeInvoke<boolean>('close_main_window_to_tray'),
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
    addToLibrary: (item: MediaItem) => write<void>('add_to_library', { item: toMediaItem(item) }),
    removeFromLibrary: (id: string) => write<void>('remove_from_library', { id }),
    bulkRemoveFromLibrary: async (ids: string[]): Promise<number> => {
      if (ids.length === 0) return 0;
      return write<number>('bulk_remove_from_library', { ids });
    },
    getLibrary: () => safeInvoke<MediaItem[]>('get_library'),
    getProfileLibrary: (filters: LibraryFilters) =>
      safeInvoke<ProfileLibrary>('get_profile_library', { filters }),
    createList: (name: string, icon?: string) => write<UserList>('create_list', { name, icon }),
    deleteList: (listId: string) => write<void>('delete_list', { listId }),
    renameList: (listId: string, name: string, icon?: string) =>
      write<void>('rename_list', { listId, name, icon }),
    addToList: (listId: string, item: MediaItem) =>
      write<UserListSummary>('add_to_list', { listId, item: toMediaItem(item) }),
    bulkAddToList: async (listId: string, items: MediaItem[]): Promise<number> => {
      if (items.length === 0) return 0;
      return write<number>('bulk_add_to_list', { listId, items: items.map(toMediaItem) });
    },
    removeFromList: (listId: string, itemId: string) =>
      write<void>('remove_from_list', { listId, itemId }),
    getLists: () => safeInvoke<UserList[]>('get_lists'),
    getListSummaries: (itemId?: string) =>
      safeInvoke<UserListSummary[]>('get_list_summaries', { itemId: itemId ?? null }),
    reorderListItems: (listId: string, itemIds: string[]) =>
      write<void>('reorder_list_items', { listId, itemIds }),
    reorderLists: (listIds: string[]) => write<void>('reorder_lists', { listIds }),
    setWatchStatus: (item: MediaItem, status: WatchStatus | null) =>
      write<MediaItem | null>('set_watch_status', { item: toMediaItem(item), status }),
    bulkSetWatchStatus: async (items: MediaItem[], status: WatchStatus | null): Promise<number> => {
      if (items.length === 0) return 0;
      return write<number>('bulk_set_watch_status', { items: items.map(toMediaItem), status });
    },
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
    getDataStats: () => safeInvoke<DataStats>('get_data_stats'),
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
