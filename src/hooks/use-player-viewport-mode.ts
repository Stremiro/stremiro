import {
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
  primaryMonitor,
  type Window as TauriWindow,
} from '@tauri-apps/api/window';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauriDesktopRuntime } from '@/lib/app-updater';
import { sleep } from '@/lib/utils';

const NATIVE_FULLSCREEN_VERIFY_ATTEMPTS = 12;
const NATIVE_FULLSCREEN_VERIFY_DELAY_MS = 50;
const WINDOW_FULLSCREEN_TRANSITION_SETTLE_DELAY_MS = 80;

type DesktopFullscreenMode = 'manual' | 'native';

interface DesktopWindowSnapshot {
  isMaximized: boolean;
  isResizable: boolean;
  outerPosition: {
    x: number;
    y: number;
  };
  innerSize: {
    width: number;
    height: number;
  };
}

// Module-scoped so internal player route remounts can preserve a desktop fallback
// fullscreen window without briefly re-showing sidebar/titlebar chrome.
const desktopViewportState: {
  mode: DesktopFullscreenMode | null;
  restoreSnapshot: DesktopWindowSnapshot | null;
} = {
  mode: null,
  restoreSnapshot: null,
};

function toPhysicalPosition(position: { x: number; y: number }): PhysicalPosition {
  return new PhysicalPosition(position.x, position.y);
}

function toPhysicalSize(size: { width: number; height: number }): PhysicalSize {
  return new PhysicalSize(size.width, size.height);
}

async function measureWindowFrameInsets(appWindow: TauriWindow): Promise<{ x: number; y: number }> {
  const [outerSize, innerSize] = await Promise.all([appWindow.outerSize(), appWindow.innerSize()]);

  return {
    x: Math.max(0, Math.round((outerSize.width - innerSize.width) / 2)),
    y: Math.max(0, Math.round((outerSize.height - innerSize.height) / 2)),
  };
}

async function applyMonitorBounds(
  appWindow: TauriWindow,
  monitor: NonNullable<Awaited<ReturnType<typeof currentMonitor>>>,
): Promise<void> {
  const size = toPhysicalSize(monitor.size);

  await appWindow.setPosition(toPhysicalPosition(monitor.position));
  await appWindow.setSize(size);
  await sleep(16);

  const frameInsets = await measureWindowFrameInsets(appWindow).catch(() => ({
    x: 0,
    y: 0,
  }));
  const adjustedPosition = toPhysicalPosition({
    x: monitor.position.x - frameInsets.x,
    y: monitor.position.y - frameInsets.y,
  });

  await appWindow.setPosition(adjustedPosition);
  await appWindow.setSize(size);
  await sleep(16);

  const settledFrameInsets = await measureWindowFrameInsets(appWindow).catch(() => frameInsets);

  if (settledFrameInsets.x !== frameInsets.x || settledFrameInsets.y !== frameInsets.y) {
    await appWindow.setPosition(
      toPhysicalPosition({
        x: monitor.position.x - settledFrameInsets.x,
        y: monitor.position.y - settledFrameInsets.y,
      }),
    );
  }
}

async function waitForNativeFullscreenState(
  appWindow: TauriWindow,
  expected: boolean,
): Promise<boolean> {
  // Sequential verify-poll: each check must run after the previous delay.
  /* eslint-disable no-await-in-loop */
  for (let attempt = 0; attempt < NATIVE_FULLSCREEN_VERIFY_ATTEMPTS; attempt += 1) {
    const isFullscreen = await appWindow.isFullscreen().catch(() => false);
    if (isFullscreen === expected) {
      return true;
    }

    await sleep(NATIVE_FULLSCREEN_VERIFY_DELAY_MS);
  }
  /* eslint-enable no-await-in-loop */

  return false;
}

async function captureDesktopWindowSnapshot(
  appWindow: TauriWindow,
): Promise<DesktopWindowSnapshot | null> {
  try {
    const [isMaximized, isResizable, outerPosition, innerSize] = await Promise.all([
      appWindow.isMaximized().catch(() => false),
      appWindow.isResizable().catch(() => true),
      appWindow.outerPosition(),
      appWindow.innerSize(),
    ]);

    return {
      isMaximized,
      isResizable,
      outerPosition: {
        x: outerPosition.x,
        y: outerPosition.y,
      },
      innerSize: {
        width: innerSize.width,
        height: innerSize.height,
      },
    };
  } catch {
    return null;
  }
}

