import { getCurrentWindow, type Window as TauriWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
} from '@/lib/player-pip';
import { prefersReducedMotion, sleep, withFinally, withTimeout } from '@/lib/utils';

const FULLSCREEN_VERIFY_ATTEMPTS = 12;
const FULLSCREEN_VERIFY_DELAY_MS = 50;
// Paired with the curtain's and PiP chrome's duration-[90ms].
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
  /** 'curtain' blacks out the viewport; 'leavingPip' only fades the PiP chrome. */
  viewportTransition: 'curtain' | 'leavingPip' | null;
  canPip: boolean;
  togglePip: () => Promise<void>;
  returnFromPip: () => Promise<void>;
  prepareForInternalPlayerNavigation: () => void;
  toggleFullscreen: () => Promise<void>;
}

export function usePlayerViewportMode(
  options: UsePlayerViewportModeOptions = {},
): UsePlayerViewportModeResult {
  const { onBeforeEnterFullscreen } = options;
  const expanded = options.expanded === undefined ? true : options.expanded;
  const isDesktopRuntime = isTauriDesktopRuntime();
  const [appWindow] = useState(() => (isDesktopRuntime ? getCurrentWindow() : null));
  const [isFullscreen, setIsFullscreen] = useState(
    () => !!document.fullscreenElement || desktopFullscreen,
  );
  const isPip = useSyncExternalStore(subscribePlayerPip, isPlayerPip);
  const [viewportTransition, setViewportTransition] =
    useState<UsePlayerViewportModeResult['viewportTransition']>(null);
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

  const prepareForInternalPlayerNavigation = () => {
    preserveViewportOnUnmountRef.current = true;
  };

  useEffect(() => {
    // Strict Mode replays setup after cleanup on the same hook instance.
    viewportCleanupHandledRef.current = false;
    return cleanupViewportOnUnmount;
  }, [cleanupViewportOnUnmount]);

  const withViewportMask = async (operation: () => Promise<void>) => {
    const animate = !prefersReducedMotion();
    if (animate) {
      // The WebView keeps its PiP-sized layout briefly after the native window grows,
      // so a curtain would paint a PiP-sized black box; video shows through instead.
      setViewportTransition(isPlayerPip() ? 'leavingPip' : 'curtain');
      await sleep(VIEWPORT_CURTAIN_FADE_IN_MS);
    }
    await withFinally(operation(), async () => {
      if (animate) await withTimeout(nextFrames(2), VIEWPORT_SETTLE_TIMEOUT_MS, () => undefined);
      if (!viewportCleanupHandledRef.current) setViewportTransition(null);
    });
  };

  const toggleFullscreen = async () => {
    if (transitionInFlightRef.current || pipReturnRef.current) return;
    transitionInFlightRef.current = true;
    await enqueueViewportTransition(async () => {
      if (viewportCleanupHandledRef.current) return;
      ++syncGenerationRef.current;
      await withViewportMask(async () => {
        const change = (async () => {
          if (isPlayerPip()) await setPlayerPip(false);
          let nativeFullscreen = false;
          if (appWindow) nativeFullscreen = await appWindow.isFullscreen();
          if (!expandedRef.current || nativeFullscreen || document.fullscreenElement) {
            await exitFullscreenIfNeeded();
          } else {
            preserveViewportOnUnmountRef.current = false;
            if (onBeforeEnterFullscreen) await onBeforeEnterFullscreen();
            setIsFullscreen(true);
            if (appWindow) {
              if (!restoreMaximized) restoreMaximized = await appWindow.isMaximized();
              await (async () => {
                if (restoreMaximized) await appWindow.unmaximize();
                // Native fullscreen drops the Windows frame so video covers the taskbar.
                await appWindow.setFullscreen(true);
                await waitForFullscreenState(appWindow, true);
                desktopFullscreen = true;
              })().catch(async (error) => {
                await exitFullscreenIfNeeded();
                throw error;
              });
            } else {
              await document.documentElement.requestFullscreen();
            }
          }
        })().catch((error) => {
          toast.error('Could not change fullscreen. Please try again.');
          throw error;
        });
        await withFinally(change, () => syncFullscreenState(true));
      });
    }).finally(() => {
      transitionInFlightRef.current = false;
    });
  };

  const togglePip = async () => {
    if (!appWindow || transitionInFlightRef.current || pipReturnRef.current) return;
    transitionInFlightRef.current = true;
    await enqueueViewportTransition(async () => {
      if (viewportCleanupHandledRef.current || !expandedRef.current) return;
      await withViewportMask(async () => {
        return (async () => {
          if (isPlayerPip()) {
            await setPlayerPip(false);
          } else {
            if (onBeforeEnterFullscreen) await onBeforeEnterFullscreen();
            await exitFullscreenIfNeeded();
            await syncFullscreenState(true);
            await setPlayerPip(true);
          }
        })().catch(async (error) => {
          // Retrying return also recovers a partially applied native entry.
          await setPlayerPip(false).catch(() => undefined);
          toast.error('Could not change picture in picture. Please try again.');
          throw error;
        });
      });
    }).finally(() => {
      transitionInFlightRef.current = false;
    });
  };

  const returnFromPip = () => {
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
  };

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
    viewportTransition,
    canPip: isDesktopRuntime,
    togglePip,
    returnFromPip,
    prepareForInternalPlayerNavigation,
    toggleFullscreen,
  };
}
