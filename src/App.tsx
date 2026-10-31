import { useQueryClient } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  Navigate,
  NavigationType,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
} from 'react-router';
import { toast } from 'sonner';
import { AppUpdateCard, APP_UPDATE_TOAST_ID } from '@/components/app-update-card';
import { Layout } from '@/components/layout';
import { Toaster } from '@/components/ui/sonner';
import { DetailsSkeleton, RouteLoadingBar, Skeleton } from '@/components/ui/skeleton';
import { useAppUpdater } from '@/hooks/use-app-updater';
import {
  registerAppUiPreferenceFlusher,
  useAppUiPreferences,
} from '@/hooks/use-app-ui-preferences';
import { api, type AppUiPreferences, getErrorMessage } from '@/lib/api';
import { openAppLink } from '@/lib/app-links';
import { isTauriDesktopRuntime, runAppUpdateCheck } from '@/lib/app-updater';
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
import { routeChunks } from '@/lib/route-chunks';
import { mpvDestroy, setMpvProperty } from '@/lib/player-mpv';
import { isPlayerPip, returnFromPlayerPip, waitForViewportTransition } from '@/lib/player-pip';
import { boundedMapSet, clearTimer, SIDEBAR_PAGE_COLUMN_INSETS, withTimeout } from '@/lib/utils';
import { Home } from '@/pages/home';

function createRoutePages() {
  return {
    Search: lazy(() => routeChunks.search().then((module) => ({ default: module.Search }))),
    Details: lazy(() => routeChunks.details().then((module) => ({ default: module.Details }))),
    Settings: lazy(() => routeChunks.settings().then((module) => ({ default: module.Settings }))),
    Profile: lazy(() => routeChunks.profile().then((module) => ({ default: module.Profile }))),
    Calendar: lazy(() => routeChunks.calendar().then((module) => ({ default: module.Calendar }))),
  };
}

function ContentRouteLoader() {
  return (
    <div
      role='status'
      aria-busy='true'
      className={`mx-auto min-h-[60vh] w-full max-w-6xl space-y-6 py-8 ${SIDEBAR_PAGE_COLUMN_INSETS}`}
    >
      <RouteLoadingBar />
      <span className='sr-only'>Loading page</span>
      <div aria-hidden='true' className='space-y-6'>
        <Skeleton className='h-8 w-48 max-w-full' />
        <Skeleton className='h-10 w-full' />
        <Skeleton className='h-48 w-full' />
      </div>
    </div>
  );
}

function RouteSuspense({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <Suspense
      key={pathname}
      fallback={pathname.startsWith('/details/') ? <DetailsSkeleton /> : <ContentRouteLoader />}
    >
      {children}
    </Suspense>
  );
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

function AppLinkManager() {
  useEffect(() => {
    if (!isTauriDesktopRuntime()) return;
    const openPendingLink = () => {
      void api
        .takePendingAppLink()
        .then((link) => {
          if (link) openAppLink(link);
        })
        .catch(() => undefined);
    };
    const listener = listen('app://link', openPendingLink);
    void listener.then(openPendingLink, openPendingLink);
    return () => {
      void listener.then(
        (unlisten) => unlisten(),
        () => undefined,
      );
    };
  }, []);

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
    const previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    const record = () => {
      if (savePausedRef.current) return;
      const entry = lastEntryRef.current;
      rememberScrollPosition(positionsByKeyRef.current, entry.key, window.scrollY);
      // Search/filter URLs get separate positions, with the same bound.
      rememberScrollPosition(positionsByPathRef.current, entry.path, window.scrollY);
    };
    window.addEventListener('scroll', record, { passive: true });
    return () => {
      window.removeEventListener('scroll', record);
      window.history.scrollRestoration = previousScrollRestoration;
    };
  }, []);

  useLayoutEffect(() => {
    // The navigation mirror feeds back gestures' POP-vs-replace decision.
    const path = `${location.pathname}${location.search}`;
    recordLocationEntry(location.key, path, navigationType);

    const lastEntry = lastEntryRef.current;
    lastEntryRef.current = { key: location.key, pathname: location.pathname, path };
    savePausedRef.current = true;

    const savedPosition =
      navigationType === NavigationType.Pop
        ? positionsByKeyRef.current.get(location.key)
        : navigationType === NavigationType.Replace && lastEntry.pathname !== location.pathname
          ? positionsByPathRef.current.get(path)
          : undefined;

    let restoreFrame: number | undefined;
    let restoreTimeout: number | undefined;
    const intentEvents = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    const cancelRestoration = () => {
      if (restoreFrame !== undefined) window.cancelAnimationFrame(restoreFrame);
      window.clearTimeout(restoreTimeout);
      for (const eventName of intentEvents) {
        window.removeEventListener(eventName, cancelRestoration, true);
      }
      savePausedRef.current = false;
    };

    if (navigationType === NavigationType.Replace && lastEntry.pathname === location.pathname) {
      rememberScrollPosition(positionsByKeyRef.current, location.key, window.scrollY);
      rememberScrollPosition(positionsByPathRef.current, path, window.scrollY);
      restoreFrame = window.requestAnimationFrame(cancelRestoration);
      return cancelRestoration;
    }

    const restorePosition = () => {
      if (savedPosition !== undefined) {
        const scrollRoot = document.scrollingElement ?? document.documentElement;
        if (scrollRoot.scrollHeight - scrollRoot.clientHeight < savedPosition) {
          restoreFrame = window.requestAnimationFrame(restorePosition);
          return;
        }
        window.scrollTo(0, savedPosition);
      }
      cancelRestoration();
    };

    // A POP without a remembered offset lands at top, not mid-list.
    window.scrollTo(0, savedPosition ?? 0);
    restoreFrame = window.requestAnimationFrame(restorePosition);
    if (savedPosition !== undefined) {
      // Keep clamped skeleton offsets out of memory while async content mounts.
      restoreTimeout = window.setTimeout(cancelRestoration, 2_500);
      for (const eventName of intentEvents) {
        window.addEventListener(eventName, cancelRestoration, {
          capture: true,
          passive: true,
        });
      }
    }

    // Preserve surviving focus; otherwise land on content, including Back/Forward.
    if (!document.querySelector(OPEN_DIALOG_SELECTOR)) {
      const active = document.activeElement;
      if (!active || active === document.body) {
        document.getElementById('app-main')?.focus({ preventScroll: true });
      }
    }

    return cancelRestoration;
  }, [location.key, location.pathname, location.search, navigationType]);

  return null;
}

