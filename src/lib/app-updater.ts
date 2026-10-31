import type { QueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { flushPendingAppWrites } from '@/lib/pending-app-writes';
import { getErrorMessage } from '@/lib/utils';

export const APP_UPDATE_STATE_QUERY_KEY = ['app-update-state'] as const;
export const APP_VERSION_QUERY_KEY = ['appVersion'] as const;
export const APP_RELEASE_NOTES_QUERY_KEY = ['app-release-notes'] as const;
const APP_UPDATE_PROGRESS_EVENT = 'app-update-progress';

// Release links resolve against the repo the updater endpoint polls (tauri.conf.json endpoints).
const APP_RELEASES_URL = 'https://github.com/stremiro/stremiro/releases';

export function appReleaseTagUrl(version: string): string {
  return `${APP_RELEASES_URL}/tag/v${encodeURIComponent(version)}`;
}

export interface ReleaseNoteBlock {
  kind: 'heading' | 'bullet' | 'text';
  text: string;
  key: string;
}

export interface AppUpdateHandle {
  version: string;
  notificationEligible: boolean;
  notes?: ReleaseNoteBlock[];
  date?: string | null;
}

// Mirrors Rust's `phase`-tagged AppUpdateProgress — no 'restarting' phase: Windows exits once the installer launches.
export type AppUpdateProgress =
  | { phase: 'downloading'; downloadedBytes: number; totalBytes: number | null }
  | { phase: 'installing' };

type AppUpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'installing'
  | 'error';

interface AppUpdateState {
  isSupported: boolean;
  status: AppUpdateStatus;
  update: AppUpdateHandle | null;
  lastCheckedAt: number | null;
  installProgress: AppUpdateProgress | null;
  errorMessage: string | null;
  errorOperation: 'check' | 'install' | null;
  retryOnReconnect: boolean;
}

let activeInstallPromise: Promise<void> | null = null;
let activeCheckPromise: Promise<AppUpdateHandle | null> | null = null;
const notifiedVersions = new Set<string>();

export function getInitialAppUpdateState(): AppUpdateState {
  const isSupported = supportsAppUpdates();

  return {
    isSupported,
    status: isSupported ? 'idle' : 'unsupported',
    update: null,
    lastCheckedAt: null,
    installProgress: null,
    errorMessage: null,
    errorOperation: null,
    retryOnReconnect: false,
  };
}

function readAppUpdateState(queryClient: QueryClient): AppUpdateState {
  return (
    queryClient.getQueryData<AppUpdateState>(APP_UPDATE_STATE_QUERY_KEY) ??
    getInitialAppUpdateState()
  );
}

function writeAppUpdateState(
  queryClient: QueryClient,
  patch: Partial<AppUpdateState> | ((current: AppUpdateState) => Partial<AppUpdateState>),
  protectInstall = false,
) {
  queryClient.setQueryData<AppUpdateState>(APP_UPDATE_STATE_QUERY_KEY, (cached) => {
    const current = cached ?? getInitialAppUpdateState();
    if (protectInstall && current.status === 'installing') return current;
    return {
      ...current,
      installProgress: null,
      errorMessage: null,
      errorOperation: null,
      retryOnReconnect: false,
      ...(typeof patch === 'function' ? patch(current) : patch),
    };
  });
}

export function isUpdateReady(state?: Pick<AppUpdateState, 'status' | 'update'> | null): boolean {
  // A known update stays "ready" through a background re-check so the badge/button never flicker.
  return state?.update != null && state.status !== 'up-to-date' && state.status !== 'error';
}

export function isTauriDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function supportsAppUpdates(): boolean {
  return !import.meta.env.DEV && isTauriDesktopRuntime();
}

export function appUpdateProgressPercent(progress: AppUpdateProgress | null): number | null {
  if (progress?.phase !== 'downloading' || !progress.totalBytes) return null;
  return Math.min(100, Math.floor((progress.downloadedBytes / progress.totalBytes) * 100));
}

export function formatAppUpdateProgress(progress: AppUpdateProgress | null): string {
  if (!progress) return 'Preparing update…';

  switch (progress.phase) {
    case 'downloading': {
      if (!progress.totalBytes) return 'Downloading update…';
      const percent = appUpdateProgressPercent(progress) ?? 0;
      const downloadedMb = (progress.downloadedBytes / (1024 * 1024)).toFixed(1);
      const totalMb = (progress.totalBytes / (1024 * 1024)).toFixed(1);
      return `Downloading update… ${percent}% (${downloadedMb}/${totalMb} MB)`;
    }
    case 'installing':
      return 'Installing update…';
  }
}

export async function saveLastNotifiedAppUpdateVersion(
  queryClient: QueryClient,
  version: string,
): Promise<void> {
  if (notifiedVersions.has(version)) return;
  notifiedVersions.add(version);
  // Mark the mounted announcement seen synchronously, even if persistence fails.
  queryClient.setQueryData<AppUpdateState>(APP_UPDATE_STATE_QUERY_KEY, (current) =>
    current?.update?.version === version
      ? { ...current, update: { ...current.update, notificationEligible: false } }
      : current,
  );
  await invoke('save_last_notified_app_update_version', { version });
}

export async function getCurrentAppVersion(): Promise<string | null> {
  try {
    return await invoke<string>('get_current_app_version');
  } catch {
    return null;
  }
}

export async function getAppReleaseNotes(version: string): Promise<AppUpdateHandle | null> {
  return invoke<AppUpdateHandle | null>('get_app_release_notes', { version });
}

export async function runAppUpdateCheck(queryClient: QueryClient): Promise<AppUpdateHandle | null> {
  if (!supportsAppUpdates()) {
    writeAppUpdateState(queryClient, () => getInitialAppUpdateState());
    return null;
  }

  if (activeCheckPromise) {
    return activeCheckPromise;
  }

  // A manual check must never clobber an in-progress install.
  const currentState = readAppUpdateState(queryClient);
  if (currentState.status === 'installing') {
    return currentState.update;
  }

  writeAppUpdateState(queryClient, {
    status: 'checking',
  });

  activeCheckPromise = (async () => {
    try {
      const update = await invoke<AppUpdateHandle | null>('check_for_app_update');
      if (update && notifiedVersions.has(update.version)) update.notificationEligible = false;

      // A late check must not stomp an in-progress install's status/progress/handle.
      writeAppUpdateState(
        queryClient,
        {
          status: update ? 'available' : 'up-to-date',
          update,
          lastCheckedAt: Date.now(),
        },
        true,
      );

      return update;
    } catch (error) {
      const message = getErrorMessage(error);

      writeAppUpdateState(
        queryClient,
        (current) => ({
          status: current.update ? 'available' : 'error',
          lastCheckedAt: Date.now(),
          errorMessage: message,
          errorOperation: 'check',
          retryOnReconnect:
            !navigator.onLine ||
            (typeof error === 'object' &&
              error !== null &&
              'retryOnReconnect' in error &&
              error.retryOnReconnect === true),
        }),
        true,
      );

      throw new Error(message, { cause: error });
    } finally {
      activeCheckPromise = null;
    }
  })();

  return activeCheckPromise;
}

export async function runAppUpdateInstall(
  queryClient: QueryClient,
  targetUpdate: AppUpdateHandle,
): Promise<void> {
  // Whole-operation dedup: every caller joins the in-flight install and sees the same settle.
  if (activeInstallPromise) {
    return activeInstallPromise;
  }

  if (!supportsAppUpdates()) {
    writeAppUpdateState(queryClient, () => getInitialAppUpdateState());
    throw new Error('Application updates are only available inside the packaged desktop app.');
  }

  activeInstallPromise = (async () => {
    writeAppUpdateState(queryClient, {
      status: 'installing',
      update: targetUpdate,
    });

    try {
      // An in-flight check could swap the pending handle; its error is already rendered, so the rejection is swallowed.
      if (activeCheckPromise) {
        await activeCheckPromise.catch(() => undefined);
      }

      // Settle current writes before downloading; a failure aborts into normal recovery rather than installing mid-write.
      await flushPendingAppWrites();

      const version = targetUpdate.version;
      const operationId = crypto.randomUUID();
      let listening = true;
      const unlisten = await listen<AppUpdateProgress & { operationId: string }>(
        APP_UPDATE_PROGRESS_EVENT,
        (event) => {
          if (listening && event.payload.operationId === operationId) {
            writeAppUpdateState(queryClient, { installProgress: event.payload });
          }
        },
      );

      try {
        // `version` pins the install to the presented handle — a newer release is rejected, not silently installed.
        await invoke('download_app_update', { version, operationId });
        await flushPendingAppWrites();
        // Windows exits the process once the installer launches — this await only resolves on failure.
        await invoke('install_app_update', { version, operationId });
      } finally {
        listening = false;
        unlisten();
      }
    } catch (error) {
      const message = getErrorMessage(error);
      let recoveredUpdate: AppUpdateHandle | null = null;

      try {
        recoveredUpdate = await invoke<AppUpdateHandle | null>('check_for_app_update');
        if (recoveredUpdate && notifiedVersions.has(recoveredUpdate.version)) {
          recoveredUpdate.notificationEligible = false;
        }
      } catch {
        recoveredUpdate = null;
      }

      // A failed install consumes the backend handle — only a fresh recovery check can re-arm retry.
      writeAppUpdateState(queryClient, {
        status: recoveredUpdate ? 'available' : 'error',
        update: recoveredUpdate,
        lastCheckedAt: Date.now(),
        errorMessage: message,
        errorOperation: 'install',
      });

      throw error;
    }
  })().finally(() => {
    activeInstallPromise = null;
  });

  return activeInstallPromise;
}
