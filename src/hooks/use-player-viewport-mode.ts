import { getCurrentWindow, type Window as TauriWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { isTauriDesktopRuntime } from '@/lib/app-updater';
import {
  enqueueViewportTransition,
  isPlayerPip,
  returnFromPlayerPip,
  setPlayerPip,
  subscribePlayerPip,
  syncPlayerPip,
  waitForViewportTransition,
} from '@/lib/player-window';
import { prefersReducedMotion, sleep, withTimeout } from '@/lib/utils';

const FULLSCREEN_VERIFY_ATTEMPTS = 12;
const FULLSCREEN_VERIFY_DELAY_MS = 50;
// Paired with the curtain's duration-[90ms] in player.tsx.
const VIEWPORT_CURTAIN_FADE_IN_MS = 90;
const VIEWPORT_SETTLE_TIMEOUT_MS = 100;

function nextFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    let remaining = count;
    const nextFrame = () => {
      remaining -= 1;
      if (remaining > 0) requestAnimationFrame(nextFrame);
      else resolve();
    };
    requestAnimationFrame(nextFrame);
  });
}

// Module-level so fullscreen state survives episode remounts.
let desktopFullscreen = false;
let restoreMaximized = false;
async function waitForFullscreenState(appWindow: TauriWindow, expected: boolean): Promise<void> {
  /* eslint-disable no-await-in-loop */
  for (let attempt = 0; attempt < FULLSCREEN_VERIFY_ATTEMPTS; attempt += 1) {
    if ((await appWindow.isFullscreen()) === expected) return;
    await sleep(FULLSCREEN_VERIFY_DELAY_MS);
  }
  /* eslint-enable no-await-in-loop */
  throw new Error('The window did not complete its fullscreen transition.');
}

interface UsePlayerViewportModeOptions {
  onBeforeEnterFullscreen?: () => Promise<void> | void;
  /** Skip resize-driven IPC while the session is docked. */
  expanded?: boolean;
}

