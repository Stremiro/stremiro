import { type RefObject, useEffect, useEffectEvent, useRef } from 'react';

/** Mounted-flag ref so late async continuations can bail; `onUnmount` runs in the same cleanup after the flag flips. */
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
