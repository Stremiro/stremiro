import { useQueryClient } from '@tanstack/react-query';
import { type RefObject, useCallback, useEffect, useRef } from 'react';
import type { PlayerStreamSession } from '@/hooks/use-player-stream-session';
import type { PlaybackStreamOutcome } from '@/lib/api';
import { invalidateStreamQueries } from '@/lib/query-invalidation';
import { applyResolvedStreamToSession, recoverPlayerStream } from '@/lib/resolve-player-stream';
import { clearTimer, withTimeout } from '@/lib/utils';

// Above the normal backend path (~20-30s) but below a wedged invoke — a hung recovery must still release `isResolving`.
const STREAM_RECOVERY_TIMEOUT_MS = 45_000;

interface UseStreamRecoveryOptions {
  stream: PlayerStreamSession;
  isHistoryResume: boolean;
  mediaType?: string;
  mediaId?: string;
  title?: string;
  resolveSeason?: number;
  resolveEpisode?: number;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  streamLookupId?: string;
  currentTimeRef: RefObject<number>;
  durationRef: RefObject<number>;
  isPlayingRef: RefObject<boolean>;
  mountedRef: RefObject<boolean>;
  errorRef: RefObject<string | null>;
  // Holds the last position before a failover swap so the resume controller continues there.
  failoverResumePositionRef: RefObject<number>;
  stopLoading: (makeTransparent?: boolean) => void;
  setError: (value: string | null) => void;
  setIsResolving: (value: boolean) => void;
  setResolveStatus: (value: string) => void;
  onSavedStreamUnavailable?: () => void;
}

interface UseStreamRecoveryResult {
  clearRecoveryTimers: () => void;
  markPlaybackStarted: () => void;
  recoverFromSlowStartup: (
    sourceUrl: string,
    outcome?: Exclude<PlaybackStreamOutcome, 'verified'>,
  ) => Promise<boolean>;
}