interface UsePlayerViewportModeResult {
  isFullscreen: boolean;
  isPip: boolean;
  isViewportTransitioning: boolean;
  canPip: boolean;
  togglePip: () => Promise<void>;
  returnFromPip: () => Promise<void>;
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
    () => !!document.fullscreenElement || desktopFullscreen,
  );
  const isPip = useSyncExternalStore(subscribePlayerPip, isPlayerPip);
  const [isViewportTransitioning, setIsViewportTransitioning] = useState(false);
  const transitionInFlightRef = useRef(false);
  const pipReturnRef = useRef<Promise<void> | null>(null);
  const preserveViewportOnUnmountRef = useRef(false);
  const viewportCleanupHandledRef = useRef(false);
  const expandedRef = useRef(expanded);
  const syncGenerationRef = useRef(0);

  const syncFullscreenState = useCallback(
    async (withinTransition = false) => {
      if (viewportCleanupHandledRef.current) return;
      const generation = ++syncGenerationRef.current;
      // A newly mounted episode must read after the previous window operation.
      if (!withinTransition) await waitForViewportTransition();
      const nativeFullscreen = appWindow ? await appWindow.isFullscreen() : false;
      if (generation !== syncGenerationRef.current || viewportCleanupHandledRef.current) return;
      desktopFullscreen = nativeFullscreen;
      setIsFullscreen(nativeFullscreen || !!document.fullscreenElement);
    },
    [appWindow],
  );

  const exitFullscreenIfNeeded = useCallback(async () => {
    if (isPlayerPip()) await setPlayerPip(false);
    if (document.fullscreenElement) await document.exitFullscreen();
    if (appWindow) {
      if (desktopFullscreen || (await appWindow.isFullscreen())) {
        await appWindow.setFullscreen(false);
        await waitForFullscreenState(appWindow, false);
      }
      if (restoreMaximized) {
        await appWindow.maximize();
        restoreMaximized = false;
      }
    }
    desktopFullscreen = false;
  }, [appWindow]);

  const cleanupViewportOnUnmount = useCallback(() => {
    if (viewportCleanupHandledRef.current) return;
    viewportCleanupHandledRef.current = true;
    ++syncGenerationRef.current;
    const preserveViewport = preserveViewportOnUnmountRef.current;
    preserveViewportOnUnmountRef.current = false;
    if (!preserveViewport) {
      void enqueueViewportTransition(exitFullscreenIfNeeded).catch(() => undefined);
    }
  }, [exitFullscreenIfNeeded]);

  const prepareForInternalPlayerNavigation = useCallback(() => {
    preserveViewportOnUnmountRef.current = true;
  }, []);

  useEffect(() => {
    // Strict Mode replays setup after cleanup on the same hook instance.
    viewportCleanupHandledRef.current = false;
    return cleanupViewportOnUnmount;
  }, [cleanupViewportOnUnmount]);

  const withViewportMask = useCallback(async (operation: () => Promise<void>) => {
    const animate = !prefersReducedMotion();
    if (animate) {
      setIsViewportTransitioning(true);
      await sleep(VIEWPORT_CURTAIN_FADE_IN_MS);
    }
    try {
      await operation();
    } finally {
      try {
        if (animate) await withTimeout(nextFrames(2), VIEWPORT_SETTLE_TIMEOUT_MS, () => undefined);
      } finally {
        if (!viewportCleanupHandledRef.current) setIsViewportTransitioning(false);
      }
    }
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (transitionInFlightRef.current || pipReturnRef.current) return;
    transitionInFlightRef.current = true;
    try {
      await enqueueViewportTransition(async () => {
        if (viewportCleanupHandledRef.current) return;
        ++syncGenerationRef.current;
        await withViewportMask(async () => {
          try {
            if (isPlayerPip()) await setPlayerPip(false);
            const nativeFullscreen = appWindow ? await appWindow.isFullscreen() : false;
            if (!expandedRef.current || nativeFullscreen || document.fullscreenElement) {
              await exitFullscreenIfNeeded();
            } else {
              preserveViewportOnUnmountRef.current = false;
              await onBeforeEnterFullscreen?.();
              setIsFullscreen(true);
              if (appWindow) {
                restoreMaximized ||= await appWindow.isMaximized();
                try {
                  if (restoreMaximized) await appWindow.unmaximize();
                  // Native fullscreen drops the Windows frame so video covers the taskbar.
                  await appWindow.setFullscreen(true);
                  await waitForFullscreenState(appWindow, true);
                  desktopFullscreen = true;
                } catch (error) {
                  await exitFullscreenIfNeeded();
                  throw error;
                }
              } else {
                await document.documentElement.requestFullscreen();
              }
            }
          } catch (error) {
            toast.error('Could not change fullscreen. Please try again.');
            throw error;
          } finally {
            await syncFullscreenState(true);
          }
        });
      });
    } finally {
      transitionInFlightRef.current = false;
    }
  }, [
    appWindow,
    exitFullscreenIfNeeded,
    onBeforeEnterFullscreen,
    syncFullscreenState,
    withViewportMask,
  ]);

  const togglePip = useCallback(async () => {
    if (!appWindow || transitionInFlightRef.current || pipReturnRef.current) return;
    transitionInFlightRef.current = true;
    try {
      await enqueueViewportTransition(async () => {
        if (viewportCleanupHandledRef.current || !expandedRef.current) return;
        await withViewportMask(async () => {
          try {
            if (isPlayerPip()) {
              await setPlayerPip(false);
            } else {
              await onBeforeEnterFullscreen?.();
              await exitFullscreenIfNeeded();
              await syncFullscreenState(true);
              await setPlayerPip(true);
            }
          } catch (error) {
            // Retrying return also recovers a partially applied native entry.
            await setPlayerPip(false).catch(() => undefined);
            toast.error('Could not change picture in picture. Please try again.');
            throw error;
          }
        });
      });
    } finally {
      transitionInFlightRef.current = false;
    }
  }, [
    appWindow,
    exitFullscreenIfNeeded,
    onBeforeEnterFullscreen,
    syncFullscreenState,
    withViewportMask,
  ]);

  const returnFromPip = useCallback(() => {
    if (!appWindow) return Promise.resolve();
    if (pipReturnRef.current) return pipReturnRef.current;
    // Panel restoration must wait for PiP entry rather than being dropped by its guard.
    const pending = enqueueViewportTransition(async () => {
      if (viewportCleanupHandledRef.current) return;
      await withViewportMask(() => returnFromPlayerPip(true));
    }).finally(() => {
      pipReturnRef.current = null;
    });
    pipReturnRef.current = pending;
    return pending;
  }, [appWindow, withViewportMask]);

  useEffect(() => {
    const sync = () => {
      void syncFullscreenState().catch(() => undefined);
    };
    const syncGeneration = syncGenerationRef;
    let isActive = true;
    let disposeWindowListener: (() => void) | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    if (appWindow)
      void waitForViewportTransition()
        .then(syncPlayerPip)
        .catch(() => undefined);
    document.addEventListener('fullscreenchange', sync);
    if (appWindow) {
      void appWindow
        .onResized(() => {
          if (!isActive || !expandedRef.current) return;
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(sync, 60);
        })
        .then((dispose) => {
          if (!isActive) dispose();
          else disposeWindowListener = dispose;
        })
        .catch(() => undefined);
    }
    return () => {
      isActive = false;
      ++syncGeneration.current;
      clearTimeout(resizeTimer);
      disposeWindowListener?.();
      document.removeEventListener('fullscreenchange', sync);
    };
  }, [appWindow, syncFullscreenState]);

  useEffect(() => {
    expandedRef.current = expanded;
    // Also the mount-time sync. Docking always restores the window, even mid-entry.
    const ready = expanded ? Promise.resolve() : enqueueViewportTransition(exitFullscreenIfNeeded);
    void ready.then(() => syncFullscreenState()).catch(() => undefined);
  }, [expanded, exitFullscreenIfNeeded, syncFullscreenState]);

  return {
    isFullscreen,
    isPip,
    isViewportTransitioning,
    canPip: isDesktopRuntime,
    togglePip,
    returnFromPip,
    prepareForInternalPlayerNavigation,
    toggleFullscreen,
  };
}
