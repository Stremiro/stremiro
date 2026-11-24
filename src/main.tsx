import { QueryClientProvider } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { StartupAsciiReveal } from '@/components/startup-ascii-reveal';
import { api } from '@/lib/api';
import { isTauriDesktopRuntime } from '@/lib/app-updater';
import { registerMemoryTrimListener } from '@/lib/memory-trim';
import { enqueuePlayerLifecycle } from '@/lib/player-lifecycle';
import { mpvDestroy } from '@/lib/player-mpv';
import { queryClient } from '@/lib/query-client';
import {
  APP_UI_PREFERENCES_QUERY_KEY,
  invalidateAddonCapabilityQueries,
  PROFILE_PREFERENCES_QUERY_KEY,
  STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
} from '@/lib/query-invalidation';
import { applyProfileAccentTheme, withTimeout } from '@/lib/utils';
import { prefetchSearchCatalog } from '@/lib/search-catalog';
import { readSearchFacets } from '@/lib/search-page-state';
import { homeTrendingQueryOptions } from '@/pages/home';
import App from './App';
import './index.css';

let resolveFirstFrameReveal: () => void = () => undefined;
const firstFrameRevealPromise = new Promise<void>((resolve) => {
  resolveFirstFrameReveal = resolve;
});

// Packaged builds have no devtools: an uncaught render error would unmount the
// whole tree and leave a permanent black window. Boundary + reload is the
// only recovery path available.
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    if (import.meta.env.DEV) console.error('Unhandled render error', error);
  }

  componentDidMount() {
    if (isTauriDesktopRuntime()) {
      void withTimeout(
        invoke('frontend_first_frame_ready').catch(() => undefined),
        2_000,
        () => undefined,
      ).finally(resolveFirstFrameReveal);
    } else {
      resolveFirstFrameReveal();
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className='flex h-screen w-screen flex-col items-center justify-center gap-4 bg-black text-white'>
          <p className='text-lg font-semibold'>Something went wrong.</p>
          <button
            type='button'
            // Recovery must land on a servable document: packaged builds
            // serve the bundle from the asset protocol with no SPA fallback
            // (reloading a deep route 404s), and re-entering the crashed
            // route would re-throw immediately anyway. Root reload is the
            // only recovery path that always works.
            onClick={() => window.location.assign('/')}
            className='rounded-lg bg-white px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-zinc-200'
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

if (isTauriDesktopRuntime()) {
  const capabilityListener = listen<boolean>('app://addon-capabilities-changed', (event) => {
    void invalidateAddonCapabilityQueries(queryClient, event.payload);
  }).catch(() => {
    if (import.meta.env.DEV) console.warn('[app] addon-capabilities listener failed to register');
  });
  const memoryTrimListener = registerMemoryTrimListener(queryClient).catch(() => {
    if (import.meta.env.DEV) console.warn('[app] memory-trim listener failed to register');
  });
  import.meta.hot?.dispose(() => {
    void capabilityListener.then((unlisten) => unlisten?.());
    void memoryTrimListener.then((unlisten) => unlisten?.());
  });
}

// Prime the always-mounted preference reads so the first frame paints the
// stored accent/profile instead of flipping from defaults; the cap keeps a
// slow store from holding launch.
const BOOTSTRAP_PAINT_TIMEOUT_MS = 300;
const STARTUP_ROUTE_TIMEOUT_MS = 2_000;
const bootstrapStartedAt = performance.now();
const applyStartupRoute = isTauriDesktopRuntime() && window.location.pathname === '/';
let rendered = false;

const seedQuery = (queryKey: readonly unknown[], data: unknown): boolean => {
  if (queryClient.getQueryData(queryKey) !== undefined) return false;
  queryClient.setQueryData(queryKey, data);
  return true;
};

const bootstrapSnapshot = api.getBootstrapSnapshot().then(
  (snapshot) => {
    if (seedQuery(PROFILE_PREFERENCES_QUERY_KEY, snapshot.profilePreferences)) {
      const { accentColor, accentTargets, accentIntensity } = snapshot.profilePreferences.profile;
      applyProfileAccentTheme(accentColor, accentTargets, accentIntensity);
    }
    seedQuery(APP_UI_PREFERENCES_QUERY_KEY, snapshot.appUiPreferences);
    seedQuery(STREAM_SELECTOR_PREFERENCES_QUERY_KEY, snapshot.streamSelectorPreferences);
    if (
      applyStartupRoute &&
      snapshot.startupRoute &&
      window.location.pathname === '/' &&
      (window.history.state?.idx ?? 0) === 0 &&
      performance.now() - bootstrapStartedAt < STARTUP_ROUTE_TIMEOUT_MS
    ) {
      window.history.replaceState(window.history.state, '', snapshot.startupRoute);
      // A late snapshot lands after the router mounted; it only observes popstate.
      if (rendered)
        window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    }
    return snapshot;
  },
  () => undefined,
);

// Start the visible catalog before its page code mounts, using the same query key.
void bootstrapSnapshot.then(() => {
  if (!navigator.onLine) return;
  if (window.location.pathname === '/') {
    void queryClient.prefetchQuery(homeTrendingQueryOptions);
  } else if (window.location.pathname === '/search') {
    void prefetchSearchCatalog(
      queryClient,
      readSearchFacets(new URLSearchParams(window.location.search)),
    );
  }
});

// A reload loses the React session but keeps native mpv. A later player init
// waits on the same queue while the browsing UI can mount independently.
if (isTauriDesktopRuntime()) {
  void enqueuePlayerLifecycle(mpvDestroy).catch(() => {
    console.warn('[app] leftover player teardown failed');
  });
}

void withTimeout(bootstrapSnapshot, BOOTSTRAP_PAINT_TIMEOUT_MS, () => undefined).then(() => {
  rendered = true;
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <RootErrorBoundary>
            <App />
            <StartupAsciiReveal revealReady={firstFrameRevealPromise} />
          </RootErrorBoundary>
        </BrowserRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
});
