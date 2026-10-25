import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';

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

export function useMarkAppUpdateSeen(update: AppUpdateHandle | null) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!update?.notificationEligible) return;
    const markSeen = () => {
      if (!document.hidden) {
        void saveLastNotifiedAppUpdateVersion(queryClient, update.version).catch(() => undefined);
      }
    };
    markSeen();
    document.addEventListener('visibilitychange', markSeen);
    return () => document.removeEventListener('visibilitychange', markSeen);
  }, [queryClient, update]);
}

export function useAppUpdater({ includeCurrentVersion = false } = {}) {
  const queryClient = useQueryClient();
  const getUpdateState = useCallback(
    () =>
      queryClient.getQueryData<ReturnType<typeof getInitialAppUpdateState>>(
        APP_UPDATE_STATE_QUERY_KEY,
      ) ?? getInitialAppUpdateState(),
    [queryClient],
  );

  const { data: updateState } = useQuery({
    queryKey: APP_UPDATE_STATE_QUERY_KEY,
    // Cache-as-store: a refetch must preserve live state — an invalidate mid-install must not wipe progress.
    queryFn: getUpdateState,
    initialData: getInitialAppUpdateState,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });

  const { data: currentVersion = null } = useQuery({
    queryKey: APP_VERSION_QUERY_KEY,
    queryFn: getCurrentAppVersion,
    enabled: includeCurrentVersion && updateState.isSupported,
    staleTime: 1000 * 60 * 60,
  });

  const checkForUpdates = () => runAppUpdateCheck(queryClient);
  const installUpdate = (update: AppUpdateHandle) => runAppUpdateInstall(queryClient, update);
  return {
    checkForUpdates,
    currentVersion,
    getUpdateState,
    installUpdate,
    isChecking: updateState.status === 'checking',
    isInstalling: updateState.status === 'installing',
    isSupported: updateState.isSupported,
    isUpdateAvailable: isUpdateReady(updateState),
    pendingUpdate: updateState.update,
    updateState,
  };
}
