import type { RefObject } from 'react';

/** Session clock: React reads published snapshots; imperative readers use the live ref. */
export interface PlaybackClock {
  ref: RefObject<number>;
  getSnapshot: () => number;
  publish: (seconds: number) => void;
  subscribe: (onChange: () => void) => () => void;
}

export function createPlaybackClock(): PlaybackClock {
  const ref: RefObject<number> = { current: 0 };
  let snapshot = 0;
  const listeners = new Set<() => void>();
  return {
    ref,
    getSnapshot: () => snapshot,
    publish: (seconds) => {
      ref.current = seconds;
      if (Object.is(snapshot, seconds)) return;
      snapshot = seconds;
      for (const listener of listeners) listener();
    },
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}
