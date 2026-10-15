import { Channel } from '@tauri-apps/api/core';
import type {
  AddonSubtitle,
  BestResolvedStream,
  HistoryPlaybackPlan,
  PlaybackLanguagePreferences,
  PlaybackStreamOutcomeReport,
  RecoverPlaybackStreamOptions,
  ResolveBestStreamOptions,
  SavedPlaybackLanguagePreference,
  SkipTimesResult,
  StreamSelectorData,
  SupportedLanguage,
  TitleWatchProgress,
  TrackLanguageCandidate,
  TrackLanguageSelectionResolution,
  ResumeRailEntry,
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

// One fold for the four preferred-identity hints so cache key and IPC payload agree on "absent".
function normalizePreferredStreamHints(hints: {
  preferredStreamKey?: string;
  preferredSourceId?: string;
  preferredSourceName?: string;
  preferredStreamFamily?: string;
}) {
  return {
    preferredStreamKey: nonBlank(hints.preferredStreamKey),
    preferredSourceId: nonBlank(hints.preferredSourceId),
    preferredSourceName: nonBlank(hints.preferredSourceName),
    preferredStreamFamily: nonBlank(hints.preferredStreamFamily),
  };
}

// Single composer for best-stream keys: every input that can change the winner
// must appear — coordinates, ranking options, all four preferred hints.
function bestStreamCacheKey(
  type: string,
  id: string,
  season?: number,
  episode?: number,
  absoluteEpisode?: number,
  options?: ResolveBestStreamOptions,
): string {
  const hints = normalizePreferredStreamHints(options ?? {});
  return JSON.stringify([
    buildStreamCacheKey(type, id, season, episode, absoluteEpisode),
    buildStreamRankingCacheKey(options),
    hints.preferredStreamKey ?? null,
    hints.preferredSourceId ?? null,
    hints.preferredSourceName ?? null,
    hints.preferredStreamFamily ?? null,
  ]);
}

export function createPlaybackApi({ safeInvoke, caches }: PlaybackApiContext) {
  return {
    getStreamLink: (
      type: string,
      id: string,
      streamKey: string,
      season?: number,
      episode?: number,
      absoluteEpisode?: number,
      options?: StreamRankingOptions,
      sourceId?: string,
    ) =>
      safeInvoke<{ url: string; kind: 'http' | 'magnet' }>('get_stream_link', {
        mediaType: type.trim(),
        id: id.trim(),
        streamKey,
        sourceId,
        season,
        episode,
        absoluteEpisode,
        ...options,
      }),
    getStreamSelectorData: (
      type: string,
      id: string,
      season: number | undefined,
      episode: number | undefined,
      absoluteEpisode: number | undefined,
      options: StreamRankingOptions | undefined,
      onProgress: Channel<StreamSelectorData>,
    ) =>
      // No TS cache — RQ owns the UI entry, Rust owns ranking/cache. `onProgress` gets merged+ranked snapshots per addon.
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
      const preferredHints = normalizePreferredStreamHints(options ?? {});
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
          ...options,
          ...preferredHints,
        }),
      );
    },
    /** Seeds a resolved stream under the exact key the player replays; mismatched options miss. */
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

      // The backend re-ranked past the failure — drop cached entries so a later resolve can't re-serve the failed candidate.
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
    getEffectivePlaybackLanguagePreferences: (mediaType?: string, mediaId?: string) =>
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
      options?: { subtitlesOff?: boolean; mediaType?: string; mediaId?: string },
    ) =>
      withStreamingCacheClear(
        caches,
        safeInvoke<SavedPlaybackLanguagePreference>('save_selected_playback_language_preference', {
          preferenceKind,
          track,
          subtitlesOff: options?.subtitlesOff,
          mediaType: options?.mediaType,
          mediaId: options?.mediaId,
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
    // Cooldowns change on every report — drop cached rankings so the next fetch re-ranks.
    reportPlaybackStreamOutcome: (report: PlaybackStreamOutcomeReport) =>
      withStreamingCacheClear(caches, safeInvoke<void>('report_playback_stream_outcome', report)),
    saveWatchProgress: (progress: WatchProgress) =>
      trackPendingAppWrite(safeInvoke<void>('save_watch_progress', { progress })),
    saveWatchProgressBatch: (rows: WatchProgress[]) =>
      trackPendingAppWrite(safeInvoke<void>('save_watch_progress_batch', { rows })),
    getWatchHistory: () => safeInvoke<WatchProgress[]>('get_watch_history'),
    // Progressive rail: `onProgress` gets the local half early; the result is the merged rail.
    getResumeRail: (
      localToday: string,
      localTodayMs: number,
      onProgress: Channel<ResumeRailEntry[]>,
    ) =>
      safeInvoke<ResumeRailEntry[]>('get_resume_rail', {
        localToday,
        localTodayMs,
        onProgress,
      }),
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
    // Bump before the IPC lands — a queued save must not resurrect the row. Delete returns removed rows for the Undo snapshot.
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
