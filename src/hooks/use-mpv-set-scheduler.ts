import { useCallback, useEffect, useRef } from 'react';
import { setMpvProperty } from '@/lib/player-mpv';

// Slider ticks fire per pointermove; coalesce mpv `set` calls to one per
// animation frame so a drag costs ~60 small IPCs/s instead of 120+. The
// pending frame is cancelled on unmount.
export function useMpvSetScheduler(): (property: string, value: number) => void {
  const pendingRef = useRef<Map<string, number>>(new Map());
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, []);

  return useCallback((property: string, value: number) => {
    pendingRef.current.set(property, value);
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = new Map();
      for (const [prop, val] of pending) {
        void setMpvProperty(prop, val).catch(() => undefined);
      }
    });
  }, []);
}
