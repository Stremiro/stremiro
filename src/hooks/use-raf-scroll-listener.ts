import { useEffect, useEffectEvent } from 'react';

/** Window scroll listener coalesced to one `onFrame` call per animation
    frame — scroll events outpace frames, so per-event work would run
    multiple times within a paint. Fires once on mount so scroll-derived
    state is correct before the first scroll. */
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
