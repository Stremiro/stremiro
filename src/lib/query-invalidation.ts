import type { QueryClient } from '@tanstack/react-query';
import type { CalendarRange } from '@/lib/api';

export const LIBRARY_QUERY_KEY = ['library'] as const;
// Rust interleaves continue-watching + Up Next from one snapshot, keyed per local day.
export const RESUME_RAIL_QUERY_KEY = 'resume-rail';
export function resumeRailQueryKey(localToday: string | undefined) {
  return [RESUME_RAIL_QUERY_KEY, localToday ?? ''] as const;
}
export const WATCH_HISTORY_QUERY_KEY = ['watch-history'] as const;
const TITLE_WATCH_PROGRESS_QUERY_KEY = ['title-watch-progress'] as const;
export const TOTAL_WATCH_TIME_QUERY_KEY = ['total-watch-time'] as const;
export const LISTS_QUERY_KEY = ['lists'] as const;
export const WATCH_STATUSES_QUERY_KEY = ['watch-statuses'] as const;
const CALENDAR_EVENTS_QUERY_KEY = ['calendar-events'] as const;
export const DATA_STATS_QUERY_KEY = ['dataStats'] as const;
// Profile chip and data manager share this query — one cadence.
export const DATA_STATS_STALE_TIME_MS = 1000 * 30;
export const PROFILE_PREFERENCES_QUERY_KEY = ['profilePreferences'] as const;
export const APP_UI_PREFERENCES_QUERY_KEY = ['appUiPreferences'] as const;
export const PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY = ['playbackLanguagePreferences'] as const;
export const STREAM_SELECTOR_PREFERENCES_QUERY_KEY = ['streamSelectorPreferences'] as const;
// The language set is compile-time static in the backend; one entry per app run.
export const SUPPORTED_LANGUAGES_QUERY_KEY = ['supportedLanguages'] as const;
const STREAMS_QUERY_KEY = ['streams'] as const;
const ADDON_SUBTITLES_QUERY_KEY = ['addonSubtitles'] as const;
const DETAILS_QUERY_KEY = ['details'] as const;
// Shared addon-config entry so settings saves refresh the selector.
export const ADDON_CONFIGS_QUERY_KEY = ['addonConfigs'] as const;
export const ADDON_CONFIGS_STALE_TIME_MS = 1000 * 60 * 5;
/** Installed URLs ride in the key; the duplicate verdict depends on them. */
export function addonUrlInspectionQueryKey(url: string, installedUrls: readonly string[]) {
  return ['addonUrlInspection', url, installedUrls] as const;
}
// Derived from the addon registry's manifests; refreshed with discovery.
export const BROWSE_GENRES_QUERY_KEY = ['browseGenres'] as const;
export const SEARCH_CATALOG_QUERY_KEY = ['search-catalog'] as const;
export const SEARCH_CATALOG_GC_TIME_MS = 1000 * 60 * 10;
// stale == GC so a cached multi-page browse is never refetched page-by-page on revisit; expiry restarts at page 1.
export const SEARCH_CATALOG_STALE_TIME_MS = SEARCH_CATALOG_GC_TIME_MS;
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
  exact = false,
) {
  await queryClient.invalidateQueries({ queryKey, exact });
}

function refreshScheduleQueries(queryClient: QueryClient) {
  // Nonblocking: write/exit barriers await local history, not remote providers.
  void invalidateQuery(queryClient, CALENDAR_EVENTS_QUERY_KEY);
  void invalidateQuery(queryClient, [RESUME_RAIL_QUERY_KEY]);
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
    range.upcomingEnd,
  ] as const;
}

// Shared lifetimes so views agree. GC at 1h: episode arrays are the heaviest payload.
export const DETAILS_STALE_TIME_MS = 1000 * 60 * 30;
export const DETAILS_GC_TIME_MS = 1000 * 60 * 60;

// Skip data changes rarely; one lookup per episode and stream duration per session.
export const SKIP_TIMES_STALE_TIME_MS = 1000 * 60 * 60 * 12;
export const SKIP_TIMES_GC_TIME_MS = 1000 * 60 * 60 * 24;

// SkipDB only accepts IMDb ids; mirrors backend `normalize_imdb_id` so an
// unkeyable id never enables the query.
const SKIP_TIMES_IMDB_ID_PATTERN = /^tt\d{1,30}$/i;