const UPDATE_STARTUP_DELAY_MS = 3_000;
const UPDATE_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function AppUpdateManager() {
  const queryClient = useQueryClient();
  const hasPlayerSession = usePlayerSession().session !== null;
  const { isSupported, isInstalling, getUpdateState } = useAppUpdater();
  const { preferences: automaticUpdateChecks, isHydrating } = useAppUiPreferences(
    (preferences) => preferences.automaticUpdateChecks,
  );
  const { pathname } = useLocation();
  const startupReadyAtRef = useRef<number | null>(null);
  const retryOnReconnectRef = useRef(false);
  const announcedVersionRef = useRef<string | null>(null);
  const isDeferred = useEffectEvent(
    () =>
      document.hidden ||
      hasPlayerSession ||
      window.location.pathname.startsWith('/player') ||
      !navigator.onLine,
  );

  useEffect(() => {
    if (!isSupported || isHydrating || !automaticUpdateChecks || isInstalling) return;

    let disposed = false;
    let running = false;
    let dueTimer: number | undefined;
    if (startupReadyAtRef.current === null) {
      startupReadyAtRef.current = Date.now() + UPDATE_STARTUP_DELAY_MS;
    }
    const maybeCheck = (event?: Event) => {
      const state = getUpdateState();
      if (event?.type === 'online' && state.retryOnReconnect) {
        retryOnReconnectRef.current = true;
      }
      if (
        disposed ||
        running ||
        isDeferred() ||
        Date.now() < startupReadyAtRef.current! ||
        state.status === 'installing'
      )
        return;
      running = true;
      const checkForUpdate = async () => {
        const isDue =
          state.lastCheckedAt === null ||
          Date.now() - state.lastCheckedAt >= UPDATE_RECHECK_INTERVAL_MS ||
          (retryOnReconnectRef.current && state.retryOnReconnect);
        retryOnReconnectRef.current = false;
        const update = isDue ? await runAppUpdateCheck(queryClient) : state.update;
        if (
          !update?.notificationEligible ||
          disposed ||
          isDeferred() ||
          getUpdateState().status === 'installing' ||
          (window.location.pathname === '/settings' &&
            new URLSearchParams(window.location.search).get('section') === 'updates') ||
          announcedVersionRef.current === update.version
        )
          return;
        announcedVersionRef.current = update.version;
        toast.custom(
          () => <AppUpdateCard onViewNotes={() => navigateApp('/settings?section=updates')} />,
          {
            id: APP_UPDATE_TOAST_ID,
            duration: Number.POSITIVE_INFINITY,
            unstyled: true,
          },
        );
      };
      void checkForUpdate()
        // Automatic checks stay silent; Settings retains the failure.
        .catch(() => undefined)
        .finally(() => {
          running = false;
          if (!disposed) armDueTimer();
        });
    };
    // One wake per due check instead of a polling tick; deferred checks resume on visibility, focus, online or
    // route change or session close.
    const armDueTimer = () => {
      window.clearTimeout(dueTimer);
      const { lastCheckedAt } = getUpdateState();
      const dueAt = Math.max(
        startupReadyAtRef.current!,
        (lastCheckedAt ?? 0) + UPDATE_RECHECK_INTERVAL_MS,
      );
      dueTimer = window.setTimeout(() => maybeCheck(), Math.max(0, dueAt - Date.now()));
    };
    document.addEventListener('visibilitychange', maybeCheck);
    window.addEventListener('focus', maybeCheck);
    window.addEventListener('online', maybeCheck);
    armDueTimer();
    maybeCheck();

    return () => {
      disposed = true;
      window.clearTimeout(dueTimer);
      document.removeEventListener('visibilitychange', maybeCheck);
      window.removeEventListener('focus', maybeCheck);
      window.removeEventListener('online', maybeCheck);
    };
  }, [
    isSupported,
    isHydrating,
    automaticUpdateChecks,
    isInstalling,
    pathname,
    hasPlayerSession,
    queryClient,
    getUpdateState,
  ]);

  return null;
}

