import type { QueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { flushPendingAppWrites } from '@/lib/pending-app-writes';

export const APP_UPDATE_STATE_QUERY_KEY = ['app-update-state'] as const;
export const APP_VERSION_QUERY_KEY = ['appVersion'] as const;
export const APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY = [
  'app-update-last-notified-version',
] as const;
const APP_UPDATE_PROGRESS_EVENT = 'app-update-progress';

// Release links resolve against the same repo the updater endpoint polls
// (plugins.updater.endpoints in tauri.conf.json).
const APP_RELEASES_URL = 'https://github.com/stremiro/stremiro/releases';

export function appReleaseTagUrl(version: string): string {
  return `${APP_RELEASES_URL}/tag/v${encodeURIComponent(version)}`;
}

export interface AppUpdateHandle {
  version: string;
  body?: string | null;
  date?: string | null;
}

// Mirrors the `phase`-tagged `AppUpdateProgress` enum emitted by Rust.
// (No 'restarting' phase: on Windows the plugin exits the process once the
// installer launches, so no event lands after 'installing'.)
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
}

let activeInstallPromise: Promise<void> | null = null;
let activeCheckPromise: Promise<AppUpdateHandle | null> | null = null;

function createInitialAppUpdateState(): AppUpdateState {
  const isSupported = isTauriDesktopRuntime();

  return {
    isSupported,
    status: isSupported ? 'idle' : 'unsupported',
    update: null,
    lastCheckedAt: null,
    installProgress: null,
    errorMessage: null,
  };
}

function readAppUpdateState(queryClient: QueryClient): AppUpdateState {
  return (
    queryClient.getQueryData<AppUpdateState>(APP_UPDATE_STATE_QUERY_KEY) ??
    createInitialAppUpdateState()
  );
}

function writeAppUpdateState(
  queryClient: QueryClient,
  updater: (current: AppUpdateState) => AppUpdateState,
) {
  queryClient.setQueryData<AppUpdateState>(APP_UPDATE_STATE_QUERY_KEY, (current) =>
    updater(current ?? createInitialAppUpdateState()),
  );
}

export function getInitialAppUpdateState(): AppUpdateState {
  return createInitialAppUpdateState();
}

export function isUpdateReady(state?: Pick<AppUpdateState, 'status' | 'update'> | null): boolean {
  // A known update stays "ready" through a background re-check (status flips
  // to 'checking' for a moment) so the badge and install button never flicker.
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

  try {
    return await invoke<string | null>('save_last_notified_app_update_version', {
      version,
    });
  } catch {
    return null;
  }
}

export async function getCurrentAppVersion(): Promise<string | null> {
  if (!isTauriDesktopRuntime()) return null;
  try {
    return await invoke<string>('get_current_app_version');
  } catch {
    return null;
  }
}

async function checkForAppUpdate(): Promise<AppUpdateHandle | null> {
  if (!isTauriDesktopRuntime()) return null;

  const update = await invoke<AppUpdateHandle | null>('check_for_app_update');
  if (!update) {
    await saveLastNotifiedAppUpdateVersion(null);
    return null;
  }

  return update;
}

export async function runAppUpdateCheck(queryClient: QueryClient): Promise<AppUpdateHandle | null> {
  if (!isTauriDesktopRuntime()) {
    writeAppUpdateState(queryClient, () => createInitialAppUpdateState());
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
  }));

  activeCheckPromise = (async () => {
    try {
      const update = await checkForAppUpdate();
      const checkedAt = Date.now();

      if (!update) {
        queryClient.setQueryData<string | null>(APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY, null);
      }

      // The check can resolve after an install started — never let it stomp
      // the 'installing' status, progress, or handle.
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
            },
      );

      throw error;
    } finally {
      activeCheckPromise = null;
    }
  })();

  return activeCheckPromise;
}

// Startup and interval checks funnel through here: the update is returned
// only when this version has not been announced yet, so a long-running
// session notifies exactly once per release.
export async function runScheduledAppUpdateCheck(
  queryClient: QueryClient,
): Promise<AppUpdateHandle | null> {
  // Toasting + mark-notified during an install would both flash the banner
  // mid-download and permanently mute the version if the install then fails.
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

// Low-level invoke: owns only the progress listener lifetime around the
// pinned-version install call; dedup, state, and recovery live above.
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
    // `version` pins the install to the handle the UI presented — a check
    // that swapped in a newer release is rejected, not silently installed.
    await invoke('install_app_update', { version });
  } finally {
    unlisten();
  }
}

export async function runAppUpdateInstall(
  queryClient: QueryClient,
  targetUpdate: AppUpdateHandle,
): Promise<void> {
  // Whole-operation dedup: every caller joins the in-flight install and sees
  // the same settle — one invoke, one recovery check, one error.
  if (activeInstallPromise) {
    return activeInstallPromise;
  }

  if (!isTauriDesktopRuntime()) {
    writeAppUpdateState(queryClient, () => createInitialAppUpdateState());
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
    }));

    try {
      // A check still in flight could swap the pending handle after install
      // starts; its error is already rendered, so the rejection is swallowed.
      if (activeCheckPromise) {
        await activeCheckPromise.catch(() => undefined);
      }

      // Settle current writes before downloading; periodic playback saves
      // continue during download. A failure aborts into the normal recovery
      // path instead of installing with a write still queued.
      await flushPendingAppWrites();

      // On Windows the backend exits the process once the installer launches,
      // so this await only resolves on failure — there is no post-success write.
      await installAppUpdate(targetUpdate.version, (progress) => {
        // Periodic watch-progress/preference saves keep running during the
        // download; flush again as the installer launches so writes debounced
        // inside that window aren't lost when the process exits.
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
        }));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let recoveredUpdate: AppUpdateHandle | null = null;
      let recoveredCheckSucceeded = false;

      try {
        recoveredUpdate = await checkForAppUpdate();
        recoveredCheckSucceeded = true;
      } catch {
        recoveredUpdate = null;
      }

      if (recoveredCheckSucceeded && !recoveredUpdate) {
        queryClient.setQueryData<string | null>(APP_UPDATE_LAST_NOTIFIED_VERSION_QUERY_KEY, null);
      }

      // A failed install consumes the backend handle: never retain the stale
      // target as available. Only a fresh recovery check can re-arm retry.
      if (recoveredCheckSucceeded && recoveredUpdate) {
        writeAppUpdateState(queryClient, (current) => ({
          ...current,
          isSupported: true,
          status: 'available',
          update: recoveredUpdate,
          lastCheckedAt: Date.now(),
          installProgress: null,
          errorMessage: message,
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
        }));
      } else {
        // Rust install failures already carry the "run another update check"
        // hint — don't append it a second time.
        writeAppUpdateState(queryClient, (current) => ({
          ...current,
          isSupported: true,
          status: 'error',
          update: null,
          lastCheckedAt: current.lastCheckedAt,
          installProgress: null,
          errorMessage: message,
        }));
      }

      throw error;
    }
  })().finally(() => {
    activeInstallPromise = null;
  });

  return activeInstallPromise;
}
