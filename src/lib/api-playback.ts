import { Channel } from '@tauri-apps/api/core';
import type {
  AddonSubtitle,
  BestResolvedStream,
  HistoryPlaybackPlan,
  PlaybackLanguagePreferences,
  PlaybackStreamOutcomeReport,
  RecoverPlaybackStreamOptions,
  ResolveBestStreamOptions,
  SkipTimesResult,
  StreamSelectorData,
  SupportedLanguage,
  TitleWatchProgress,
  TrackLanguageCandidate,
  TrackLanguageSelectionResolution,
  UpNextCandidate,
  WatchProgress,
} from '@/lib/api';
import {
  type ApiCacheGroups,
  buildStreamCacheKey,
  bumpWatchProgressEpoch,
  primeCachedRequest,
  type RequestCache,
  runCachedRequest,
  withStreamingCacheClear,
} from '@/lib/api-cache';
import type { InvokeApi } from '@/lib/api-core';
import { trackPendingAppWrite } from '@/lib/pending-app-writes';
import { buildStreamRankingCacheKey, type StreamRankingOptions } from '@/lib/stream-ranking';
import { nonBlank } from '@/lib/utils';

interface PlaybackApiCaches extends ApiCacheGroups {
  bestStream: RequestCache<BestResolvedStream>;
}

interface PlaybackApiContext {
  safeInvoke: InvokeApi;
  caches: PlaybackApiCaches;
}

// Single composer for best-stream keys; selector relies on RQ + Rust.
// Every input that can change the resolved winner must appear here:
// content coordinates, ranking options, and all three preferred-identity
// hints — a preferred key, source, or family that differs must miss.
function bestStreamCacheKey(
  type: string,
  id: string,
  season?: number,
  episode?: number,
  absoluteEpisode?: number,
  options?: ResolveBestStreamOptions,
): string {
  return JSON.stringify([
    buildStreamCacheKey(type, id, season, episode, absoluteEpisode),
    buildStreamRankingCacheKey(options),
    options?.preferredStreamKey?.trim() || null,
    options?.preferredSourceId?.trim() || null,
    options?.preferredSourceName?.trim() || null,
    options?.preferredStreamFamily?.trim() || null,
  ]);
}

