type PreviewInvokeArgs = Record<string, unknown> | undefined;

let previewProfilePreferences = {
  profile: {
    username: 'Guest User',
    accentColor: '#ffffff',
    accentIntensity: 100,
  },
  viewMode: 'grid',
};
let previewAppUiPreferences = {
  playerVolume: 75,
  playerSpeed: 1,
  spoilerProtection: false,
  subtitleDelay: 0,
  subtitlePos: 100,
  subtitleScale: 1.0,
  autoPlayNext: false,
  trailerPreviews: true,
  autoSkipIntro: false,
};
let previewStreamSelectorPreferences = {
  quality: 'all',
  source: 'all',
  addon: 'all',
  sort: 'smart',
  batch: 'all',
};

const EMPTY_MEDIA_SCHEDULE = {
  id: 'mock-id',
  title: 'Browser Preview',
  type: 'series',
  releaseDate: undefined,
  episodes: [],
};

const EMPTY_SEARCH_CATALOG_PAGE = {
  items: [],
  nextSkip: null,
};

const EMPTY_STREAM_SELECTOR_DATA = {
  streams: [],
  sourceSummaries: [],
  fatalErrorMessage: null,
  complete: true,
};

const EMPTY_DATA_STATS = {
  history_count: 0,
  library_count: 0,
  lists_count: 0,
  watch_statuses_count: 0,
};

// Mirrors the backend's closed language set so preview renders the real options.
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

