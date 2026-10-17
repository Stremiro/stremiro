import type { QueryClient } from '@tanstack/react-query';
import type { CalendarRange, LibraryFilters } from '@/lib/api';
import { nonBlank } from '@/lib/utils';

export const LIBRARY_QUERY_KEY = ['library'] as const;
export const PROFILE_LIBRARY_QUERY_KEY = ['profile-library'] as const;
export function profileLibraryQueryKey(filters: LibraryFilters) {
  return [...PROFILE_LIBRARY_QUERY_KEY, filters] as const;
}
// Rust interleaves continue-watching + Up Next from one snapshot, keyed per local day.
export const RESUME_RAIL_QUERY_KEY = 'resume-rail';
export function resumeRailQueryKey(localToday: string | undefined) {
  return [RESUME_RAIL_QUERY_KEY, localToday ?? ''] as const;
}
export const WATCH_HISTORY_QUERY_KEY = ['watch-history'] as const;
export const RECENT_WATCH_SEED_QUERY_KEY = [...WATCH_HISTORY_QUERY_KEY, 'recent-seed'] as const;
export const TITLE_WATCH_PROGRESS_QUERY_KEY = ['title-watch-progress'] as const;
export const TOTAL_WATCH_TIME_QUERY_KEY = ['total-watch-time'] as const;
export const LISTS_QUERY_KEY = ['lists'] as const;
const LIST_SUMMARIES_QUERY_KEY = ['list-summaries'] as const;
export function listSummariesQueryKey(itemId?: string) {
  return [...LIST_SUMMARIES_QUERY_KEY, nonBlank(itemId)] as const;
}
export const WATCH_STATUSES_QUERY_KEY = ['watch-statuses'] as const;
const CALENDAR_EVENTS_QUERY_KEY = ['calendar-events'] as const;
export const DATA_STATS_QUERY_KEY = ['dataStats'] as const;
// Profile chip and data manager share this query — one cadence.
export const DATA_STATS_STALE_TIME_MS = 1000 * 30;
export const PROFILE_PREFERENCES_QUERY_KEY = ['profilePreferences'] as const;
export const APP_UI_PREFERENCES_QUERY_KEY = ['appUiPreferences'] as const;
export const DEFAULT_PLAYER_KEYBINDINGS_QUERY_KEY = ['defaultPlayerKeybindings'] as const;
export const PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY = ['playbackLanguagePreferences'] as const;
export const STREAM_SELECTOR_PREFERENCES_QUERY_KEY = ['streamSelectorPreferences'] as const;
// The language set is compile-time static in the backend; one entry per app run.
export const SUPPORTED_LANGUAGES_QUERY_KEY = ['supportedLanguages'] as const;
const STREAMS_QUERY_KEY = ['streams'] as const;
const ADDON_SUBTITLES_QUERY_KEY = ['addonSubtitles'] as const;
export const DETAILS_QUERY_KEY = ['details'] as const;
// Shared addon-config entry so settings saves refresh the selector.
export const ADDON_CONFIGS_QUERY_KEY = ['addonConfigs'] as const;
export const ADDON_CONFIGS_STALE_TIME_MS = 1000 * 60 * 5;
/** Installed ids track registry membership for duplicate verdicts. */
export function addonUrlInspectionQueryKey(url: string, installedIds: readonly string[]) {
  return ['addonUrlInspection', url, installedIds] as const;
}
// Derived from the addon registry's manifests; refreshed with discovery.
export const BROWSE_GENRES_QUERY_KEY = ['browseGenres'] as const;
export const SEARCH_CATALOG_QUERY_KEY = ['search-catalog'] as const;
// Search stays fresh until invalidated; unused catalogs expire after 10 minutes.
export const SEARCH_CATALOG_GC_TIME_MS = 1000 * 60 * 10;
export const CALENDAR_EVENTS_STALE_TIME_MS = 1000 * 60 * 60;
// Home rails key under this prefix; invalidateDiscoveryQueries sweeps by it.
const TRENDING_QUERY_KEY = ['trending'] as const;
export function trendingRowQueryKey(row: string, ...coords: string[]) {
  return [...TRENDING_QUERY_KEY, row, ...coords];
}
const EFFECTIVE_PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY = [
  'effectivePlaybackLanguagePreferences',
] as const;

export function effectivePlaybackLanguagePreferencesQueryKey(mediaType?: string, mediaId?: string) {
  return [...EFFECTIVE_PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY, mediaType, mediaId] as const;
}

async function invalidateQuery(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  cancelInFlight: boolean | 'inactive' = false,
) {
  const filters = { queryKey, exact: false };
  if (cancelInFlight) {
    await queryClient.cancelQueries(
      { ...filters, type: cancelInFlight === 'inactive' ? 'inactive' : 'all' },
      { revert: true },
    );
  }
  await queryClient.invalidateQueries(filters);
}