export function createPlaybackApi({ safeInvoke, caches }: PlaybackApiContext) {
  return {
    getStreamSelectorData: (
      type: string,
      id: string,
      season: number | undefined,
      episode: number | undefined,
      absoluteEpisode: number | undefined,
      options: StreamRankingOptions | undefined,
      onProgress: Channel<StreamSelectorData>,
    ) =>
      // No TS cache: React Query owns the UI entry, Rust owns ranking/cache.
      // `onProgress` receives merged+ranked snapshots as each addon lands.
      safeInvoke<StreamSelectorData>('get_stream_selector_data', {
        mediaType: type.trim(),
        id: id.trim(),
        season,
        episode,
        absoluteEpisode,
        ...options,
        onProgress,
      }),
    getAddonSubtitles: (type: string, id: string, season?: number, episode?: number) => {
      const trimmedType = type.trim();
      const trimmedId = id.trim();
      return safeInvoke<AddonSubtitle[]>('get_addon_subtitles', {
        mediaType: trimmedType,
        id: trimmedId,
        season,
        episode,
      });
    },
    resolveBestStream: (
      type: string,
      id: string,
      season?: number,
      episode?: number,
      absoluteEpisode?: number,
      options?: ResolveBestStreamOptions,
    ) => {
      const trimmedType = type.trim();
      const trimmedId = id.trim();
      const {
        preferredStreamKey: rawPreferredStreamKey,
        preferredSourceId: rawPreferredSourceId,
        preferredSourceName: rawPreferredSourceName,
        preferredStreamFamily: rawPreferredStreamFamily,
        ...rankingOptions
      } = options ?? {};
      const preferredStreamKey = nonBlank(rawPreferredStreamKey);
      const preferredSourceId = nonBlank(rawPreferredSourceId);
      const preferredSourceName = nonBlank(rawPreferredSourceName);
      const preferredStreamFamily = nonBlank(rawPreferredStreamFamily);
      const cacheKey = bestStreamCacheKey(
        trimmedType,
        trimmedId,
        season,
        episode,
        absoluteEpisode,
        options,
      );
      return runCachedRequest(caches.bestStream, cacheKey, () =>
        safeInvoke<BestResolvedStream>('resolve_best_stream', {
          mediaType: trimmedType,
          id: trimmedId,
          season,
          episode,
          absoluteEpisode,
          preferredStreamKey,
          preferredSourceId,
          preferredSourceName,
          preferredStreamFamily,
          ...rankingOptions,
        }),
      );
    },
    /** Seeds a resolved stream under the exact request key the player replays;
        the key covers every preferred hint, so mismatched options miss. */
    primeBestStream: (
      type: string,
      id: string,
      season: number | undefined,
      episode: number | undefined,
      absoluteEpisode: number | undefined,
      options: ResolveBestStreamOptions | undefined,
      result: BestResolvedStream,
    ) => {
      const cacheKey = bestStreamCacheKey(
        type.trim(),
        id.trim(),
        season,
        episode,
        absoluteEpisode,
        options,
      );
      primeCachedRequest(caches.bestStream, cacheKey, result);
    },
    recoverPlaybackStream: ({
      mediaType,
      mediaId,
      streamSeason,
      streamEpisode,
      absoluteSeason,
      absoluteEpisode,
      streamLookupId,
      failedStreamUrl,
      failedSourceId,
      failedStreamFamily,
      failedStreamKey,
      excludedStreamKeys,
      outcome,
      ...rankingOptions
    }: RecoverPlaybackStreamOptions) => {
      const trimmedType = mediaType.trim();
      const trimmedId = mediaId.trim();

      // The backend just recorded the failure and re-ranked; drop cached
      // best-stream entries so a later resolve can't re-serve the
      // just-failed candidate from TTL cache.
      return withStreamingCacheClear(
        caches,
        safeInvoke<BestResolvedStream | null>('recover_playback_stream', {
          mediaType: trimmedType,
          id: trimmedId,
          season: streamSeason,
          episode: streamEpisode,
          absoluteSeason,
          absoluteEpisode,
          streamLookupId,
          failedStreamUrl,
          failedSourceId,
          failedStreamFamily,
          failedStreamKey,
          excludedStreamKeys,
          outcome,
          ...rankingOptions,
        }),
      );
    },
    /** Sets one global language default; `undefined` clears it. */
    savePlaybackLanguagePreference: (preferenceKind: 'audio' | 'sub', language?: string) =>
      withStreamingCacheClear(
        caches,
        safeInvoke<PlaybackLanguagePreferences>('save_playback_language_preference', {
          preferenceKind,
          language,
        }),
      ),
    getPlaybackLanguagePreferences: () =>
      safeInvoke<PlaybackLanguagePreferences>('get_playback_language_preferences'),
    getEffectivePlaybackLanguagePreferences: (mediaId?: string, mediaType?: string) =>
      safeInvoke<PlaybackLanguagePreferences>('get_effective_playback_language_preferences', {
        mediaId,
        mediaType,
      }),
    resolvePreferredTrackSelection: (
      tracks: TrackLanguageCandidate[],
      preferredLanguage?: string,
      selectedTrackId?: number,
    ) =>
      safeInvoke<TrackLanguageSelectionResolution>('resolve_preferred_track_selection', {
        tracks,
        preferredLanguage,
        selectedTrackId,
      }),
    saveSelectedPlaybackLanguagePreference: (
      preferenceKind: 'audio' | 'sub',
      track?: TrackLanguageCandidate,
      subtitlesOff?: boolean,
    ) =>
      withStreamingCacheClear(
        caches,
        safeInvoke<PlaybackLanguagePreferences>('save_selected_playback_language_preference', {
          preferenceKind,
          track,
          subtitlesOff,
        }),
      ),
    savePlaybackLanguagePreferenceOutcomeFromTracks: (
      mediaId: string,
      mediaType: string,
      audioTrack?: TrackLanguageCandidate,
      subtitleTrack?: TrackLanguageCandidate,
      subtitlesOff?: boolean,
    ) =>
      // Learned per-title picks feed ranking when no global default is set.
      withStreamingCacheClear(
        caches,
        safeInvoke<void>('save_playback_language_preference_outcome_from_tracks', {
          mediaId,
          mediaType,
          audioTrack,
          subtitleTrack,
          subtitlesOff,
        }),
      ),
    getSupportedLanguages: () => safeInvoke<SupportedLanguage[]>('get_supported_languages'),
    // Backend cooldowns change on every report: drop cached rankings so the
    // next selector fetch re-ranks instead of re-serving the just-failed
    // source from TTL cache.
    reportPlaybackStreamOutcome: (report: PlaybackStreamOutcomeReport) =>
      withStreamingCacheClear(caches, safeInvoke<void>('report_playback_stream_outcome', report)),
    saveWatchProgress: (progress: WatchProgress) =>
      trackPendingAppWrite(safeInvoke<void>('save_watch_progress', { progress })),
    saveWatchProgressBatch: (rows: WatchProgress[]) =>
      trackPendingAppWrite(safeInvoke<void>('save_watch_progress_batch', { rows })),
    getWatchHistory: () => safeInvoke<WatchProgress[]>('get_watch_history'),
    getContinueWatching: () => safeInvoke<WatchProgress[]>('get_continue_watching'),
    getUpNextEntries: (localToday: string) =>
      safeInvoke<UpNextCandidate[]>('get_up_next_entries', { localToday }),
    getTitleWatchProgress: (id: string) =>
      safeInvoke<TitleWatchProgress>('get_title_watch_progress', { id }),
    getTotalWatchTimeSecs: () => safeInvoke<number>('get_total_watch_time_secs'),
    buildHistoryPlaybackPlan: (item: WatchProgress, from: string) =>
      safeInvoke<HistoryPlaybackPlan>('build_history_playback_plan', { item, from }),
    getWatchProgress: (id: string, type: string, season?: number, episode?: number) =>
      safeInvoke<WatchProgress | null>('get_watch_progress', {
        id,
        type,
        season,
        episode,
      }),
    // Bump before the IPC lands: a progress save queued across this delete
    // must not resurrect the row when it flushes. The delete returns the rows
    // it removed — the Undo snapshot needs no second read or dedupe mirror.
    removeAllFromWatchHistory: (id: string, type: string) => {
      bumpWatchProgressEpoch();
      return trackPendingAppWrite(
        safeInvoke<WatchProgress[]>('remove_all_from_watch_history', { id, type }),
      );
    },
    getSkipTimes: (
      mediaType: string,
      id: string,
      imdbId: string | undefined,
      season: number | undefined,
      episode: number | undefined,
      durationSecs: number | undefined,
    ) =>
      safeInvoke<SkipTimesResult>('get_skip_times', {
        mediaType: mediaType.trim(),
        id: id.trim(),
        imdbId: nonBlank(imdbId),
        season,
        episode,
        durationSecs,
      }),
  };
}
