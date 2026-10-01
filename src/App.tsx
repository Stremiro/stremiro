import { useQueryClient } from '@tanstack/react-query';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Loader2 } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useLayoutEffect, useRef } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router';
import { toast } from 'sonner';
import { AppUpdateCard, APP_UPDATE_TOAST_ID } from '@/components/app-update-card';
import { Toaster } from '@/components/ui/sonner';
import { useAppUpdater } from '@/hooks/use-app-updater';
import { isTauriDesktopRuntime, runScheduledAppUpdateCheck } from '@/lib/app-updater';
import { flushPendingAppWrites } from '@/lib/pending-app-writes';
import { isEditableTarget, OPEN_DIALOG_SELECTOR } from '@/lib/dom';
import { bindAppNavigate, navigateApp, recordLocationEntry } from '@/lib/navigation';
import { PlayerHost, PlayerRouteRegistrar, PlayerSessionProvider } from '@/lib/player-session';
import { routeChunks, warmRouteChunks } from '@/lib/route-chunks';
import { Layout } from './components/layout';
import { Home } from './pages/home';

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
    <div className='flex min-h-[60vh] w-full items-center justify-center'>
      <Loader2 className='h-7 w-7 animate-spin text-white/35' />
    </div>
  );
}

function RouteSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={<ContentRouteLoader />}>{children}</Suspense>;
}

// A single router subscription at the root feeds every per-item anchor via
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

// delete+set keeps recency order: plain set leaves a revisited entry at its
// first-seen slot, so the cap would evict live positions (e.g. '/' after
// every return) before stale ones.
function rememberScrollPosition(map: Map<string, number>, key: string, position: number) {
  map.delete(key);
  map.set(key, position);
  if (map.size > MAX_SAVED_SCROLL_POSITIONS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

// The window scroller is shared across routes: PUSH lands at the top, POP
// restores the offset saved under that history entry, and a cross-path
// REPLACE — the details/player "back" actions — restores the last offset
// seen on the target path (back to a scrolled grid resumes mid-list).
// Same-path REPLACE — the search URL reflect — never touches the scroller,
// or every debounced keystroke would yank the page back to the top.
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
  // Scroll events fired while a navigation commit shrinks the document would
  // attribute the incoming page's clamped offset to the departing entry.
  const savePausedRef = useRef(false);

  // Track the offset continuously rather than reading scrollY at commit
  // time — by then the incoming page may have already clamped it.
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
    // Feed the navigation mirror first — back gestures consult it to decide
    // between a POP and an explicit replace.
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
      // A POP without a remembered offset still lands at the top — carrying
      // over the departing page's scroll would open mid-list.
      window.scrollTo(0, 0);
    } else {
      window.scrollTo(0, savedPosition);
      // A still-mounting page can clamp the first attempt — retry once the
      // frame settles.
      restoreFrame = window.requestAnimationFrame(() => {
        window.scrollTo(0, savedPosition);
      });
    }

    // Land keyboard focus on the new page's landmark. The focused element is
    // usually unmounted by a PUSH (focus falls to <body>); moving it to the
    // main region keeps screen readers oriented and gives Tab a sensible
    // start. POP preserves whatever context history nav restored, same-path
    // REPLACE keeps the search input, and a live dialog owns its own focus.
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

// The first check waits for startup to settle so it never competes with the
// initial catalog/profile fetches; afterwards a 6h interval keeps
// long-running sessions aware of new releases.
const UPDATE_STARTUP_DELAY_MS = 8_000;
const UPDATE_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
// While a title plays, announcing polls on this cadence instead — the card
// overlays fullscreen video and its install path exits the process.
const UPDATE_PLAYBACK_RETRY_MS = 60_000;

function AppUpdateManager() {
  const queryClient = useQueryClient();
  const { isSupported, markUpdateNotified } = useAppUpdater();

  useEffect(() => {
    if (import.meta.env.DEV || !isSupported) return;

    let disposed = false;
    let playbackRetryTimer: number | null = null;

    const announceAvailableUpdate = async () => {
      // Defer the whole announce while the expanded player is up: the
      // persistent card would sit on top of the video, and its "Update &
      // restart" would cut playback. Not marking notified here keeps the
      // release eligible for the retry once /player is left.
      if (window.location.pathname.startsWith('/player')) {
        playbackRetryTimer ??= window.setTimeout(() => {
          playbackRetryTimer = null;
          void announceAvailableUpdate();
        }, UPDATE_PLAYBACK_RETRY_MS);
        return;
      }

      try {
        const update = await runScheduledAppUpdateCheck(queryClient);
        if (!update || disposed) return;

        await markUpdateNotified(update.version).catch(() => undefined);
        if (disposed) return;

        // Persistent card: it reads live update state and morphs
        // announce → progress → error in place under one toast id.
        toast.custom(
          () => <AppUpdateCard onViewNotes={() => navigateApp('/settings?section=updates')} />,
          {
            id: APP_UPDATE_TOAST_ID,
            duration: Number.POSITIVE_INFINITY,
            unstyled: true,
          },
        );
      } catch {
        // Automatic checks stay silent; the updates card surfaces the error.
      }
    };

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
      if (playbackRetryTimer !== null) {
        window.clearTimeout(playbackRetryTimer);
      }
    };
  }, [isSupported, markUpdateNotified, queryClient]);

  return null;
}

// Waits out queued preference/progress writes before the native close is
// honored — the Tauri API awaits this handler and destroys the window only
// when it returns unprevented, so a failed flush vetoes once and can retry.
function AppCloseManager() {
  const isDesktopRuntime = isTauriDesktopRuntime();

  useEffect(() => {
    if (!isDesktopRuntime) return;

    let isActive = true;
    let unlisten: (() => void) | undefined;

    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        try {
          await flushPendingAppWrites();
        } catch {
          event.preventDefault();
          toast.error('Could not save playback or settings. Try closing again.');
        }
      })
      .then((dispose) => {
        if (!isActive) {
          dispose();
          return;
        }

        unlisten = dispose;
      })
      .catch(() => {
        if (import.meta.env.DEV) {
          console.warn('[app] close-requested listener failed to register');
        }
      });

    return () => {
      isActive = false;
      unlisten?.();
    };
  }, [isDesktopRuntime]);

  return null;
}

function App() {
  useEffect(() => {
    // Native-app chrome: no browser context menu or ghost-drag outside real
    // inputs in any build. Editable text keeps its OS menu and selection;
    // DevTools stays reachable via keyboard shortcuts.
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

  // Warm the lazy route chunks on idle so the first visit to each page never
  // flashes the content loader — the chunks are local files in the bundle.
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
          {/* /library is a deep link into Profile's library tab — render it
              directly so the path survives (Profile reads pathname for its
              initial tab and the sidebar highlights both paths). */}
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
          {/* Unknown paths land on Home — a stray deep link should never
              render a blank shell. */}
          <Route path='*' element={<Navigate to='/' replace />} />
        </Route>
        <Route path='/player/:type/:id' element={<PlayerRouteRegistrar />} />
        <Route path='/player/:type/:id/:season/:episode' element={<PlayerRouteRegistrar />} />
      </Routes>
      {/* Root-level playback session: survives outlet route changes so leaving
          /player minimizes into the mini player instead of tearing mpv down. */}
      <PlayerHost />
      <AppNavigationBinder />
      <RouteScrollManager />
      <AppCloseManager />
      <AppUpdateManager />
      <Toaster />
    </PlayerSessionProvider>
  );
}

export default App;
