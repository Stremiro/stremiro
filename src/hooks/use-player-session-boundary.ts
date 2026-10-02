import { useQueryClient } from '@tanstack/react-query';
import { type RefObject, useCallback, useEffect, useRef } from 'react';
import { usePlaybackProgressPersistence } from '@/hooks/use-playback-progress-persistence';
import { usePlaybackStreamHealth } from '@/hooks/use-playback-stream-health';
import { usePlayerResumeController } from '@/hooks/use-player-resume-controller';
import type { PlayerStreamSession } from '@/hooks/use-player-stream-session';
import { usePlayerTrackController } from '@/hooks/use-player-track-controller';
import type { PlaybackLanguagePreferences } from '@/lib/api';
import type { PlaybackClock } from '@/lib/player-clock';
import { invalidatePlaybackHistoryQueriesForTitle } from '@/lib/query-invalidation';
import { withTimeout } from '@/lib/utils';

interface UsePlayerSessionBoundaryArgs {
  absoluteEpisode?: number;
  absoluteSeason?: number;
  activeStreamResetKey: string;
  backdrop?: string;
  clock: PlaybackClock;
  durationRef: RefObject<number>;
  failoverResumePositionRef: RefObject<number>;
  hasPlaybackStarted: boolean;
  isDestroyedRef: RefObject<boolean>;
  isHistoryResume: boolean;
  isLoading: boolean;
  isPlaying: boolean;
  isResolving: boolean;
  mediaId?: string;
  mediaType?: string;
  mountedRef: RefObject<boolean>;
  onResumeMessage: (text: string) => void;
  playbackLanguageMediaType?: 'movie' | 'series' | 'anime';
  poster?: string;
  startTime?: number;
  stream: PlayerStreamSession;
  streamEpisode?: number;
  streamSeason?: number;
  title: string;
}

export function usePlayerSessionBoundary({
  absoluteEpisode,
  absoluteSeason,
  activeStreamResetKey,
  stream,
  backdrop,
  clock,
  durationRef,
  failoverResumePositionRef,
  hasPlaybackStarted,
  isDestroyedRef,
  isHistoryResume,
  isLoading,
  isPlaying,
  isResolving,
  mediaId,
  mediaType,
  mountedRef,
  onResumeMessage,
  playbackLanguageMediaType,
  poster,
  startTime,
  streamEpisode,
  streamSeason,
  title,
}: UsePlayerSessionBoundaryArgs) {
  const { activeStreamUrl } = stream;
  const queryClient = useQueryClient();
  const playbackLanguagePreferencesRef = useRef<PlaybackLanguagePreferences>({});
  const saveProgressRef = useRef<(() => Promise<void>) | undefined>(undefined);

  const {
    audioTracks,
    cycleTrack,
    notifyObservedTrackSelection,
    subTracks,
    trackSwitching,
    subtitlesOff,
    playbackLanguagePreferences,
    refreshTracks,
    selectAddonSubtitle,
    setTrack,
  } = usePlayerTrackController({
    mediaId,
    mediaType: playbackLanguageMediaType,
    activeStreamUrl,
    hasPlaybackStarted,
    isLoading,
    isResolving,
    resetKey: activeStreamResetKey,
  });

  const { saveProgress } = usePlaybackProgressPersistence({
    mediaId,
    mediaType,
    title: title || 'Unknown',
    poster,
    backdrop,
    absoluteSeason,
    absoluteEpisode,
    streamSeason,
    streamEpisode,
    isPlaying,
    clock,
    durationRef,
    stream,
  });

  const { reportFailure: reportStreamFailure, reportVerified: reportStreamVerified } =
    usePlaybackStreamHealth({
      mediaId,
      mediaType,
      absoluteSeason,
      absoluteEpisode,
      stream,
    });

  const { applyResumeIfReady, clearResumeRetryTimer, prepareForStreamLoad } =
    usePlayerResumeController({
      mediaId,
      mediaType,
      activeStreamUrl,
      startTime,
      absoluteSeason,
      absoluteEpisode,
      isHistoryResume,
      mountedRef,
      isDestroyedRef,
      currentTimeRef: clock.ref,
      durationRef,
      failoverResumePositionRef,
      onResumeMessage,
    });

  useEffect(() => {
    playbackLanguagePreferencesRef.current = {
      preferredAudioLanguage: playbackLanguagePreferences.preferredAudioLanguage,
      preferredSubtitleLanguage: playbackLanguagePreferences.preferredSubtitleLanguage,
    };
  }, [
    playbackLanguagePreferences.preferredAudioLanguage,
    playbackLanguagePreferences.preferredSubtitleLanguage,
  ]);

  useEffect(() => {
    saveProgressRef.current = saveProgress;
  }, [saveProgress]);

  // Invalidates after its own save so Continue Watching refetches the final
  // position; overlapping flushes dedupe in the save queue. Never blocks on
  // persistence: callers proceed after 2s and the save still lands.
  const flushPlaybackBeforeNavigation = useCallback(async () => {
    const flush = Promise.resolve(saveProgressRef.current?.()).then(() =>
      invalidatePlaybackHistoryQueriesForTitle(queryClient, mediaId),
    );
    // A slow save must still invalidate after it lands, even if navigation
    // already continued at the timeout.
    await withTimeout(flush, 2000, () => undefined);
  }, [mediaId, queryClient]);

  const navigationGuardEnabled = !!mediaType && !!mediaId && !!activeStreamUrl;

  // Single exit flush for session close, remount (episode change) and stream
  // teardown — reads the latest save through the ref.
  useEffect(() => {
    if (!navigationGuardEnabled) return;
    return () => {
      void flushPlaybackBeforeNavigation();
    };
  }, [navigationGuardEnabled, flushPlaybackBeforeNavigation]);

  return {
    applyResumeIfReady,
    audioTracks,
    clearResumeRetryTimer,
    cycleTrack,
    flushPlaybackBeforeNavigation,
    notifyObservedTrackSelection,
    playbackLanguagePreferencesRef,
    prepareForStreamLoad,
    refreshTracks,
    reportStreamFailure,
    reportStreamVerified,
    saveProgressRef,
    selectAddonSubtitle,
    setTrack,
    subTracks,
    subtitlesOff,
    trackSwitching,
  };
}
