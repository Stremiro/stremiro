import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
  APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY,
  APP_UPDATE_STATE_QUERY_KEY,
  APP_VERSION_QUERY_KEY,
  type AppUpdateHandle,
  getCurrentAppVersion,
  getInitialAppUpdateState,
  getStoredLastNotifiedAppUpdateVersion,
  isUpdateReady,
  runAppUpdateCheck,
  runAppUpdateInstall,
  saveLastNotifiedAppUpdateVersion,
} from '@/lib/app-updater';
import { runOptimisticQueryMutation } from '@/lib/optimistic-query';

export function useAppUpdater() {
  const queryClient = useQueryClient();

  const { data: updateState = getInitialAppUpdateState() } = useQuery({
    queryKey: APP_UPDATE_STATE_QUERY_KEY,
    // Cache-as-store: a refetch must preserve live state, not reset to
    // initial — an invalidate mid-install would otherwise wipe progress.
    queryFn: () =>
      queryClient.getQueryData<ReturnType<typeof getInitialAppUpdateState>>(
        APP_UPDATE_STATE_QUERY_KEY,
      ) ?? getInitialAppUpdateState(),
    initialData: getInitialAppUpdateState,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });

  const { data: currentVersion = null } = useQuery({
    queryKey: APP_VERSION_QUERY_KEY,
    queryFn: getCurrentAppVersion,
    enabled: updateState.isSupported,
    staleTime: 1000 * 60 * 60,
  });

  // Hydrates the cache the update notifier reads via getQueryData.
  useQuery({
    queryKey: APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY,
    queryFn: getStoredLastNotifiedAppUpdateVersion,
    enabled: updateState.isSupported,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });

  const checkForUpdates = useCallback(() => runAppUpdateCheck(queryClient), [queryClient]);
  const installUpdate = useCallback(
    (update: AppUpdateHandle) => runAppUpdateInstall(queryClient, update),
    [queryClient],
  );
  const markUpdateNotified = useCallback(
    async (version: string | null) => {
      await runOptimisticQueryMutation({
        mutate: saveLastNotifiedAppUpdateVersion,
        optimisticData: version,
        queryClient,
        queryKey: APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY,
        variables: version,
      });
    },
    [queryClient],
  );

  return {
    checkForUpdates,
    currentVersion,
    installUpdate,
    isChecking: updateState.status === 'checking',
    isInstalling: updateState.status === 'installing',
    isSupported: updateState.isSupported,
    isUpdateAvailable: isUpdateReady(updateState),
    markUpdateNotified,
    pendingUpdate: updateState.update,
    updateState,
  };
}
