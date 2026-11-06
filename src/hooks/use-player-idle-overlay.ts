import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import { clearTimer, type TimerHandle } from '@/lib/utils';

// Zero input for this delay surfaces the idle title card; any input dismisses it.
const PLAYER_IDLE_OVERLAY_DELAY_MS = 10_000;
// Throttles steady input streams — same rate as the controls wake path.
const IDLE_ACTIVITY_THROTTLE_MS = 300;

// Wake on 'click', not pointerdown — a pointerdown wake would let the ensuing click resume playback under the card.
const IDLE_ACTIVITY_EVENTS = ['pointermove', 'click', 'keydown', 'wheel'];
// A lone modifier press is intent-free input — it must not dismiss the card.
const IDLE_IGNORED_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph']);

interface UsePlayerIdleOverlayOptions {
  /** True only during healthy paused playback with no interactive layer open. */
  enabled: boolean;
  mountedRef: RefObject<boolean>;
}

export function usePlayerIdleOverlay({ enabled, mountedRef }: UsePlayerIdleOverlayOptions) {
  const [idle, setIdle] = useState(false);
  const idleTimerRef = useRef<TimerHandle | null>(null);
  const lastThrottledAtRef = useRef(0);

  const armIdleTimer = useCallback(() => {
    clearTimer(idleTimerRef);
    if (!mountedRef.current) return;
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      setIdle(true);
    }, PLAYER_IDLE_OVERLAY_DELAY_MS);
  }, [mountedRef]);

  const noteActivity = useCallback(
    (throttle: boolean) => {
      if (!enabled || !mountedRef.current) return;
      if (throttle) {
        const now = performance.now();
        if (now - lastThrottledAtRef.current < IDLE_ACTIVITY_THROTTLE_MS) return;
        lastThrottledAtRef.current = now;
      }
      setIdle(false);
      armIdleTimer();
    },
    [armIdleTimer, enabled, mountedRef],
  );

  // Surface clicks wake through this so the first click dismisses the card, not toggles pause.
  const wake = () => noteActivity(false);

  useEffect(() => {
    if (!enabled) {
      setIdle(false);
      clearTimer(idleTimerRef);
      // A stamp from the previous enabled stretch would swallow the first pointermove after re-enable.
      lastThrottledAtRef.current = 0;
      return;
    }

    const handleActivity = (event: Event) => {
      if (event instanceof KeyboardEvent && IDLE_IGNORED_KEYS.has(event.key)) return;
      noteActivity(event.type !== 'click');
    };
    armIdleTimer();
    for (const eventName of IDLE_ACTIVITY_EVENTS) {
      window.addEventListener(eventName, handleActivity, { passive: true });
    }
    return () => {
      for (const eventName of IDLE_ACTIVITY_EVENTS) {
        window.removeEventListener(eventName, handleActivity);
      }
      clearTimer(idleTimerRef);
    };
  }, [enabled, armIdleTimer, noteActivity]);

  return { idle: enabled && idle, wake };
}
