import {
  type AddonConfig,
  type AddonConfigsOp,
  type AddonSubtitle,
  type AppUiPreferences,
  DEFAULT_APP_UI_PREFERENCES,
  type HistoryPlaybackPlan,
  type LibraryFilters,
  type MediaItem,
  type PlaybackLanguagePreferences,
  type ProfileLibrary,
  type ProfilePreferences,
  type ProfilePreferencesPatch,
  type SmartListRules,
  type StreamSelectorData,
  type StreamSelectorPreferences,
  type StreamSelectorPreferencesState,
  type UserList,
  type WatchProgress,
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
      skip: true,
    },
  },
  viewMode: 'grid',
};
const PREVIEW_PLAYER_KEYBINDINGS: Record<string, string[]> = {
  togglePlay: [' ', 'k'],
  seekBackward: ['arrowleft', 'j'],
  seekForward: ['arrowright', 'l'],
  volumeUp: ['arrowup'],
  volumeDown: ['arrowdown'],
  toggleMute: ['m'],
  toggleFullscreen: ['f'],
  speedDown: ['['],
  speedUp: [']'],
  speedReset: ['\\'],
  cycleSubtitles: ['c'],
  cycleAudio: ['a'],
  subtitleEarlier: ['z'],
  subtitleLater: ['x'],
  skipSegment: ['s', 'enter'],
  previousEpisode: ['p'],
  nextEpisode: ['n'],
  episodes: ['e'],
  streamSelector: ['q'],
  dock: ['i'],
  shortcuts: ['?'],
};
let previewAppUiPreferences: AppUiPreferences = structuredClone({
  ...DEFAULT_APP_UI_PREFERENCES,
  effectivePlayerKeybindings: PREVIEW_PLAYER_KEYBINDINGS,
  defaultPlayerKeybindings: PREVIEW_PLAYER_KEYBINDINGS,
});
const PREVIEW_STREAM_SELECTOR_DEFAULTS: StreamSelectorPreferences = {
  quality: 'all',
  source: 'all',
  addon: 'all',
  sort: 'smart',
  batch: 'all',
};
const PREVIEW_STREAM_SELECTOR_PREFERENCES: StreamSelectorPreferencesState = {
  initialized: false,
  preferences: PREVIEW_STREAM_SELECTOR_DEFAULTS,
  defaultPreferences: PREVIEW_STREAM_SELECTOR_DEFAULTS,
  episodeDefaultPreferences: { ...PREVIEW_STREAM_SELECTOR_DEFAULTS, batch: 'episodes' },
};
let previewLaunchAtLogin = false;
let previewPlaybackLanguagePreferences: PlaybackLanguagePreferences = {};
let previewAddonConfigs: AddonConfig[] = [];
const previewAddonUrls = new Map<string, string>();
let previewAddonConfigSeq = 0;
let previewLibrary: MediaItem[] = [];
let previewWatchStatuses: Record<string, WatchStatus> = {};
const previewStatusAdded = new Set<string>();
let previewLists: UserList[] = [];
let previewListSeq = 0;

function getPreviewLibraryStatusCounts(): ProfileLibrary['statusCounts'] {
  const counts: ProfileLibrary['statusCounts'] = {
    watching: 0,
    watched: 0,
    plan_to_watch: 0,
    dropped: 0,
    none: 0,
  };
  for (const item of previewLibrary) {
    counts[previewWatchStatuses[item.id] ?? 'none'] += 1;
  }
  return counts;
}

const EMPTY_SEARCH_CATALOG_PAGE = {
  items: [
    {
      id: 'probe-1',
      title: 'Probe Title One',
      type: 'movie',
      displayYear: '2024',
      genres: ['Drama', 'Thriller'],
      description:
        'A deliberately long synopsis used only to measure how the hover panel behaves when a title carries a lot of text so that wrapping changes height.',
      poster: 'https://picsum.photos/seed/probe1/400/600',
      backdrop: 'https://picsum.photos/seed/probe1b/800/450',
    },
    {
      id: 'probe-2',
      title: 'Probe Title Two',
      type: 'series',
      displayYear: '2023',
      genres: ['Comedy'],
      description: 'Short.',
      poster: 'https://picsum.photos/seed/probe2/400/600',
      backdrop: 'https://picsum.photos/seed/probe2b/800/450',
    },
  ],
  continuation: { seenKeys: [] },
  exhausted: true,
  partial: false,
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
  for (const id of ids) previewStatusAdded.delete(id);
  previewWatchStatuses = Object.fromEntries(
    Object.entries(previewWatchStatuses).filter(([id]) => !ids.has(id)),
  );
  return previousCount - previewLibrary.length;
}

