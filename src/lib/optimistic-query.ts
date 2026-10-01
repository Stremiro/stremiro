import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { settlePendingAppWrites, trackPendingAppWrite } from '@/lib/pending-app-writes';

interface RunOptimisticQueryMutationOptions<TData, TVariables> {
  mutate: (variables: TVariables) => Promise<TData>;
  optimisticData: TData;
  queryClient: QueryClient;
  queryKey: QueryKey;
  variables: TVariables;
}

// Serialize native writes per query key; only the newest write owns the cache.
const writeTails = new Map<string, Promise<unknown>>();
// Monotonic write generations per key: a refetch racing the write chain can
// overwrite the optimistic marker with stale server data, so ownership is
// "latest requested write" — never payload identity.
const writeGenerations = new Map<string, number>();
let nextWriteGeneration = 0;

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
  const generation = ++nextWriteGeneration;
  writeGenerations.set(queueId, generation);
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