function refreshScheduleQueries(queryClient: QueryClient) {
  // Nonblocking: write/exit barriers await local history, not remote providers.
  void invalidateQuery(queryClient, CALENDAR_EVENTS_QUERY_KEY, true);
  void invalidateQuery(queryClient, [RESUME_RAIL_QUERY_KEY], true);
}

// Trimmed id so details and card-hover share one cache entry.
export function titleWatchProgressQueryKey(itemId: string | undefined) {
  return [...TITLE_WATCH_PROGRESS_QUERY_KEY, itemId?.trim()] as const;
}

export function detailsQueryKey(type: string | undefined, id: string | undefined) {
  // Trimmed ids share one entry instead of duplicate IPC.
  return [...DETAILS_QUERY_KEY, type, id?.trim()] as const;
}

// Card variant without episodes; shares the details prefix for invalidation.
export function detailsCardQueryKey(type: string | undefined, id: string | undefined) {
  return [...DETAILS_QUERY_KEY, 'card', type, id?.trim()] as const;
}

export function calendarEventsQueryKey(range: CalendarRange) {
  return [
    ...CALENDAR_EVENTS_QUERY_KEY,
    range.visibleStart,
    range.visibleEnd,
    range.upcomingStart,
  ] as const;
}

// Shared lifetimes so views agree; inactive episode arrays expire after 10 minutes.
export const DETAILS_STALE_TIME_MS = 1000 * 60 * 30;
export const DETAILS_GC_TIME_MS = 1000 * 60 * 10;

// Skip data changes rarely; one lookup per episode and stream duration per session.
export const SKIP_TIMES_STALE_TIME_MS = 1000 * 60 * 60 * 12;
export const SKIP_TIMES_GC_TIME_MS = 1000 * 60 * 60 * 24;

// SkipDB shifts segments to fit the reported duration, so the key buckets by it.
export function skipTimesQueryKey(
  mediaType: string | undefined,
  id: string | undefined,
  season: number | undefined,
  episode: number | undefined,
  imdbId: string | undefined,
  streamLookupId: string | undefined,
  durationSecs: number | undefined,
) {
  return [
    'skip-times',
    mediaType,
    id,
    season,
    episode,
    imdbId ?? '',
    streamLookupId ?? '',
    durationSecs ?? 0,
  ] as const;
}

// Shared by MediaRow's default and parents keying the same row (e.g. home hero).
export const MEDIA_ROW_STALE_TIME_MS = 1000 * 60 * 10;

// Full-list views refresh slower than collections.
export const LISTS_VIEW_STALE_TIME_MS = 1000 * 30;

// Page-level history views refresh slower than the card-row default.
export const WATCH_HISTORY_VIEW_STALE_TIME_MS = 1000 * 60 * 3;

// Shared by the collection hooks and hero-slide prefetches.
export const WATCH_HISTORY_STALE_TIME_MS = 1000 * 30;

// One merged rail cadence for the home snapshot.
export const RESUME_SECTION_MIN_STALE_MS = 1000 * 30;

export async function invalidateLibraryQueries(queryClient: QueryClient) {
  // Watch status is a library attribute; refresh shared dependents once.
  refreshScheduleQueries(queryClient);
  await Promise.all([
    invalidateQuery(queryClient, LIBRARY_QUERY_KEY),
    invalidateQuery(queryClient, PROFILE_LIBRARY_QUERY_KEY),
    invalidateQuery(queryClient, WATCH_STATUSES_QUERY_KEY),
    invalidateQuery(queryClient, DATA_STATS_QUERY_KEY),
    invalidateQuery(queryClient, trendingRowQueryKey('similar'), true),
  ]);
}

async function invalidateHistoryCollections(
  queryClient: QueryClient,
  itemId?: string,
  refetchTitleProgress = true,
) {
  await Promise.all([
    invalidateQuery(queryClient, WATCH_HISTORY_QUERY_KEY, true),
    queryClient.invalidateQueries({
      queryKey: itemId ? titleWatchProgressQueryKey(itemId) : TITLE_WATCH_PROGRESS_QUERY_KEY,
      refetchType: refetchTitleProgress ? 'active' : 'none',
    }),
    invalidateQuery(queryClient, TOTAL_WATCH_TIME_QUERY_KEY),
    invalidateQuery(queryClient, DATA_STATS_QUERY_KEY),
    invalidateQuery(queryClient, trendingRowQueryKey('similar'), true),
  ]);
}

export async function invalidatePlaybackHistoryQueries(queryClient: QueryClient) {
  refreshScheduleQueries(queryClient);
  await invalidateHistoryCollections(queryClient);
}

// Title-scoped variant for single-title removes/restores and player flushes —
// a prefix sweep would refetch every cached title entry.
export async function invalidatePlaybackHistoryQueriesForTitle(
  queryClient: QueryClient,
  itemId: string | undefined,
  { refetchTitleProgress = true }: { refetchTitleProgress?: boolean } = {},
) {
  refreshScheduleQueries(queryClient);
  await invalidateHistoryCollections(queryClient, itemId, refetchTitleProgress);
}

