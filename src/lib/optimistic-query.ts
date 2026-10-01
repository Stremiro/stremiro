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
  const cachedOptimisticData = queryClient.setQueryData<TData>(queryKey, optimisticData);

  const queueId = JSON.stringify(queryKey);
  const previous = writeTails.get(queueId) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      try {
        const savedValue = await mutate(variables);
        if (
          writeTails.get(queueId) === current &&
          queryClient.getQueryData<TData>(queryKey) === cachedOptimisticData
        ) {
          queryClient.setQueryData<TData>(queryKey, savedValue);
        }
        return savedValue;
      } catch (error) {
        if (
          writeTails.get(queueId) === current &&
          queryClient.getQueryData<TData>(queryKey) === cachedOptimisticData
        ) {
          await queryClient.invalidateQueries({ queryKey });
        }
        throw error;
      }
    });
  writeTails.set(queueId, current);
  const cleanup = () => {
    if (writeTails.get(queueId) === current) {
      writeTails.delete(queueId);
    }
  };
  void current.then(cleanup, cleanup);
  return trackPendingAppWrite(current);
}
