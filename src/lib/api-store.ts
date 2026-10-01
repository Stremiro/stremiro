import type {
  AddonConfig,
  AddonConfigInput,
  AppUiPreferences,
  AppUiPreferencesPatch,
  DataStats,
  ImportResult,
  LocalProfile,
  MediaItem,
  ProfilePreferences,
  ProfileViewMode,
  StreamSelectorPreferences,
  StreamSelectorPreferencesState,
  UserList,
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

interface StoreApiContext {
  safeInvoke: InvokeApi;
  caches: ApiCacheGroups;
}

/** Library/list rows persist only `MediaItem` fields — a `MediaDetails`
    caller must not ship its episode/cast/trailer arrays over IPC. */
export function toMediaItem({
  id,
  title,
  poster,
  backdrop,
  logo,
  description,
  year,
  displayYear,
  genres,
  type,
}: MediaItem): MediaItem {
  return { id, title, poster, backdrop, logo, description, year, displayYear, genres, type };
}

export function createStoreApi({ safeInvoke, caches }: StoreApiContext) {
  const getAddonConfigs = () => safeInvoke<AddonConfig[]>('get_addon_configs');

  return {
    getAddonConfigs,
    saveAddonConfigs: (configs: AddonConfigInput[]) =>
      // Track the full write (including the cache-clear continuation) so a
      // close/export during a settings save waits on it — and sees failure.
      trackPendingAppWrite(
        (async () => {
          // Rust owns capability snapshots; omit read-only response fields even
          // when saving an existing AddonConfig array.
          const saved = await safeInvoke<AddonConfig[]>('save_addon_configs', {
            configs: configs.map(({ id, url, name, enabled }) => ({ id, url, name, enabled })),
          });
          clearProviderDataCaches(caches);
          return saved;
        })(),
      ),
    getAppUiPreferences: () => safeInvoke<AppUiPreferences>('get_app_ui_preferences'),
    saveAppUiPreferences: (patch: AppUiPreferencesPatch) =>
      safeInvoke<AppUiPreferences>('save_app_ui_preferences', {
        patch,
      }),
    getProfilePreferences: () => safeInvoke<ProfilePreferences>('get_profile_preferences'),
    saveProfilePreferences: (profile: LocalProfile, viewMode: ProfileViewMode) =>
      safeInvoke<ProfilePreferences>('save_profile_preferences', {
        profile,
        viewMode,
      }),
    getStreamSelectorPreferences: () =>
      safeInvoke<StreamSelectorPreferencesState>('get_stream_selector_preferences'),
    saveStreamSelectorPreferences: (preferences: StreamSelectorPreferences) =>
      withStreamingCacheClear(
        caches,
        safeInvoke<StreamSelectorPreferences>('save_stream_selector_preferences', {
          preferences,
        }),
      ),
    addToLibrary: (item: MediaItem) =>
      safeInvoke<void>('add_to_library', { item: toMediaItem(item) }),
    removeFromLibrary: (id: string) => safeInvoke<void>('remove_from_library', { id }),
    getLibrary: () => safeInvoke<MediaItem[]>('get_library'),
    createList: (name: string, icon?: string) =>
      safeInvoke<UserList>('create_list', { name, icon }),
    deleteList: (listId: string) => safeInvoke<void>('delete_list', { listId }),
    renameList: (listId: string, name: string, icon?: string) =>
      safeInvoke<void>('rename_list', { listId, name, icon }),
    addToList: (listId: string, item: MediaItem) =>
      safeInvoke<void>('add_to_list', { listId, item: toMediaItem(item) }),
    removeFromList: (listId: string, itemId: string) =>
      safeInvoke<void>('remove_from_list', { listId, itemId }),
    getLists: () => safeInvoke<UserList[]>('get_lists'),
    reorderListItems: (listId: string, itemIds: string[]) =>
      safeInvoke<void>('reorder_list_items', { listId, itemIds }),
    reorderLists: (listIds: string[]) => safeInvoke<void>('reorder_lists', { listIds }),
    setWatchStatus: (itemId: string, status: WatchStatus | null) =>
      safeInvoke<void>('set_watch_status', { itemId, status }),
    getAllWatchStatuses: () => safeInvoke<Record<string, WatchStatus>>('get_all_watch_statuses'),
    getDataStats: () => safeInvoke<DataStats>('get_data_stats'),
    // Bump before the IPC lands: a progress save queued across this clear
    // must not resurrect a wiped row when it flushes.
    clearWatchHistory: () => {
      bumpWatchProgressEpoch();
      return safeInvoke<void>('clear_watch_history');
    },
    clearLibrary: () => safeInvoke<void>('clear_library'),
    clearAllLists: () => safeInvoke<void>('clear_all_lists'),
    clearAllWatchStatuses: () => safeInvoke<void>('clear_all_watch_statuses'),
    exportAppDataToFile: (path: string) => safeInvoke<void>('export_app_data_to_file', { path }),
    importAppDataFromFile: (path: string) =>
      safeInvoke<ImportResult>('import_app_data_from_file', { path }),
  };
}
