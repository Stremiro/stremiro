// Write barrier for native lifecycle points (window close, backup, updater install): owners register flushers at module scope; lifecycle awaits them all.
const pendingAppWriteFlushers = new Set<() => Promise<unknown>>();

// Tracked writes stay visible after their owner unmounts; the barrier snapshots the set, so a settled failure drops out and never vetoes a later close.
const activeAppWrites = new Set<Promise<unknown>>();
const activeBarriers = new Set<Set<Promise<unknown>>>();

export function trackPendingAppWrite<T>(write: Promise<T>): Promise<T> {
  activeAppWrites.add(write);
  for (const barrier of activeBarriers) barrier.add(write);
  const cleanup = () => {
    activeAppWrites.delete(write);
  };
  // `then(cleanup, cleanup)` observes the rejection — the raw write still propagates it.
  void write.then(cleanup, cleanup);
  return write;
}

export function trackNoncriticalAppWrite<T>(write: Promise<T>): Promise<T> {
  trackPendingAppWrite(write.catch(() => undefined));
  return write;
}

export function registerPendingAppWriteFlusher(flush: () => Promise<unknown>): () => void {
  pendingAppWriteFlushers.add(flush);
  return () => pendingAppWriteFlushers.delete(flush);
}

// Strict settle: wait for every write, then rethrow the first rejection instead of swallowing via `allSettled`.
export async function settlePendingAppWrites(writes: Iterable<Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(writes);
  const firstRejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (firstRejected) {
    throw firstRejected.reason;
  }
}

export async function flushPendingAppWrites(): Promise<void> {
  const captured = new Set(activeAppWrites);
  activeBarriers.add(captured);
  captured.add(
    settlePendingAppWrites(
      Array.from(pendingAppWriteFlushers, (flush) => Promise.resolve().then(flush)),
    ),
  );
  let failed = false;
  let failure: unknown;
  try {
    // Keep writes captured even if they settle while another owner flushes.
    while (captured.size > 0) {
      const batch = Array.from(captured);
      captured.clear();
      try {
        // eslint-disable-next-line no-await-in-loop -- Capture writes added during the preceding settle.
        await settlePendingAppWrites(batch);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
    if (failed) throw failure;
  } finally {
    activeBarriers.delete(captured);
  }
}