export function resolveSkipTimesImdbAnchor(
  imdbId: string | undefined,
  mediaId: string | undefined,
  ...extraCandidates: Array<string | undefined>
): string | undefined {
  for (const candidate of [imdbId, mediaId, ...extraCandidates]) {
    const normalized = candidate?.trim().toLowerCase();
    if (normalized && SKIP_TIMES_IMDB_ID_PATTERN.test(normalized)) {
      return normalized;
    }
  }
  return undefined;
}

// SkipDB shifts segments to fit the reported duration, so the key buckets by it.
export function skipTimesQueryKey(
  mediaType: string | undefined,
  id: string | undefined,
  season: number | undefined,
  episode: number | undefined,
  imdbId: string | undefined,
  durationSecs: number | undefined,
) {
  return ['skip-times', mediaType, id, season, episode, imdbId ?? '', durationSecs ?? 0] as const;
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
    invalidateQuery(queryClient, WATCH_STATUSES_QUERY_KEY),
    invalidateQuery(queryClient, DATA_STATS_QUERY_KEY),
  ]);
}

async function invalidateHistoryCollections(
  queryClient: QueryClient,
  itemId?: string,
  refetchTitleProgress = true,
) {
  await Promise.all([
    invalidateQuery(queryClient, WATCH_HISTORY_QUERY_KEY),
    queryClient.invalidateQueries({
      queryKey: itemId ? titleWatchProgressQueryKey(itemId) : TITLE_WATCH_PROGRESS_QUERY_KEY,
      refetchType: refetchTitleProgress ? 'active' : 'none',
    }),
    invalidateQuery(queryClient, TOTAL_WATCH_TIME_QUERY_KEY),
    invalidateQuery(queryClient, DATA_STATS_QUERY_KEY),
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
  // lists_count lives inside the stats payload.
  await Promise.all([
    invalidateQuery(queryClient, LISTS_QUERY_KEY),
    invalidateQuery(queryClient, DATA_STATS_QUERY_KEY),
  ]);
}

export async function invalidateWatchStatusQueries(queryClient: QueryClient) {
  // watch_statuses_count lives inside the stats payload.
  refreshScheduleQueries(queryClient);
  await Promise.all([
    invalidateQuery(queryClient, WATCH_STATUSES_QUERY_KEY),
    invalidateQuery(queryClient, DATA_STATS_QUERY_KEY),
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
    invalidateQuery(queryClient, STREAMS_QUERY_KEY),
    invalidateQuery(queryClient, ADDON_SUBTITLES_QUERY_KEY),
  ]);
}

export async function invalidateDiscoveryQueries(queryClient: QueryClient) {
  // Provider caches clear too; RQ must not serve the previous addon set.
  await Promise.all([
    invalidateQuery(queryClient, DETAILS_QUERY_KEY),
    invalidateQuery(queryClient, SEARCH_CATALOG_QUERY_KEY),
    invalidateQuery(queryClient, [RESUME_RAIL_QUERY_KEY]),
    invalidateQuery(queryClient, CALENDAR_EVENTS_QUERY_KEY),
    invalidateQuery(queryClient, TRENDING_QUERY_KEY),
    invalidateQuery(queryClient, BROWSE_GENRES_QUERY_KEY),
  ]);
}

export async function invalidatePlaybackLanguageQueries(queryClient: QueryClient) {
  await Promise.all([
    invalidateQuery(queryClient, EFFECTIVE_PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY),
    invalidateQuery(queryClient, STREAMS_QUERY_KEY),
  ]);
}

// The restore flow already resets the profile/selector/language/addon snapshots itself — this covers the rest.
async function invalidateSettingsQueries(queryClient: QueryClient) {
  await Promise.all([
    invalidateQuery(queryClient, APP_UI_PREFERENCES_QUERY_KEY),
    invalidateQuery(queryClient, EFFECTIVE_PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY),
    invalidateStreamQueries(queryClient),
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
    invalidateQuery(queryClient, LISTS_QUERY_KEY),
    invalidateQuery(queryClient, WATCH_STATUSES_QUERY_KEY),
    restoreSettings && invalidateSettingsQueries(queryClient),
  ]);
}
