import { useCallback, useEffect, useRef, useState } from 'react';
import { clearTimer } from '@/lib/utils';

const POINTER_IDLE_MS = 2_200;
// Pointermove streams fire per frame; a recent arm already covers the tail,
// so re-arms coalesce instead of churning a clear+setTimeout pair per event.
const WAKE_REARM_MS = 250;

/** `idle` turns true once `wake` hasn't been called for 2.2s. */
export function usePointerIdle() {
  const [idle, setIdle] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWakeAtRef = useRef(0);

  const wake = useCallback(() => {
    setIdle(false);
    const now = performance.now();
    if (timerRef.current !== null && now - lastWakeAtRef.current < WAKE_REARM_MS) return;
    lastWakeAtRef.current = now;
    clearTimer(timerRef);
    timerRef.current = setTimeout(() => setIdle(true), POINTER_IDLE_MS);
  }, []);

  useEffect(() => () => clearTimer(timerRef), []);

  return { idle, wake };
}