function readMediaType(args: PreviewInvokeArgs): 'movie' | 'series' {
  // Exact camelCase contract only: accepting snake_case fallbacks here would
  // hide the IPC naming drift this mock exists to surface.
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

// Mirrors `apply_app_ui_preferences_patch`: absent keys keep the current
// value; present-but-invalid numerics fall to the backend defaults.
function mergePreviewAppUiPreferences(patch: Record<string, unknown>) {
  const current = previewAppUiPreferences;
  const volume = readFiniteNumber(patch, 'playerVolume');
  const speed = readFiniteNumber(patch, 'playerSpeed');
  const delay = readFiniteNumber(patch, 'subtitleDelay');
  const pos = readFiniteNumber(patch, 'subtitlePos');
  const scale = readFiniteNumber(patch, 'subtitleScale');

  previewAppUiPreferences = {
    playerVolume:
      volume === undefined ? current.playerVolume : Math.max(0, Math.min(100, Math.round(volume))),
    playerSpeed:
      speed === undefined
        ? current.playerSpeed
        : speed > 0
          ? Math.max(0.25, Math.min(4, speed))
          : 1,
    spoilerProtection:
      typeof patch.spoilerProtection === 'boolean'
        ? patch.spoilerProtection
        : current.spoilerProtection,
    autoPlayNext:
      typeof patch.autoPlayNext === 'boolean' ? patch.autoPlayNext : current.autoPlayNext,
    trailerPreviews:
      typeof patch.trailerPreviews === 'boolean' ? patch.trailerPreviews : current.trailerPreviews,
    autoSkipIntro:
      typeof patch.autoSkipIntro === 'boolean' ? patch.autoSkipIntro : current.autoSkipIntro,
    subtitleDelay:
      delay === undefined
        ? current.subtitleDelay
        : Math.round(Math.max(-5, Math.min(5, delay)) * 10) / 10,
    subtitlePos: pos === undefined ? current.subtitlePos : Math.max(0, Math.min(100, pos)),
    subtitleScale:
      scale === undefined
        ? current.subtitleScale
        : scale > 0
          ? Math.round(Math.max(0.25, Math.min(3, scale)) * 20) / 20
          : 1.0,
  };
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
    case 'save_app_ui_preferences': {
      const patch = typeof args?.patch === 'object' && args.patch !== null ? args.patch : {};
      mergePreviewAppUiPreferences(patch as Record<string, unknown>);
      return previewAppUiPreferences as T;
    }
    case 'get_profile_preferences':
      return previewProfilePreferences as T;
    case 'save_profile_preferences':
      // The only caller (`useLocalProfile`) sanitizes the profile before invoking.
      previewProfilePreferences = {
        profile:
          typeof args?.profile === 'object' && args.profile !== null
            ? (args.profile as typeof previewProfilePreferences.profile)
            : previewProfilePreferences.profile,
        viewMode: args?.viewMode === 'list' ? 'list' : 'grid',
      };
      return previewProfilePreferences as T;
    case 'get_stream_selector_preferences':
      return {
        preferences: previewStreamSelectorPreferences,
        initialized: true,
      } as T;
    case 'save_stream_selector_preferences': {
      const preferences =
        typeof args?.preferences === 'object' && args.preferences !== null ? args.preferences : {};
      previewStreamSelectorPreferences = {
        quality:
          typeof (preferences as { quality?: unknown }).quality === 'string'
            ? ((preferences as { quality: string })
                .quality as typeof previewStreamSelectorPreferences.quality)
            : previewStreamSelectorPreferences.quality,
        source:
          typeof (preferences as { source?: unknown }).source === 'string'
            ? ((preferences as { source: string })
                .source as typeof previewStreamSelectorPreferences.source)
            : previewStreamSelectorPreferences.source,
        addon:
          typeof (preferences as { addon?: unknown }).addon === 'string' &&
          (preferences as { addon: string }).addon.trim()
            ? (preferences as { addon: string }).addon.trim()
            : 'all',
        sort:
          typeof (preferences as { sort?: unknown }).sort === 'string'
            ? ((preferences as { sort: string })
                .sort as typeof previewStreamSelectorPreferences.sort)
            : previewStreamSelectorPreferences.sort,
        batch:
          typeof (preferences as { batch?: unknown }).batch === 'string'
            ? ((preferences as { batch: string })
                .batch as typeof previewStreamSelectorPreferences.batch)
            : previewStreamSelectorPreferences.batch,
      };
      return previewStreamSelectorPreferences as T;
    }
    case 'get_skip_times':
      return { segments: [] } as T;
    case 'get_watch_history':
    case 'get_continue_watching':
    case 'get_library':
    case 'get_lists':
      return [] as T;
    case 'get_title_watch_progress':
      return { history: [], continueWatching: [] } as T;
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
    case 'get_media_schedules': {
      const items = Array.isArray(args?.items) ? args.items : [];

      // The base schedule shape must be spread per item; the list is
      // request-bounded so the allocation cost is trivial.
      // eslint-disable-next-line oxc/no-map-spread
      return items.map((item, index) => {
        const scheduleRequest =
          typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
        const mediaType =
          typeof scheduleRequest.mediaType === 'string' && scheduleRequest.mediaType.trim()
            ? scheduleRequest.mediaType.trim()
            : EMPTY_MEDIA_SCHEDULE.type;
        const id =
          typeof scheduleRequest.id === 'string' && scheduleRequest.id.trim()
            ? scheduleRequest.id.trim()
            : `${EMPTY_MEDIA_SCHEDULE.id}-${index + 1}`;

        return {
          ...EMPTY_MEDIA_SCHEDULE,
          id,
          title: `Browser Preview ${index + 1}`,
          type: mediaType,
        };
      }) as T;
    }
    case 'get_playback_language_preferences':
    case 'get_effective_playback_language_preferences':
      return {} as T;
    case 'save_playback_language_preferences':
      return {
        preferredAudioLanguage:
          typeof args?.preferredAudioLanguage === 'string'
            ? (args.preferredAudioLanguage as string)
            : undefined,
        preferredSubtitleLanguage:
          typeof args?.preferredSubtitleLanguage === 'string'
            ? (args.preferredSubtitleLanguage as string)
            : undefined,
      } as T;
    case 'resolve_preferred_track_selection':
      return {
        selectedMatches: false,
      } as T;
    case 'get_addon_configs':
      return [] as T;
    case 'get_all_watch_statuses':
      return {} as T;
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
          target: `/details/${mediaType}/${mediaId}`,
          state: { from, season: absoluteSeason },
        } as T;
      }

      // Preview-only: route state carries opaque identities, never stream
      // URLs. Mirror the backend's media-id fallback when no saved lookup
      // identity is available.
      const target =
        typeof absoluteSeason === 'number' && typeof absoluteEpisode === 'number'
          ? `/player/${mediaType}/${mediaId}/${absoluteSeason}/${absoluteEpisode}`
          : `/player/${mediaType}/${mediaId}`;

      return {
        kind: 'player',
        target,
        state: {
          from,
          title: typeof item?.title === 'string' ? item.title : undefined,
          poster: typeof item?.poster === 'string' ? item.poster : undefined,
          backdrop: typeof item?.backdrop === 'string' ? item.backdrop : undefined,
          format:
            typeof item?.last_stream_format === 'string' ? item.last_stream_format : undefined,
          streamSourceId: typeof item?.source_id === 'string' ? item.source_id : undefined,
          streamSourceName: typeof item?.source_name === 'string' ? item.source_name : undefined,
          streamFamily: typeof item?.stream_family === 'string' ? item.stream_family : undefined,
          selectedStreamKey:
            typeof item?.last_stream_key === 'string' ? item.last_stream_key : undefined,
          startTime:
            typeof item?.resume_start_time === 'number' ? item.resume_start_time : undefined,
          absoluteSeason,
          absoluteEpisode,
          streamSeason:
            typeof item?.stream_season === 'number' ? item.stream_season : absoluteSeason,
          streamEpisode:
            typeof item?.stream_episode === 'number' ? item.stream_episode : absoluteEpisode,
          resumeFromHistory: true,
          streamLookupId:
            typeof item?.last_stream_lookup_id === 'string' && item.last_stream_lookup_id.trim()
              ? item.last_stream_lookup_id
              : mediaId,
        },
      } as T;
    }
    case 'get_data_stats':
      return EMPTY_DATA_STATS as T;
    case 'save_selected_playback_language_preference':
      return {} as T;
    case 'save_playback_language_preference_outcome_from_tracks':
      return undefined as T;
    case 'get_supported_languages':
      return PREVIEW_SUPPORTED_LANGUAGES as T;
    case 'get_mpv_language_selection_options':
      return {} as T;
    default:
      throw new Error(
        `Command "${command}" is unavailable in browser preview. Run the Tauri desktop app for this path.`,
      );
  }
}
