import {
  type AddonConfig,
  type AddonConfigsOp,
  type AppUiPreferences,
  DEFAULT_APP_UI_PREFERENCES,
  type HistoryPlaybackPlan,
  type LibraryFilters,
  type MediaItem,
  type PlaybackLanguagePreferences,
  type ProfileLibrary,
  type ProfilePreferences,
  type ProfilePreferencesPatch,
  type StreamSelectorData,
  type UserList,
  type WatchStatus,
} from '@/lib/api';
import { toMediaItem } from '@/lib/api-store';
import { clamp } from '@/lib/utils';

type PreviewInvokeArgs = Record<string, unknown> | undefined;

let previewProfilePreferences: ProfilePreferences = {
  profile: {
    username: 'Guest User',
    accentColor: '#ffffff',
    accentIntensity: 100,
    accentTargets: {
      navigation: true,
      actions: true,
      progress: true,
      artwork: true,
    },
  },
  viewMode: 'grid',
};
let previewAppUiPreferences: AppUiPreferences = structuredClone(DEFAULT_APP_UI_PREFERENCES);
let previewLaunchAtLogin = false;
let previewStreamSelectorPreferences = {
  quality: 'all',
  source: 'all',
  addon: 'all',
  sort: 'smart',
  batch: 'all',
};
let previewPlaybackLanguagePreferences: PlaybackLanguagePreferences = {};
let previewAddonConfigs: AddonConfig[] = [];
let previewAddonConfigSeq = 0;
let previewLibrary: MediaItem[] = [];
let previewWatchStatuses: Record<string, WatchStatus> = {};
let previewLists: UserList[] = [];
let previewListSeq = 0;

const EMPTY_SEARCH_CATALOG_PAGE = {
  items: [],
  nextSkip: null,
};

const EMPTY_STREAM_SELECTOR_DATA: StreamSelectorData = {
  streams: [],
  sourceSummaries: [],
  stats: {
    resCounts: { '4k': 0, '1080p': 0, '720p': 0, sd: 0 },
    playableCount: 0,
    p2pCount: 0,
    cachedCount: 0,
    batchCount: 0,
    episodeLikeCount: 0,
    sourceHealth: { degraded: 0, offline: 0, pending: 0 },
  },
};

// Mirrors MOVIE_GENRE_FALLBACK/SERIES_ONLY_GENRES in browse_genre_commands.rs — the backend never returns empty genre lists.
const PREVIEW_MOVIE_GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Biography',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'History',
  'Horror',
  'Mystery',
  'Romance',
  'Sci-Fi',
  'Sport',
  'Thriller',
  'War',
  'Western',
];
const PREVIEW_SERIES_GENRES = [...PREVIEW_MOVIE_GENRES, 'Game-Show', 'Reality-TV', 'Talk-Show'];
const PREVIEW_BROWSE_GENRES = {
  all: PREVIEW_SERIES_GENRES,
  movie: PREVIEW_MOVIE_GENRES,
  series: PREVIEW_SERIES_GENRES,
  anime: PREVIEW_SERIES_GENRES.filter((genre) => genre.toLowerCase() !== 'animation'),
};

// Mirrors the backend's closed language set.
const PREVIEW_SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ja', label: 'Japanese' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
];

