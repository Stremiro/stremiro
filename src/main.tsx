import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { api } from '@/lib/api';
import { isTauriDesktopRuntime } from '@/lib/app-updater';
import {
  APP_UI_PREFERENCES_QUERY_KEY,
  DETAILS_GC_TIME_MS,
  DETAILS_QUERY_KEY,
  invalidateAddonCapabilityQueries,
  PROFILE_PREFERENCES_QUERY_KEY,
  STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
} from '@/lib/query-invalidation';
import { sleep } from '@/lib/utils';
import { homeTrendingMoviesQueryOptions } from '@/pages/home';
import App from './App';
import './index.css';

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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'offlineFirst', // Local IPC — Rust owns networking
      staleTime: 1000 * 60 * 5, // 5 min default — prevents redundant refetches
      gcTime: 1000 * 60 * 30, // 30 min in-memory cache retention
      refetchOnWindowFocus: false, // Desktop app — no tab switching noise
      retry: 1, // One retry on transient failures
    },
    mutations: { networkMode: 'always', gcTime: 0 },
  },
});
queryClient.setQueryDefaults(DETAILS_QUERY_KEY, { gcTime: DETAILS_GC_TIME_MS });

if (isTauriDesktopRuntime()) {
  const listener = listen('app://addon-capabilities-changed', () => {
    void invalidateAddonCapabilityQueries(queryClient);
  }).catch(() => {
    if (import.meta.env.DEV) console.warn('[app] addon-capabilities listener failed to register');
  });
  import.meta.hot?.dispose(() => {
    void listener.then((unlisten) => unlisten?.());
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

const seedQuery = (queryKey: readonly unknown[], data: unknown) => {
  if (queryClient.getQueryData(queryKey) === undefined) queryClient.setQueryData(queryKey, data);
};

const bootstrapSnapshot = api.getBootstrapSnapshot().then(
  (snapshot) => {
    seedQuery(PROFILE_PREFERENCES_QUERY_KEY, snapshot.profilePreferences);
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

if (window.location.pathname === '/' && navigator.onLine) {
  void queryClient.prefetchQuery(homeTrendingMoviesQueryOptions);
}

void Promise.race([bootstrapSnapshot, sleep(BOOTSTRAP_PAINT_TIMEOUT_MS)]).then(() => {
  rendered = true;
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <RootErrorBoundary>
            <App />
          </RootErrorBoundary>
        </BrowserRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
});
