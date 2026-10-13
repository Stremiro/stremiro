import { useEffect, useEffectEvent } from 'react';

/** Scroll listener coalesced to one `onFrame` per animation frame; fires once on mount. */
export function useRafScrollListener(onFrame: () => void) {
  const onFrameEvent = useEffectEvent(onFrame);

  useEffect(() => {
    let frame: number | null = null;
    const handleScroll = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        onFrameEvent();
      });
    };

    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);
}