function readStringArg(args: PreviewInvokeArgs, key: string, fallback: string): string {
  const value = args?.[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function readPreviewMediaItem(value: unknown): MediaItem {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    !('title' in value) ||
    typeof value.title !== 'string' ||
    !('type' in value) ||
    (value.type !== 'movie' && value.type !== 'series')
  ) {
    throw new Error('Invalid media item');
  }
  return toMediaItem(value as MediaItem);
}

function readPreviewItems(args: PreviewInvokeArgs): MediaItem[] {
  if (!Array.isArray(args?.items)) throw new Error('Media items are required');
  return [
    ...new Map(
      args.items.map((value: unknown) => {
        const item = readPreviewMediaItem(value);
        return [item.id, item] as const;
      }),
    ).values(),
  ];
}

function readPreviewWatchStatus(args: PreviewInvokeArgs): WatchStatus | null {
  const status = args?.status;
  if (
    status === null ||
    status === 'watching' ||
    status === 'watched' ||
    status === 'plan_to_watch' ||
    status === 'dropped'
  )
    return status;
  throw new Error('Invalid watch status');
}

function addPreviewLibraryItem(item: MediaItem): boolean {
  if (previewLibrary.some((entry) => entry.id === item.id)) return false;
  previewLibrary = [...previewLibrary, item];
  return true;
}

function removePreviewLibraryItems(ids: ReadonlySet<string>): number {
  const previousCount = previewLibrary.length;
  previewLibrary = previewLibrary.filter((item) => !ids.has(item.id));
  previewWatchStatuses = Object.fromEntries(
    Object.entries(previewWatchStatuses).filter(([id]) => !ids.has(id)),
  );
  return previousCount - previewLibrary.length;
}

function addPreviewListItems(listId: string, items: MediaItem[]): number {
  const list = previewLists.find((entry) => entry.id === listId);
  if (!list) throw new Error('List not found');
  const existingIds = new Set(list.item_ids);
  const additions = items.filter((item) => {
    if (existingIds.has(item.id)) return false;
    existingIds.add(item.id);
    return true;
  });
  previewLists = previewLists.map((entry) =>
    entry.id === listId
      ? {
          ...entry,
          item_ids: [...entry.item_ids, ...additions.map((item) => item.id)],
          items: [...(entry.items ?? []), ...additions],
        }
      : entry,
  );
  return additions.length;
}

function readMediaType(args: PreviewInvokeArgs): 'movie' | 'series' {
  // Exact camelCase only — snake_case fallbacks would hide the IPC naming drift this mock surfaces.
  const value = args?.mediaType;
  if (typeof value !== 'string') {
    return 'movie';
  }

  const normalized = value.trim().toLowerCase();
  return normalized === 'movie' ? 'movie' : 'series';
}

function readFiniteNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// Mirrors `apply_app_ui_preferences_patch`: absent keys keep current value; invalid numerics fall to defaults.
function mergePreviewAppUiPreferences(patch: Record<string, unknown>) {
  const current = previewAppUiPreferences;
  const volume = readFiniteNumber(patch, 'playerVolume');
  const speed = readFiniteNumber(patch, 'playerSpeed');
  const delay = readFiniteNumber(patch, 'subtitleDelay');
  const pos = readFiniteNumber(patch, 'subtitlePos');
  const scale = readFiniteNumber(patch, 'subtitleScale');

  previewAppUiPreferences = {
    playerVolume: volume === undefined ? current.playerVolume : clamp(Math.round(volume), 0, 100),
    playerSpeed: speed === undefined ? current.playerSpeed : speed > 0 ? clamp(speed, 0.25, 4) : 1,
    spoilerProtection:
      typeof patch.spoilerProtection === 'boolean'
        ? patch.spoilerProtection
        : current.spoilerProtection,
    autoPlayNext:
      typeof patch.autoPlayNext === 'boolean' ? patch.autoPlayNext : current.autoPlayNext,
    nextEpisodeCountdownSecs:
      (patch.nextEpisodeCountdownSecs as number | undefined) ?? current.nextEpisodeCountdownSecs,
    controlsHideDelayMs:
      (patch.controlsHideDelayMs as number | undefined) ?? current.controlsHideDelayMs,
    trailerPreviews:
      typeof patch.trailerPreviews === 'boolean' ? patch.trailerPreviews : current.trailerPreviews,
    autoSkipIntro:
      typeof patch.autoSkipIntro === 'boolean' ? patch.autoSkipIntro : current.autoSkipIntro,
    closeToTray: typeof patch.closeToTray === 'boolean' ? patch.closeToTray : current.closeToTray,
    minimizeToTray:
      typeof patch.minimizeToTray === 'boolean' ? patch.minimizeToTray : current.minimizeToTray,
    startMinimized:
      typeof patch.startMinimized === 'boolean' ? patch.startMinimized : current.startMinimized,
    startupPage:
      patch.startupPage === undefined
        ? current.startupPage
        : patch.startupPage === 'library' ||
            patch.startupPage === 'calendar' ||
            patch.startupPage === 'lastVisited'
          ? patch.startupPage
          : 'home',
    lastLocation:
      patch.lastLocation === undefined
        ? current.lastLocation
        : typeof patch.lastLocation === 'string' &&
            [...patch.lastLocation].length <= 512 &&
            /^\/(?:[?#]|$|(?:search|details|profile|library|calendar|settings)(?:[/?#]|$))/.test(
              patch.lastLocation,
            ) &&
            !/[\p{Cc}\\]/u.test(patch.lastLocation) &&
            !patch.lastLocation.includes('//') &&
            !patch.lastLocation.includes('..')
          ? patch.lastLocation
          : null,
    subtitleDelay:
      delay === undefined ? current.subtitleDelay : Math.round(clamp(delay, -5, 5) * 10) / 10,
    subtitlePos: pos === undefined ? current.subtitlePos : clamp(pos, 0, 100),
    subtitleScale:
      scale === undefined
        ? current.subtitleScale
        : scale > 0
          ? Math.round(clamp(scale, 0.25, 3) * 20) / 20
          : 1.0,
    // Preview trusts the settings UI, which only writes normalized keys.
    playerKeybindings:
      patch.playerKeybindings && typeof patch.playerKeybindings === 'object'
        ? (patch.playerKeybindings as Record<string, string[]>)
        : current.playerKeybindings,
  };
}

// Mirrors `apply_addon_configs_op` without validation — enough for settings edits to round-trip in preview.
function applyPreviewAddonConfigsOp(op: AddonConfigsOp) {
  switch (op.kind) {
    case 'add': {
      previewAddonConfigSeq += 1;
      previewAddonConfigs = [
        ...previewAddonConfigs,
        {
          id: `preview-addon-${previewAddonConfigSeq}`,
          url: op.url,
          name: '',
          enabled: true,
          displayUrl: op.url,
          pinned: false,
        },
      ];
      return;
    }
    case 'remove':
      previewAddonConfigs = previewAddonConfigs.filter((config) => config.id !== op.id);
      return;
    case 'setEnabled':
      previewAddonConfigs = previewAddonConfigs.map((config) =>
        config.id === op.id ? { ...config, enabled: op.enabled } : config,
      );
      return;
    case 'reorder': {
      // reorder_known_ids merge: requested ids first, omitted ids keep relative order at the tail.
      const byId = new Map(previewAddonConfigs.map((config) => [config.id, config]));
      const ordered = op.ids.flatMap((id) => {
        const config = byId.get(id);
        byId.delete(id);
        return config ? [config] : [];
      });
      previewAddonConfigs = [...ordered, ...byId.values()];
      return;
    }
  }
}

export async function handlePreviewInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  switch (command) {
    case 'query_search_catalog':
      return EMPTY_SEARCH_CATALOG_PAGE as T;
    case 'get_app_ui_preferences':
      return previewAppUiPreferences as T;
    case 'get_launch_at_login':
      return previewLaunchAtLogin as T;
    case 'set_launch_at_login':
      previewLaunchAtLogin = args?.enabled === true;
      return previewLaunchAtLogin as T;
    case 'hide_main_window_to_tray':
      return undefined as T;
    case 'save_app_ui_preferences': {
      const patch = typeof args?.patch === 'object' && args.patch !== null ? args.patch : {};
      mergePreviewAppUiPreferences(patch as Record<string, unknown>);
      return previewAppUiPreferences as T;
    }
    case 'get_profile_preferences':
      return previewProfilePreferences as T;
    case 'save_profile_preferences': {
      const patch = (args?.patch ?? {}) as Omit<ProfilePreferencesPatch, 'avatar'> & {
        avatar?: string | null;
      };
      const { viewMode, avatar, ...profile } = patch;
      // Preview only displays edits; persistence and validation belong to Rust.
      previewProfilePreferences = {
        profile: {
          ...previewProfilePreferences.profile,
          ...profile,
          avatar:
            'avatar' in patch ? (avatar ?? undefined) : previewProfilePreferences.profile.avatar,
          accentTargets: {
            ...previewProfilePreferences.profile.accentTargets,
            ...profile.accentTargets,
          },
        },
        viewMode: viewMode ?? previewProfilePreferences.viewMode,
      };
      return previewProfilePreferences as T;
    }
    case 'get_stream_selector_preferences':
      return {
        preferences: previewStreamSelectorPreferences,
        initialized: true,
      } as T;
    case 'save_stream_selector_preferences': {
      const preferences = (
        typeof args?.preferences === 'object' && args.preferences !== null ? args.preferences : {}
      ) as Record<string, unknown>;
      previewStreamSelectorPreferences = {
        quality:
          typeof preferences.quality === 'string'
            ? preferences.quality
            : previewStreamSelectorPreferences.quality,
        source:
          typeof preferences.source === 'string'
            ? preferences.source
            : previewStreamSelectorPreferences.source,
        addon: typeof preferences.addon === 'string' ? preferences.addon.trim() || 'all' : 'all',
        sort:
          typeof preferences.sort === 'string'
            ? preferences.sort
            : previewStreamSelectorPreferences.sort,
        batch:
          typeof preferences.batch === 'string'
            ? preferences.batch
            : previewStreamSelectorPreferences.batch,
      };
      return previewStreamSelectorPreferences as T;
    }
    case 'get_skip_times':
      return { segments: [] } as T;
    case 'get_watch_history':
    case 'get_resume_rail':
    case 'query_similar_titles':
      return [] as T;
    case 'get_total_watch_time_secs':
      return 0 as T;
    case 'get_recent_watch_seed':
      return null as T;
    case 'get_library':
      return previewLibrary as T;
    case 'get_profile_library': {
      const filters = (args?.filters ?? {}) as LibraryFilters;
      const query = filters.query?.trim().toLowerCase() ?? '';
      const statusCounts: ProfileLibrary['statusCounts'] = {
        watching: 0,
        watched: 0,
        plan_to_watch: 0,
        dropped: 0,
        none: 0,
      };
      for (const item of previewLibrary) {
        statusCounts[previewWatchStatuses[item.id] ?? 'none'] += 1;
      }
      const items = previewLibrary.filter(
        (item) =>
          (!filters.type || filters.type === 'all' || item.type === filters.type) &&
          (!filters.status ||
            filters.status === 'all' ||
            (previewWatchStatuses[item.id] ?? 'none') === filters.status) &&
          item.title.toLowerCase().includes(query),
      );
      items.sort((a, b) => {
        if (filters.sort === 'year-asc' || filters.sort === 'year-desc') {
          if (a.primaryYear !== b.primaryYear) {
            if (a.primaryYear === undefined) return 1;
            if (b.primaryYear === undefined) return -1;
            return filters.sort === 'year-desc'
              ? b.primaryYear - a.primaryYear
              : a.primaryYear - b.primaryYear;
          }
        }
        return (
          a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.id.localeCompare(b.id)
        );
      });
      if (filters.sort === 'title-desc') items.reverse();
      return { items, statusCounts } as T;
    }
    case 'add_to_library':
      addPreviewLibraryItem(readPreviewMediaItem(args?.item));
      return undefined as T;
    case 'remove_from_library':
      removePreviewLibraryItems(new Set([readStringArg(args, 'id', '')]));
      return undefined as T;
    case 'bulk_remove_from_library': {
      if (
        !Array.isArray(args?.ids) ||
        !args.ids.every((id: unknown) => typeof id === 'string' && id.trim().length > 0)
      ) {
        throw new Error('Media IDs are required');
      }
      return removePreviewLibraryItems(new Set(args.ids as string[])) as T;
    }
    case 'set_watch_status': {
      const item = readPreviewMediaItem(args?.item);
      const status = readPreviewWatchStatus(args);
      if (status === null) {
        delete previewWatchStatuses[item.id];
        return null as T;
      }
      const added = addPreviewLibraryItem(item);
      previewWatchStatuses[item.id] = status;
      return (added ? item : null) as T;
    }
    case 'bulk_set_watch_status': {
      const items = readPreviewItems(args);
      const status = readPreviewWatchStatus(args);
      let count = 0;
      for (const item of items) {
        if (status === null) {
          if (Object.hasOwn(previewWatchStatuses, item.id)) {
            delete previewWatchStatuses[item.id];
            count += 1;
          }
        } else {
          addPreviewLibraryItem(item);
          previewWatchStatuses[item.id] = status;
          count += 1;
        }
      }
      return count as T;
    }
    case 'get_lists':
      return previewLists as T;
    case 'get_list_summaries':
      return previewLists.map((list) => ({
        id: list.id,
        name: list.name,
        icon: list.icon,
        item_count: list.item_ids.length,
        contains_item: list.item_ids.includes(readStringArg(args, 'itemId', '').trim()),
      })) as T;
    case 'create_list': {
      previewListSeq += 1;
      const list: UserList = {
        id: `preview-list-${previewListSeq}`,
        name: readStringArg(args, 'name', 'Untitled list'),
        icon: readStringArg(args, 'icon', 'list'),
        item_ids: [],
      };
      previewLists = [...previewLists, { ...list, items: [] }];
      return list as T;
    }
    case 'delete_list':
      previewLists = previewLists.filter((list) => list.id !== args?.listId);
      return undefined as T;
    case 'rename_list':
      previewLists = previewLists.map((list) =>
        list.id === args?.listId
          ? {
              ...list,
              name: readStringArg(args, 'name', list.name),
              icon: readStringArg(args, 'icon', list.icon),
            }
          : list,
      );
      return undefined as T;
    case 'add_to_list':
      addPreviewListItems(readStringArg(args, 'listId', ''), [readPreviewMediaItem(args?.item)]);
      return undefined as T;
    case 'bulk_add_to_list':
      return addPreviewListItems(readStringArg(args, 'listId', ''), readPreviewItems(args)) as T;
    case 'remove_from_list':
      previewLists = previewLists.map((list) =>
        list.id === args?.listId
          ? {
              ...list,
              item_ids: list.item_ids.filter((id) => id !== args?.itemId),
              items: list.items?.filter((item) => item.id !== args?.itemId),
            }
          : list,
      );
      return undefined as T;
    case 'clear_library':
      previewLibrary = [];
      previewWatchStatuses = {};
      return undefined as T;
    case 'clear_all_watch_statuses':
      previewWatchStatuses = {};
      return undefined as T;
    case 'clear_all_lists':
      previewLists = [];
      return undefined as T;
    case 'get_calendar_events':
      return { trackedCount: 0, days: [], upcoming: [] } as T;
    case 'get_title_watch_progress':
    case 'set_episodes_watched':
      return {
        episodeProgress: {},
        watchedEpisodeCeiling: {},
      } as T;
    case 'get_details_prefetch_bundle':
      // No card payload in preview — the mounted details query fetches it.
      return {
        progress: {
          episodeProgress: {},
          watchedEpisodeCeiling: {},
        },
      } as T;
    case 'get_stream_selector_data':
      return EMPTY_STREAM_SELECTOR_DATA as T;
    case 'get_media_details':
      return {
        id: readStringArg(args, 'id', 'mock-id'),
        title: 'Browser Preview',
        type: readMediaType(args),
        description: 'Desktop-backed metadata is unavailable in browser preview mode.',
        year: '2026',
        episodes: [],
      } as T;
    case 'get_playback_language_preferences':
    case 'get_effective_playback_language_preferences':
      return previewPlaybackLanguagePreferences as T;
    case 'save_playback_language_preference': {
      const language = typeof args?.language === 'string' ? args.language : undefined;
      if (args?.preferenceKind === 'audio') {
        previewPlaybackLanguagePreferences.preferredAudioLanguage = language;
      } else {
        previewPlaybackLanguagePreferences.preferredSubtitleLanguage = language;
      }
      return previewPlaybackLanguagePreferences as T;
    }
    case 'resolve_preferred_track_selection':
      return {
        selectedMatches: false,
      } as T;
    case 'get_addon_configs':
      return previewAddonConfigs as T;
    case 'update_addon_configs': {
      const op =
        typeof args?.op === 'object' && args.op !== null ? (args.op as AddonConfigsOp) : null;
      if (op) applyPreviewAddonConfigsOp(op);
      return previewAddonConfigs as T;
    }
    case 'inspect_addon_url':
      return {
        configurePage: false,
        error: 'Addon URLs are validated by the desktop app.',
      } as T;
    case 'get_browse_genres':
      return PREVIEW_BROWSE_GENRES as T;
    case 'get_all_watch_statuses':
      return { ...previewWatchStatuses } as T;
    case 'get_watch_progress':
    case 'recover_playback_stream':
      return null as T;
    case 'remove_all_from_watch_history':
      // The command returns the rows it deleted — preview holds no history.
      return [] as T;
    case 'build_history_playback_plan': {
      const item =
        typeof args?.item === 'object' && args?.item !== null
          ? (args.item as Record<string, unknown>)
          : null;
      const mediaId = typeof item?.id === 'string' && item.id.trim() ? item.id : 'mock-id';
      const itemType = typeof item?.type_ === 'string' ? item.type_.trim().toLowerCase() : 'movie';
      const mediaType = mediaId.startsWith('kitsu:')
        ? 'anime'
        : itemType === 'movie'
          ? 'movie'
          : 'series';
      const absoluteSeason =
        typeof item?.absolute_season === 'number'
          ? item.absolute_season
          : typeof item?.season === 'number'
            ? item.season
            : undefined;
      const absoluteEpisode =
        typeof item?.absolute_episode === 'number'
          ? item.absolute_episode
          : typeof item?.episode === 'number'
            ? item.episode
            : undefined;
      const from = readStringArg(args, 'from', '/');

      if (
        mediaType !== 'movie' &&
        (typeof absoluteSeason !== 'number' || typeof absoluteEpisode !== 'number')
      ) {
        return {
          kind: 'details',
          reason: 'missing-episode-context',
          target: `/details/${mediaType}/${encodeURIComponent(mediaId)}`,
          state: { from, season: absoluteSeason },
        } as T;
      }

      // Route state carries opaque identities, never stream URLs; mirrors the backend's media-id lookup fallback.
      const target =
        typeof absoluteSeason === 'number' && typeof absoluteEpisode === 'number'
          ? `/player/${mediaType}/${encodeURIComponent(mediaId)}/${absoluteSeason}/${absoluteEpisode}`
          : `/player/${mediaType}/${encodeURIComponent(mediaId)}`;

      const state: HistoryPlaybackPlan['state'] = {
        from,
        title: typeof item?.title === 'string' ? item.title : undefined,
        poster: typeof item?.poster === 'string' ? item.poster : undefined,
        backdrop: typeof item?.backdrop === 'string' ? item.backdrop : undefined,
        streamSourceId: typeof item?.source_id === 'string' ? item.source_id : undefined,
        streamSourceName: typeof item?.source_name === 'string' ? item.source_name : undefined,
        streamFamily: typeof item?.stream_family === 'string' ? item.stream_family : undefined,
        selectedStreamKey:
          typeof item?.last_stream_key === 'string' ? item.last_stream_key : undefined,
        startTime: typeof item?.resume_start_time === 'number' ? item.resume_start_time : undefined,
        absoluteSeason,
        absoluteEpisode,
        streamSeason: typeof item?.stream_season === 'number' ? item.stream_season : absoluteSeason,
        streamEpisode:
          typeof item?.stream_episode === 'number' ? item.stream_episode : absoluteEpisode,
        resumeFromHistory: true,
        streamLookupId:
          typeof item?.last_stream_lookup_id === 'string' && item.last_stream_lookup_id.trim()
            ? item.last_stream_lookup_id
            : mediaId,
      };
      const plan: HistoryPlaybackPlan = {
        kind: 'player',
        target,
        state,
        warmResolveRequest: {
          mediaType,
          mediaId: mediaId.trim(),
          streamLookupId: state.streamLookupId,
          streamSeason: state.streamSeason,
          streamEpisode: state.streamEpisode,
          absoluteSeason,
          absoluteEpisode,
          title: state.title || undefined,
          preferred: {
            streamKey: state.selectedStreamKey,
            sourceId: state.streamSourceId,
            sourceName: state.streamSourceName,
            streamFamily: state.streamFamily,
          },
        },
      };
      return plan as T;
    }
    case 'get_data_stats':
      return {
        history_count: 0,
        history_title_count: 0,
        has_learned_playback_data: false,
        library_count: previewLibrary.length,
        lists_count: previewLists.length,
        watch_statuses_count: Object.keys(previewWatchStatuses).length,
      } as T;
    case 'save_selected_playback_language_preference':
      // No scoped row in preview — `effective` stays absent, matching the backend's missing-scope contract.
      return { preferences: {} } as T;
    case 'save_playback_language_preference_outcome_from_tracks':
      return undefined as T;
    case 'get_supported_languages':
      return PREVIEW_SUPPORTED_LANGUAGES as T;
    default:
      throw new Error(
        `Command "${command}" is unavailable in browser preview. Run the Tauri desktop app for this path.`,
      );
  }
}
