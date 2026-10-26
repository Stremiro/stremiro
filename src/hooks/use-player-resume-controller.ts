import { useCallback, type RefObject, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { MIN_RESUME_POSITION_SECS } from '@/lib/history-playback';
import { seekAbsoluteSeconds, setMpvProperty } from '@/lib/player-mpv';
import { usePlayerSession } from '@/lib/player-session';
import { clearTimer, formatTime, isLocalMediaId } from '@/lib/utils';

const RESUME_SEEK_MAX_ATTEMPTS = 6;
const RESUME_SEEK_RETRY_DELAY_MS = 220;
const RESUME_SEEK_SETTLE_TIMEOUT_MS = 1500;
const RESUME_SEEK_SETTLE_TOLERANCE_SECS = 2;
// Anti-flap hysteresis: fetched candidates only upgrade, never downgrade.
const RESUME_FETCH_UPGRADE_MIN_DELTA_SECS = 8;

function normalizeResumeTime(value?: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function hasResumeReadinessSignal(currentTime: number, duration: number): boolean {
  return (
    (Number.isFinite(duration) && duration > 0) || (Number.isFinite(currentTime) && currentTime > 0)
  );
}

// Watch progress is keyed by media only, so fetches stay valid across native loads.
function buildResumeMediaKey(
  mediaId?: string,
  mediaType?: string,
  absoluteSeason?: number,
  absoluteEpisode?: number,
  startTime?: number,
) {
  return [
    mediaId ?? '',
    mediaType ?? '',
    absoluteSeason ?? '',
    absoluteEpisode ?? '',
    normalizeResumeTime(startTime),
  ].join('|');
}

interface UsePlayerResumeControllerArgs {
  mediaId?: string;
  mediaType?: string;
  activeStreamUrl?: string;
  activeStreamLoadKey: string;
  startTime?: number;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  isHistoryResume: boolean;
  suspended: boolean;
  mountedRef: RefObject<boolean>;
  isDestroyedRef: RefObject<boolean>;
  currentTimeRef: RefObject<number>;
  durationRef: RefObject<number>;
  failoverResumePositionRef: RefObject<number>;
  onResumeMessage: (text: string) => void;
}

export function usePlayerResumeController({
  mediaId,
  mediaType,
  activeStreamUrl,
  activeStreamLoadKey,
  startTime,
  absoluteSeason,
  absoluteEpisode,
  isHistoryResume,
  suspended,
  mountedRef,
  isDestroyedRef,
  currentTimeRef,
  durationRef,
  failoverResumePositionRef,
  onResumeMessage,
}: UsePlayerResumeControllerArgs) {
  const { trayPause } = usePlayerSession();
  const resumeTimeRef = useRef(0);
  const resumeAppliedRef = useRef(false);
  const automaticResumeCancelledRef = useRef(false);
  const resumeSeekAttemptsRef = useRef(0);
  const resumeSeekInFlightRef = useRef(false);
  const resumeSeekSettleUntilRef = useRef(0);
  const resumeSeekRetryTimerRef = useRef<number | null>(null);
  const resumePausePendingRef = useRef(false);
  const resumeOsdShownRef = useRef(false);
  const resumeSessionKeyRef = useRef('');
  const resumeMediaKeyRef = useRef('');
  // Session changes and user seeks invalidate pending resume continuations.
  const resumeSessionEpochRef = useRef(0);
  const activeStreamUrlRef = useRef(activeStreamUrl);
  const activeStreamLoadKeyRef = useRef(activeStreamLoadKey);
  const applyResumeIfReadyRef = useRef<() => Promise<void>>(async () => undefined);
  const suspendedRef = useRef(suspended);

  const clearResumeRetryTimer = useCallback(() => clearTimer(resumeSeekRetryTimerRef), []);

  const isResumePending = useCallback(
    () =>
      !suspendedRef.current &&
      (resumePausePendingRef.current ||
        (!resumeAppliedRef.current && resumeTimeRef.current >= MIN_RESUME_POSITION_SECS)),
    [],
  );

  const releaseResumePause = useCallback(async () => {
    if (!resumePausePendingRef.current || !mountedRef.current || isDestroyedRef.current) {
      return;
    }

    resumePausePendingRef.current = false;
    if (trayPause.getSnapshot()) return;

    try {
      await setMpvProperty('pause', false);
    } catch {
      // Best-effort only; dev-gated warn keeps prod silent.
      if (import.meta.env.DEV) console.warn('[player] resume unpause best-effort failed');
    }
  }, [isDestroyedRef, mountedRef, trayPause]);

  // Hands a resume-owned pause to another owner so finalization cannot unpause underneath it.
  const takeResumePause = () => {
    const owned = resumePausePendingRef.current;
    resumePausePendingRef.current = false;
    return owned;
  };

  const finalizeResume = useCallback(
    async (resumeTime: number, didSeek: boolean) => {
      resumeAppliedRef.current = true;
      resumeSeekInFlightRef.current = false;
      resumeSeekSettleUntilRef.current = 0;
      resumeSeekAttemptsRef.current = 0;
      clearResumeRetryTimer();

      // Announce any applied resume — a plain Play silently jumping to a saved position needs the explanation.
      if (didSeek && resumeTime > 60 && !resumeOsdShownRef.current) {
        resumeOsdShownRef.current = true;
        onResumeMessage(`Resuming from ${formatTime(resumeTime)}`);
      }

      await releaseResumePause();
    },
    [clearResumeRetryTimer, onResumeMessage, releaseResumePause],
  );

  const cancelAutomaticResume = () => {
    automaticResumeCancelledRef.current = true;
    resumeSessionEpochRef.current += 1;
    resumeTimeRef.current = 0;
    void finalizeResume(0, false);
  };

  const scheduleResumeRetry = useCallback(
    (delayMs = RESUME_SEEK_RETRY_DELAY_MS) => {
      if (suspendedRef.current) {
        clearResumeRetryTimer();
        return;
      }
      if (resumeAppliedRef.current || resumeSeekRetryTimerRef.current !== null) {
        return;
      }

      resumeSeekRetryTimerRef.current = window.setTimeout(() => {
        resumeSeekRetryTimerRef.current = null;
        void applyResumeIfReadyRef.current();
      }, delayMs);
    },
    [clearResumeRetryTimer],
  );

  const applyResumeIfReady = useCallback(async () => {
    if (suspendedRef.current) {
      clearResumeRetryTimer();
      return;
    }
    const resumeTime = resumeTimeRef.current;
    const currentTime = currentTimeRef.current;
    const durationValue = durationRef.current;

    if (resumeAppliedRef.current) {
      await releaseResumePause();
      return;
    }

    if (resumeTime < MIN_RESUME_POSITION_SECS) {
      clearResumeRetryTimer();
      await releaseResumePause();
      return;
    }

    if (durationValue > 0 && resumeTime >= Math.max(MIN_RESUME_POSITION_SECS, durationValue - 5)) {
      await finalizeResume(resumeTime, false);
      return;
    }

    if (!hasResumeReadinessSignal(currentTime, durationValue)) {
      scheduleResumeRetry();
      return;
    }

    const satisfiedResumeTime = Math.max(0, resumeTime - RESUME_SEEK_SETTLE_TOLERANCE_SECS);
    if (currentTime >= satisfiedResumeTime) {
      await finalizeResume(resumeTime, true);
      return;
    }

    if (resumeSeekInFlightRef.current) {
      return;
    }
    const settleRemaining = resumeSeekSettleUntilRef.current - performance.now();
    if (settleRemaining > 0) {
      scheduleResumeRetry(settleRemaining);
      return;
    }

    if (resumeSeekAttemptsRef.current >= RESUME_SEEK_MAX_ATTEMPTS) {
      await finalizeResume(resumeTime, false);
      return;
    }

    resumeSeekInFlightRef.current = true;
    resumeSeekAttemptsRef.current += 1;
    const seekEpoch = resumeSessionEpochRef.current;

    await (async () => {
      try {
        await seekAbsoluteSeconds(resumeTime);
        if (resumeSessionEpochRef.current === seekEpoch) {
          resumeSeekSettleUntilRef.current = performance.now() + RESUME_SEEK_SETTLE_TIMEOUT_MS;
        }
      } catch {
        // MPV may reject early seeks before metadata is ready.
        if (import.meta.env.DEV) console.warn('[player] resume seek deferred');
      }
    })().finally(() => {
      // Only the issuing session may release the flag — a stale completion must not clear a newer seek.
      if (resumeSessionEpochRef.current === seekEpoch) {
        resumeSeekInFlightRef.current = false;
      }
    });

    // Cancellation or a session change invalidates the seek continuation.
    if (
      resumeSessionEpochRef.current !== seekEpoch ||
      suspendedRef.current ||
      !mountedRef.current ||
      isDestroyedRef.current
    ) {
      return;
    }

    if (currentTimeRef.current >= satisfiedResumeTime) {
      await finalizeResume(resumeTime, true);
      return;
    }

    scheduleResumeRetry(
      Math.max(
        durationValue > 0 ? 140 : RESUME_SEEK_RETRY_DELAY_MS,
        resumeSeekSettleUntilRef.current - performance.now(),
      ),
    );
  }, [
    clearResumeRetryTimer,
    currentTimeRef,
    durationRef,
    finalizeResume,
    isDestroyedRef,
    mountedRef,
    releaseResumePause,
    scheduleResumeRetry,
  ]);

  const prepareForStreamLoad = () => {
    resumeAppliedRef.current = false;
    const initialResumeTime = resumeTimeRef.current;
    const shouldStartPaused = initialResumeTime >= MIN_RESUME_POSITION_SECS;
    resumePausePendingRef.current = shouldStartPaused;
    return shouldStartPaused;
  };

  useEffect(() => {
    applyResumeIfReadyRef.current = applyResumeIfReady;
  }, [applyResumeIfReady]);

  useEffect(() => {
    const normalizedStartTime = normalizeResumeTime(startTime);
    const nextMediaKey = buildResumeMediaKey(
      mediaId,
      mediaType,
      absoluteSeason,
      absoluteEpisode,
      startTime,
    );
    const nextResumeSessionKey = JSON.stringify([nextMediaKey, activeStreamLoadKey]);

    // Same session: keep applied state so late fetches can't re-seek over the user's position.
    if (nextResumeSessionKey === resumeSessionKeyRef.current) return;

    const mediaChanged = nextMediaKey !== resumeMediaKeyRef.current;
    const streamKept = activeStreamLoadKeyRef.current === activeStreamLoadKey;
    // "Start over" on the still-loaded stream reloads nothing, so the sub-threshold sentinel must rewind here.
    const restartLoadedStream =
      mediaChanged &&
      streamKept &&
      !!activeStreamUrl &&
      normalizedStartTime > 0 &&
      normalizedStartTime < MIN_RESUME_POSITION_SECS &&
      currentTimeRef.current >= MIN_RESUME_POSITION_SECS;

    resumeSessionKeyRef.current = nextResumeSessionKey;
    resumeMediaKeyRef.current = nextMediaKey;
    resumeSessionEpochRef.current += 1;
    activeStreamUrlRef.current = activeStreamUrl;
    activeStreamLoadKeyRef.current = activeStreamLoadKey;

    if (mediaChanged) {
      automaticResumeCancelledRef.current = false;
      resumeTimeRef.current = normalizedStartTime;
    } else {
      // Same title, new stream (resolve/failover): keep a delivered resume candidate — wiping it drops resume when the fetch beats resolution.
      const failoverPosition = failoverResumePositionRef.current;
      failoverResumePositionRef.current = 0;
      if (resumeAppliedRef.current && failoverPosition >= MIN_RESUME_POSITION_SECS) {
        // Post-resume failover: the die-position is where the user was — replace the stale candidate or the swap rewinds.
        resumeTimeRef.current = failoverPosition;
      } else {
        // Resume pending (or non-resume start): keep the intended point unless playback already moved past it.
        resumeTimeRef.current = Math.max(
          resumeTimeRef.current,
          automaticResumeCancelledRef.current ? 0 : normalizedStartTime,
          failoverPosition,
        );
      }
    }

    resumeAppliedRef.current = false;
    resumeSeekAttemptsRef.current = 0;
    resumeSeekInFlightRef.current = false;
    resumeSeekSettleUntilRef.current = 0;
    resumePausePendingRef.current = false;
    resumeOsdShownRef.current = false;
    clearResumeRetryTimer();

    if (restartLoadedStream) {
      resumeAppliedRef.current = true;
      const restartEpoch = resumeSessionEpochRef.current;
      void seekAbsoluteSeconds(0)
        .then(() =>
          restartEpoch === resumeSessionEpochRef.current &&
          mountedRef.current &&
          !isDestroyedRef.current &&
          !trayPause.getSnapshot()
            ? setMpvProperty('pause', false)
            : undefined,
        )
        .catch(() => undefined);
      return;
    }

    if (
      resumeTimeRef.current >= MIN_RESUME_POSITION_SECS &&
      activeStreamUrl &&
      hasResumeReadinessSignal(currentTimeRef.current, durationRef.current)
    ) {
      void applyResumeIfReadyRef.current();
    }
  }, [
    absoluteEpisode,
    absoluteSeason,
    activeStreamUrl,
    activeStreamLoadKey,
    clearResumeRetryTimer,
    currentTimeRef,
    durationRef,
    failoverResumePositionRef,
    isDestroyedRef,
    mediaId,
    mediaType,
    mountedRef,
    startTime,
    trayPause,
  ]);

  useEffect(() => {
    if (!mediaType || !mediaId || isLocalMediaId(mediaId)) {
      return;
    }

    // Deterministic discards skip the IPC: history-resume already refreshed progress, explicit start time wins, applied resume can't upgrade.
    if (isHistoryResume || normalizeResumeTime(startTime) > 0) return;
    if (resumeAppliedRef.current || automaticResumeCancelledRef.current) return;

    let cancelled = false;
    const requestMediaKey = buildResumeMediaKey(
      mediaId,
      mediaType,
      absoluteSeason,
      absoluteEpisode,
      startTime,
    );

    void api
      .getWatchProgress(mediaId, mediaType, absoluteSeason, absoluteEpisode)
      .then((progress) => {
        const candidate = progress?.resume_start_time;

        if (cancelled || requestMediaKey !== resumeMediaKeyRef.current || !candidate) {
          return;
        }
        // Late history reads must not jump back over the user's position.
        if (resumeAppliedRef.current || automaticResumeCancelledRef.current) return;
        if (currentTimeRef.current >= candidate - RESUME_SEEK_SETTLE_TOLERANCE_SECS) return;
        const currentResume = resumeTimeRef.current;
        const shouldUpgradeResume =
          currentResume <= 0 || candidate >= currentResume + RESUME_FETCH_UPGRADE_MIN_DELTA_SECS;

        if (shouldUpgradeResume) {
          resumeTimeRef.current = candidate;
          resumeOsdShownRef.current = false;

          if (
            activeStreamUrlRef.current &&
            hasResumeReadinessSignal(currentTimeRef.current, durationRef.current)
          ) {
            void applyResumeIfReadyRef.current();
          }
        }
      })
      .catch(() => {
        if (import.meta.env.DEV) console.warn('[player] resume progress fetch failed');
      });

    return () => {
      cancelled = true;
    };
  }, [
    absoluteEpisode,
    absoluteSeason,
    currentTimeRef,
    durationRef,
    isHistoryResume,
    mediaId,
    mediaType,
    startTime,
  ]);

  useEffect(() => {
    suspendedRef.current = suspended;
    if (suspended) {
      clearResumeRetryTimer();
    } else if (activeStreamUrlRef.current && isResumePending()) {
      void applyResumeIfReadyRef.current();
    }
  }, [clearResumeRetryTimer, isResumePending, suspended]);

  useEffect(() => () => clearResumeRetryTimer(), [clearResumeRetryTimer]);

  return {
    applyResumeIfReady,
    cancelAutomaticResume,
    clearResumeRetryTimer,
    isResumePending,
    prepareForStreamLoad,
    takeResumePause,
  };
}
