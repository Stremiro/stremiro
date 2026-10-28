import { useCallback, useEffect, useRef, useState } from 'react';
import { clearTimer } from '@/lib/utils';

const POINTER_IDLE_MS = 1_500;

/** `idle` turns true once `wake` hasn't been called for 1.5s. */
export function usePointerIdle() {
  const [idle, setIdle] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wake = useCallback(() => {
    clearTimer(timerRef);
    setIdle(false);
    timerRef.current = setTimeout(() => setIdle(true), POINTER_IDLE_MS);
  }, []);

  useEffect(() => () => clearTimer(timerRef), []);

  return { idle, wake };
}
