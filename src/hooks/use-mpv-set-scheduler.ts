import { useCallback, useEffect, useRef } from 'react';
import { setMpvProperties } from '@/lib/player-mpv';

// Coalesce slider ticks into one property batch per animation frame.
export function useMpvSetScheduler(): (property: string, value: number) => void {
  const pendingRef = useRef<Map<string, number>>(new Map());
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      pending.clear();
    };
  }, []);

  return useCallback((property: string, value: number) => {
    pendingRef.current.set(property, value);
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const properties = [...pendingRef.current];
      pendingRef.current.clear();
      void setMpvProperties(properties).catch(() => undefined);
    });
  }, []);
}
