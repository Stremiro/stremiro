import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import { destroy, listenEvents } from 'tauri-plugin-libmpv-api';

import type { PlayerStreamSession } from '@/hooks/use-player-stream-session';
import type { SubtitleAdjustmentSettings } from '@/hooks/use-subtitle-adjustments';
import { api, type PlaybackLanguagePreferences } from '@/lib/api';
import type { PlaybackClock } from '@/lib/player-clock';
import { enqueuePlayerLifecycle } from '@/lib/player-lifecycle';
import {
  buildPlayerMpvConfig,
  formatPlayerHttpHeaderFields,
  isPlayerTrackRefreshProperty,
  mpvCommand,
  mpvInit,
  readPlaybackPositionProbe,
  setMpvProperty,
} from '@/lib/player-mpv';
import { sleep, type TimerHandle } from '@/lib/utils';

const TIME_UPDATE_THROTTLE_MS = 350;
// Position probe cadence: subscribers get ~3Hz while per-frame property
// events stay off.
const POSITION_POLL_MS = 300;
// Post-pause probe grace covers optimistic-seek settle ticks and a quick
// resume click.
const PAUSED_POLL_GRACE_MS = 1500;
// Consecutive null probes (~7.5s) mean the mpv IPC channel is dead. Legitimate
// nulls don't reach this: the probe only runs while playing or loading.
const POSITION_POLL_STRIKE_OUT = 25;
// The buffered-ahead band only needs to move when it visibly would.
const BUFFERED_PUBLISH_DELTA_SECS = 0.5;
const IDLE_GRACE_MS = 4000;
// Mid-playback `idle-active` means the source dropped out from under a live
// playhead and nothing reloads it — if the playhead is still dead after this
// window the failure must reach the user instead of freezing on a last frame.
const IDLE_DEAD_VERDICT_MS = 10_000;
const MPV_TEARDOWN_SETTLE_MS = 150;
const TRACK_REFRESH_COALESCE_MS = 120;
const FORCE_SHOW_AFTER_MS = 6500;
const FORCE_SHOW_VERDICT_MS = 5000;

type StreamFailureOutcome = 'load-failed' | 'disconnected';

