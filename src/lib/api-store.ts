import type {
  AddonConfig,
  AddonConfigInput,
  AddonUrlInspection,
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
  TitleWatchProgress,
  UserList,
  WatchStatus,
} from '@/lib/api';
import {
  type ApiCacheGroups,
  bumpWatchProgressEpoch,
  clearProviderDataCaches,
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
  const write: InvokeApi = (command, args) => trackPendingAppWrite(safeInvoke(command, args));

  return {
    getAddonConfigs,
    inspectAddonUrl: (url: string) => safeInvoke<AddonUrlInspection>('inspect_addon_url', { url }),
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
    // Display filters only: ranking never reads them, so resolved winners stay cached.
    saveStreamSelectorPreferences: (preferences: StreamSelectorPreferences) =>
      safeInvoke<StreamSelectorPreferences>('save_stream_selector_preferences', {
        preferences,
      }),
    addToLibrary: (item: MediaItem) => write<void>('add_to_library', { item: toMediaItem(item) }),
    removeFromLibrary: (id: string) => write<void>('remove_from_library', { id }),
    getLibrary: () => safeInvoke<MediaItem[]>('get_library'),
    createList: (name: string, icon?: string) => write<UserList>('create_list', { name, icon }),
    deleteList: (listId: string) => write<void>('delete_list', { listId }),
    renameList: (listId: string, name: string, icon?: string) =>
      write<void>('rename_list', { listId, name, icon }),
    addToList: (listId: string, item: MediaItem) =>
      write<void>('add_to_list', { listId, item: toMediaItem(item) }),
    removeFromList: (listId: string, itemId: string) =>
      write<void>('remove_from_list', { listId, itemId }),
    getLists: () => safeInvoke<UserList[]>('get_lists'),
    reorderListItems: (listId: string, itemIds: string[]) =>
      write<void>('reorder_list_items', { listId, itemIds }),
    reorderLists: (listIds: string[]) => write<void>('reorder_lists', { listIds }),
    setWatchStatus: (item: MediaItem, status: WatchStatus | null) =>
      write<MediaItem | null>('set_watch_status', { item: toMediaItem(item), status }),
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
    // Bump before the IPC lands: a progress save queued across this clear
    // must not resurrect a wiped row when it flushes.
    clearWatchHistory: () => {
      bumpWatchProgressEpoch();
      return write<void>('clear_watch_history');
    },
    clearLibrary: () => write<void>('clear_library'),
    clearAllLists: () => write<void>('clear_all_lists'),
    clearAllWatchStatuses: () => write<void>('clear_all_watch_statuses'),
    exportAppDataToFile: (path: string) => write<void>('export_app_data_to_file', { path }),
    importAppDataFromFile: (path: string) =>
      trackPendingAppWrite(
        safeInvoke<ImportResult>('import_app_data_from_file', { path }).finally(() =>
          clearProviderDataCaches(caches),
        ),
      ),
  };
}
