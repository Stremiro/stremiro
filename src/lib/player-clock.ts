import type { RefObject } from 'react';

import { createSubscribableStore } from '@/lib/subscribable-store';

/** Session clock: React reads published snapshots; imperative readers use the live ref. */
export interface PlaybackClock {
  ref: RefObject<number>;
  getSnapshot: () => number;
  publish: (seconds: number) => void;
  subscribe: (onChange: () => void) => () => void;
}

export function createPlaybackClock(): PlaybackClock {
  // The ref tracks every tick immediately; the store snapshot only notifies
  // subscribers on change.
  const ref: RefObject<number> = { current: 0 };
  const store = createSubscribableStore(0);
  return {
    ref,
    getSnapshot: store.getSnapshot,
    publish: (seconds) => {
      ref.current = seconds;
      store.publish(seconds);
    },
    subscribe: store.subscribe,
  };
}
