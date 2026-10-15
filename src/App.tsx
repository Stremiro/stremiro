import { useQueryClient } from '@tanstack/react-query';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Loader2 } from 'lucide-react';
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
} from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router';
import { toast } from 'sonner';
import { AppUpdateCard, APP_UPDATE_TOAST_ID } from '@/components/app-update-card';
import { Layout } from '@/components/layout';
import { Toaster } from '@/components/ui/sonner';
import { useAppUpdater } from '@/hooks/use-app-updater';
import {
  registerAppUiPreferenceFlusher,
  useAppUiPreferences,
} from '@/hooks/use-app-ui-preferences';
import { api, type AppUiPreferences, getErrorMessage } from '@/lib/api';
import { isTauriDesktopRuntime, runScheduledAppUpdateCheck } from '@/lib/app-updater';
import { flushPendingAppWrites } from '@/lib/pending-app-writes';
import { isEditableTarget, OPEN_DIALOG_SELECTOR } from '@/lib/dom';
import { bindAppNavigate, navigateApp, recordLocationEntry } from '@/lib/navigation';
import {
  PlayerHost,
  PlayerRouteRegistrar,
  PlayerSessionProvider,
  usePlayerSession,
} from '@/lib/player-session';
import { APP_UI_PREFERENCES_QUERY_KEY } from '@/lib/query-invalidation';
import { routeChunks, warmRouteChunks } from '@/lib/route-chunks';
import { mpvDestroy, setMpvProperty } from '@/lib/player-mpv';
import { isPlayerPip, returnFromPlayerPip, waitForViewportTransition } from '@/lib/player-window';
import { boundedMapSet, clearTimer, withTimeout } from '@/lib/utils';
import { Home } from '@/pages/home';

const Search = lazy(() => routeChunks.search().then((module) => ({ default: module.Search })));
const Details = lazy(() => routeChunks.details().then((module) => ({ default: module.Details })));
const Settings = lazy(() =>
  routeChunks.settings().then((module) => ({ default: module.Settings })),
);
const Profile = lazy(() => routeChunks.profile().then((module) => ({ default: module.Profile })));
const Calendar = lazy(() =>
  routeChunks.calendar().then((module) => ({ default: module.Calendar })),
);

function ContentRouteLoader() {
  return (
    <div role='status' className='flex min-h-[60vh] w-full items-center justify-center'>
      <Loader2 className='h-7 w-7 animate-spin text-white/35' />
      <span className='sr-only'>Loading page</span>
    </div>
  );
}

function RouteSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={<ContentRouteLoader />}>{children}</Suspense>;
}

// One root router subscription feeds every per-item anchor via
// navigateOnAnchorClick, so browse grids hold zero location subscriptions.
function AppNavigationBinder() {
  const navigate = useNavigate();

  useEffect(() => {
    bindAppNavigate(navigate);
    return () => bindAppNavigate(null);
  }, [navigate]);

  return null;
}

const MAX_SAVED_SCROLL_POSITIONS = 40;

function rememberScrollPosition(map: Map<string, number>, key: string, position: number) {
  boundedMapSet(map, key, position, MAX_SAVED_SCROLL_POSITIONS);
}

function LastLocationRecorder() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const { preferences: startupPage, updatePreferences } = useAppUiPreferences(
    (preferences) => preferences.startupPage,
  );
  const pendingLocationRef = useRef<string | null>(null);
  const locationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushLocation = useCallback(() => {
    clearTimer(locationTimerRef);
    const path = pendingLocationRef.current;
    pendingLocationRef.current = null;
    const current = queryClient.getQueryData<AppUiPreferences>(APP_UI_PREFERENCES_QUERY_KEY);
    if (path && current?.startupPage === 'lastVisited' && current.lastLocation !== path) {
      updatePreferences({ lastLocation: path });
    }
  }, [queryClient, updatePreferences]);

  useEffect(() => {
    const unregister = registerAppUiPreferenceFlusher(flushLocation);
    return () => {
      unregister();
      flushLocation();
    };
  }, [flushLocation]);

  useEffect(() => {
    if (startupPage !== 'lastVisited') {
      pendingLocationRef.current = null;
      return;
    }
    if (location.pathname.startsWith('/player')) {
      flushLocation();
      return;
    }
    const nextLocation = `${location.pathname}${location.search}`;
    const current = queryClient.getQueryData<AppUiPreferences>(APP_UI_PREFERENCES_QUERY_KEY);
    if (current?.lastLocation === nextLocation) {
      pendingLocationRef.current = null;
      return;
    }
    pendingLocationRef.current = nextLocation;
    locationTimerRef.current = setTimeout(flushLocation, 1_500);
    return () => clearTimer(locationTimerRef);
  }, [location.pathname, location.search, startupPage, flushLocation, queryClient]);

  return null;
}