interface UsePlayerMpvLifecycleArgs {
  stream: PlayerStreamSession;
  isHistoryResume: boolean;
  /** Read at apply time — a mid-init pref change must not bind a stale speed. */
  playbackSpeedRef: RefObject<number>;
  /** Read at apply time — a mid-init pref hydration must not bind stale defaults. */
  subtitleSettingsRef: RefObject<SubtitleAdjustmentSettings>;
  playbackLanguagePreferencesRef: RefObject<PlaybackLanguagePreferences>;
  volumeRef: RefObject<number>;
  mountedRef: RefObject<boolean>;
  isDestroyedRef: RefObject<boolean>;
  mpvInitializedRef: RefObject<boolean>;
  isLoading: boolean;
  isPlayingRef: RefObject<boolean>;
  clock: PlaybackClock;
  /** Buffered-ahead seconds store — feeds the seekbar band without player-tree renders. */
  bufferedClock: PlaybackClock;
  durationRef: RefObject<number>;
  playbackVerifiedAtRef: RefObject<number>;
  errorRef: RefObject<string | null>;
  forceShowTimeoutRef: RefObject<TimerHandle | null>;
  saveProgressRef: RefObject<(() => Promise<void>) | undefined>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setDuration: Dispatch<SetStateAction<number>>;
  setIsPlaying: Dispatch<SetStateAction<boolean>>;
  setVolume: Dispatch<SetStateAction<number>>;
  setIsMuted: Dispatch<SetStateAction<boolean>>;
  setPlaybackSpeed: Dispatch<SetStateAction<number>>;
  setMpvSurfaceReady: Dispatch<SetStateAction<boolean>>;
  /** Imperative margin re-apply — a reconfig event must not re-render the player tree. */
  requestSurfaceRefresh: () => void;
  isResolvingRef: RefObject<boolean>;
  // Callbacks read through `useEffectEvent` wrappers below so the stream
  // effect always invokes the latest render's props.
  clearUiTimers: () => void;
  clearResumeRetryTimer: () => void;
  clearRecoveryTimers: () => void;
  prepareForStreamLoad: () => boolean;
  markPlaybackReady: () => void;
  applyResumeIfReady: () => Promise<void>;
  onEnded: () => void;
  /** Optimistic-seek gate: true while a time-pos tick should be swallowed for the pending target. */
  observeTimeUpdate: (timePos: number, now: number) => boolean;
  /** True while an optimistic seek is pending — keeps the probe alive past the idle gate. */
  isSeekPending: () => boolean;
  /** Observed `current-tracks/{type}/id` values — a switch confirm waits on the event, not polling. */
  onObservedTrackSelection: (type: 'audio' | 'sub', id: number | null) => void;
  refreshTracks: () => Promise<unknown>;
  reportStreamFailure: (outcome: StreamFailureOutcome, sourceUrl?: string) => void;
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
  mountedRef,
  isDestroyedRef,
  mpvInitializedRef,
  isLoading,
  isPlayingRef,
  clock,
  bufferedClock,
  durationRef,
  playbackVerifiedAtRef,
  errorRef,
  forceShowTimeoutRef,
  saveProgressRef,
  setIsLoading,
  setError,
  setDuration,
  setIsPlaying,
  setVolume,
  setIsMuted,
  setPlaybackSpeed,
  setMpvSurfaceReady,
  isResolvingRef,
  ...callbacks
}: UsePlayerMpvLifecycleArgs) {
  const { activeStreamUrl, activeStreamHeaders, lastStreamUrlRef } = stream;
  const isDev = import.meta.env.DEV;
  const currentTimeRef = clock.ref;
  // Effect events keep callback changes from restarting the native player.
  const recoverFromSlowStartup = useEffectEvent(callbacks.recoverFromSlowStartup);
  const reportStreamFailure = useEffectEvent(callbacks.reportStreamFailure);
  const applyResumeIfReady = useEffectEvent(callbacks.applyResumeIfReady);
  const markPlaybackReady = useEffectEvent(callbacks.markPlaybackReady);
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
  const onObservedTrackSelection = useEffectEvent(callbacks.onObservedTrackSelection);
  const onEnded = useEffectEvent(callbacks.onEnded);
  const revealControls = useEffectEvent(callbacks.revealControls);
  const requestSurfaceRefresh = useEffectEvent(callbacks.requestSurfaceRefresh);
  const isHistoryResumeRef = useRef(isHistoryResume);
  const isLoadingRef = useRef(isLoading);
  const languageOptionsRequestRef = useRef<{
    fingerprint: string;
    promise: Promise<Record<string, string>>;
  } | null>(null);
  const [isBuffering, setIsBuffering] = useState(false);

  useEffect(() => {
    isHistoryResumeRef.current = isHistoryResume;
    isLoadingRef.current = isLoading;
  });

  useEffect(() => {
    const publishVisiblePosition = () => {
      if (document.hidden) return;
      // Paused polling may be idle when a hidden window becomes visible.
      clock.publish(clock.ref.current);
      bufferedClock.publish(bufferedClock.ref.current);
    };
    document.addEventListener('visibilitychange', publishVisiblePosition);
    return () => document.removeEventListener('visibilitychange', publishVisiblePosition);
  }, [clock, bufferedClock]);

  useEffect(() => {
    if (!activeStreamUrl) return;

    isDestroyedRef.current = false;
    mpvInitializedRef.current = false;

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let loadfileSent = false;
    let trackRefreshTimer: TimerHandle | null = null;
    let idleDeadTimer: TimerHandle | null = null;
    let positionPollTimer: TimerHandle | null = null;
    let positionPollInFlight = false;
    let lastBufferedPublishAt = 0;
    let pausedPollGraceUntil = 0;
    let consecutiveProbeFailures = 0;

    // Rust owns the language table: one bounded call builds alang/slang +
    // selection options. Failure degrades to no options.
    const requestMpvLanguageOptions = (prefs: PlaybackLanguagePreferences) => {
      const fingerprint = `${prefs.preferredAudioLanguage ?? ''}|${prefs.preferredSubtitleLanguage ?? ''}`;
      const existing = languageOptionsRequestRef.current;
      if (existing?.fingerprint === fingerprint) return existing.promise;
      const promise = api
        .getMpvLanguageSelectionOptions(
          prefs.preferredAudioLanguage,
          prefs.preferredSubtitleLanguage,
        )
        .catch(() => {
          if (isDev) console.warn('[player] mpv language options fetch best-effort failed');
          // Evict the failed entry so the next run retries instead of reusing
          // the degraded no-options result.
          if (languageOptionsRequestRef.current?.promise === promise) {
            languageOptionsRequestRef.current = null;
          }
          return {} as Record<string, string>;
        });
      languageOptionsRequestRef.current = { fingerprint, promise };
      return promise;
    };

    // Cosmetic property writes must never fail init — a rejected set here
    // would surface "Failed to initialize player" on a live mpv.
    const setMpvPropertyBestEffort = (name: string, value: string | number | boolean) =>
      setMpvProperty(name, value).catch(() => {
        if (isDev) console.warn(`[player] mpv ${name} apply best-effort failed`);
      });

    const isPlayheadNearEnd = () =>
      durationRef.current > 0 && currentTimeRef.current >= Math.max(0, durationRef.current - 1);

    // mpv fires file-loaded + playback-restart + reconfig + both track
    // notifications in a burst on every mount/recovery/advance — coalesce to
    // one refresh per quiet period.
    const scheduleTrackRefresh = () => {
      if (trackRefreshTimer !== null) clearTimeout(trackRefreshTimer);
      trackRefreshTimer = setTimeout(() => {
        trackRefreshTimer = null;
        if (!cancelled && mountedRef.current && !isDestroyedRef.current) {
          void refreshTracks();
        }
      }, TRACK_REFRESH_COALESCE_MS);
    };

    // Playhead tick — driven by the position poll: optimistic-seek gate,
    // publish, ready/resume signals.
    const handleTimePos = (data: number) => {
      const now = performance.now();
      // A pending optimistic seek owns the displayed position — swallow
      // stale pre-seek ticks.
      if (observeTimeUpdate(data, now)) return;

      currentTimeRef.current = data;
      // A hidden window skips the subscriber notify but keeps the ref for
      // persistence and seek rollback.
      if (!document.hidden) {
        clock.publish(data);
      }
      if (isLoadingRef.current && data > 0.1) {
        markPlaybackReady();
      }
      // Resume needs at most one check per poll.
      void applyResumeIfReady();
    };

    // Seconds buffered ahead; the seekbar adds the live position and clamps
    // on duration. Ticks skip publishing when the band hasn't visibly moved.
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

    const pollPlaybackPosition = async () => {
      if (positionPollInFlight) return;
      if (cancelled || !mountedRef.current || isDestroyedRef.current) return;
      if (!mpvInitializedRef.current) return;
      // Idle gate: a paused/EOF stream can't move on its own, so the probe
      // stops spending reads on a static frame. The grace window covers settle
      // ticks after a pause and a pending optimistic seek.
      if (
        !isPlayingRef.current &&
        !isLoadingRef.current &&
        !isSeekPending() &&
        performance.now() > pausedPollGraceUntil
      ) {
        return;
      }
      positionPollInFlight = true;
      try {
        const { timePos, bufferedAhead } = await readPlaybackPositionProbe();
        if (cancelled || !mountedRef.current || isDestroyedRef.current) return;
        if (typeof timePos === 'number') handleTimePos(timePos);
        if (typeof bufferedAhead === 'number') handleBufferedAhead(bufferedAhead);
        // Both fields null while NOT loading means the IPC channel is gone —
        // a live-but-opening mpv legitimately reports null time-pos.
        consecutiveProbeFailures =
          !isLoadingRef.current && timePos === null && bufferedAhead === null
            ? consecutiveProbeFailures + 1
            : 0;
        if (consecutiveProbeFailures >= POSITION_POLL_STRIKE_OUT && positionPollTimer !== null) {
          clearInterval(positionPollTimer);
          positionPollTimer = null;
          if (isDev) console.warn('[player] position probe stopped: mpv IPC unreachable');
          // mpv itself is unreachable — every control silently no-ops from
          // here and the frame is frozen. A dead IPC is a player fault, not
          // a stream fault: surface the dead end (retry re-inits mpv via a
          // fresh resolve) without benching an innocent source. The
          // error/resolving gates match the idle-dead verdict's.
          if (!errorRef.current && !isResolvingRef.current) {
            setError('The player stopped responding. Try again.');
          }
        }
      } finally {
        positionPollInFlight = false;
      }
    };

    const initPlayer = async () => {
      // Dequeued after an enqueued cleanup — no writes once cancelled.
      if (cancelled) return;
      setIsLoading(true);
      setError(null);
      clock.publish(0);
      bufferedClock.publish(0);
      setDuration(0);
      setIsBuffering(false);

      setTransparent(false);

      try {
        setMpvSurfaceReady(false);

        const shouldStartPaused = prepareForStreamLoad();
        const languageSelectionOptions = await requestMpvLanguageOptions(
          playbackLanguagePreferencesRef.current,
        );
        if (cancelled) return;
        const mpvConfig = buildPlayerMpvConfig({
          initialVolume: volumeRef.current,
          startPaused: shouldStartPaused,
          languageSelectionOptions,
        });

        await mpvInit(mpvConfig);
        if (cancelled) return;

        // One parallel batch before loadfile: display props, stream headers,
        // and listener registration are independent. One listenEvents covers
        // property-changes and named events. allSettled so a listener
        // rejection can't strand still-pending property writes past setup.
        const headerFields = formatPlayerHttpHeaderFields(activeStreamHeaders);
        const startupResults = await Promise.allSettled([
          listenEvents((event) => {
            if (cancelled || !mountedRef.current || isDestroyedRef.current) return;

            if (event.event !== 'property-change') {
              if (
                event.event === 'file-loaded' ||
                event.event === 'audio-reconfig' ||
                event.event === 'video-reconfig' ||
                event.event === 'playback-restart'
              ) {
                scheduleTrackRefresh();
                window.requestAnimationFrame(() => {
                  if (!cancelled && mountedRef.current && !isDestroyedRef.current) {
                    requestSurfaceRefresh();
                  }
                });
              }
              return;
            }

            const { name, data } = event;
            if (!name) return;

            if (isPlayerTrackRefreshProperty(name)) {
              // Observed selection ids double as the switch-confirm channel:
              // a pending `aid`/`sid` write resolves on this event.
              if (name === 'current-tracks/audio/id') {
                onObservedTrackSelection('audio', typeof data === 'number' ? data : null);
              } else if (name === 'current-tracks/sub/id') {
                onObservedTrackSelection('sub', typeof data === 'number' ? data : null);
              }
              scheduleTrackRefresh();
              return;
            }

            switch (name) {
              case 'duration':
                if (typeof data === 'number') {
                  setDuration(data);
                  durationRef.current = data;
                  if (data > 0 && isLoadingRef.current) {
                    markPlaybackReady();
                  }
                  void applyResumeIfReady();
                }
                break;
              case 'pause':
                if (typeof data === 'boolean') {
                  isPlayingRef.current = !data;
                  setIsPlaying(!data);
                  if (data) {
                    // Keep the probe ticking briefly past the pause so settle
                    // ticks and a quick resume still land.
                    pausedPollGraceUntil = performance.now() + PAUSED_POLL_GRACE_MS;
                  }
                }
                break;
              case 'paused-for-cache':
                if (typeof data === 'boolean') {
                  setIsBuffering(data);
                }
                break;
              case 'volume':
                if (typeof data === 'number') {
                  setVolume(data);
                  volumeRef.current = data;
                }
                break;
              case 'mute':
                if (typeof data === 'boolean') setIsMuted(data);
                break;
              case 'speed':
                if (typeof data === 'number') setPlaybackSpeed(data);
                break;
              case 'eof-reached':
                // mpv emits transient EOF at seek boundaries and live edges;
                // terminal only once loaded and the playhead is at the end.
                if (data !== true || isLoadingRef.current) break;
                if (durationRef.current > 0 && currentTimeRef.current < durationRef.current - 2) {
                  break;
                }
                onEnded();
                break;
              case 'idle-active':
                if (data === true) {
                  if (errorRef.current) break;
                  if (isLoadingRef.current && !loadfileSent) break;

                  const verifiedAt = playbackVerifiedAtRef.current;
                  if (verifiedAt > 0 && performance.now() - verifiedAt < IDLE_GRACE_MS) break;

                  const hasProgressedMeaningfully =
                    currentTimeRef.current > 2 && durationRef.current > 0;

                  if (isPlayheadNearEnd()) break;

                  const currentUrl = lastStreamUrlRef.current || activeStreamUrl;
                  if (!currentUrl) break;

                  const duringInitialLoad = isLoadingRef.current;
                  const outcome = duringInitialLoad ? 'load-failed' : 'disconnected';

                  if (isHistoryResumeRef.current && hasProgressedMeaningfully) break;

                  // Report only where recovery never runs —
                  // `recover_playback_stream` records the outcome itself.
                  if (isHistoryResumeRef.current) {
                    reportStreamFailure(outcome, currentUrl);
                    if (duringInitialLoad) stopLoading();
                    reopenSelector();
                    break;
                  }

                  if (hasProgressedMeaningfully) {
                    reportStreamFailure(outcome, currentUrl);
                    // Nothing reloads a source that idles mid-playback, so arm
                    // a verdict: a still-dead playhead surfaces the failure —
                    // recovery (isResolvingRef) or a stream swap (cancelled)
                    // cancels it, and position movement means mpv self-healed.
                    if (idleDeadTimer === null) {
                      const deadPosition = currentTimeRef.current;
                      idleDeadTimer = setTimeout(() => {
                        idleDeadTimer = null;
                        if (cancelled || !mountedRef.current || isDestroyedRef.current) return;
                        if (errorRef.current || isResolvingRef.current || isLoadingRef.current) {
                          return;
                        }
                        if (currentTimeRef.current > deadPosition + 0.5) return;
                        setError('This stream disconnected. Try another stream.');
                      }, IDLE_DEAD_VERDICT_MS);
                    }
                    break;
                  }

                  // idle-active can fire mid-playback: re-check near-end/verified
                  // before failing the stream after recovery.
                  void recoverFromSlowStartup(currentUrl, outcome).then((didRecover) => {
                    // A swap/unmount during the up-to-45s recovery must not
                    // fail the stream that replaced it.
                    if (cancelled || isDestroyedRef.current) return;
                    if (didRecover || !mountedRef.current || errorRef.current) return;

                    if (isPlayheadNearEnd()) return;

                    if (playbackVerifiedAtRef.current > 0 && currentTimeRef.current > 0.5) return;

                    setError(
                      duringInitialLoad
                        ? 'Stream failed to load. Try another stream.'
                        : 'This stream disconnected. Try another stream.',
                    );
                    if (duringInitialLoad) stopLoading();
                  });
                }
                break;
              case 'core-idle':
                if (data === false) {
                  // duration>0 only: `loadfileSent` marked ready the instant
                  // mpv started opening — before a single frame existed.
                  if (isLoadingRef.current && durationRef.current > 0) {
                    markPlaybackReady();
                  }
                  void applyResumeIfReady();
                }
                break;
            }
          }).then((registeredUnlisten) => {
            // Attach the moment registration resolves: a batch rejection or a
            // cleanup that already ran must not strand the webview subscription.
            if (cancelled) {
              registeredUnlisten();
            } else {
              unlisten = registeredUnlisten;
            }
          }),
          Promise.all([
            setMpvPropertyBestEffort('sub-delay', subtitleSettingsRef.current.delay),
            setMpvPropertyBestEffort('sub-pos', subtitleSettingsRef.current.pos),
            subtitleSettingsRef.current.scale !== 1.0
              ? setMpvPropertyBestEffort('sub-scale', subtitleSettingsRef.current.scale)
              : Promise.resolve(),
            // Headers apply before loadfile; empty clears so secrets never
            // leak. Never log header values; dev signal is a static code only.
            setMpvPropertyBestEffort('http-header-fields', headerFields ?? ''),
          ]).then(() => undefined),
        ]);
        for (const result of startupResults) {
          if (result.status === 'rejected') throw result.reason;
        }
        if (cancelled) return;

        mpvInitializedRef.current = true;
        setMpvSurfaceReady(true);

        // Speed reads the live ref after the init awaits: the prefs effect's
        // mpvInitializedRef gate skips mid-init changes, so this write must
        // carry the newest value.
        if (playbackSpeedRef.current !== 1.0) {
          await setMpvPropertyBestEffort('speed', playbackSpeedRef.current);
        }
        if (cancelled) return;

        // Start the probe once the instance is live so reads never hit a dead mpv.
        positionPollTimer = window.setInterval(() => {
          void pollPlaybackPosition();
        }, POSITION_POLL_MS);

        await mpvCommand('loadfile', [activeStreamUrl, 'replace']);
        loadfileSent = true;
        if (cancelled) return;
        isPlayingRef.current = !shouldStartPaused;
        setIsPlaying(!shouldStartPaused);
        void applyResumeIfReady();

        clearUiTimers();
        forceShowTimeoutRef.current = setTimeout(() => {
          // Mid-recovery the old stream's timers must not flash an error for
          // a swap already in flight.
          if (isResolvingRef.current) return;
          if (!cancelled && mountedRef.current && isLoadingRef.current && !errorRef.current) {
            if (isDev) console.warn('[player] load timed out; revealing controls');
            stopLoading(true);
            // A stuck load must never strand the user on a black frame —
            // surface the chrome while the verdict is pending.
            revealControls();
            forceShowTimeoutRef.current = setTimeout(() => {
              if (cancelled || !mountedRef.current || errorRef.current) return;
              if (isResolvingRef.current) return;
              if (playbackVerifiedAtRef.current > 0) return;
              if (durationRef.current > 0 && currentTimeRef.current > 0.1) return;

              const currentUrl = lastStreamUrlRef.current || activeStreamUrl;
              if (!currentUrl) {
                reportStreamFailure('load-failed');
                setError('Stream failed to load. Try another stream.');
                stopLoading();
                return;
              }

              // Fires before the startup watchdog — a hung connect gets one
              // re-rank first. Recovery records its own outcome; a report here
              // would double-count.
              void recoverFromSlowStartup(currentUrl, 'load-failed').then((didRecover) => {
                if (cancelled || isDestroyedRef.current) return;
                if (didRecover || !mountedRef.current || errorRef.current) return;
                // A newer recovery attempt took over — don't clobber it.
                if (isResolvingRef.current) return;

                if (isHistoryResumeRef.current) {
                  stopLoading();
                  reopenSelector();
                  return;
                }

                setError('Stream failed to load. Try another stream.');
                stopLoading();
              });
            }, FORCE_SHOW_VERDICT_MS);
          }
        }, FORCE_SHOW_AFTER_MS);
      } catch (error) {
        // A cancelled run returns to the already-enqueued cleanup, which owns
        // teardown — no independent late destroy.
        if (cancelled) return;
        if (isDev) console.error('[player] mpv init failed:', error);
        // A failure before `loadfile` is player setup, not a stream fault —
        // reporting would bench a source that was never attempted.
        if (loadfileSent) reportStreamFailure('load-failed');
        // Still serialized on the lifecycle queue: tear the half-built
        // instance down here so a remount's init can't race it.
        if (trackRefreshTimer !== null) clearTimeout(trackRefreshTimer);
        if (idleDeadTimer !== null) clearTimeout(idleDeadTimer);
        if (positionPollTimer !== null) {
          clearInterval(positionPollTimer);
          positionPollTimer = null;
        }
        unlisten?.();
        unlisten = undefined;
        mpvInitializedRef.current = false;
        setMpvSurfaceReady(false);
        await destroy().catch(() => {
          if (isDev) console.warn('[player] mpv init-failure destroy best-effort failed');
        });
        if (cancelled) return;
        if (mountedRef.current) {
          setError('Failed to initialize player. Please try a different stream.');
          stopLoading();
        }
      }
    };

    // Warm the language request while the startup waits on the lifecycle queue.
    void requestMpvLanguageOptions(playbackLanguagePreferencesRef.current);
    void enqueuePlayerLifecycle(initPlayer);

    return () => {
      cancelled = true;
      isDestroyedRef.current = true;
      mpvInitializedRef.current = false;
      setMpvSurfaceReady(false);
      setIsBuffering(false);
      if (trackRefreshTimer !== null) clearTimeout(trackRefreshTimer);
      if (idleDeadTimer !== null) clearTimeout(idleDeadTimer);
      if (positionPollTimer !== null) {
        clearInterval(positionPollTimer);
        positionPollTimer = null;
      }
      if (unlisten) unlisten();
      clearUiTimers();
      clearResumeRetryTimer();
      clearRecoveryTimers();
      // Teardown serializes through the window-scoped lifecycle queue — a
      // remount's init waits out this destroy + settle instead of racing the
      // native instance it could destroy.
      void enqueuePlayerLifecycle(async () => {
        await destroy();
        await sleep(MPV_TEARDOWN_SETTLE_MS);
      }).catch(() => {
        if (isDev) console.warn('[player] mpv teardown destroy best-effort failed');
      });
      restorePlayerSurface();
      // Ref holds latest coords; capture can go stale after details load.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      void saveProgressRef.current?.();
    };
    // Keyed on the URL only: header changes always come with a URL change, and
    // callbacks go through effect events so late renders can't re-init mpv.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStreamUrl]);

  return { isBuffering };
}