function addPreviewListItems(listId: string, items: MediaItem[]): number {
  const list = previewLists.find((entry) => entry.id === listId);
  if (!list) throw { kind: 'list_not_found', message: 'List not found' };
  if (list.rules)
    throw { kind: 'smart_list_read_only', message: 'Smart lists update automatically.' };
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
  const audioDelay = readFiniteNumber(patch, 'audioDelay');
  const delay = readFiniteNumber(patch, 'subtitleDelay');
  const pos = readFiniteNumber(patch, 'subtitlePos');
  const scale = readFiniteNumber(patch, 'subtitleScale');
  // Preview trusts the settings UI, which only writes normalized keys.
  const overrides =
    patch.playerKeybindings && typeof patch.playerKeybindings === 'object'
      ? (patch.playerKeybindings as Record<string, string[]>)
      : current.playerKeybindings;
  const claimedKeys = new Set(Object.values(overrides).flat());

  previewAppUiPreferences = {
    ...current,
    playerVolume: volume === undefined ? current.playerVolume : clamp(Math.round(volume), 0, 100),
    playerSpeed: speed === undefined ? current.playerSpeed : speed > 0 ? clamp(speed, 0.25, 4) : 1,
    audioDelay:
      audioDelay === undefined
        ? current.audioDelay
        : Math.round(clamp(audioDelay, -5, 5) * 10) / 10,
    nextEpisodeCountdownSecs:
      (patch.nextEpisodeCountdownSecs as number | undefined) ?? current.nextEpisodeCountdownSecs,
    controlsHideDelayMs:
      (patch.controlsHideDelayMs as number | undefined) ?? current.controlsHideDelayMs,
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
    subtitleFont:
      patch.subtitleFont === undefined
        ? current.subtitleFont
        : ((
            [
              'modern',
              'grotesk',
              'humanist',
              'classic',
              'screen',
              'serif',
              'book',
              'rounded',
              'mono',
            ] as const
          ).find((font) => font === patch.subtitleFont) ?? 'default'),
    subtitleColor:
      patch.subtitleColor === undefined
        ? current.subtitleColor
        : ((['gray', 'yellow', 'cyan', 'green', 'red', 'orange', 'blue', 'pink'] as const).find(
            (color) => color === patch.subtitleColor,
          ) ?? 'white'),
    subtitleEdge:
      patch.subtitleEdge === undefined
        ? current.subtitleEdge
        : ((['none', 'thick', 'shadow', 'box'] as const).find(
            (edge) => edge === patch.subtitleEdge,
          ) ?? 'outline'),
    playerKeybindings: overrides,
    recentSearches: Array.isArray(patch.recentSearches)
      ? (patch.recentSearches as string[])
      : current.recentSearches,
    effectivePlayerKeybindings: Object.fromEntries(
      Object.entries(PREVIEW_PLAYER_KEYBINDINGS).map(([action, keys]) => [
        action,
        overrides[action] ?? keys.filter((key) => !claimedKeys.has(key)),
      ]),
    ),
    defaultPlayerKeybindings: PREVIEW_PLAYER_KEYBINDINGS,
  };
  for (const key of [
    'nightMode',
    'spoilerProtection',
    'autoPlayNext',
    'trailerPreviews',
    'autoSkipIntro',
    'autoLoadAddonSubtitles',
    'subtitleBold',
    'subtitleItalic',
    'automaticUpdateChecks',
    'closeToTray',
    'minimizeToTray',
    'startMinimized',
  ] as const) {
    if (typeof patch[key] === 'boolean') previewAppUiPreferences[key] = patch[key];
  }
}

