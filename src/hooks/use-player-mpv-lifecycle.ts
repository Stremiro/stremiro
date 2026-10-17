import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import { listenEvents } from 'tauri-plugin-libmpv-api';

import type { PlayerStreamSession } from '@/hooks/use-player-stream-session';
import type { SubtitleAdjustmentSettings } from '@/hooks/use-subtitle-adjustments';
import type { PlaybackLanguagePreferences } from '@/lib/api';
import type { PlaybackClock } from '@/lib/player-clock';
import { enqueuePlayerLifecycle } from '@/lib/player-lifecycle';
import {
  mpvCommand,
  mpvDestroy,
  mpvInit,
  readPlaybackPositionProbe,
  setMpvProperties,
} from '@/lib/player-mpv';
import { isNearMediaEnd } from '@/lib/player-skip';
import { usePlayerSession } from '@/lib/player-session';
import { sleep, type TimerHandle } from '@/lib/utils';

const TIME_UPDATE_THROTTLE_MS = 350;
const HIDDEN_TIME_UPDATE_THROTTLE_MS = 1000;
// Position probe cadence: subscribers get ~3Hz while per-frame property events stay off.
const POSITION_POLL_MS = 300;
const POSITION_MAINTENANCE_POLL_MS = 1000;
// Post-pause probe grace covers optimistic-seek settle ticks and a quick resume click.
const PAUSED_POLL_GRACE_MS = 1500;
const POSITION_POLL_FAILURE_BUDGET_MS = 7500;
// The buffered-ahead band only needs to move when it visibly would.
const BUFFERED_PUBLISH_DELTA_SECS = 0.5;
const IDLE_GRACE_MS = 4000;
// Mid-playback `idle-active` = source dropped under a live playhead; if still dead after this window the failure must reach the user.
const IDLE_DEAD_VERDICT_MS = 10_000;
const MPV_TEARDOWN_SETTLE_MS = 150;
const TRACK_REFRESH_COALESCE_MS = 120;
const FORCE_SHOW_AFTER_MS = 6500;

type StreamFailureOutcome = 'load-failed' | 'disconnected';

export function getPlayerStreamLoadKey(stream: PlayerStreamSession): string {
  return JSON.stringify([
    stream.activeStreamUrl,
    stream.activeStreamKey,
    stream.activeStreamMpvHttpHeaderFields,
  ]);
}

