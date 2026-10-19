import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import { clearTimer, type TimerHandle } from '@/lib/utils';

// Zero input for this delay surfaces the idle title card; any input dismisses it.
const PLAYER_IDLE_OVERLAY_DELAY_MS = 10_000;
// Throttles steady pointermove streams — same rate as the controls wake path.
const IDLE_POINTERMOVE_THROTTLE_MS = 300;

// Wake on 'click', not pointerdown — a pointerdown wake would let the ensuing click resume playback under the card.
const IDLE_ACTIVITY_EVENTS = ['pointermove', 'click', 'keydown', 'wheel'];

interface UsePlayerIdleOverlayOptions {
  /** True only during healthy paused playback with no interactive layer open. */
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

  // Surface clicks wake through this so the first click dismisses the card, not toggles pause.
  const wake = () => noteActivity(false);

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

  return { idle: enabled && idle, wake };
}