export function useStreamRecovery({
  stream,
  isHistoryResume,
  mediaType,
  mediaId,
  title,
  resolveSeason,
  resolveEpisode,
  absoluteSeason,
  absoluteEpisode,
  streamLookupId,
  currentTimeRef,
  durationRef,
  isPlayingRef,
  mountedRef,
  errorRef,
  failoverResumePositionRef,
  stopLoading,
  setError,
  setIsResolving,
  setResolveStatus,
  onSavedStreamUnavailable,
}: UseStreamRecoveryOptions): UseStreamRecoveryResult {
  // The exclusion identity: winner-apply owns writes, recovery reads the current stream key.
  const { selectedStreamKeyRef } = stream;
  const queryClient = useQueryClient();
  const playbackStartedRef = useRef(false);
  const startupWatchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startupWatchdogCancelledRef = useRef(false);
  const startupRecoveryAttemptedForRef = useRef<Set<string>>(new Set());
  // Failed keys in this episode's chain — excluding only the latest would let A→B→A bounce past a viable third.
  const failedStreamKeysRef = useRef<Set<string>>(new Set());
  // Shared with other callers — a watchdog verdict during an in-flight recovery must not error it out.
  const recoveryInFlightRef = useRef(false);
  const recoveryEpochRef = useRef(0);

  const clearRecoveryTimers = useCallback(() => {
    // Cancelled so in-flight recovery cannot swap streams after unmount.
    startupWatchdogCancelledRef.current = true;
    clearTimer(startupWatchdogTimerRef);
  }, []);

  const markPlaybackStarted = useCallback(() => {
    playbackStartedRef.current = true;
    clearRecoveryTimers();
  }, [clearRecoveryTimers]);

  useEffect(() => {
    recoveryEpochRef.current += 1;
    playbackStartedRef.current = false;
    startupWatchdogCancelledRef.current = false;
    recoveryInFlightRef.current = false;
    return () => {
      recoveryEpochRef.current += 1;
    };
  }, [stream.activeStreamUrl]);

  useEffect(() => {
    startupRecoveryAttemptedForRef.current.clear();
    failedStreamKeysRef.current.clear();
  }, [absoluteEpisode, absoluteSeason, mediaId, resolveSeason, resolveEpisode]);

  const recoverFromSlowStartup = useCallback(
    async (
      sourceUrl: string,
      outcome: Exclude<PlaybackStreamOutcome, 'verified'> = 'startup-timeout',
    ) => {
      // Fast-fail only; Rust validates media types.
      const effectiveMediaType = mediaType?.trim();
      if (startupWatchdogCancelledRef.current) return false;
      if (playbackStartedRef.current) return false;
      if (
        !mediaId ||
        !sourceUrl ||
        (effectiveMediaType !== 'movie' &&
          effectiveMediaType !== 'series' &&
          effectiveMediaType !== 'anime')
      ) {
        return false;
      }
      if (startupRecoveryAttemptedForRef.current.has(sourceUrl)) return false;

      const epoch = recoveryEpochRef.current;
      const isCurrent = () => epoch === recoveryEpochRef.current && mountedRef.current;
      startupRecoveryAttemptedForRef.current.add(sourceUrl);
      const failedStreamKey = selectedStreamKeyRef.current;
      const excludedStreamKeys = [...failedStreamKeysRef.current];
      if (failedStreamKey) failedStreamKeysRef.current.add(failedStreamKey);
      recoveryInFlightRef.current = true;
      setError(null);
      setIsResolving(true);
      setResolveStatus('Slow start, trying a faster stream');

      try {
        if (startupWatchdogCancelledRef.current || playbackStartedRef.current) return false;
        const resolved = await withTimeout(
          recoverPlayerStream({
            mediaType: effectiveMediaType,
            mediaId,
            streamLookupId: streamLookupId || mediaId,
            streamSeason: resolveSeason,
            streamEpisode: resolveEpisode,
            absoluteSeason,
            absoluteEpisode,
            title,
            failed: {
              streamUrl: sourceUrl,
              sourceId: stream.activeStreamSourceIdRef.current,
              streamFamily: stream.activeStreamFamilyRef.current,
              streamKey: failedStreamKey,
            },
            excludedStreamKeys,
            outcome,
          }),
          STREAM_RECOVERY_TIMEOUT_MS,
          () => null,
        );

        // The backend re-ranked past the failed stream — don't serve the stale ordering from cache.
        void invalidateStreamQueries(queryClient);

        if (!isCurrent() || startupWatchdogCancelledRef.current || playbackStartedRef.current) {
          return false;
        }
        if (stream.committedStreamUrlRef.current !== sourceUrl) return false;

        if (resolved?.url && resolved.url !== sourceUrl) {
          applyResolvedStreamToSession(stream, resolved);
          failoverResumePositionRef.current = currentTimeRef.current;
          return true;
        }
      } catch {
        // Best-effort only.
      } finally {
        if (isCurrent()) {
          recoveryInFlightRef.current = false;
          setIsResolving(false);
          setResolveStatus('');
        }
      }

      return false;
    },
    [
      stream,
      absoluteSeason,
      currentTimeRef,
      failoverResumePositionRef,
      mediaId,
      mediaType,
      title,
      mountedRef,
      absoluteEpisode,
      queryClient,
      resolveEpisode,
      resolveSeason,
      selectedStreamKeyRef,
      setError,
      setIsResolving,
      setResolveStatus,
      streamLookupId,
    ],
  );

  useEffect(() => {
    // Recovery bails once playback started, so late dep changes never re-arm.
    if (!stream.activeStreamUrl || playbackStartedRef.current) return;

    // This effect re-arms as details/episodes land mid-load — reset the flag the cleanup set or the timer stays cancelled.
    startupWatchdogCancelledRef.current = false;

    clearTimer(startupWatchdogTimerRef);

    const startupWatchdogDelayMs = isHistoryResume ? 10000 : 12000;
    const epoch = recoveryEpochRef.current;

    startupWatchdogTimerRef.current = setTimeout(() => {
      if (
        epoch !== recoveryEpochRef.current ||
        startupWatchdogCancelledRef.current ||
        playbackStartedRef.current ||
        !mountedRef.current ||
        errorRef.current
      ) {
        return;
      }

      const hasAnyProgress = durationRef.current > 0 || currentTimeRef.current > 0.1;

      // Paused with progress means the stream proved alive (pausing doesn't stop demuxing); paused at zero stays a stall candidate.
      if (!isPlayingRef.current && hasAnyProgress) return;

      const stalledAtStart = durationRef.current > 0 && currentTimeRef.current <= 0.15;
      if (hasAnyProgress && !stalledAtStart) return;

      const currentUrl = stream.committedStreamUrlRef.current;
      if (!currentUrl) return;

      void recoverFromSlowStartup(currentUrl, 'startup-timeout').then((didRecover) => {
        if (
          epoch !== recoveryEpochRef.current ||
          startupWatchdogCancelledRef.current ||
          didRecover ||
          !mountedRef.current ||
          playbackStartedRef.current ||
          // Deduped behind an in-flight recovery — let that attempt reach its own verdict.
          recoveryInFlightRef.current
        ) {
          return;
        }
        // Fall back to manual selection only when no alternate resolves; recovery already recorded the outcome.
        if (isHistoryResume) {
          stopLoading();
          onSavedStreamUnavailable?.();
          return;
        }
        setError('This stream is taking too long to start. Try another stream.');
        stopLoading();
      });
    }, startupWatchdogDelayMs);

    return () => {
      startupWatchdogCancelledRef.current = true;
      clearTimer(startupWatchdogTimerRef);
    };
  }, [
    stream,
    currentTimeRef,
    durationRef,
    errorRef,
    isHistoryResume,
    isPlayingRef,
    mountedRef,
    recoverFromSlowStartup,
    setError,
    stopLoading,
    onSavedStreamUnavailable,
  ]);

  return {
    clearRecoveryTimers,
    markPlaybackStarted,
    recoverFromSlowStartup,
  };
}