// Shared window scroller: PUSH lands at top, POP restores the entry's saved
// offset, cross-path REPLACE (back actions) restores the target path's offset.
// Same-path REPLACE (search URL reflect) never touches the scroller.
function RouteScrollManager() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const positionsByKeyRef = useRef(new Map<string, number>());
  const positionsByPathRef = useRef(new Map<string, number>());
  const lastEntryRef = useRef({
    key: location.key,
    pathname: location.pathname,
    path: `${location.pathname}${location.search}`,
  });
  // Paused during commits so a shrinking document doesn't attribute the
  // incoming page's clamped offset to the departing entry.
  const savePausedRef = useRef(false);

  // Track continuously — at commit time the incoming page may have already clamped scrollY.
  useEffect(() => {
    const record = () => {
      if (savePausedRef.current) return;
      const entry = lastEntryRef.current;
      rememberScrollPosition(positionsByKeyRef.current, entry.key, window.scrollY);
      // Search/filter URLs get separate positions, with the same bound.
      rememberScrollPosition(positionsByPathRef.current, entry.path, window.scrollY);
    };
    window.addEventListener('scroll', record, { passive: true });
    return () => window.removeEventListener('scroll', record);
  }, []);

  useLayoutEffect(() => {
    // The navigation mirror feeds back gestures' POP-vs-replace decision.
    const path = `${location.pathname}${location.search}`;
    recordLocationEntry(location.key, path, navigationType);

    const lastEntry = lastEntryRef.current;
    lastEntryRef.current = { key: location.key, pathname: location.pathname, path };
    savePausedRef.current = true;
    const unpauseFrame = window.requestAnimationFrame(() => {
      savePausedRef.current = false;
    });

    const savedPosition =
      navigationType === 'POP'
        ? positionsByKeyRef.current.get(location.key)
        : navigationType === 'REPLACE' && lastEntry.pathname !== location.pathname
          ? positionsByPathRef.current.get(path)
          : undefined;

    if (navigationType === 'REPLACE' && lastEntry.pathname === location.pathname) {
      return () => window.cancelAnimationFrame(unpauseFrame);
    }

    let restoreFrame: number | undefined;
    if (savedPosition === undefined) {
      // A POP without a remembered offset lands at top, not mid-list.
      window.scrollTo(0, 0);
    } else {
      window.scrollTo(0, savedPosition);
      // A still-mounting page can clamp the first attempt — retry after a frame.
      restoreFrame = window.requestAnimationFrame(() => {
        window.scrollTo(0, savedPosition);
      });
    }

    // Land keyboard focus on the new page's landmark — a PUSH unmounts the
    // focused element. POP preserves restored context; a live dialog owns focus.
    if (navigationType !== 'POP' && !document.querySelector(OPEN_DIALOG_SELECTOR)) {
      const active = document.activeElement;
      if (!active || active === document.body) {
        document.getElementById('app-main')?.focus({ preventScroll: true });
      }
    }

    return () => {
      window.cancelAnimationFrame(unpauseFrame);
      if (restoreFrame !== undefined) window.cancelAnimationFrame(restoreFrame);
    };
  }, [location.key, location.pathname, location.search, navigationType]);

  return null;
}

