import { type RefObject, useEffect, useEffectEvent, useRef } from 'react';

/**
 * Liveness flag for async continuations: a ref that is `true` while mounted
 * and `false` after unmount, so late promise winners can bail. `onUnmount`
 * runs inside the same cleanup (after the flag flips) for paired teardown —
 * timers, attempt-id bumps — without a second effect at the call site.
 */
export function useMountedRef(onUnmount?: () => void): RefObject<boolean> {
  const mountedRef = useRef(true);
  const teardown = useEffectEvent(() => onUnmount?.());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardown();
    };
  }, []);

  return mountedRef;
}