// Close barrier: every awaited step is bounded — a wedged native op or viewport
// transition must not trap the window open (the OS reclaims mpv at exit).
const CLOSE_BARRIER_STEP_TIMEOUT_MS = 8_000;
const CLOSE_MPV_TEARDOWN_TIMEOUT_MS = 2_000;

function AppCloseManager() {
  const isDesktopRuntime = isTauriDesktopRuntime();
  const { session, trayPause } = usePlayerSession();
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

    // onCloseRequested destroys the window itself unless vetoed: keep core:window:allow-destroy.
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (closing) {
          event.preventDefault();
          return;
        }
        closing = true;
        const close = async () => {
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
            await settleCloseStep(flushPendingAppWrites());
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
                if (hasSession()) {
                  trayPause.publish(true);
                  await settleCloseStep(setMpvProperty('pause', true));
                }
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
          // A failed or slow native teardown still closes — vetoing would wedge
          // the window behind an unkillable mpv call; exit reclaims it.
          await withTimeout(
            mpvDestroy().catch(() => undefined),
            CLOSE_MPV_TEARDOWN_TIMEOUT_MS,
            () => undefined,
          );
        };
        await close()
          .catch(() => {
            // Veto once so the save retries; the next close quits anyway.
            if (!saveFailureVetoed) {
              saveFailureVetoed = true;
              event.preventDefault();
              toast.error('Could not save playback progress.', {
                description: 'Close again to quit anyway.',
              });
            }
          })
          .finally(() => {
            closing = false;
          });
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
            if (!isActive) {
              disposeQuit();
              return;
            }
            unlistenQuit = disposeQuit;
            return api.markFrontendQuitReady();
          })
          .catch(() => {
            if (import.meta.env.DEV) {
              console.warn('[app] quit-requested listener setup failed');
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
  }, [isDesktopRuntime, trayPause]);

  return null;
}

function App() {
  const [{ Search, Details, Settings, Profile, Calendar }, setRoutePages] =
    useState(createRoutePages);
  const retryRoute = () => setRoutePages(createRoutePages());

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

  return (
    <PlayerSessionProvider>
      <Routes>
        <Route element={<Layout onRouteRetry={retryRoute} />}>
          <Route path='/' element={<Home />} />
          <Route
            element={
              <RouteSuspense>
                <Outlet />
              </RouteSuspense>
            }
          >
            <Route path='/search' element={<Search />} />
            <Route path='/details/:type/:id' element={<Details />} />
            <Route path='/settings' element={<Settings />} />
            <Route path='/profile' element={<Profile />} />
            {/* /library is a deep link into Profile's library tab — the path
                survives so the sidebar can highlight it. */}
            <Route path='/library' element={<Profile />} />
            <Route path='/calendar' element={<Calendar />} />
          </Route>
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
      <AppLinkManager />
      <RouteScrollManager />
      <LastLocationRecorder />
      <AppCloseManager />
      <AppUpdateManager />
      <Toaster />
    </PlayerSessionProvider>
  );
}

export default App;
