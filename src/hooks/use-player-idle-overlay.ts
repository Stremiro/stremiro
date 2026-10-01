import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import { clearTimer, type TimerHandle } from '@/lib/utils';

// A zero-input stretch past this delay surfaces the idle title card over a
// dimmed frame; any input — pointer, key, wheel, touch — dismisses it.
const PLAYER_IDLE_OVERLAY_DELAY_MS = 10_000;
// Steady pointermove streams would churn a clear/setTimeout pair per event —
// the same rate-limit the controls wake path applies.
const IDLE_POINTERMOVE_THROTTLE_MS = 300;

const IDLE_ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'];

interface UsePlayerIdleOverlayOptions {
  /** False while loading, errored, ended, or an interactive layer is open —
      the card exists over any healthy session, playing or paused. */
  enabled: boolean;
  mountedRef: RefObject<boolean>;
}

export function usePlayerIdleOverlay({ enabled, mountedRef }: UsePlayerIdleOverlayOptions) {
  const [idle, setIdle] = useState(false);
  const idleTimerRef = useRef<TimerHandle | null>(null);
  const lastPointerMoveAtRef = useRef(0);

  const armIdleTimer = useCallback(() => {
    clearTimer(idleTimerRef);
    if (!mountedRef.current) return;
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      setIdle(true);
    }, PLAYER_IDLE_OVERLAY_DELAY_MS);
  }, [mountedRef]);

  const noteActivity = useCallback(
    (isPointerMove: boolean) => {
      if (!enabled || !mountedRef.current) return;
      if (isPointerMove) {
        const now = performance.now();
        if (now - lastPointerMoveAtRef.current < IDLE_POINTERMOVE_THROTTLE_MS) return;
        lastPointerMoveAtRef.current = now;
      }
      setIdle(false);
      armIdleTimer();
    },
    [armIdleTimer, enabled, mountedRef],
  );

  // The surface click handler wakes through this so the first click dismisses
  // the card instead of toggling pause under it.
  const wake = useCallback(() => noteActivity(false), [noteActivity]);

  useEffect(() => {
    if (!enabled) {
      setIdle(false);
      clearTimer(idleTimerRef);
      return;
    }

    const handleActivity = (event: Event) => noteActivity(event.type === 'pointermove');
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

  return { idle, wake };
}