// First check waits for startup to settle; then a 6h interval keeps sessions aware.
const UPDATE_STARTUP_DELAY_MS = 8_000;
const UPDATE_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function AppUpdateManager() {
  const queryClient = useQueryClient();
  const { isSupported, markUpdateNotified } = useAppUpdater();
  const { pathname } = useLocation();
  const resumeDeferredCheckRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (import.meta.env.DEV || !isSupported) return;

    let disposed = false;
    let deferred = false;

    // Defer while hidden or in the expanded player — the card would sit on the video.
    const deferCheck = () => {
      if (!document.hidden && !window.location.pathname.startsWith('/player')) return false;
      deferred = true;
      return true;
    };

    const announceAvailableUpdate = async () => {
      if (disposed || deferCheck()) return;
      deferred = false;

      try {
        const update = await runScheduledAppUpdateCheck(queryClient);
        // Visibility and navigation may change while the check is in flight.
        if (!update || disposed || deferCheck()) return;

        // Persistent card morphs announce → progress → error under one toast id.
        toast.custom(
          () => <AppUpdateCard onViewNotes={() => navigateApp('/settings?section=updates')} />,
          {
            id: APP_UPDATE_TOAST_ID,
            duration: Number.POSITIVE_INFINITY,
            unstyled: true,
          },
        );

        await markUpdateNotified(update.version).catch(() => undefined);
      } catch {
        // Automatic checks stay silent; the updates card surfaces the error.
      }
    };

    const resumeDeferredCheck = () => {
      if (deferred && !document.hidden) void announceAvailableUpdate();
    };
    resumeDeferredCheckRef.current = resumeDeferredCheck;
    document.addEventListener('visibilitychange', resumeDeferredCheck);

    const startupTimer = window.setTimeout(
      () => void announceAvailableUpdate(),
      UPDATE_STARTUP_DELAY_MS,
    );
    const interval = window.setInterval(
      () => void announceAvailableUpdate(),
      UPDATE_RECHECK_INTERVAL_MS,
    );

    return () => {
      disposed = true;
      window.clearTimeout(startupTimer);
      window.clearInterval(interval);
      resumeDeferredCheckRef.current = null;
      document.removeEventListener('visibilitychange', resumeDeferredCheck);
    };
  }, [isSupported, markUpdateNotified, queryClient]);

  useEffect(() => {
    resumeDeferredCheckRef.current?.();
  }, [pathname]);

  return null;
}

// Close barrier: every awaited step is bounded — a wedged native op or viewport
// transition must not trap the window open (the OS reclaims mpv at exit).
const CLOSE_BARRIER_STEP_TIMEOUT_MS = 8_000;

