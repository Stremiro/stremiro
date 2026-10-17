import { useCallback, useEffect, useRef } from 'react';
import { type MpvSubtitleProperties, setMpvProperties } from '@/lib/player-mpv';

export type MpvSetScheduler = (
  property: string,
  value: number | boolean,
) => Promise<number | undefined>;

interface PendingMpvSet {
  value: number | boolean;
  resolve: (value: number | undefined) => void;
}

// Coalesce slider ticks into one property batch per animation frame.
export function useMpvSetScheduler(): MpvSetScheduler {
  const pendingRef = useRef<Map<string, PendingMpvSet>>(new Map());
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      for (const request of pending.values()) request.resolve(undefined);
      pending.clear();
    };
  }, []);

  return useCallback(
    (property: string, value: number | boolean) =>
      new Promise<number | undefined>((resolve) => {
        pendingRef.current.get(property)?.resolve(undefined);
        // Muting stays immediate and cancels any queued unmute.
        if (property === 'mute' && value === true) {
          pendingRef.current.delete(property);
          void setMpvProperties([[property, value]]).then(
            () => resolve(undefined),
            () => resolve(undefined),
          );
          return;
        }
        pendingRef.current.set(property, { value, resolve });
        if (frameRef.current !== null) return;
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          const mute = pendingRef.current.get('mute');
          pendingRef.current.delete('mute');
          const requests = [...pendingRef.current];
          if (mute) requests.push(['mute', mute]);
          pendingRef.current.clear();
          if (requests.length === 0) return;
          const settle = (properties: MpvSubtitleProperties) => {
            for (const [name, request] of requests) {
              request.resolve(properties.find(([appliedName]) => appliedName === name)?.[1]);
            }
          };
          void setMpvProperties(requests.map(([name, request]) => [name, request.value])).then(
            settle,
            (error: { subtitleProperties?: MpvSubtitleProperties } | null) =>
              settle(error?.subtitleProperties ?? []),
          );
        });
      }),
    [],
  );
}
