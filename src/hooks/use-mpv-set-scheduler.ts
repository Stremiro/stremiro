import { useCallback, useEffect, useRef } from 'react';
import { type MpvSubtitleProperties, setMpvProperties, setMpvProperty } from '@/lib/player-mpv';

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

type MpvWriteOutcome = 'success' | 'failure' | 'superseded';

// Coalesce slider ticks per property into one animation frame.
export function useMpvSetScheduler(): MpvSetScheduler {
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
  }, []);

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
    async (property: string, request: PendingMpvSet): Promise<MpvWriteOutcome> => {
      if (latestRef.current.get(property) !== request) return 'superseded';
      try {
        await setMpvProperty(property, request.value);
        settle(property, request);
        return 'success';
      } catch {
        settle(property, request, undefined, true);
        return 'failure';
      }
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
          void applyAudio(property, nextRequest);
          return;
        }
        pendingRef.current.set(property, nextRequest);
        if (frameRef.current !== null) return;
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          const volume = pendingRef.current.get('volume');
          const mute = pendingRef.current.get('mute');
          pendingRef.current.delete('volume');
          pendingRef.current.delete('mute');
          // Unmute only after native volume succeeds; newer mutes invalidate it.
          const volumeWrite = volume ? applyAudio('volume', volume) : undefined;
          if (mute) {
            if (volumeWrite)
              void volumeWrite.then((outcome) => {
                if (outcome === 'success') return applyAudio('mute', mute);
                settle('mute', mute, undefined, true);
              });
            else void applyAudio('mute', mute);
          }
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
