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
import { prefersReducedMotion, sleep } from '@/lib/utils';

const FULLSCREEN_VERIFY_ATTEMPTS = 12;
const FULLSCREEN_VERIFY_DELAY_MS = 50;

// Preserve fullscreen across episode remounts. Native fullscreen restores the
// window placement; maximized windows must first shed their work-area frame.
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

  const toggleFullscreen = useCallback(async () => {
    if (transitionInFlightRef.current) return;
    transitionInFlightRef.current = true;
    try {
      await enqueueViewportTransition(async () => {
        if (viewportCleanupHandledRef.current) return;
        ++syncGenerationRef.current;
        const animate = !prefersReducedMotion();
        if (animate) {
          setIsViewportTransitioning(true);
          await sleep(100);
        }
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
                // Native fullscreen removes the Windows frame, covers the
                // monitor's client area and informs the Windows taskbar.
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
          try {
            await syncFullscreenState(true);
            if (animate) await sleep(60);
          } finally {
            if (!viewportCleanupHandledRef.current) setIsViewportTransitioning(false);
          }
        }
      });
    } finally {
      transitionInFlightRef.current = false;
    }
  }, [appWindow, exitFullscreenIfNeeded, onBeforeEnterFullscreen, syncFullscreenState]);

  const togglePip = useCallback(async () => {
    if (!appWindow || transitionInFlightRef.current) return;
    transitionInFlightRef.current = true;
    try {
      await enqueueViewportTransition(async () => {
        if (viewportCleanupHandledRef.current || !expandedRef.current) return;
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
    } finally {
      transitionInFlightRef.current = false;
    }
  }, [appWindow, exitFullscreenIfNeeded, onBeforeEnterFullscreen, syncFullscreenState]);

  useEffect(() => {
    const sync = () => {
      void syncFullscreenState().catch(() => undefined);
    };
    const syncGeneration = syncGenerationRef;
    let isActive = true;
    let disposeWindowListener: (() => void) | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const initialSyncTimer = window.setTimeout(sync, 0);
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
      window.clearTimeout(initialSyncTimer);
      clearTimeout(resizeTimer);
      disposeWindowListener?.();
      document.removeEventListener('fullscreenchange', sync);
    };
  }, [appWindow, syncFullscreenState]);

  expandedRef.current = expanded;
  useEffect(() => {
    // Docking always restores the window, including an entry still in flight.
    const ready = expanded ? Promise.resolve() : enqueueViewportTransition(exitFullscreenIfNeeded);
    void ready.then(() => syncFullscreenState()).catch(() => undefined);
  }, [expanded, exitFullscreenIfNeeded, syncFullscreenState]);

  return {
    isFullscreen,
    isPip,
    isViewportTransitioning,
    canPip: isDesktopRuntime,
    togglePip,
    returnFromPip: returnFromPlayerPip,
    prepareForInternalPlayerNavigation,
    toggleFullscreen,
  };
}
