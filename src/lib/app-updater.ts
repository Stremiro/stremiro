import type { QueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { flushPendingAppWrites } from '@/lib/pending-app-writes';

export const APP_UPDATE_STATE_QUERY_KEY = ['app-update-state'] as const;
export const APP_VERSION_QUERY_KEY = ['appVersion'] as const;
export const APP_RELEASE_NOTES_QUERY_KEY = ['app-release-notes'] as const;
export const APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY = [
  'app-update-last-notified-version',
] as const;
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
}

let activeInstallPromise: Promise<void> | null = null;
let activeCheckPromise: Promise<AppUpdateHandle | null> | null = null;

export function getInitialAppUpdateState(): AppUpdateState {
  const isSupported = isTauriDesktopRuntime();

  return {
    isSupported,
    status: isSupported ? 'idle' : 'unsupported',
    update: null,
    lastCheckedAt: null,
    installProgress: null,
    errorMessage: null,
    errorOperation: null,
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
  updater: (current: AppUpdateState) => AppUpdateState,
) {
  queryClient.setQueryData<AppUpdateState>(APP_UPDATE_STATE_QUERY_KEY, (current) =>
    updater(current ?? getInitialAppUpdateState()),
  );
}

export function isUpdateReady(state?: Pick<AppUpdateState, 'status' | 'update'> | null): boolean {
  // A known update stays "ready" through a background re-check so the badge/button never flicker.
  return state?.update != null && state.status !== 'up-to-date' && state.status !== 'error';
}

export function isTauriDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
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

export async function getStoredLastNotifiedAppUpdateVersion(): Promise<string | null> {
  if (!isTauriDesktopRuntime()) return null;

  try {
    return await invoke<string | null>('get_last_notified_app_update_version');
  } catch {
    return null;
  }
}

export async function saveLastNotifiedAppUpdateVersion(
  version: string | null,
): Promise<string | null> {
  if (!isTauriDesktopRuntime()) return null;

  // Let failures propagate — a swallowed one would masquerade as "never notified" and re-announce the same release.
  return invoke<string | null>('save_last_notified_app_update_version', {
    version,
  });
}

export async function getCurrentAppVersion(): Promise<string | null> {
  if (!isTauriDesktopRuntime()) return null;
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
  if (!isTauriDesktopRuntime()) {
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

  writeAppUpdateState(queryClient, (current) => ({
    ...current,
    isSupported: true,
    status: 'checking',
    installProgress: null,
    errorMessage: null,
    errorOperation: null,
  }));

  activeCheckPromise = (async () => {
    try {
      const update = await invoke<AppUpdateHandle | null>('check_for_app_update');
      const checkedAt = Date.now();

      if (!update) {
        queryClient.setQueryData<string | null>(APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY, null);
      }

      // A late check must not stomp an in-progress install's status/progress/handle.
      writeAppUpdateState(queryClient, (current) =>
        current.status === 'installing'
          ? current
          : {
              ...current,
              isSupported: true,
              status: update ? 'available' : 'up-to-date',
              update,
              lastCheckedAt: checkedAt,
              installProgress: null,
              errorMessage: null,
              errorOperation: null,
            },
      );

      return update;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      writeAppUpdateState(queryClient, (current) =>
        current.status === 'installing'
          ? current
          : {
              ...current,
              isSupported: true,
              status: current.update ? 'available' : 'error',
              lastCheckedAt: Date.now(),
              installProgress: null,
              errorMessage: message,
              errorOperation: 'check',
            },
      );

      throw error;
    } finally {
      activeCheckPromise = null;
    }
  })();

  return activeCheckPromise;
}

// Scheduled checks funnel here — returns the update only when this version hasn't been announced (once per release).
export async function runScheduledAppUpdateCheck(
  queryClient: QueryClient,
): Promise<AppUpdateHandle | null> {
  // Notify during install would flash the banner mid-download and permanently mute the version if it fails.
  if (readAppUpdateState(queryClient).status === 'installing') return null;

  const update = await runAppUpdateCheck(queryClient);
  if (!update || readAppUpdateState(queryClient).status === 'installing') return null;

  const cached = queryClient.getQueryData<string | null>(
    APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY,
  );
  const lastNotifiedVersion =
    cached !== undefined ? cached : await getStoredLastNotifiedAppUpdateVersion();

  return lastNotifiedVersion === update.version ? null : update;
}

// Low-level invoke: owns only the progress listener lifetime; dedup, state, and recovery live above.
async function installAppUpdate(
  version: string,
  onProgress: (progress: AppUpdateProgress) => void,
): Promise<void> {
  const unlisten = await listen<AppUpdateProgress>(APP_UPDATE_PROGRESS_EVENT, (event) => {
    if (typeof event.payload?.phase === 'string') {
      onProgress(event.payload);
    }
  });

  try {
    // `version` pins the install to the presented handle — a newer release is rejected, not silently installed.
    await invoke('install_app_update', { version });
  } finally {
    unlisten();
  }
}

export async function runAppUpdateInstall(
  queryClient: QueryClient,
  targetUpdate: AppUpdateHandle,
): Promise<void> {
  // Whole-operation dedup: every caller joins the in-flight install and sees the same settle.
  if (activeInstallPromise) {
    return activeInstallPromise;
  }

  if (!isTauriDesktopRuntime()) {
    writeAppUpdateState(queryClient, () => getInitialAppUpdateState());
    throw new Error('Application updates are only available inside the packaged desktop app.');
  }

  activeInstallPromise = (async () => {
    writeAppUpdateState(queryClient, (current) => ({
      ...current,
      isSupported: true,
      status: 'installing',
      update: targetUpdate,
      installProgress: null,
      errorMessage: null,
      errorOperation: null,
    }));

    try {
      // An in-flight check could swap the pending handle; its error is already rendered, so the rejection is swallowed.
      if (activeCheckPromise) {
        await activeCheckPromise.catch(() => undefined);
      }

      // Settle current writes before downloading; a failure aborts into normal recovery rather than installing mid-write.
      await flushPendingAppWrites();

      // Windows exits the process once the installer launches — this await only resolves on failure.
      await installAppUpdate(targetUpdate.version, (progress) => {
        // Saves keep running during the download — flush again at install-launch so debounced writes aren't lost at exit.
        if (progress.phase === 'installing') {
          void flushPendingAppWrites().catch(() => undefined);
        }
        writeAppUpdateState(queryClient, (current) => ({
          ...current,
          isSupported: true,
          status: 'installing',
          update: targetUpdate,
          installProgress: progress,
          errorMessage: null,
          errorOperation: null,
        }));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let recoveredUpdate: AppUpdateHandle | null = null;
      let recoveredCheckSucceeded = false;

      try {
        recoveredUpdate = await invoke<AppUpdateHandle | null>('check_for_app_update');
        recoveredCheckSucceeded = true;
      } catch {
        recoveredUpdate = null;
      }

      if (recoveredCheckSucceeded && !recoveredUpdate) {
        queryClient.setQueryData<string | null>(APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY, null);
      }

      // A failed install consumes the backend handle — only a fresh recovery check can re-arm retry.
      if (recoveredCheckSucceeded && recoveredUpdate) {
        writeAppUpdateState(queryClient, (current) => ({
          ...current,
          isSupported: true,
          status: 'available',
          update: recoveredUpdate,
          lastCheckedAt: Date.now(),
          installProgress: null,
          errorMessage: message,
          errorOperation: 'install',
        }));
      } else if (recoveredCheckSucceeded) {
        writeAppUpdateState(queryClient, (current) => ({
          ...current,
          isSupported: true,
          status: 'up-to-date',
          update: null,
          lastCheckedAt: Date.now(),
          installProgress: null,
          errorMessage: null,
          errorOperation: null,
        }));
      } else {
        // Rust failures already carry the "run another check" hint — don't append it twice.
        writeAppUpdateState(queryClient, (current) => ({
          ...current,
          isSupported: true,
          status: 'error',
          update: null,
          lastCheckedAt: current.lastCheckedAt,
          installProgress: null,
          errorMessage: message,
          errorOperation: 'install',
        }));
      }

      throw error;
    }
  })().finally(() => {
    activeInstallPromise = null;
  });

  return activeInstallPromise;
}
