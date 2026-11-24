import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StartupAsciiReveal } from '../src/components/startup-ascii-reveal';
import { UpdateAsciiMotif, UpdateProgressBar } from '../src/components/update-chrome';
import type { BestResolvedStream } from '../src/lib/api';
import {
  clearProviderDataCaches,
  runBestStreamRequest,
  stageResolvedPlayerLaunch,
  takeResolvedPlayerLaunch,
} from '../src/lib/api-cache';
import { APP_UPDATE_STATE_QUERY_KEY } from '../src/lib/app-updater';
import { trimFrontendMemory } from '../src/lib/memory-trim';
import {
  APP_UI_PREFERENCES_QUERY_KEY,
  DETAILS_QUERY_KEY,
  PROFILE_PREFERENCES_QUERY_KEY,
  SEARCH_CATALOG_QUERY_KEY,
} from '../src/lib/query-invalidation';

function sampleResolvedStream(cacheTtlMs: number): BestResolvedStream {
  return {
    stream: {
      url: 'https://cdn.example/video.mkv',
      title: '1080p',
      addonId: 'addon-1',
      addonName: 'Addon',
      behaviorHints: undefined,
    },
    candidateCount: 1,
    cacheTtlMs,
  } as unknown as BestResolvedStream;
}

test('trimFrontendMemory preserves mounted disabled observers, caller staleTime policies, in-flight fetches, update state, preferences, fresh entries, and staged launches', async () => {
  clearProviderDataCaches();
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, gcTime: 600_000 } },
  });

  // Protected app state & preferences (even if stale/unobserved)
  const staleAt = Date.now() - 120_000;
  client.setQueryData(
    PROFILE_PREFERENCES_QUERY_KEY,
    { accentColor: '#10b981' },
    { updatedAt: staleAt },
  );
  client.setQueryData(APP_UI_PREFERENCES_QUERY_KEY, { closeToTray: true }, { updatedAt: staleAt });
  client.setQueryData(APP_UPDATE_STATE_QUERY_KEY, { status: 'available' }, { updatedAt: staleAt });

  // Active mounted observer
  const activeKey = [...DETAILS_QUERY_KEY, 'movie', 'tt1111111'] as const;
  client.setQueryData(activeKey, { id: 'tt1111111' }, { updatedAt: staleAt });
  const activeObserver = new QueryObserver(client, {
    queryKey: activeKey,
    queryFn: () => Promise.resolve({ id: 'tt1111111' }),
  });
  const unsubActive = activeObserver.subscribe(() => undefined);

  // Mounted DISABLED observer (TanStack treats as type:'inactive', but observersCount === 1)
  const disabledKey = [...DETAILS_QUERY_KEY, 'movie', 'tt2222222'] as const;
  client.setQueryData(disabledKey, { id: 'tt2222222' }, { updatedAt: staleAt });
  const disabledObserver = new QueryObserver(client, {
    queryKey: disabledKey,
    enabled: false,
    queryFn: () => Promise.resolve({ id: 'tt2222222' }),
  });
  const unsubDisabled = disabledObserver.subscribe(() => undefined);

  // Unmounted observer whose caller configured staleTime: Infinity (e.g. Search catalog facets)
  const callerInfiniteKey = [...SEARCH_CATALOG_QUERY_KEY, 'caller-infinite'] as const;
  await client.prefetchQuery({
    queryKey: callerInfiniteKey,
    queryFn: () => Promise.resolve({ items: ['facet'] }),
    staleTime: Infinity,
  });
  client.setQueryData(callerInfiniteKey, { items: ['facet'] }, { updatedAt: staleAt });

  // Unmounted observer whose caller configured staleTime: 'static'
  const callerStaticKey = [...SEARCH_CATALOG_QUERY_KEY, 'caller-static'] as const;
  await client.prefetchQuery({
    queryKey: callerStaticKey,
    queryFn: () => Promise.resolve({ items: ['static'] }),
    staleTime: 'static',
  });
  client.setQueryData(callerStaticKey, { items: ['static'] }, { updatedAt: staleAt });

  // Unmounted query with function-valued staleTime returning a longer window
  const fnStaleKey = [...SEARCH_CATALOG_QUERY_KEY, 'caller-fn'] as const;
  await client.prefetchQuery({
    queryKey: fnStaleKey,
    queryFn: () => Promise.resolve({ items: ['fn'] }),
    staleTime: () => 600_000,
  });
  client.setQueryData(fnStaleKey, { items: ['fn'] }, { updatedAt: staleAt });

  // Genuine in-flight fetch (unobserved but fetchStatus === 'fetching')
  const inFlightKey = [...SEARCH_CATALOG_QUERY_KEY, 'in-flight'] as const;
  let releaseFetch!: (value: { items: string[] }) => void;
  const fetchPromise = client.prefetchQuery({
    queryKey: inFlightKey,
    queryFn: () =>
      new Promise<{ items: string[] }>((resolve) => {
        releaseFetch = resolve;
      }),
  });
  expect(client.getQueryCache().find({ queryKey: inFlightKey })?.state.fetchStatus).toBe(
    'fetching',
  );

  // Truly unobserved infinite-staleTime default query (must survive)
  const infiniteKey = ['eternal-cache'] as const;
  client.setQueryDefaults(infiniteKey, { staleTime: Infinity });
  client.setQueryData(infiniteKey, { pinned: true }, { updatedAt: staleAt });

  // Truly unobserved fresh query (must survive)
  const freshKey = [...SEARCH_CATALOG_QUERY_KEY, 'fresh'] as const;
  client.setQueryData(freshKey, { items: ['b'] }, { updatedAt: Date.now() });

  // Truly unobserved stale query (should be evicted)
  const staleKey = [...SEARCH_CATALOG_QUERY_KEY, 'stale'] as const;
  client.setQueryData(staleKey, { items: ['a'] }, { updatedAt: staleAt });

  // Staged player launch & fresh cached stream (must survive)
  const staged = sampleResolvedStream(60_000);
  const launchId = stageResolvedPlayerLaunch(staged);
  let loads = 0;
  await runBestStreamRequest('movie:tt3333333', () => {
    loads += 1;
    return Promise.resolve(sampleResolvedStream(60_000));
  });

  try {
    const removed = trimFrontendMemory(client);
    expect(removed).toBe(1);
    expect(client.getQueryData(staleKey)).toBeUndefined();
    expect(client.getQueryData(freshKey)).toEqual({ items: ['b'] });
    expect(client.getQueryData(infiniteKey)).toEqual({ pinned: true });
    expect(client.getQueryData(callerInfiniteKey)).toEqual({ items: ['facet'] });
    expect(client.getQueryData(callerStaticKey)).toEqual({ items: ['static'] });
    expect(client.getQueryData(fnStaleKey)).toEqual({ items: ['fn'] });
    expect(client.getQueryData(activeKey)).toEqual({ id: 'tt1111111' });
    expect(client.getQueryData(disabledKey)).toEqual({ id: 'tt2222222' });
    expect(client.getQueryCache().find({ queryKey: inFlightKey })).toBeDefined();
    expect(client.getQueryData(PROFILE_PREFERENCES_QUERY_KEY)).toBeDefined();
    expect(client.getQueryData(APP_UI_PREFERENCES_QUERY_KEY)).toBeDefined();
    expect(client.getQueryData(APP_UPDATE_STATE_QUERY_KEY)).toBeDefined();
    expect(takeResolvedPlayerLaunch(launchId)).toBe(staged);

    // Fresh stream cache entry stays intact
    await runBestStreamRequest('movie:tt3333333', () => {
      loads += 1;
      return Promise.resolve(sampleResolvedStream(60_000));
    });
    expect(loads).toBe(1);

    releaseFetch({ items: ['done'] });
    await fetchPromise;
    expect(client.getQueryData(inFlightKey)).toEqual({ items: ['done'] });
  } finally {
    unsubActive();
    unsubDisabled();
    clearProviderDataCaches();
    client.clear();
  }
});

