import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { settlePendingAppWrites, trackPendingAppWrite } from '@/lib/pending-app-writes';

interface RunOptimisticQueryMutationOptions<TData, TVariables> {
  mutate: (variables: TVariables) => Promise<TData>;
  optimisticData?: TData;
  queryClient: QueryClient;
  queryKey: QueryKey;
  variables: TVariables;
}

export function restoreQueryArrayEntry(
  queryClient: QueryClient,
  queryKey: QueryKey,
  itemId: string,
  previousEntry: { id: string } | null | undefined,
): void {
  queryClient.setQueryData<{ id: string }[]>(queryKey, (current) => {
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
  isRestored: (row: T) => boolean,
  key: (row: T) => string,
): T[] {
  const positions = new Map(current.map((row, index) => [key(row), index]));
  const buckets = new Map<number, T[]>();
  const leading: T[] = [];
  let predecessor: number | undefined;
  let successor: number | undefined;
  for (const row of snapshot) {
    const position = positions.get(key(row));
    if (position !== undefined) {
      predecessor = position;
      successor ??= position;
      continue;
    }
    if (!isRestored(row)) continue;
    if (predecessor === undefined) {
      leading.push(row);
      continue;
    }
    const at = predecessor + 1;
    const bucket = buckets.get(at);
    if (bucket) bucket.push(row);
    else buckets.set(at, [row]);
  }
  if (leading.length > 0) {
    const at = successor ?? 0;
    buckets.set(at, [...leading, ...(buckets.get(at) ?? [])]);
  }
  const rows: T[] = [];
  for (let index = 0; index <= current.length; index++) {
    const bucket = buckets.get(index);
    if (bucket) rows.push(...bucket);
    if (index < current.length) rows.push(current[index]);
  }
  return rows;
}

// Serialize native writes per query key; only the newest write owns the cache.
// Monotonic generations: a racing refetch can overwrite the optimistic marker, so ownership is "latest write", never payload identity.
const writeStates = new Map<string, { generation: number; tail?: Promise<unknown> }>();
let nextWriteGeneration = 0;

function bumpWriteGeneration(queueId: string): number {
  const generation = ++nextWriteGeneration;
  const state = writeStates.get(queueId);
  if (state) state.generation = generation;
  else writeStates.set(queueId, { generation });
  return generation;
}

/** Buffered edits take cache ownership before their native write is queued. */
export function claimOptimisticQueryWrite(queryKey: QueryKey): void {
  bumpWriteGeneration(JSON.stringify(queryKey));
}

/** Wait for writes already queued before a backup reads or restores settings. */
export async function settleOptimisticQueryWrites(queryKeys: readonly QueryKey[]): Promise<void> {
  const tails = queryKeys
    .map((key) => writeStates.get(JSON.stringify(key))?.tail)
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
  if (optimisticData !== undefined) queryClient.setQueryData<TData>(queryKey, optimisticData);

  const queueId = JSON.stringify(queryKey);
  const generation = bumpWriteGeneration(queueId);
  const isNewestWrite = () => writeStates.get(queueId)?.generation === generation;
  const previous = writeStates.get(queueId)?.tail ?? Promise.resolve();
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
  writeStates.get(queueId)!.tail = current;
  const cleanup = () => {
    if (writeStates.get(queueId)?.tail === current) {
      writeStates.delete(queueId);
    }
  };
  void current.then(cleanup, cleanup);
  return trackPendingAppWrite(current);
}