function AppCloseManager() {
  const isDesktopRuntime = isTauriDesktopRuntime();
  const { session } = usePlayerSession();
  const hasSession = useEffectEvent(() => !!session);

  useEffect(() => {
    if (!isDesktopRuntime) return;

    let isActive = true;
    let closing = false;
    let saveFailureVetoed = false;
    let quitRequested = false;
    let unlisten: (() => void) | undefined;
    let unlistenQuit: (() => void) | undefined;

    const settleCloseStep = <T,>(step: Promise<T>) =>
      withTimeout(
        step.then(
          () => true,
          () => true,
        ),
        CLOSE_BARRIER_STEP_TIMEOUT_MS,
        () => false,
      );

    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (closing) {
          event.preventDefault();
          return;
        }
        closing = true;
        try {
          const transitionSettled = await settleCloseStep(waitForViewportTransition());
          if (transitionSettled && isPlayerPip()) {
            if (!quitRequested) {
              event.preventDefault();
              await settleCloseStep(returnFromPlayerPip());
              return;
            }
            await settleCloseStep(returnFromPlayerPip());
          }
          if (!quitRequested) {
            try {
              const hidden = await withTimeout(
                api.closeMainWindowToTray(),
                CLOSE_BARRIER_STEP_TIMEOUT_MS,
                () => {
                  throw new Error('Hiding the window timed out.');
                },
              );
              if (hidden) {
                event.preventDefault();
                if (hasSession()) await settleCloseStep(setMpvProperty('pause', true));
                await settleCloseStep(flushPendingAppWrites());
                return;
              }
            } catch {
              // Without a working tray the window must stay closable.
              event.preventDefault();
              quitRequested = true;
              toast.error('Could not minimize to the system tray.', {
                description: 'Close again to quit.',
              });
              void settleCloseStep(flushPendingAppWrites());
              return;
            }
          }
          await withTimeout(flushPendingAppWrites(), CLOSE_BARRIER_STEP_TIMEOUT_MS, () => {
            throw new Error('Pending writes did not settle.');
          });
          // A failed native teardown still closes — vetoing would wedge the
          // window behind an unkillable mpv call; exit reclaims it.
          await mpvDestroy().catch(() => undefined);
        } catch {
          // Veto once so the save retries; the next close quits anyway.
          if (!saveFailureVetoed) {
            saveFailureVetoed = true;
            event.preventDefault();
            toast.error('Could not save playback progress.', {
              description: 'Close again to quit anyway.',
            });
          }
        } finally {
          closing = false;
        }
      })
      .then((dispose) => {
        if (!isActive) {
          dispose();
          return;
        }

        unlisten = dispose;
        void getCurrentWindow()
          .listen('app://quit-requested', () => {
            quitRequested = true;
            void getCurrentWindow()
              .close()
              .catch((error) => {
                toast.error('Could not quit Stremiro.', { description: getErrorMessage(error) });
              });
          })
          .then((disposeQuit) => {
            if (!isActive) disposeQuit();
            else unlistenQuit = disposeQuit;
          })
          .catch(() => {
            if (import.meta.env.DEV) {
              console.warn('[app] quit-requested listener failed to register');
            }
          });
      })
      .catch(() => {
        if (import.meta.env.DEV) {
          console.warn('[app] close-requested listener failed to register');
        }
      });

    return () => {
      isActive = false;
      unlisten?.();
      unlistenQuit?.();
    };
  }, [isDesktopRuntime]);

  return null;
}

function App() {
  useEffect(() => {
    // Native-app chrome: no context menu or ghost-drag outside editable text.
    const isEditable = (target: EventTarget | null) =>
      isEditableTarget(target, '[data-selectable="true"]');
    const handleContextMenu = (event: MouseEvent) => {
      if (!isEditable(event.target)) event.preventDefault();
    };
    const handleDragStart = (event: DragEvent) => {
      if (!isEditable(event.target)) event.preventDefault();
    };
    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('dragstart', handleDragStart);
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('dragstart', handleDragStart);
    };
  }, []);

  // Warm lazy route chunks on idle so first visits skip the loader.
  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warmRouteChunks, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = window.setTimeout(warmRouteChunks, 1500);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <PlayerSessionProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route path='/' element={<Home />} />
          <Route
            path='/search'
            element={
              <RouteSuspense>
                <Search />
              </RouteSuspense>
            }
          />
          <Route
            path='/details/:type/:id'
            element={
              <RouteSuspense>
                <Details />
              </RouteSuspense>
            }
          />
          <Route
            path='/settings'
            element={
              <RouteSuspense>
                <Settings />
              </RouteSuspense>
            }
          />
          <Route
            path='/profile'
            element={
              <RouteSuspense>
                <Profile />
              </RouteSuspense>
            }
          />
          {/* /library is a deep link into Profile's library tab — the path
              survives so the sidebar can highlight it. */}
          <Route
            path='/library'
            element={
              <RouteSuspense>
                <Profile />
              </RouteSuspense>
            }
          />
          <Route
            path='/calendar'
            element={
              <RouteSuspense>
                <Calendar />
              </RouteSuspense>
            }
          />
          {/* Unknown paths land on Home rather than a blank shell. */}
          <Route path='*' element={<Navigate to='/' replace />} />
        </Route>
        <Route path='/player/:type/:id' element={<PlayerRouteRegistrar />} />
        <Route path='/player/:type/:id/:season/:episode' element={<PlayerRouteRegistrar />} />
      </Routes>
      {/* Root-level playback session survives route changes so leaving
          /player minimizes into the mini player instead of tearing down. */}
      <PlayerHost />
      <AppNavigationBinder />
      <RouteScrollManager />
      <LastLocationRecorder />
      <AppCloseManager />
      <AppUpdateManager />
      <Toaster />
    </PlayerSessionProvider>
  );
}

export default App;
