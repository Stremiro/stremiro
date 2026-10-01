// App-level write barrier for native lifecycle points (window close,
// backup import/export, updater install): each global write owner
// registers its existing flusher once at module scope, and lifecycle
// callers await them all without owning any per-owner policy.
const pendingAppWriteFlushers = new Set<() => Promise<unknown>>();

// Raw write operations tracked here stay visible to the barrier after their
// owner unmounts. The barrier snapshots the set when it runs, so a settled
// failure is dropped by the cleanup and never vetoes a later close.
const activeAppWrites = new Set<Promise<unknown>>();

export function trackPendingAppWrite<T>(write: Promise<T>): Promise<T> {
  activeAppWrites.add(write);
  const cleanup = () => {
    activeAppWrites.delete(write);
  };
  // `then(cleanup, cleanup)` observes the rejection — the raw write still
  // propagates it to its own caller.
  void write.then(cleanup, cleanup);
  return write;
}

export function registerPendingAppWriteFlusher(flush: () => Promise<unknown>): () => void {
  pendingAppWriteFlushers.add(flush);
  return () => pendingAppWriteFlushers.delete(flush);
}

// Strict settle: the barrier waits for every captured write, then rethrows
// the first rejection instead of swallowing it inside `allSettled`.
export async function settlePendingAppWrites(writes: Iterable<Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(writes);
  const firstRejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (firstRejected) {
    throw firstRejected.reason;
  }
}

registerPendingAppWriteFlusher(() => settlePendingAppWrites(activeAppWrites));

export async function flushPendingAppWrites(): Promise<void> {
  await settlePendingAppWrites(
    Array.from(pendingAppWriteFlushers, (flush) => Promise.resolve().then(flush)),
  );
}