interface UsePlayerMpvLifecycleArgs {
  stream: PlayerStreamSession;
  isHistoryResume: boolean;
  /** Read at apply time — a mid-init pref change must not bind a stale speed. */
  playbackSpeedRef: RefObject<number>;
  /** Read at apply time — a mid-init pref hydration must not bind stale defaults. */
  subtitleSettingsRef: RefObject<SubtitleAdjustmentSettings>;
  playbackLanguagePreferencesRef: RefObject<PlaybackLanguagePreferences>;
  volumeRef: RefObject<number>;
  isMutedRef: RefObject<boolean>;
  mountedRef: RefObject<boolean>;
  isDestroyedRef: RefObject<boolean>;
  mpvInitializedRef: RefObject<boolean>;
  isLoading: boolean;
  isPlayingRef: RefObject<boolean>;
  isBufferingRef: RefObject<boolean>;
  clock: PlaybackClock;
  observedPositionRef: RefObject<number | null>;
  /** Buffered-ahead seconds store — feeds the seekbar band without player-tree renders. */
  bufferedClock: PlaybackClock;
  durationRef: RefObject<number>;
  playbackVerifiedAtRef: RefObject<number>;
  errorRef: RefObject<string | null>;
  recoverableStreamErrorRef: RefObject<string | null>;
  forceShowTimeoutRef: RefObject<TimerHandle | null>;
  saveProgressRef: RefObject<(() => Promise<void>) | undefined>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setError: (value: string | null) => void;
  setStreamError: (value: string) => void;
  setDuration: Dispatch<SetStateAction<number>>;
  setIsPlaying: Dispatch<SetStateAction<boolean>>;
  setVolume: Dispatch<SetStateAction<number>>;
  setIsMuted: (muted: boolean) => void;
  setPlaybackSpeed: Dispatch<SetStateAction<number>>;
  setMpvSurfaceReady: Dispatch<SetStateAction<boolean>>;
  /** Imperative margin re-apply — a reconfig event must not re-render the player tree. */
  requestSurfaceRefresh: () => void;
  isResolvingRef: RefObject<boolean>;
  // Callbacks read through `useEffectEvent` wrappers so the stream effect always invokes the latest props.
  clearUiTimers: () => void;
  clearResumeRetryTimer: () => void;
  clearRecoveryTimers: () => void;
  prepareForStreamLoad: () => boolean;
  markPlaybackReady: () => void;
  /** First advancing playhead tick; idempotent per stream. */
  markPlaybackVerified: () => void;
  applyResumeIfReady: () => Promise<void>;
  onEndedChange: (ended: boolean) => void;
  /** Optimistic-seek gate: true while a time-pos tick should be swallowed for the pending target. */
  observeTimeUpdate: (timePos: number, now: number) => boolean;
  /** True while an optimistic seek is pending — keeps the probe alive past the idle gate. */
  isSeekPending: () => boolean;
  /** Resume seeks bypass optimistic seeking and need observed positions while paused. */
  isResumePending: () => boolean;
  /** True when a switch waiter owns the follow-up track refresh. */
  onObservedTrackSelection: (type: 'audio' | 'sub', id: number | null) => boolean;
  refreshTracks: () => Promise<unknown>;
  reportStreamFailure: (
    outcome: StreamFailureOutcome,
    sourceUrl?: string,
    streamKey?: string,
  ) => void;
  recoverFromSlowStartup: (sourceUrl: string, outcome: StreamFailureOutcome) => Promise<boolean>;
  reopenSelectorForSavedStreamFailure: () => void;
  stopLoading: (makeTransparent?: boolean) => void;
  setTransparent: (transparent: boolean) => void;
  restorePlayerSurface: () => void;
  revealControls: () => void;
}

