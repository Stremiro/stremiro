import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { api } from '@/lib/api';
import {
  APP_UI_PREFERENCES_QUERY_KEY,
  PROFILE_PREFERENCES_QUERY_KEY,
} from '@/lib/query-invalidation';
import { sleep } from '@/lib/utils';
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
    console.error('Unhandled render error', error);
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
      staleTime: 1000 * 60 * 5, // 5 min default — prevents redundant refetches
      gcTime: 1000 * 60 * 30, // 30 min in-memory cache retention
      refetchOnWindowFocus: false, // Desktop app — no tab switching noise
      retry: 1, // One retry on transient failures
    },
  },
});

// Prime the always-mounted preference reads so the first frame paints the
// stored accent/profile instead of flipping from defaults; the cap keeps a
// slow store from holding launch.
const PREFERENCES_PRIME_TIMEOUT_MS = 300;
const primePreferences = Promise.all([
  queryClient.prefetchQuery({
    queryKey: PROFILE_PREFERENCES_QUERY_KEY,
    queryFn: api.getProfilePreferences,
    staleTime: Infinity,
    gcTime: Infinity,
  }),
  queryClient.prefetchQuery({
    queryKey: APP_UI_PREFERENCES_QUERY_KEY,
    queryFn: api.getAppUiPreferences,
    staleTime: Infinity,
    gcTime: Infinity,
  }),
]);

void Promise.race([primePreferences, sleep(PREFERENCES_PRIME_TIMEOUT_MS)]).then(() => {
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