// Mirrors `apply_addon_configs_op` without validation — enough for settings edits to round-trip in preview.
function applyPreviewAddonConfigsOp(op: AddonConfigsOp) {
  switch (op.kind) {
    case 'add': {
      previewAddonConfigSeq += 1;
      const id = `preview-addon-${previewAddonConfigSeq}`;
      previewAddonUrls.set(id, op.url);
      previewAddonConfigs = [
        ...previewAddonConfigs,
        {
          id,
          name: '',
          enabled: true,
          displayUrl: op.url,
          pinned: false,
          configurable: false,
        },
      ];
      return;
    }
    case 'remove':
      previewAddonUrls.delete(op.id);
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
    case 'get_stream_selector_preferences':
      return PREVIEW_STREAM_SELECTOR_PREFERENCES as T;
    case 'get_default_player_keybindings':
      return PREVIEW_PLAYER_KEYBINDINGS as T;
    case 'get_bootstrap_snapshot':
      return {
        profilePreferences: previewProfilePreferences,
        appUiPreferences: previewAppUiPreferences,
        streamSelectorPreferences: PREVIEW_STREAM_SELECTOR_PREFERENCES,
        startupRoute: null,
      } as T;
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
    case 'record_recent_search': {
      // Mirrors `push_recent_search`.
      const query =
        typeof args?.query === 'string' ? args.query.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
      if (query) {
        previewAppUiPreferences = {
          ...previewAppUiPreferences,
          recentSearches: [
            query,
            ...previewAppUiPreferences.recentSearches.filter(
              (entry) => entry.toLowerCase() !== query.toLowerCase(),
            ),
          ].slice(0, 8),
        };
      }
      return previewAppUiPreferences as T;
    }
    case 'get_profile_preferences':
      return previewProfilePreferences as T;
    case 'set_profile_avatar_from_bytes':
      throw new Error('Profile photo updates require the desktop app');
    case 'clear_profile_avatar':
      previewProfilePreferences = {
        ...previewProfilePreferences,
        profile: { ...previewProfilePreferences.profile, avatar: undefined },
      };
      return previewProfilePreferences as T;
    case 'save_profile_preferences': {
      const { viewMode, ...profile } = (args?.patch ?? {}) as ProfilePreferencesPatch;
      // Preview only displays edits; persistence and validation belong to Rust.
      previewProfilePreferences = {
        profile: {
          ...previewProfilePreferences.profile,
          ...profile,
          accentTargets: {
            ...previewProfilePreferences.profile.accentTargets,
            ...profile.accentTargets,
          },
        },
        viewMode: viewMode ?? previewProfilePreferences.viewMode,
      };
      return previewProfilePreferences as T;
    }
    case 'get_skip_times':
      return { segments: [] } as T;
    case 'get_watch_history':
    case 'get_resume_rail':
    case 'query_similar_titles':
    case 'search_episodes':
      return [] as T;
    case 'search_titles': {
      const titles = (args?.titles ?? []) as string[];
      const query = String(args?.query ?? '')
        .trim()
        .toLowerCase();
      return titles.flatMap((title, index) =>
        title.toLowerCase().includes(query) ? [index] : [],
      ) as T;
    }
    case 'get_total_watch_time_secs':
      return 0 as T;
    case 'get_recent_watch_seed':
      return null as T;
    case 'get_library':
      return previewLibrary as T;
    case 'get_library_genres': {
      const genres = new Map<string, string>();
      for (const item of previewLibrary.toSorted(
        (a, b) =>
          a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.id.localeCompare(b.id),
      )) {
        for (const genre of item.genres ?? []) {
          const normalized = genre.trim().toLowerCase();
          if (!genres.has(normalized)) genres.set(normalized, genre);
        }
      }
      return [...genres.entries()]
        .toSorted(([a], [b]) => (a < b ? -1 : Number(a > b)))
        .map(([, genre]) => genre) as T;
    }
    case 'get_profile_library': {
      const filters = (args?.filters ?? {}) as LibraryFilters;
      const query = filters.query?.trim().toLowerCase() ?? '';
      const statusCounts = getPreviewLibraryStatusCounts();
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
      return { items, allIds: previewLibrary.map((item) => item.id).toSorted(), statusCounts } as T;
    }
    case 'add_to_library': {
      const item = readPreviewMediaItem(args?.item);
      addPreviewLibraryItem(item);
      previewStatusAdded.delete(item.id);
      return previewLibrary.find((entry) => entry.id === item.id) as T;
    }
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
        if (previewStatusAdded.has(item.id)) removePreviewLibraryItems(new Set([item.id]));
        return (previewLibrary.find((entry) => entry.id === item.id) ?? null) as T;
      }
      if (addPreviewLibraryItem(item)) previewStatusAdded.add(item.id);
      previewWatchStatuses[item.id] = status;
      return previewLibrary.find((entry) => entry.id === item.id) as T;
    }
    case 'bulk_set_watch_status': {
      const ids = new Set(Array.isArray(args?.ids) ? args.ids : []);
      const items = previewLibrary.filter((item) => ids.has(item.id));
      const status = readPreviewWatchStatus(args);
      let count = 0;
      for (const item of items) {
        if (status === null) {
          previewStatusAdded.delete(item.id);
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
        is_smart: Boolean(list.rules),
      })) as T;
    case 'create_list': {
      previewListSeq += 1;
      const list: UserList = {
        id: `preview-list-${previewListSeq}`,
        name: readStringArg(args, 'name', 'Untitled list'),
        icon: readStringArg(args, 'icon', 'list'),
        item_ids: [],
        rules: args?.rules as SmartListRules | undefined,
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
              rules: list.rules
                ? ((args?.rules as SmartListRules | undefined) ?? list.rules)
                : undefined,
            }
          : list,
      );
      return undefined as T;
    case 'add_to_list': {
      const listId = readStringArg(args, 'listId', '');
      addPreviewListItems(listId, [readPreviewMediaItem(args?.item)]);
      const list = previewLists.find((entry) => entry.id === listId);
      if (!list) throw { kind: 'list_not_found', message: 'List not found' };
      return {
        id: list.id,
        name: list.name,
        icon: list.icon,
        item_count: list.item_ids.length,
        contains_item: true,
        is_smart: false,
      } as T;
    }
    case 'bulk_add_to_list':
      return addPreviewListItems(
        readStringArg(args, 'listId', ''),
        Array.isArray(args?.itemIds)
          ? previewLibrary.filter((item) => (args.itemIds as string[]).includes(item.id))
          : [],
      ) as T;
    case 'bulk_remove_from_list': {
      const ids = new Set(Array.isArray(args?.itemIds) ? args.itemIds : []);
      const list = previewLists.find((entry) => entry.id === args?.listId);
      if (!list) throw { kind: 'list_not_found', message: 'List not found' };
      if (list.rules)
        throw { kind: 'smart_list_read_only', message: 'Smart lists update automatically.' };
      const entries = (list.items ?? []).flatMap((item) =>
        ids.has(item.id) ? [{ item, index: list.item_ids.indexOf(item.id) }] : [],
      );
      previewLists = previewLists.map((entry) =>
        entry.id === list.id
          ? {
              ...entry,
              item_ids: entry.item_ids.filter((id) => !ids.has(id)),
              items: entry.items?.filter((item) => !ids.has(item.id)),
            }
          : entry,
      );
      return entries as T;
    }
    case 'restore_list_items': {
      const entries = args?.entries as { item: MediaItem; index: number }[];
      previewLists = previewLists.map((list) => {
        if (list.id !== args?.listId) return list;
        if (list.rules)
          throw { kind: 'smart_list_read_only', message: 'Smart lists update automatically.' };
        const items = [...(list.items ?? [])];
        const itemIds = [...list.item_ids];
        for (const entry of entries.toSorted((a, b) => a.index - b.index)) {
          if (itemIds.includes(entry.item.id)) continue;
          itemIds.splice(entry.index, 0, entry.item.id);
          items.splice(entry.index, 0, entry.item);
        }
        return { ...list, item_ids: itemIds, items };
      });
      return undefined as T;
    }
    case 'remove_from_list':
      previewLists = previewLists.map((list) =>
        list.id === args?.listId && !list.rules
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
      previewStatusAdded.clear();
      return undefined as T;
    case 'clear_all_watch_statuses':
      previewWatchStatuses = {};
      previewStatusAdded.clear();
      return undefined as T;
    case 'clear_all_lists':
      previewLists = [];
      return undefined as T;
    case 'get_calendar_events':
      return { trackedCount: 0, days: [], upcoming: [] } as T;
    case 'get_title_watch_progress':
      return {
        episodeProgress: {},
        watchedEpisodeCeiling: {},
      } as T;
    case 'set_episodes_watched':
      return [{ episodeProgress: {}, watchedEpisodeCeiling: {} }, []] as T;
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
    case 'get_addon_subtitles':
      return [
        {
          id: 'preview-subtitle',
          selectionKey:
            '["preview-addon","preview-subtitle","https://subtitles.invalid/preview.srt","eng"]',
          url: 'https://subtitles.invalid/preview.srt',
          lang: 'eng',
          label: 'Browser.Preview_English.srt',
          detail: 'Browser.Preview_English',
          mpvTitle: 'Browser.Preview_English.srt',
          sourceId: 'preview-addon',
          sourceName: 'Browser Preview',
        } satisfies AddonSubtitle,
      ] as T;
    case 'get_episode_navigation':
      return { previousIndex: null, nextIndex: null } as T;
    case 'get_unaired_episode_indices':
      return [] as T;
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
    case 'get_addon_url': {
      const url = previewAddonUrls.get(readStringArg(args, 'id', ''));
      if (url === undefined) throw new Error('Addon not found.');
      return url as T;
    }
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
    case 'cancel_stream_request':
    case 'set_continue_watching_dismissed':
      return undefined as T;
    case 'bulk_remove_from_watch_history':
    case 'remove_all_from_watch_history':
      // The command returns the rows it deleted — preview holds no history.
      return [] as T;
    case 'build_history_playback_plan': {
      const item = args?.item as WatchProgress | undefined;
      const mediaId = item?.id.trim() ? item.id : 'mock-id';
      const itemType = item?.type_.trim().toLowerCase() ?? 'movie';
      const mediaType = mediaId.startsWith('kitsu:')
        ? 'anime'
        : itemType === 'movie'
          ? 'movie'
          : 'series';
      const absoluteSeason = item?.absolute_season ?? item?.season;
      const absoluteEpisode = item?.absolute_episode ?? item?.episode;
      const from = readStringArg(args, 'from', '/');

      if (mediaType !== 'movie' && (absoluteSeason == null || absoluteEpisode == null)) {
        return {
          kind: 'details',
          reason: 'missing-episode-context',
          target: `/details/${mediaType}/${encodeURIComponent(mediaId)}`,
          state: { from, season: absoluteSeason },
        } as T;
      }

      // Route state carries opaque identities, never stream URLs; mirrors the backend's media-id lookup fallback.
      const target =
        absoluteSeason != null && absoluteEpisode != null
          ? `/player/${mediaType}/${encodeURIComponent(mediaId)}/${absoluteSeason}/${absoluteEpisode}`
          : `/player/${mediaType}/${encodeURIComponent(mediaId)}`;

      const state: HistoryPlaybackPlan['state'] = {
        from,
        title: item?.title,
        poster: item?.poster,
        backdrop: item?.backdrop,
        streamSourceId: item?.source_id,
        streamSourceName: item?.source_name,
        streamFamily: item?.stream_family,
        selectedStreamKey: item?.last_stream_key,
        startTime: item?.resume_start_time,
        absoluteSeason,
        absoluteEpisode,
        streamSeason: item?.stream_season ?? absoluteSeason,
        streamEpisode: item?.stream_episode ?? absoluteEpisode,
        resumeFromHistory: true,
        streamLookupId: item?.last_stream_lookup_id?.trim() ? item.last_stream_lookup_id : mediaId,
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
        library_status_counts: getPreviewLibraryStatusCounts(),
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
