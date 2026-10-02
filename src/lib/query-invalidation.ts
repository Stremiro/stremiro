import type { QueryClient } from '@tanstack/react-query';
import type { CalendarRange } from '@/lib/api';

export const LIBRARY_QUERY_KEY = ['library'] as const;
export const CONTINUE_WATCHING_QUERY_KEY = ['continue-watching'] as const;
export const UP_NEXT_ENTRIES_QUERY_KEY = [
  ...CONTINUE_WATCHING_QUERY_KEY,
  'up-next-entries',
] as const;
export const WATCH_HISTORY_QUERY_KEY = ['watch-history'] as const;
const TITLE_WATCH_PROGRESS_QUERY_KEY = ['title-watch-progress'] as const;
export const TOTAL_WATCH_TIME_QUERY_KEY = ['total-watch-time'] as const;
export const LISTS_QUERY_KEY = ['lists'] as const;
export const WATCH_STATUSES_QUERY_KEY = ['watch-statuses'] as const;
const CALENDAR_EVENTS_QUERY_KEY = ['calendar-events'] as const;
export const DATA_STATS_QUERY_KEY = ['dataStats'] as const;
// One entry, one cadence — profile chip and data manager share this query.
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
/** The installed URLs ride in the key: the duplicate verdict depends on them. */
export function addonUrlInspectionQueryKey(url: string, installedUrls: readonly string[]) {
  return ['addonUrlInspection', url, installedUrls] as const;
}
// Derived from the addon registry's manifests; refreshed with discovery.
export const BROWSE_GENRES_QUERY_KEY = ['browseGenres'] as const;
export const SEARCH_CATALOG_QUERY_KEY = ['search-catalog'] as const;
export const CALENDAR_EVENTS_STALE_TIME_MS = 1000 * 60 * 60;
// Home's rails key under this prefix and invalidateDiscoveryQueries sweeps
// by it — rename-safety needs one owner.
const TRENDING_QUERY_KEY = ['trending'] as const;
export function trendingRowQueryKey(row: string, ...coords: string[]) {
  return [...TRENDING_QUERY_KEY, row, ...coords];
}
const EFFECTIVE_PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY = [
  'effectivePlaybackLanguagePreferences',
] as const;

export function effectivePlaybackLanguagePreferencesQueryKey(mediaType?: string, mediaId?: string) {
  return [EFFECTIVE_PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY[0], mediaType, mediaId] as const;
}

async function invalidateQuery(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  exact = false,
) {
  await queryClient.invalidateQueries({ queryKey, exact });
}

function refreshScheduleQueries(queryClient: QueryClient) {
  // Schedule views may fetch remote metadata; durable write/exit barriers
  // wait for the local history refresh, without waiting for those providers.
  void invalidateQuery(queryClient, CALENDAR_EVENTS_QUERY_KEY);
  void invalidateQuery(queryClient, UP_NEXT_ENTRIES_QUERY_KEY);
}

// Per-title resume reads key on the trimmed id so details and card-hover
// share one cache entry.
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

// Shared details lifetimes so views agree instead of refetching apart.
// GC at 1h: full details payloads carry episode arrays, so a browsed title
// shouldn't hold its heaviest payload for hours after unmount.
export const DETAILS_STALE_TIME_MS = 1000 * 60 * 30;
export const DETAILS_GC_TIME_MS = 1000 * 60 * 60;

// Skip data changes rarely; prefetch shares lifetime with the player read.
export const SKIP_TIMES_STALE_TIME_MS = 1000 * 60 * 60 * 12;
export const SKIP_TIMES_GC_TIME_MS = 1000 * 60 * 60 * 24;

// IMDb ids (`tt` + digits) are the only lookup key SkipDB accepts. Mirrors
// the backend `normalize_imdb_id` bound so an unkeyable id never enables the
// query at all.
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

// The skip key includes the duration bucket — SkipDB shifts segments to fit
// the reported duration, so matched data is only valid for that duration.
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

// Catalog row freshness — MediaRow's default and any parent sharing a row's
// key (e.g. the home hero) must agree so one entry never carries two cadences.
export const MEDIA_ROW_STALE_TIME_MS = 1000 * 60 * 10;

// Full-list views refresh slower than collections.
export const LISTS_VIEW_STALE_TIME_MS = 1000 * 30;

// Page-level history views refresh slower than the card-row default — same
// 3-minute policy, one owner.
export const WATCH_HISTORY_VIEW_STALE_TIME_MS = 1000 * 60 * 3;

// Per-row/per-title history freshness — shared by the collection hooks and
// hero-slide prefetches so one entry never carries two cadences.
export const WATCH_HISTORY_STALE_TIME_MS = 1000 * 30;

