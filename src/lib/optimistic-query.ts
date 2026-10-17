import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { settlePendingAppWrites, trackPendingAppWrite } from '@/lib/pending-app-writes';

interface RunOptimisticQueryMutationOptions<TData, TVariables> {
  mutate: (variables: TVariables) => Promise<TData>;
  optimisticData: TData;
  queryClient: QueryClient;
  queryKey: QueryKey;
  variables: TVariables;
}

export function restoreQueryArrayEntry<T extends { id: string }>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  itemId: string,
  previousEntry: T | null | undefined,
): void {
  queryClient.setQueryData<T[]>(queryKey, (current) => {
    if (!previousEntry) return current?.filter((entry) => entry.id !== itemId);
    return current?.some((entry) => entry.id === itemId)
      ? current.map((entry) => (entry.id === itemId ? previousEntry : entry))
      : [...(current ?? []), previousEntry];
  });
}

// Anchors each restored row beside its nearest snapshot neighbour still cached (predecessor first, then successor), so overlapping removals keep relative order.
export function reinsertSnapshotRows<T>(
  current: readonly T[],
  snapshot: readonly T[],
  indices: readonly number[],
  key: (row: T) => string,
): T[] {
  const rows = [...current];
  const cachedIndex = (neighbour: number) => {
    const neighbourKey = key(snapshot[neighbour]);
    return rows.findIndex((row) => key(row) === neighbourKey);
  };
  for (const index of indices) {
    let at = -1;
    for (let prior = index - 1; prior >= 0 && at === -1; prior--) {
      const found = cachedIndex(prior);
      if (found !== -1) at = found + 1;
    }
    for (let next = index + 1; next < snapshot.length && at === -1; next++) {
      at = cachedIndex(next);
    }
    rows.splice(at === -1 ? 0 : at, 0, snapshot[index]);
  }
  return rows;
}

// Serialize native writes per query key; only the newest write owns the cache.
const writeTails = new Map<string, Promise<unknown>>();
// Monotonic write generations: a racing refetch can overwrite the optimistic marker, so ownership is "latest write", never payload identity.
const writeGenerations = new Map<string, number>();
let nextWriteGeneration = 0;

function bumpWriteGeneration(queryKey: QueryKey): number {
  const generation = ++nextWriteGeneration;
  writeGenerations.set(JSON.stringify(queryKey), generation);
  return generation;
}

/** Buffered edits take cache ownership before their native write is queued. */
export function claimOptimisticQueryWrite(queryKey: QueryKey): void {
  bumpWriteGeneration(queryKey);
}

/** Wait for writes already queued before a backup reads or restores settings. */
export async function settleOptimisticQueryWrites(queryKeys: readonly QueryKey[]): Promise<void> {
  const tails = queryKeys
    .map((key) => writeTails.get(JSON.stringify(key)))
    .filter((tail): tail is Promise<unknown> => tail !== undefined);
  await settlePendingAppWrites(tails);
}

export async function runOptimisticQueryMutation<TData, TVariables>({
  mutate,
  optimisticData,
  queryClient,
  queryKey,
  variables,
}: RunOptimisticQueryMutationOptions<TData, TVariables>): Promise<TData> {
  void queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData<TData>(queryKey, optimisticData);

  const queueId = JSON.stringify(queryKey);
  const generation = bumpWriteGeneration(queryKey);
  const isNewestWrite = () => writeGenerations.get(queueId) === generation;
  const previous = writeTails.get(queueId) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      try {
        const savedValue = await mutate(variables);
        if (isNewestWrite()) {
          queryClient.setQueryData<TData>(queryKey, savedValue);
        }
        return savedValue;
      } catch (error) {
        if (isNewestWrite()) {
          await queryClient.invalidateQueries({ queryKey });
        }
        throw error;
      }
    });
  writeTails.set(queueId, current);
  const cleanup = () => {
    if (writeTails.get(queueId) === current) {
      writeTails.delete(queueId);
      writeGenerations.delete(queueId);
    }
  };
  void current.then(cleanup, cleanup);
  return trackPendingAppWrite(current);
}
