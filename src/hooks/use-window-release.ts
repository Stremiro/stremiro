import { useEffect } from 'react';

/** Clear interaction state on blur/hide; pointer exit can use a partial release. */
export function useWindowRelease(release: () => void, onPointerOut?: () => void) {
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') release();
    };
    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) onPointerOut?.();
    };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (onPointerOut) document.addEventListener('pointerout', handlePointerOut);
    return () => {
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (onPointerOut) document.removeEventListener('pointerout', handlePointerOut);
    };
  }, [release, onPointerOut]);
}