async function restoreDesktopWindowSnapshot(
  appWindow: TauriWindow,
  snapshot: DesktopWindowSnapshot,
): Promise<void> {
  await appWindow.setAlwaysOnTop(false).catch(() => undefined);
  await appWindow.unmaximize().catch(() => undefined);
  await appWindow.setResizable(true).catch(() => undefined);
  await appWindow.setPosition(toPhysicalPosition(snapshot.outerPosition)).catch(() => undefined);
  await appWindow.setSize(toPhysicalSize(snapshot.innerSize)).catch(() => undefined);

  if (snapshot.isMaximized) {
    await appWindow.maximize().catch(() => undefined);
  }

  await appWindow.setResizable(snapshot.isResizable).catch(() => undefined);
  await sleep(WINDOW_FULLSCREEN_TRANSITION_SETTLE_DELAY_MS);
}

async function enterManualDesktopFullscreen(appWindow: TauriWindow): Promise<boolean> {
  const snapshot =
    desktopViewportState.restoreSnapshot ?? (await captureDesktopWindowSnapshot(appWindow));
  if (!snapshot) {
    return false;
  }

  const monitor =
    (await currentMonitor().catch(() => null)) ?? (await primaryMonitor().catch(() => null));
  if (!monitor) {
    return false;
  }

  desktopViewportState.restoreSnapshot = snapshot;
  desktopViewportState.mode = 'manual';

  try {
    if (snapshot.isMaximized) {
      await appWindow.unmaximize().catch(() => undefined);
    }

    await appWindow.setResizable(false);
    await appWindow.setAlwaysOnTop(true);
    await applyMonitorBounds(appWindow, monitor);
    await appWindow.setFocus().catch(() => undefined);
    await sleep(WINDOW_FULLSCREEN_TRANSITION_SETTLE_DELAY_MS);
    return true;
  } catch {
    await restoreDesktopWindowSnapshot(appWindow, snapshot).catch(() => undefined);
    desktopViewportState.mode = null;
    desktopViewportState.restoreSnapshot = null;
    return false;
  }
}

interface UsePlayerViewportModeOptions {
  onBeforeEnterFullscreen?: () => Promise<void> | void;
  /** False while the session is docked in the mini player — resize-driven
      fullscreen syncs are skipped until the player expands again. */
  expanded?: boolean;
}

interface UsePlayerViewportModeResult {
  cleanupViewportOnUnmount: () => void;
  isFullscreen: boolean;
  prepareForInternalPlayerNavigation: () => void;
  toggleFullscreen: () => Promise<void>;
}

