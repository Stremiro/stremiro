import { useCallback, useEffect, useRef } from 'react';
import { type MpvSubtitleProperties, setMpvProperties } from '@/lib/player-mpv';

export type MpvSetScheduler = (
  property: string,
  value: number | boolean,
  onFailed?: () => void,
) => Promise<number | undefined>;

interface PendingMpvSet {
  value: number | boolean;
  resolve: (value: number | undefined) => void;
  onFailed?: () => void;
}

// Coalesce slider ticks per property into one animation frame.
export function useMpvSetScheduler(resetKey?: string): MpvSetScheduler {
  const pendingRef = useRef<Map<string, PendingMpvSet>>(new Map());
  const latestRef = useRef<Map<string, PendingMpvSet>>(new Map());
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const pending = pendingRef.current;
    const latest = latestRef.current;
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      for (const request of latest.values()) request.resolve(undefined);
      latest.clear();
      pending.clear();
    };
  }, [resetKey]);

  const settle = useCallback(
    (property: string, request: PendingMpvSet, value?: number, failed = false) => {
      if (latestRef.current.get(property) !== request) return;
      latestRef.current.delete(property);
      if (failed) request.onFailed?.();
      request.resolve(value);
    },
    [],
  );

  const applyAudio = useCallback(
    async (requests: [string, PendingMpvSet][]) => {
      let failed = false;
      try {
        await setMpvProperties(requests.map(([name, request]) => [name, request.value]));
      } catch {
        failed = true;
      }
      for (const [name, request] of requests) settle(name, request, undefined, failed);
    },
    [settle],
  );

  return useCallback(
    (property: string, value: number | boolean, onFailed?: () => void) =>
      new Promise<number | undefined>((resolve) => {
        latestRef.current.get(property)?.resolve(undefined);
        const nextRequest = { value, resolve, onFailed };
        latestRef.current.set(property, nextRequest);
        // Muting stays immediate and cancels any queued unmute.
        if (property === 'mute' && value === true) {
          pendingRef.current.delete(property);
          void applyAudio([[property, nextRequest]]);
          return;
        }
        pendingRef.current.set(property, nextRequest);
        if (frameRef.current !== null) return;
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          const audio: [string, PendingMpvSet][] = [];
          for (const name of ['volume', 'mute']) {
            const request = pendingRef.current.get(name);
            if (request) audio.push([name, request]);
            pendingRef.current.delete(name);
          }
          if (audio.length > 0) void applyAudio(audio);
          if (pendingRef.current.size === 0) return;
          const requests = [...pendingRef.current];
          pendingRef.current.clear();
          const settleBatch = (properties: MpvSubtitleProperties) => {
            for (const [name, request] of requests) {
              settle(name, request, properties.find(([appliedName]) => appliedName === name)?.[1]);
            }
          };
          void setMpvProperties(requests.map(([name, request]) => [name, request.value])).then(
            settleBatch,
            (error: { subtitleProperties?: MpvSubtitleProperties } | null) =>
              settleBatch(error?.subtitleProperties ?? []),
          );
        });
      }),
    [applyAudio, settle],
  );
}
