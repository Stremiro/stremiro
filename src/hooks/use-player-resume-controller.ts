import { type RefObject, useCallback, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { getPlayableResumeStartTime, MIN_RESUME_POSITION_SECS } from '@/lib/history-playback';
import { mpvCommand, setMpvProperty } from '@/lib/player-mpv';
import { formatTime } from '@/lib/utils';

const RESUME_SEEK_MAX_ATTEMPTS = 6;
const RESUME_SEEK_RETRY_DELAY_MS = 220;
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

function buildResumeSessionKey(
  mediaId?: string,
  mediaType?: string,
  absoluteSeason?: number,
  absoluteEpisode?: number,
  activeStreamUrl?: string,
  startTime?: number,
) {
  return [
    buildResumeMediaKey(mediaId, mediaType, absoluteSeason, absoluteEpisode, startTime),
    activeStreamUrl ?? '',
  ].join('|');
}

// Session key minus the stream URL: a progress fetch stays valid across
// resolve/failover transitions since watch progress is keyed by media only.
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
  startTime?: number;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  isHistoryResume: boolean;
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
  startTime,
  absoluteSeason,
  absoluteEpisode,
  isHistoryResume,
  mountedRef,
  isDestroyedRef,
  currentTimeRef,
  durationRef,
  failoverResumePositionRef,
  onResumeMessage,
}: UsePlayerResumeControllerArgs) {
  const resumeTimeRef = useRef(0);
  const resumeAppliedRef = useRef(false);
  const resumeSeekAttemptsRef = useRef(0);
  const resumeSeekInFlightRef = useRef(false);
  const resumeSeekRetryTimerRef = useRef<number | null>(null);
  const resumePausePendingRef = useRef(false);
  const resumeOsdShownRef = useRef(false);
  const resumeSessionKeyRef = useRef('');
  const resumeMediaKeyRef = useRef('');
  // Bumped on every resume-session change: a seek issued under session A can
  // never be mistaken for the new session's bookkeeping after A→B (or A→B→A).
  const resumeSessionEpochRef = useRef(0);
  const activeStreamUrlRef = useRef(activeStreamUrl);
  const applyResumeIfReadyRef = useRef<() => Promise<void>>(async () => undefined);

  const clearResumeRetryTimer = useCallback(() => {
    if (resumeSeekRetryTimerRef.current !== null) {
      window.clearTimeout(resumeSeekRetryTimerRef.current);
      resumeSeekRetryTimerRef.current = null;
    }
  }, []);

  const releaseResumePause = useCallback(async () => {
    if (!resumePausePendingRef.current || !mountedRef.current || isDestroyedRef.current) {
      return;
    }

    resumePausePendingRef.current = false;

    try {
      await setMpvProperty('pause', false);
    } catch {
      // Best-effort only; dev-gated warn keeps prod silent.
      if (import.meta.env.DEV) console.warn('[player] resume unpause best-effort failed');
    }
  }, [isDestroyedRef, mountedRef]);

  const finalizeResume = useCallback(
    async (resumeTime: number, didSeek: boolean) => {
      resumeAppliedRef.current = true;
      resumeSeekInFlightRef.current = false;
      resumeSeekAttemptsRef.current = 0;
      clearResumeRetryTimer();

      // Announce any applied resume — a plain Play that silently jumps to
      // the saved position is exactly when the user needs the explanation.
      if (didSeek && resumeTime > 60 && !resumeOsdShownRef.current) {
        resumeOsdShownRef.current = true;
        onResumeMessage(`Resuming from ${formatTime(resumeTime)}`);
      }

      await releaseResumePause();
    },
    [clearResumeRetryTimer, onResumeMessage, releaseResumePause],
  );

  const scheduleResumeRetry = useCallback((delayMs = RESUME_SEEK_RETRY_DELAY_MS) => {
    if (resumeAppliedRef.current || resumeSeekRetryTimerRef.current !== null) {
      return;
    }

    resumeSeekRetryTimerRef.current = window.setTimeout(() => {
      resumeSeekRetryTimerRef.current = null;
      void applyResumeIfReadyRef.current();
    }, delayMs);
  }, []);

  const applyResumeIfReady = useCallback(async () => {
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

    if (resumeSeekAttemptsRef.current >= RESUME_SEEK_MAX_ATTEMPTS) {
      await finalizeResume(resumeTime, false);
      return;
    }

    resumeSeekInFlightRef.current = true;
    resumeSeekAttemptsRef.current += 1;
    const seekEpoch = resumeSessionEpochRef.current;

    try {
      await mpvCommand('seek', [resumeTime.toString(), 'absolute']);
    } catch {
      // MPV may reject early seeks before metadata is ready.
      if (import.meta.env.DEV) console.warn('[player] resume seek deferred');
    } finally {
      // Only the issuing session may release the flag — a stale completion
      // must not clear the in-flight bookkeeping of a newer session's seek.
      if (resumeSessionEpochRef.current === seekEpoch) {
        resumeSeekInFlightRef.current = false;
      }
    }

    // A session change or teardown mid-seek invalidates the whole tail: the
    // old resumeTime must not finalize, unpause, or schedule a retry for the
    // new session.
    if (
      resumeSessionEpochRef.current !== seekEpoch ||
      !mountedRef.current ||
      isDestroyedRef.current
    ) {
      return;
    }

    if (currentTimeRef.current >= satisfiedResumeTime) {
      await finalizeResume(resumeTime, true);
      return;
    }

    scheduleResumeRetry(durationValue > 0 ? 140 : RESUME_SEEK_RETRY_DELAY_MS);
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

  const prepareForStreamLoad = useCallback(() => {
    resumeAppliedRef.current = false;
    const initialResumeTime = resumeTimeRef.current;
    const shouldStartPaused = initialResumeTime >= MIN_RESUME_POSITION_SECS;
    resumePausePendingRef.current = shouldStartPaused;
    return shouldStartPaused;
  }, []);

  useEffect(() => {
    applyResumeIfReadyRef.current = applyResumeIfReady;
  }, [applyResumeIfReady]);

  useEffect(() => {
    const normalizedStartTime = normalizeResumeTime(startTime);
    const nextResumeSessionKey = buildResumeSessionKey(
      mediaId,
      mediaType,
      absoluteSeason,
      absoluteEpisode,
      activeStreamUrl,
      startTime,
    );

    // Same session re-render: keep applied state so late fetches cannot
    // re-seek over the user's current position.
    if (nextResumeSessionKey === resumeSessionKeyRef.current) return;

    const nextMediaKey = buildResumeMediaKey(
      mediaId,
      mediaType,
      absoluteSeason,
      absoluteEpisode,
      startTime,
    );
    const mediaChanged = nextMediaKey !== resumeMediaKeyRef.current;
    const streamKept = activeStreamUrlRef.current === activeStreamUrl;
    // Start over relaunching the still-loaded stream (same session, same
    // winner) reloads nothing, so the sub-threshold sentinel must rewind here.
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

    if (mediaChanged) {
      resumeTimeRef.current = normalizedStartTime;
    } else {
      // Same title, new stream (initial resolve or failover): keep a resume
      // candidate the progress fetch already delivered — wiping it here would
      // silently drop resume whenever the fetch beats stream resolution.
      const failoverPosition = failoverResumePositionRef.current;
      failoverResumePositionRef.current = 0;
      if (resumeAppliedRef.current && failoverPosition >= MIN_RESUME_POSITION_SECS) {
        // Post-resume failover: the position where the previous stream died
        // is where the user actually was — replace the stale candidate,
        // otherwise the swap rewinds over already-watched content.
        resumeTimeRef.current = failoverPosition;
      } else {
        // Resume still pending (or a non-resume start): keep the intended
        // point unless playback had already moved past it.
        resumeTimeRef.current = Math.max(
          resumeTimeRef.current,
          normalizedStartTime,
          failoverPosition,
        );
      }
    }

    resumeAppliedRef.current = false;
    resumeSeekAttemptsRef.current = 0;
    resumeSeekInFlightRef.current = false;
    resumePausePendingRef.current = false;
    resumeOsdShownRef.current = false;
    clearResumeRetryTimer();

    if (restartLoadedStream) {
      resumeAppliedRef.current = true;
      void mpvCommand('seek', ['0', 'absolute'])
        .then(() => setMpvProperty('pause', false))
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
    clearResumeRetryTimer,
    currentTimeRef,
    durationRef,
    failoverResumePositionRef,
    mediaId,
    mediaType,
    startTime,
  ]);

  useEffect(() => {
    if (!mediaType || !mediaId || mediaId === 'local') {
      return;
    }

    // Deterministic discards — skip the IPC. A history-resume plan already
    // refreshed progress before navigating, an explicit start time wins, and
    // an applied resume can never be upgraded.
    if (isHistoryResume || normalizeResumeTime(startTime) > 0) return;
    if (resumeAppliedRef.current) return;

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
        const candidate = getPlayableResumeStartTime(progress);

        if (cancelled || requestMediaKey !== resumeMediaKeyRef.current || !candidate) {
          return;
        }
        // Never clobber an applied resume: late history reads must not jump
        // back over the user's position.
        if (resumeAppliedRef.current) return;
        if (currentTimeRef.current >= candidate - 2) return;
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

  return {
    applyResumeIfReady,
    clearResumeRetryTimer,
    prepareForStreamLoad,
  };
}