export function usePlayerViewportMode(
  options: UsePlayerViewportModeOptions = {},
): UsePlayerViewportModeResult {
  const { onBeforeEnterFullscreen, expanded = true } = options;
  const isDesktopRuntime = isTauriDesktopRuntime();
  const appWindow = useMemo(
    () => (isDesktopRuntime ? getCurrentWindow() : null),
    [isDesktopRuntime],
  );
  const [isFullscreen, setIsFullscreen] = useState(
    () => !!document.fullscreenElement || desktopViewportState.mode !== null,
  );
  const preserveViewportOnUnmountRef = useRef(false);
  const viewportCleanupHandledRef = useRef(false);
  const expandedRef = useRef(expanded);

  const syncFullscreenState = useCallback(async () => {
    let nativeFullscreen = false;

    if (appWindow) {
      try {
        nativeFullscreen = await appWindow.isFullscreen();
      } catch {
        nativeFullscreen = false;
      }
    }

    if (nativeFullscreen) {
      desktopViewportState.mode = 'native';
    } else if (desktopViewportState.mode === 'native') {
      desktopViewportState.mode = null;
    }

    const next =
      nativeFullscreen || desktopViewportState.mode === 'manual' || !!document.fullscreenElement;
    setIsFullscreen((prev) => (prev === next ? prev : next));
  }, [appWindow]);

  const exitFullscreenIfNeeded = useCallback(async () => {
    const activeDesktopMode = desktopViewportState.mode;
    let nativeFullscreen = false;

    if (appWindow) {
      try {
        nativeFullscreen = await appWindow.isFullscreen();
      } catch {
        nativeFullscreen = false;
      }
    }

    if (!document.fullscreenElement && !nativeFullscreen && activeDesktopMode !== 'manual') {
      desktopViewportState.mode = null;
      setIsFullscreen(false);
      return;
    }

    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
    }

    if (nativeFullscreen && appWindow) {
      await appWindow.setFullscreen(false).catch(() => undefined);

      if (!(await waitForNativeFullscreenState(appWindow, false))) {
        await sleep(WINDOW_FULLSCREEN_TRANSITION_SETTLE_DELAY_MS);
      }

      desktopViewportState.mode = null;
    } else if (activeDesktopMode === 'manual' && appWindow) {
      const snapshot = desktopViewportState.restoreSnapshot;

      desktopViewportState.mode = null;
      desktopViewportState.restoreSnapshot = null;

      if (snapshot) {
        await restoreDesktopWindowSnapshot(appWindow, snapshot);
      } else {
        await appWindow.setResizable(true).catch(() => undefined);
        await appWindow.setAlwaysOnTop(false).catch(() => undefined);
      }
    }

    await syncFullscreenState();
  }, [appWindow, syncFullscreenState]);

  const cleanupViewportOnUnmount = useCallback(() => {
    if (viewportCleanupHandledRef.current) return;

    viewportCleanupHandledRef.current = true;
    const shouldPreserveViewport = preserveViewportOnUnmountRef.current;
    preserveViewportOnUnmountRef.current = false;

    if (shouldPreserveViewport) {
      return;
    }

    void exitFullscreenIfNeeded();
  }, [exitFullscreenIfNeeded]);

  const prepareForInternalPlayerNavigation = useCallback(() => {
    preserveViewportOnUnmountRef.current = true;
  }, []);

  // Both manual-fullscreen fallbacks funnel here: enter, then reconcile
  // React state with whatever the window actually became.
  const enterManualFullscreenWithSync = useCallback(
    async (window: TauriWindow) => {
      if (!(await enterManualDesktopFullscreen(window))) {
        desktopViewportState.mode = null;
        desktopViewportState.restoreSnapshot = null;
        setIsFullscreen(false);
      }
      await syncFullscreenState();
    },
    [syncFullscreenState],
  );

  const toggleFullscreen = useCallback(async () => {
    try {
      const domFullscreen = !!document.fullscreenElement;

      if (isDesktopRuntime && appWindow) {
        // Windows-only build: entry is always the manual borderless-cover
        // path. `isFullscreen` is still read so an out-of-band native
        // fullscreen exits correctly.
        const nativeFullscreen = await appWindow.isFullscreen().catch(() => false);
        if (nativeFullscreen || desktopViewportState.mode === 'manual' || domFullscreen) {
          await exitFullscreenIfNeeded();
          return;
        }

        preserveViewportOnUnmountRef.current = false;
        if (onBeforeEnterFullscreen) {
          await onBeforeEnterFullscreen();
        }

        setIsFullscreen(true);
        await enterManualFullscreenWithSync(appWindow);
        return;
      }

      if (domFullscreen) {
        setIsFullscreen(false);
        await exitFullscreenIfNeeded();
        return;
      }

      preserveViewportOnUnmountRef.current = false;
      if (onBeforeEnterFullscreen) {
        await onBeforeEnterFullscreen();
      }
      setIsFullscreen(true);
      await document.documentElement.requestFullscreen();
    } catch {
      await syncFullscreenState();
    }
  }, [
    appWindow,
    enterManualFullscreenWithSync,
    exitFullscreenIfNeeded,
    isDesktopRuntime,
    onBeforeEnterFullscreen,
    syncFullscreenState,
  ]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      void syncFullscreenState();
    };

    let isActive = true;
    let disposeWindowListener: (() => void) | undefined;
    let resizeDebounceTimer: ReturnType<typeof setTimeout> | undefined;
    const initialSyncTimer = window.setTimeout(() => {
      void syncFullscreenState();
    }, 0);

    document.addEventListener('fullscreenchange', handleFullscreenChange);

    if (appWindow) {
      void appWindow
        .onResized(() => {
          // Docked in the mini player, the fullscreen bit can't move and the
          // player tree isn't on screen — skip the debounced IPC entirely.
          if (!isActive || !expandedRef.current) return;
          // Debounce so rapid resize events during fullscreen transitions
          // don't cause flickering state updates.
          clearTimeout(resizeDebounceTimer);
          resizeDebounceTimer = setTimeout(() => {
            void syncFullscreenState();
          }, 60);
        })
        .then((dispose) => {
          if (!isActive) {
            dispose();
            return;
          }

          disposeWindowListener = dispose;
        })
        .catch(() => undefined);
    }

    return () => {
      isActive = false;
      window.clearTimeout(initialSyncTimer);
      clearTimeout(resizeDebounceTimer);
      disposeWindowListener?.();
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [appWindow, syncFullscreenState]);

  // Latest binding for the window-resize listener: written during render so
  // a resize between the dock commit and the post-commit effect can't read
  // the stale flag and fire the gated IPC while docked.
  expandedRef.current = expanded;

  // The resize listener is suspended while docked; resync once on expand so
  // a fullscreen change that happened mid-dock isn't stale.
  useEffect(() => {
    if (expanded) void syncFullscreenState();
  }, [expanded, syncFullscreenState]);

  return {
    cleanupViewportOnUnmount,
    isFullscreen,
    prepareForInternalPlayerNavigation,
    toggleFullscreen,
  };
}