export function usePlayerMpvLifecycle({
  stream,
  isHistoryResume,
  playbackSpeedRef,
  subtitleSettingsRef,
  playbackLanguagePreferencesRef,
  volumeRef,
  isMutedRef,
  mountedRef,
  isDestroyedRef,
  mpvInitializedRef,
  isLoading,
  isPlayingRef,
  isBufferingRef,
  clock,
  observedPositionRef,
  bufferedClock,
  durationRef,
  playbackVerifiedAtRef,
  errorRef,
  recoverableStreamErrorRef,
  forceShowTimeoutRef,
  saveProgressRef,
  setIsLoading,
  setError,
  setStreamError,
  setDuration,
  setIsPlaying,
  setVolume,
  setIsMuted,
  setPlaybackSpeed,
  setMpvSurfaceReady,
  isResolvingRef,
  ...callbacks
}: UsePlayerMpvLifecycleArgs) {
  const { trayPause } = usePlayerSession();
  const {
    activeStreamUrl,
    activeStreamMpvHttpHeaderFields,
    activeStreamKey,
    committedStreamUrlRef,
  } = stream;
  const activeStreamLoadKey = getPlayerStreamLoadKey(stream);
  const isDev = import.meta.env.DEV;
  const currentTimeRef = clock.ref;
  // Effect events keep callback changes from restarting the native player.
  const recoverFromSlowStartup = useEffectEvent(callbacks.recoverFromSlowStartup);
  const reportStreamFailure = useEffectEvent(callbacks.reportStreamFailure);
  const applyResumeIfReady = useEffectEvent(callbacks.applyResumeIfReady);
  const markPlaybackReady = useEffectEvent(callbacks.markPlaybackReady);
  const markPlaybackVerified = useEffectEvent(callbacks.markPlaybackVerified);
  const prepareForStreamLoad = useEffectEvent(callbacks.prepareForStreamLoad);
  const refreshTracks = useEffectEvent(callbacks.refreshTracks);
  const reopenSelector = useEffectEvent(callbacks.reopenSelectorForSavedStreamFailure);
  const stopLoading = useEffectEvent(callbacks.stopLoading);
  const setTransparent = useEffectEvent(callbacks.setTransparent);
  const restorePlayerSurface = useEffectEvent(callbacks.restorePlayerSurface);
  const clearUiTimers = useEffectEvent(callbacks.clearUiTimers);
  const clearResumeRetryTimer = useEffectEvent(callbacks.clearResumeRetryTimer);
  const clearRecoveryTimers = useEffectEvent(callbacks.clearRecoveryTimers);
  const observeTimeUpdate = useEffectEvent(callbacks.observeTimeUpdate);
  const isSeekPending = useEffectEvent(callbacks.isSeekPending);
  const isResumePending = useEffectEvent(callbacks.isResumePending);
  const onObservedTrackSelection = useEffectEvent(callbacks.onObservedTrackSelection);
  const onEndedChange = useEffectEvent(callbacks.onEndedChange);
  const revealControls = useEffectEvent(callbacks.revealControls);
  const requestSurfaceRefresh = useEffectEvent(callbacks.requestSurfaceRefresh);
  const isHistoryResumeNow = useEffectEvent(() => isHistoryResume);
  const isLoadingNow = useEffectEvent(() => isLoading);
  const [isBuffering, setIsBuffering] = useState(false);
  const refreshPositionRef = useRef<(() => void) | null>(null);
  const requestPositionRefresh = useCallback(() => refreshPositionRef.current?.(), []);

  useEffect(() => {
    const publishVisiblePosition = () => {
      if (document.hidden) return;
      // Paused polling may be idle when a hidden window becomes visible.
      clock.publish(clock.ref.current);
      bufferedClock.publish(bufferedClock.ref.current);
      requestPositionRefresh();
    };
    document.addEventListener('visibilitychange', publishVisiblePosition);
    return () => document.removeEventListener('visibilitychange', publishVisiblePosition);
  }, [clock, bufferedClock, requestPositionRefresh]);

  useEffect(() => {
    if (!activeStreamUrl) return;

    isDestroyedRef.current = false;
    mpvInitializedRef.current = false;

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let loadfileSent = false;
    let trackRefreshTimer: TimerHandle | null = null;
    let surfaceRefreshFrame: number | null = null;
    let idleGraceTimer: TimerHandle | null = null;
    let idleDeadTimer: TimerHandle | null = null;
    let idleActive = false;
    let positionPollTimer: TimerHandle | null = null;
    let positionPollInFlight = false;
    let positionPollRequested = false;
    let positionGeneration = 0;
    let previousNativePosition: { time: number; at: number; streamError: string | null } | null =
      null;
    let seeking = false;
    let pendingEof = false;
    let eofGeneration = 0;
    let lastTimePublishAt = 0;
    let lastBufferedPublishAt = 0;
    let pausedPollGraceUntil = 0;
    let probeFailuresSince: number | null = null;
    let nearCompletionSaved = false;

    // Cosmetic property writes must never fail init — a reject here would surface "Failed to initialize player" on a live mpv.
    const setMpvPropertiesBestEffort = (properties: Parameters<typeof setMpvProperties>[0]) =>
      setMpvProperties(properties).catch(() => {
        if (isDev) console.warn('[player] mpv property batch apply best-effort failed');
      });

    const streamGone = () => cancelled || !mountedRef.current || isDestroyedRef.current;

    const isPlayheadNearEnd = () => isNearMediaEnd(currentTimeRef.current, durationRef.current);

    const clearTransientTimers = () => {
      pendingEof = false;
      eofGeneration += 1;
      if (trackRefreshTimer !== null) clearTimeout(trackRefreshTimer);
      if (surfaceRefreshFrame !== null) {
        window.cancelAnimationFrame(surfaceRefreshFrame);
        surfaceRefreshFrame = null;
      }
      if (idleGraceTimer !== null) {
        clearTimeout(idleGraceTimer);
        idleGraceTimer = null;
      }
      if (idleDeadTimer !== null) {
        clearTimeout(idleDeadTimer);
        idleDeadTimer = null;
      }
      if (positionPollTimer !== null) {
        clearTimeout(positionPollTimer);
        positionPollTimer = null;
      }
    };

    // mpv bursts file-loaded + reconfig + track notifications on every mount/recovery — coalesce to one refresh per quiet period.
    const scheduleTrackRefresh = () => {
      if (trackRefreshTimer !== null) clearTimeout(trackRefreshTimer);
      trackRefreshTimer = setTimeout(() => {
        trackRefreshTimer = null;
        if (!streamGone()) {
          void refreshTracks();
        }
      }, TRACK_REFRESH_COALESCE_MS);
    };

    const scheduleSurfaceRefresh = () => {
      if (surfaceRefreshFrame !== null) return;
      surfaceRefreshFrame = window.requestAnimationFrame(() => {
        surfaceRefreshFrame = null;
        if (!streamGone()) requestSurfaceRefresh();
      });
    };

    const handleIdleActive = () => {
      if (streamGone() || !idleActive || errorRef.current) return;
      if (isLoadingNow() && !loadfileSent) return;

      const verifiedAt = playbackVerifiedAtRef.current;
      const graceRemaining = IDLE_GRACE_MS - (performance.now() - verifiedAt);
      if (verifiedAt > 0 && graceRemaining > 0) {
        if (idleGraceTimer === null) {
          idleGraceTimer = setTimeout(() => {
            idleGraceTimer = null;
            handleIdleActive();
          }, graceRemaining);
        }
        return;
      }

      const hasProgressedMeaningfully = currentTimeRef.current > 2 && durationRef.current > 0;

      if (isPlayheadNearEnd()) return;

      const currentUrl = committedStreamUrlRef.current;
      if (!currentUrl) return;

      const duringInitialLoad = isLoadingNow();
      const outcome = duringInitialLoad ? 'load-failed' : 'disconnected';

      // Report only where recovery never runs — `recover_playback_stream` records the outcome itself.
      if (isHistoryResumeNow() && duringInitialLoad) {
        reportStreamFailure(outcome, activeStreamUrl, activeStreamKey);
        stopLoading();
        reopenSelector();
        return;
      }

      if (hasProgressedMeaningfully) {
        reportStreamFailure(outcome, activeStreamUrl, activeStreamKey);
        // Nothing reloads a mid-playback idle — arm a verdict; recovery, a swap, or position movement cancels it.
        if (idleDeadTimer === null) {
          const deadPosition = currentTimeRef.current;
          idleDeadTimer = setTimeout(() => {
            idleDeadTimer = null;
            if (streamGone()) return;
            if (errorRef.current || isResolvingRef.current || isLoadingNow()) {
              return;
            }
            if (currentTimeRef.current > deadPosition + 0.5) return;
            setStreamError('This stream disconnected. Try another stream.');
          }, IDLE_DEAD_VERDICT_MS);
        }
        return;
      }

      // idle-active can fire mid-playback: re-check near-end/verified before failing after recovery.
      void recoverFromSlowStartup(currentUrl, outcome).then((didRecover) => {
        // A swap/unmount during the up-to-45s recovery must not fail the stream that replaced it.
        if (streamGone() || didRecover || errorRef.current || isResolvingRef.current) return;

        if (isPlayheadNearEnd()) return;

        if (playbackVerifiedAtRef.current > 0 && currentTimeRef.current > 0.5) return;

        setStreamError(
          duringInitialLoad
            ? 'Stream failed to load. Try another stream.'
            : 'This stream disconnected. Try another stream.',
        );
        if (duringInitialLoad) stopLoading();
      });
    };

    // Playhead tick — driven by the position poll: optimistic-seek gate, publish, ready/resume signals.
    const handleTimePos = (data: number, nearCompletion: boolean, generation: number) => {
      const now = performance.now();
      const seekPending = isSeekPending();
      if (seekPending) {
        previousNativePosition = null;
      }
      // A pending optimistic seek owns the displayed position — swallow stale pre-seek ticks.
      if (observeTimeUpdate(data, now)) return;

      currentTimeRef.current = data;
      // Hidden playback still needs policy ticks without full-rate UI updates.
      if (!document.hidden || now - lastTimePublishAt >= HIDDEN_TIME_UPDATE_THROTTLE_MS) {
        lastTimePublishAt = now;
        clock.publish(data);
      }
      if (data > 0.1 && isLoadingNow()) markPlaybackReady();
      const previous = previousNativePosition;
      const streamError = recoverableStreamErrorRef.current;
      if (
        generation === positionGeneration &&
        loadfileSent &&
        isPlayingRef.current &&
        !isBufferingRef.current &&
        !seeking &&
        !seekPending &&
        !isResumePending()
      ) {
        // Seeks and native timeline jumps cannot prove playback.
        if (
          previous &&
          previous.streamError === streamError &&
          data - previous.time > 0.01 &&
          data - previous.time <= ((now - previous.at) / 1000) * playbackSpeedRef.current + 1
        ) {
          markPlaybackVerified();
        }
        previousNativePosition = { time: data, at: now, streamError };
      } else {
        previousNativePosition = null;
      }
      // Rust owns the completion threshold; save only accepted native ticks, never a stale pre-seek or optimistic value.
      if (nearCompletion && isPlayingRef.current && !nearCompletionSaved) {
        nearCompletionSaved = true;
        void saveProgressRef.current?.();
      }
      // Resume needs at most one check per poll.
      void applyResumeIfReady();
    };

    // Seconds buffered ahead (seekbar adds live position, clamps on duration); skip publishing when the band hasn't visibly moved.
    const handleBufferedAhead = (data: number) => {
      const next = Math.max(0, data);
      const now = performance.now();
      if (
        now - lastBufferedPublishAt < TIME_UPDATE_THROTTLE_MS &&
        Math.abs(bufferedClock.ref.current - next) < BUFFERED_PUBLISH_DELTA_SECS
      ) {
        return;
      }
      lastBufferedPublishAt = now;
      if (!document.hidden) {
        bufferedClock.publish(next);
      } else {
        bufferedClock.ref.current = next;
      }
    };

    const nextPollDelay = () => {
      if (
        isLoadingNow() ||
        seeking ||
        isSeekPending() ||
        isResumePending() ||
        pendingEof ||
        isBufferingRef.current ||
        performance.now() <= pausedPollGraceUntil
      ) {
        return POSITION_POLL_MS;
      }
      return !isPlayingRef.current || (document.hidden && playbackVerifiedAtRef.current > 0)
        ? POSITION_MAINTENANCE_POLL_MS
        : POSITION_POLL_MS;
    };

    const schedulePositionPoll = (delay = nextPollDelay()) => {
      if (positionPollTimer !== null) clearTimeout(positionPollTimer);
      positionPollTimer = null;
      if (streamGone() || !mpvInitializedRef.current) return;
      positionPollTimer = window.setTimeout(() => {
        positionPollTimer = null;
        void pollPlaybackPosition();
        schedulePositionPoll();
      }, delay);
    };

    const pollPlaybackPosition = async (force = false) => {
      if (positionPollInFlight) {
        if (force) positionPollRequested = true;
        return;
      }
      if (streamGone()) return;
      if (!mpvInitializedRef.current) return;
      if (
        !pendingEof &&
        errorRef.current &&
        !recoverableStreamErrorRef.current &&
        !isResolvingRef.current &&
        !isLoadingNow()
      )
        return;
      // Idle gate: a paused/EOF stream can't move on its own; grace covers settle ticks and a pending optimistic seek.
      if (
        !isPlayingRef.current &&
        !isLoadingNow() &&
        !pendingEof &&
        !seeking &&
        !isSeekPending() &&
        !isResumePending() &&
        performance.now() > pausedPollGraceUntil
      ) {
        probeFailuresSince = null;
        return;
      }
      positionPollInFlight = true;
      const generation = positionGeneration;
      const eofReadGeneration = eofGeneration;
      const streamError = recoverableStreamErrorRef.current;
      try {
        const { timePos, bufferedAhead, nearCompletion } = await readPlaybackPositionProbe(
          durationRef.current,
        );
        if (
          streamGone() ||
          committedStreamUrlRef.current !== activeStreamUrl ||
          streamError !== recoverableStreamErrorRef.current
        )
          return;
        if (typeof timePos === 'number' && Number.isFinite(timePos)) {
          if (loadfileSent) observedPositionRef.current = timePos;
          handleTimePos(timePos, nearCompletion, generation);
        }
        if (typeof bufferedAhead === 'number') handleBufferedAhead(bufferedAhead);
        if (
          pendingEof &&
          eofReadGeneration === eofGeneration &&
          generation === positionGeneration &&
          !isLoadingNow() &&
          !seeking &&
          !isSeekPending() &&
          (durationRef.current <= 0 ||
            (typeof timePos === 'number' && timePos >= durationRef.current - 2))
        ) {
          pendingEof = false;
          onEndedChange(true);
        }
        // Both fields null while NOT loading = dead IPC — a live-but-opening mpv legitimately reports null time-pos.
        const now = performance.now();
        probeFailuresSince =
          !isLoadingNow() && timePos === null && bufferedAhead === null
            ? (probeFailuresSince ?? now)
            : null;
        if (
          probeFailuresSince !== null &&
          now - probeFailuresSince >= POSITION_POLL_FAILURE_BUDGET_MS &&
          positionPollTimer !== null &&
          !errorRef.current &&
          !isResolvingRef.current
        ) {
          clearTimeout(positionPollTimer);
          positionPollTimer = null;
          if (isDev) console.warn('[player] position probe stopped: mpv IPC unreachable');
          // Dead IPC is a player fault, not a stream fault: surface the dead end (retry re-inits via a fresh
          // resolve) without benching an innocent source. Gates match the idle-dead verdict's.
          setError('The player stopped responding. Try again.');
        }
      } finally {
        positionPollInFlight = false;
        if (positionPollRequested) {
          positionPollRequested = false;
          void pollPlaybackPosition(true);
        }
      }
    };

    refreshPositionRef.current = () => {
      pausedPollGraceUntil = performance.now() + PAUSED_POLL_GRACE_MS;
      schedulePositionPoll(POSITION_POLL_MS);
      void pollPlaybackPosition(true);
    };

    const initPlayer = async () => {
      // Dequeued after an enqueued cleanup — no writes once cancelled.
      if (cancelled) return;
      setIsLoading(true);
      setError(null);
      clock.publish(0);
      durationRef.current = 0;
      bufferedClock.publish(0);
      setDuration(0);
      isBufferingRef.current = false;
      setIsBuffering(false);

      setTransparent(false);

      try {
        setMpvSurfaceReady(false);

        const resumeStartPaused = prepareForStreamLoad();
        const shouldStartPaused = resumeStartPaused || trayPause.getSnapshot();
        const initialVolume = volumeRef.current;
        const initialMuted = isMutedRef.current;
        await mpvInit({
          initialVolume,
          initialMuted,
          startPaused: shouldStartPaused,
          ...playbackLanguagePreferencesRef.current,
        });
        if (cancelled) return;

        // One parallel batch before loadfile — headers and listener registration are independent;
        // allSettled so a listener rejection can't strand still-pending property writes.
        const startupResults = await Promise.allSettled([
          listenEvents((event) => {
            if (streamGone()) return;

            if (event.event !== 'property-change') {
              if (event.event === 'seek') {
                previousNativePosition = null;
                positionGeneration += 1;
                seeking = true;
                pendingEof = false;
                eofGeneration += 1;
                refreshPositionRef.current?.();
              } else if (event.event === 'playback-restart') {
                previousNativePosition = null;
                positionGeneration += 1;
                seeking = false;
                refreshPositionRef.current?.();
                scheduleSurfaceRefresh();
              } else if (
                event.event === 'file-loaded' ||
                event.event === 'audio-reconfig' ||
                event.event === 'video-reconfig'
              ) {
                scheduleTrackRefresh();
                scheduleSurfaceRefresh();
              }
              return;
            }

            const { name, data } = event;
            if (!name) return;

            if (name === 'current-tracks/audio/id' || name === 'current-tracks/sub/id') {
              // Observed selection ids double as the switch-confirm channel — a pending `aid`/`sid` write resolves on this event.
              const switchWillRefresh = onObservedTrackSelection(
                name === 'current-tracks/audio/id' ? 'audio' : 'sub',
                typeof data === 'number' ? data : null,
              );
              if (!switchWillRefresh) scheduleTrackRefresh();
              return;
            }

            switch (name) {
              case 'duration':
                if (typeof data === 'number') {
                  setDuration(data);
                  durationRef.current = data;
                  if (data > 0 && isLoadingNow()) {
                    markPlaybackReady();
                  }
                  void applyResumeIfReady();
                }
                break;
              case 'pause':
                if (typeof data === 'boolean') {
                  previousNativePosition = null;
                  positionGeneration += 1;
                  isPlayingRef.current = !data;
                  setIsPlaying(!data);
                  refreshPositionRef.current?.();
                }
                break;
              case 'paused-for-cache':
                if (typeof data === 'boolean') {
                  previousNativePosition = null;
                  positionGeneration += 1;
                  isBufferingRef.current = data;
                  setIsBuffering(data);
                  refreshPositionRef.current?.();
                }
                break;
              case 'volume':
                if (typeof data === 'number') {
                  // Muted chrome shows 0; the ref keeps the level to restore.
                  if (!isMutedRef.current) setVolume(data);
                  volumeRef.current = data;
                }
                break;
              case 'mute':
                if (typeof data === 'boolean') {
                  setIsMuted(data);
                  setVolume(data ? 0 : volumeRef.current);
                }
                break;
              case 'speed':
                if (typeof data === 'number') setPlaybackSpeed(data);
                break;
              case 'eof-reached':
                if (data === false) {
                  pendingEof = false;
                  eofGeneration += 1;
                  onEndedChange(false);
                  break;
                }
                if (data === true) {
                  pendingEof = true;
                  eofGeneration += 1;
                  if (durationRef.current <= 0 && !isLoadingNow()) {
                    pendingEof = false;
                    onEndedChange(true);
                  } else {
                    refreshPositionRef.current?.();
                  }
                }
                break;
              case 'idle-active':
                if (data === true) {
                  idleActive = true;
                  handleIdleActive();
                } else if (data === false) {
                  idleActive = false;
                  if (idleGraceTimer !== null) {
                    clearTimeout(idleGraceTimer);
                    idleGraceTimer = null;
                  }
                  if (idleDeadTimer !== null) {
                    clearTimeout(idleDeadTimer);
                    idleDeadTimer = null;
                  }
                }
                break;
              case 'core-idle':
                if (data === false) {
                  // duration>0 only: `loadfileSent` marked ready before a single frame existed.
                  if (isLoadingNow() && durationRef.current > 0) {
                    markPlaybackReady();
                  }
                  void applyResumeIfReady();
                }
                break;
            }
          }).then((registeredUnlisten) => {
            // Attach the moment registration resolves: a batch rejection or already-ran cleanup must not strand the subscription.
            if (cancelled) {
              registeredUnlisten();
            } else {
              unlisten = registeredUnlisten;
            }
          }),
          setMpvProperties([
            // Headers apply before loadfile; empty clears so secrets never leak — never log header values.
            ['http-header-fields', activeStreamMpvHttpHeaderFields ?? ''],
          ]),
        ]);
        for (const result of startupResults) {
          if (result.status === 'rejected') throw result.reason;
        }
        if (cancelled) return;

        mpvInitializedRef.current = true;
        setMpvSurfaceReady(true);

        // Live refs after the init awaits — the `mpvInitializedRef` gate skips mid-init changes, so write the newest values.
        const liveProperties: [string, number | boolean][] = [
          ['sub-delay', subtitleSettingsRef.current.delay],
          ['sub-pos', subtitleSettingsRef.current.pos],
          ['sub-scale', subtitleSettingsRef.current.scale],
        ];
        if (playbackSpeedRef.current !== 1.0)
          liveProperties.push(['speed', playbackSpeedRef.current]);
        if (volumeRef.current !== initialVolume) liveProperties.push(['volume', volumeRef.current]);
        if (isMutedRef.current !== initialMuted) liveProperties.push(['mute', isMutedRef.current]);
        await setMpvPropertiesBestEffort(liveProperties);
        if (cancelled) return;

        // Start the probe once the instance is live so reads never hit a dead mpv.
        schedulePositionPoll();

        // A tray hide during init may have paused an instance that did not exist yet.
        await setMpvProperties([['pause', resumeStartPaused || trayPause.getSnapshot()]]);
        if (cancelled) return;
        await mpvCommand('loadfile', [activeStreamUrl, 'replace']);
        loadfileSent = true;
        if (cancelled) return;
        isPlayingRef.current = !(resumeStartPaused || trayPause.getSnapshot());
        setIsPlaying(isPlayingRef.current);
        void applyResumeIfReady();

        clearUiTimers();
        forceShowTimeoutRef.current = setTimeout(() => {
          // Mid-recovery the old stream's timers must not flash an error for a swap already in flight.
          if (isResolvingRef.current) return;
          if (!streamGone() && isLoadingNow() && !errorRef.current) {
            if (isDev) console.warn('[player] load timed out; revealing controls');
            stopLoading(true);
            // A stuck load must never strand the user on a black frame — surface chrome while the verdict is pending.
            revealControls();
          }
        }, FORCE_SHOW_AFTER_MS);
      } catch (error) {
        // A cancelled run returns to the already-enqueued cleanup, which owns teardown — no late destroy.
        if (cancelled) return;
        if (isDev) console.error('[player] mpv init failed:', error);
        // A failure before `loadfile` is player setup, not a stream fault — reporting would bench a source never attempted.
        if (loadfileSent) reportStreamFailure('load-failed', activeStreamUrl, activeStreamKey);
        // Still serialized on the lifecycle queue — tear the half-built instance down so a remount's init can't race it.
        clearTransientTimers();
        unlisten?.();
        unlisten = undefined;
        mpvInitializedRef.current = false;
        setMpvSurfaceReady(false);
        await mpvDestroy().catch(() => {
          if (isDev) console.warn('[player] mpv init-failure destroy best-effort failed');
        });
        if (cancelled) return;
        if (mountedRef.current) {
          setError('Failed to initialize player. Please try a different stream.');
          stopLoading();
        }
      }
    };

    void enqueuePlayerLifecycle(initPlayer);

    return () => {
      cancelled = true;
      refreshPositionRef.current = null;
      isDestroyedRef.current = true;
      mpvInitializedRef.current = false;
      setMpvSurfaceReady(false);
      isBufferingRef.current = false;
      setIsBuffering(false);
      clearTransientTimers();
      if (unlisten) unlisten();
      clearUiTimers();
      clearResumeRetryTimer();
      clearRecoveryTimers();
      // Teardown serializes through the lifecycle queue — a remount's init waits out this destroy + settle.
      void enqueuePlayerLifecycle(async () => {
        await mpvDestroy();
        await sleep(MPV_TEARDOWN_SETTLE_MS);
      }).catch(() => {
        if (isDev) console.warn('[player] mpv teardown destroy best-effort failed');
      });
      restorePlayerSurface();
      // Ref holds latest coords; capture can go stale after details load.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      void saveProgressRef.current?.();
    };
    // Same-URL recovery can change credentials; apply the new headers before reloading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStreamLoadKey]);

  return { isBuffering, requestPositionRefresh };
}