test('StartupAsciiReveal respects SSR and reduced motion, and renders a non-interactive overlay when enabled', () => {
  // Without a browser window (SSR), StartupAsciiReveal renders nothing.
  expect(renderToStaticMarkup(<StartupAsciiReveal />)).toBe('');

  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { matchMedia: () => ({ matches: true }) as MediaQueryList },
    });
    expect(renderToStaticMarkup(<StartupAsciiReveal />)).toBe('');

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { matchMedia: () => ({ matches: false }) as MediaQueryList },
    });
    const markup = renderToStaticMarkup(<StartupAsciiReveal />);
    expect(markup).toContain('data-startup-ascii-reveal="true"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('pointer-events-none');
  } finally {
    if (hadWindow && windowDescriptor) {
      Object.defineProperty(globalThis, 'window', windowDescriptor);
    } else {
      delete (globalThis as Record<string, unknown>).window;
    }
  }
});

test('UpdateProgressBar and UpdateAsciiMotif preserve progressbar accessibility and hidden decorative motif', () => {
  const determinate = renderToStaticMarkup(<UpdateProgressBar percent={42} />);
  expect(determinate).toContain('role="progressbar"');
  expect(determinate).toContain('aria-valuenow="42"');
  expect(determinate).toContain('scaleX(0.42)');

  const indeterminate = renderToStaticMarkup(<UpdateProgressBar percent={null} />);
  expect(indeterminate).toContain('role="progressbar"');
  expect(indeterminate).not.toContain('aria-valuenow');

  const motif = renderToStaticMarkup(<UpdateAsciiMotif active />);
  expect(motif).toContain('aria-hidden="true"');
  expect(motif).toContain('motion-safe:animate-pulse');
});