export async function invalidateListQueries(queryClient: QueryClient) {
  // Calendar tracks list members; lists_count lives inside the stats payload.
  void invalidateQuery(queryClient, CALENDAR_EVENTS_QUERY_KEY, true);
  await Promise.all([
    invalidateQuery(queryClient, LISTS_QUERY_KEY),
    invalidateQuery(queryClient, LIST_SUMMARIES_QUERY_KEY),
    invalidateQuery(queryClient, DATA_STATS_QUERY_KEY),
  ]);
}

export async function invalidateWatchStatusQueries(queryClient: QueryClient) {
  // watch_statuses_count lives inside the stats payload.
  refreshScheduleQueries(queryClient);
  await Promise.all([
    invalidateQuery(queryClient, WATCH_STATUSES_QUERY_KEY),
    invalidateQuery(queryClient, PROFILE_LIBRARY_QUERY_KEY),
    invalidateQuery(queryClient, DATA_STATS_QUERY_KEY),
    invalidateQuery(queryClient, trendingRowQueryKey('similar'), true),
  ]);
}

// Selector pages key under the streams prefix so invalidateStreamQueries sweeps them.
export function streamSelectorQueryKey(
  type: string | undefined,
  lookupId: string | undefined,
  season: number | undefined,
  episode: number | undefined,
  absoluteEpisode: number | undefined,
  rankingCacheKey: string,
) {
  return [
    ...STREAMS_QUERY_KEY,
    'selector',
    type,
    lookupId,
    season,
    episode,
    absoluteEpisode,
    rankingCacheKey,
  ] as const;
}

export function addonSubtitlesQueryKey(
  mediaType: string | undefined,
  mediaId: string | undefined,
  season: number | undefined,
  episode: number | undefined,
) {
  return [
    ...ADDON_SUBTITLES_QUERY_KEY,
    mediaType ?? null,
    mediaId ?? null,
    season ?? null,
    episode ?? null,
  ] as const;
}

export async function invalidateStreamQueries(queryClient: QueryClient) {
  // Addon subtitles are an addon resource; a changed addon set drops them too.
  await Promise.all([
    invalidateQuery(queryClient, STREAMS_QUERY_KEY, 'inactive'),
    invalidateQuery(queryClient, ADDON_SUBTITLES_QUERY_KEY),
  ]);
}

let discoveryEpoch = 0;

export function getDiscoveryEpoch() {
  return discoveryEpoch;
}

export async function invalidateDiscoveryQueries(queryClient: QueryClient) {
  discoveryEpoch += 1;
  // Drop abandoned fetches, but keep mounted selectors attached to a refreshed query.
  queryClient.removeQueries({ queryKey: STREAMS_QUERY_KEY, type: 'inactive' });
  await Promise.all([
    queryClient.resetQueries({ queryKey: STREAMS_QUERY_KEY, type: 'active' }),
    ...[
      ADDON_SUBTITLES_QUERY_KEY,
      DETAILS_QUERY_KEY,
      SEARCH_CATALOG_QUERY_KEY,
      [RESUME_RAIL_QUERY_KEY],
      CALENDAR_EVENTS_QUERY_KEY,
      TRENDING_QUERY_KEY,
      BROWSE_GENRES_QUERY_KEY,
      RECENT_WATCH_SEED_QUERY_KEY,
    ].map((queryKey) => invalidateQuery(queryClient, queryKey, true)),
  ]);
}

export async function invalidatePlaybackLanguageQueries(queryClient: QueryClient) {
  await Promise.all([
    invalidateQuery(queryClient, EFFECTIVE_PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY),
    invalidateQuery(queryClient, STREAMS_QUERY_KEY, 'inactive'),
  ]);
}

// The restore flow already resets the profile/selector/language/addon snapshots itself — this covers the rest.
async function invalidateSettingsQueries(queryClient: QueryClient) {
  await Promise.all([
    invalidateQuery(queryClient, APP_UI_PREFERENCES_QUERY_KEY),
    invalidateQuery(queryClient, EFFECTIVE_PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY),
    invalidateDiscoveryQueries(queryClient),
  ]);
}

export async function invalidateStoredDataQueries(
  queryClient: QueryClient,
  restoreSettings = false,
) {
  // Settings discovery owns the awaited schedule refresh when restored;
  // data-only imports keep the usual nonblocking schedule refresh.
  if (!restoreSettings) refreshScheduleQueries(queryClient);
  await Promise.all([
    invalidateHistoryCollections(queryClient),
    invalidateQuery(queryClient, LIBRARY_QUERY_KEY),
    invalidateQuery(queryClient, PROFILE_LIBRARY_QUERY_KEY),
    invalidateQuery(queryClient, LISTS_QUERY_KEY),
    invalidateQuery(queryClient, LIST_SUMMARIES_QUERY_KEY),
    invalidateQuery(queryClient, WATCH_STATUSES_QUERY_KEY),
    restoreSettings && invalidateSettingsQueries(queryClient),
  ]);
}