export async function invalidateLibraryQueries(queryClient: QueryClient) {
  // library_count lives inside the stats payload — the data manager refetches
  // when library membership changes.
  void invalidateQuery(queryClient, CALENDAR_EVENTS_QUERY_KEY);
  await Promise.all([
    invalidateQuery(queryClient, LIBRARY_QUERY_KEY),
    invalidateQuery(queryClient, DATA_STATS_QUERY_KEY),
  ]);
}

export async function invalidatePlaybackHistoryQueries(queryClient: QueryClient) {
  refreshScheduleQueries(queryClient);
  await Promise.all([
    invalidateQuery(queryClient, CONTINUE_WATCHING_QUERY_KEY, true),
    invalidateQuery(queryClient, WATCH_HISTORY_QUERY_KEY),
    invalidateQuery(queryClient, TITLE_WATCH_PROGRESS_QUERY_KEY),
    invalidateQuery(queryClient, TOTAL_WATCH_TIME_QUERY_KEY),
    invalidateQuery(queryClient, DATA_STATS_QUERY_KEY),
  ]);
}

// Title-scoped variant: single-title removes/restores and player flushes need
// only the two collections plus this title's snapshot — a prefix sweep would
// refetch every cached title entry.
export async function invalidatePlaybackHistoryQueriesForTitle(
  queryClient: QueryClient,
  itemId: string | undefined,
) {
  refreshScheduleQueries(queryClient);
  await Promise.all([
    invalidateQuery(queryClient, CONTINUE_WATCHING_QUERY_KEY, true),
    invalidateQuery(queryClient, WATCH_HISTORY_QUERY_KEY),
    itemId
      ? invalidateQuery(queryClient, titleWatchProgressQueryKey(itemId))
      : invalidateQuery(queryClient, TITLE_WATCH_PROGRESS_QUERY_KEY),
    invalidateQuery(queryClient, TOTAL_WATCH_TIME_QUERY_KEY),
    invalidateQuery(queryClient, DATA_STATS_QUERY_KEY),
  ]);
}

export async function invalidateListQueries(queryClient: QueryClient) {
  // lists_count lives inside the stats payload — the profile chip and data
  // manager both refetch when lists change.
  await Promise.all([
    invalidateQuery(queryClient, LISTS_QUERY_KEY),
    invalidateQuery(queryClient, DATA_STATS_QUERY_KEY),
  ]);
}

export async function invalidateWatchStatusQueries(queryClient: QueryClient) {
  refreshScheduleQueries(queryClient);
  await invalidateQuery(queryClient, WATCH_STATUSES_QUERY_KEY);
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
  // Addon subtitles are an addon resource — a changed addon set drops the
  // cached subtitle lists alongside stream caches.
  await Promise.all([
    invalidateQuery(queryClient, STREAMS_QUERY_KEY),
    invalidateQuery(queryClient, ADDON_SUBTITLES_QUERY_KEY),
  ]);
}

export async function invalidateDiscoveryQueries(queryClient: QueryClient) {
  // Provider caches clear too — RQ must not serve the previous addon set.
  await Promise.all([
    invalidateQuery(queryClient, DETAILS_QUERY_KEY),
    invalidateQuery(queryClient, SEARCH_CATALOG_QUERY_KEY),
    invalidateQuery(queryClient, UP_NEXT_ENTRIES_QUERY_KEY),
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

export async function invalidateDataStatsQuery(queryClient: QueryClient) {
  await invalidateQuery(queryClient, DATA_STATS_QUERY_KEY);
}

// Backup restore rewrites preferences, profile, and the addon registry in one
// pass — every surface built from them refetches.
export async function invalidateSettingsQueries(queryClient: QueryClient) {
  await Promise.all([
    invalidateQuery(queryClient, APP_UI_PREFERENCES_QUERY_KEY),
    invalidateQuery(queryClient, PROFILE_PREFERENCES_QUERY_KEY),
    invalidateQuery(queryClient, STREAM_SELECTOR_PREFERENCES_QUERY_KEY),
    invalidateQuery(queryClient, PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY),
    invalidateQuery(queryClient, ADDON_CONFIGS_QUERY_KEY),
    invalidatePlaybackLanguageQueries(queryClient),
    invalidateStreamQueries(queryClient),
    invalidateDiscoveryQueries(queryClient),
  ]);
}

export async function invalidateStoredDataQueries(queryClient: QueryClient) {
  await Promise.all([
    invalidatePlaybackHistoryQueries(queryClient),
    invalidateLibraryQueries(queryClient),
    invalidateListQueries(queryClient),
    invalidateWatchStatusQueries(queryClient),
    invalidateDataStatsQuery(queryClient),
  ]);
}
