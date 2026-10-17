import { useQueryClient } from '@tanstack/react-query';
import { type RefObject, useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { PlayerStreamSession } from '@/hooks/use-player-stream-session';
import { api, type PlaybackStreamOutcome } from '@/lib/api';
import { getErrorKind } from '@/lib/api-core';
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
  isLoading: boolean;
  isPlaying: boolean;
  isPlayingRef: RefObject<boolean>;
  isResumePending: () => boolean;
  mountedRef: RefObject<boolean>;
  errorRef: RefObject<string | null>;
  // Holds the last position before a failover swap so the resume controller continues there.
  failoverResumePositionRef: RefObject<number>;
  stopLoading: (makeTransparent?: boolean) => void;
  setError: (value: string | null) => void;
  setStreamError: (value: string) => void;
  setResolveStatus: (value: string | null) => void;
  onSavedStreamUnavailable?: () => void;
}

interface UseStreamRecoveryResult {
  cancelRecovery: () => number;
  releaseManualSelection: (generation: number) => void;
  clearRecoveryTimers: () => void;
  markPlaybackStarted: () => void;
  /** True when recovery or a newer playback owner handled the failure. */
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
  isLoading,
  isPlaying,
  isPlayingRef,
  isResumePending,
  mountedRef,
  errorRef,
  failoverResumePositionRef,
  stopLoading,
  setError,
  setStreamError,
  setResolveStatus,
  onSavedStreamUnavailable,
}: UseStreamRecoveryOptions): UseStreamRecoveryResult {
  // The exclusion identity: winner-apply owns writes, recovery reads the current stream key.
  const { selectedStreamKeyRef } = stream;
  const queryClient = useQueryClient();
  const isLoadingNow = useEffectEvent(() => isLoading);
  const playbackStartedRef = useRef(false);
  const startupWatchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startupWatchdogCancelledRef = useRef(false);
  const manualSelectionOwnsStreamRef = useRef<{
    generation: number;
    url: string | undefined;
    streamKey: string | undefined;
  } | null>(null);
  const [startupWatchdogRevision, setStartupWatchdogRevision] = useState(0);
  const startupRecoveryAttemptedForRef = useRef<Set<string>>(new Set());
  // Failed keys in this episode's chain — excluding only the latest would let A→B→A bounce past a viable third.
  const failedStreamKeysRef = useRef<Set<string>>(new Set());
  // Shared with other callers — a watchdog verdict during an in-flight recovery must not error it out.
  const recoveryInFlightRef = useRef(false);
  const recoveryEpochRef = useRef(0);
  const recoveryRequestIdRef = useRef<string | null>(null);

  const cancelPendingRecovery = useCallback(() => {
    const requestId = recoveryRequestIdRef.current;
    recoveryRequestIdRef.current = null;
    if (requestId) void api.cancelPlaybackRecovery(requestId).catch(() => {});
  }, []);

  const clearRecoveryTimers = useCallback(() => {
    // Cancelled so in-flight recovery cannot swap streams after unmount.
    startupWatchdogCancelledRef.current = true;
    clearTimer(startupWatchdogTimerRef);
    cancelPendingRecovery();
  }, [cancelPendingRecovery]);

  const cancelRecovery = useCallback(() => {
    const generation = ++recoveryEpochRef.current;
    manualSelectionOwnsStreamRef.current = {
      generation,
      url: stream.committedStreamUrlRef.current,
      streamKey: selectedStreamKeyRef.current,
    };
    recoveryInFlightRef.current = false;
    clearRecoveryTimers();
    return generation;
  }, [clearRecoveryTimers, selectedStreamKeyRef, stream.committedStreamUrlRef]);

  const releaseManualSelection = useCallback(
    (generation: number) => {
      const owner = manualSelectionOwnsStreamRef.current;
      if (
        !mountedRef.current ||
        owner?.generation !== generation ||
        owner.url !== stream.committedStreamUrlRef.current ||
        owner.streamKey !== selectedStreamKeyRef.current
      ) {
        return;
      }
      manualSelectionOwnsStreamRef.current = null;
      recoveryEpochRef.current += 1;
      if (!playbackStartedRef.current) {
        startupWatchdogCancelledRef.current = false;
        setStartupWatchdogRevision((revision) => revision + 1);
      }
    },
    [mountedRef, selectedStreamKeyRef, stream.committedStreamUrlRef],
  );

  const markPlaybackStarted = useCallback(() => {
    playbackStartedRef.current = true;
    recoveryEpochRef.current += 1;
    if (recoveryInFlightRef.current) {
      recoveryInFlightRef.current = false;
      setResolveStatus(null);
    }
    clearRecoveryTimers();
  }, [clearRecoveryTimers, setResolveStatus]);

  useEffect(() => {
    recoveryEpochRef.current += 1;
    playbackStartedRef.current = false;
    manualSelectionOwnsStreamRef.current = null;
    startupWatchdogCancelledRef.current = false;
    recoveryInFlightRef.current = false;
    return () => {
      recoveryEpochRef.current += 1;
      cancelPendingRecovery();
    };
  }, [
    cancelPendingRecovery,
    stream.activeStreamUrl,
    stream.activeStreamKey,
    stream.activeStreamMpvHttpHeaderFields,
  ]);

  useEffect(() => {
    cancelPendingRecovery();
    startupRecoveryAttemptedForRef.current.clear();
    failedStreamKeysRef.current.clear();
  }, [
    absoluteEpisode,
    absoluteSeason,
    cancelPendingRecovery,
    mediaId,
    resolveSeason,
    resolveEpisode,
  ]);

  const recoverFromSlowStartup = useCallback(
    async (
      sourceUrl: string,
      outcome: Exclude<PlaybackStreamOutcome, 'verified'> = 'startup-timeout',
    ) => {
      // Fast-fail only; Rust validates media types.
      const effectiveMediaType = mediaType?.trim();
      if (manualSelectionOwnsStreamRef.current) return true;
      if (startupWatchdogCancelledRef.current || playbackStartedRef.current) return false;
      if (
        !mediaId ||
        !sourceUrl ||
        (effectiveMediaType !== 'movie' &&
          effectiveMediaType !== 'series' &&
          effectiveMediaType !== 'anime')
      ) {
        return false;
      }
      if (recoveryInFlightRef.current) return true;
      const failedStreamKey = selectedStreamKeyRef.current;
      const failedRequestIdentity = failedStreamKey || sourceUrl;
      if (startupRecoveryAttemptedForRef.current.has(failedRequestIdentity)) return false;

      const epoch = recoveryEpochRef.current;
      const isCurrent = () => epoch === recoveryEpochRef.current && mountedRef.current;
      const requestId = crypto.randomUUID();
      recoveryRequestIdRef.current = requestId;
      startupRecoveryAttemptedForRef.current.add(failedRequestIdentity);
      const excludedStreamKeys = [...failedStreamKeysRef.current];
      if (failedStreamKey) failedStreamKeysRef.current.add(failedStreamKey);
      recoveryInFlightRef.current = true;
      setError(null);
      setResolveStatus('Trying another stream');

      try {
        const resolved = await withTimeout(
          recoverPlayerStream({
            requestId,
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
          () => {
            if (recoveryRequestIdRef.current === requestId) cancelPendingRecovery();
            return null;
          },
        );

        // The backend re-ranked past the failed stream — don't serve the stale ordering from cache.
        void invalidateStreamQueries(queryClient);

        if (!isCurrent()) return true;
        if (startupWatchdogCancelledRef.current || playbackStartedRef.current) {
          return false;
        }
        if (
          stream.committedStreamUrlRef.current !== sourceUrl ||
          selectedStreamKeyRef.current !== failedStreamKey
        )
          return true;

        if (
          resolved?.url &&
          (resolved.url !== sourceUrl ||
            (failedStreamKey && resolved.streamKey && resolved.streamKey !== failedStreamKey))
        ) {
          applyResolvedStreamToSession(stream, resolved);
          failoverResumePositionRef.current = currentTimeRef.current;
          return true;
        }
      } catch (error) {
        if (getErrorKind(error) === 'cancelled') return true;
        // Best-effort only.
      } finally {
        if (recoveryRequestIdRef.current === requestId) recoveryRequestIdRef.current = null;
        if (isCurrent()) {
          recoveryInFlightRef.current = false;
          setResolveStatus(null);
        }
      }

      return !isCurrent();
    },
    [
      stream,
      absoluteSeason,
      cancelPendingRecovery,
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
      setResolveStatus,
      streamLookupId,
    ],
  );

  useEffect(() => {
    // Recovery bails once playback started, so late dep changes never re-arm.
    if (
      !stream.activeStreamUrl ||
      (!isPlaying && !isResumePending()) ||
      playbackStartedRef.current ||
      manualSelectionOwnsStreamRef.current
    )
      return;

    // This effect re-arms as details/episodes land mid-load — reset the flag the cleanup set or the timer stays cancelled.
    startupWatchdogCancelledRef.current = false;

    clearTimer(startupWatchdogTimerRef);

    const startupWatchdogDelayMs = isHistoryResume ? 10000 : 12000;
    const epoch = recoveryEpochRef.current;

    const checkStartup = () => {
      if (
        epoch !== recoveryEpochRef.current ||
        startupWatchdogCancelledRef.current ||
        playbackStartedRef.current ||
        !mountedRef.current ||
        errorRef.current ||
        (!isPlayingRef.current && !isResumePending())
      ) {
        return;
      }

      if (document.hidden) {
        startupWatchdogTimerRef.current = setTimeout(checkStartup, startupWatchdogDelayMs);
        return;
      }

      const currentUrl = stream.committedStreamUrlRef.current;
      if (!currentUrl) return;

      void recoverFromSlowStartup(
        currentUrl,
        isLoadingNow() ? 'load-failed' : 'startup-timeout',
      ).then((didRecover) => {
        if (
          epoch !== recoveryEpochRef.current ||
          startupWatchdogCancelledRef.current ||
          didRecover ||
          !mountedRef.current ||
          errorRef.current ||
          playbackStartedRef.current ||
          document.hidden ||
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
        setStreamError('This stream is taking too long to start. Try another stream.');
        stopLoading();
      });
    };
    startupWatchdogTimerRef.current = setTimeout(checkStartup, startupWatchdogDelayMs);
    const onVisibilityChange = () => {
      clearTimer(startupWatchdogTimerRef);
      if (!document.hidden && !playbackStartedRef.current && !startupWatchdogCancelledRef.current) {
        startupWatchdogTimerRef.current = setTimeout(checkStartup, startupWatchdogDelayMs);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      startupWatchdogCancelledRef.current = true;
      clearTimer(startupWatchdogTimerRef);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [
    stream,
    errorRef,
    isHistoryResume,
    isPlaying,
    isPlayingRef,
    isResumePending,
    mountedRef,
    recoverFromSlowStartup,
    setStreamError,
    stopLoading,
    onSavedStreamUnavailable,
    startupWatchdogRevision,
  ]);

  return {
    cancelRecovery,
    releaseManualSelection,
    clearRecoveryTimers,
    markPlaybackStarted,
    recoverFromSlowStartup,
  };
}
