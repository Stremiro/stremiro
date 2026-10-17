import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
  APP_RELEASE_NOTES_QUERY_KEY,
  APP_UPDATE_STATE_QUERY_KEY,
  APP_VERSION_QUERY_KEY,
  type AppUpdateHandle,
  getAppReleaseNotes,
  getCurrentAppVersion,
  getInitialAppUpdateState,
  isTauriDesktopRuntime,
  isUpdateReady,
  runAppUpdateCheck,
  runAppUpdateInstall,
  saveLastNotifiedAppUpdateVersion,
} from '@/lib/app-updater';

export function useAppReleaseNotes(version: string | null) {
  return useQuery({
    queryKey: [...APP_RELEASE_NOTES_QUERY_KEY, version],
    queryFn: () => getAppReleaseNotes(version!),
    enabled: isTauriDesktopRuntime() && !!version,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useAppUpdater() {
  const queryClient = useQueryClient();

  const { data: updateState } = useQuery({
    queryKey: APP_UPDATE_STATE_QUERY_KEY,
    // Cache-as-store: a refetch must preserve live state — an invalidate mid-install must not wipe progress.
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

  const checkForUpdates = useCallback(() => runAppUpdateCheck(queryClient), [queryClient]);
  const installUpdate = useCallback(
    (update: AppUpdateHandle) => runAppUpdateInstall(queryClient, update),
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
    markUpdateNotified: saveLastNotifiedAppUpdateVersion,
    pendingUpdate: updateState.update,
    updateState,
  };
}
