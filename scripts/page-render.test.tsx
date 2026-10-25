import { expect, mock, spyOn, test } from 'bun:test';
import type { ComponentProps, ComponentType } from 'react';
import type { StreamSelectorData } from '../src/lib/api';

// Bun's navigator has no connectivity snapshot; render the pages as online.
Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });

const react = await import('react');
const readStore = react.useSyncExternalStore;

// Desktop stores omit SSR snapshots; use their real client snapshots for this smoke test.
mock.module('react', () => ({
  ...react,
  useSyncExternalStore<T>(
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ) {
    return readStore(subscribe, getSnapshot, getServerSnapshot ?? getSnapshot);
  },
}));

const radixDialog = await import('@radix-ui/react-dialog');
const DialogPortal = radixDialog.Portal;
let renderSelectorPortal = false;
// SSR omits portals; expose only the selector fixture's content, retaining the real dialog.
mock.module('@radix-ui/react-dialog', () => ({
  ...radixDialog,
  Portal: ({ children, ...props }: ComponentProps<typeof DialogPortal>) =>
    renderSelectorPortal ? children : <DialogPortal {...props}>{children}</DialogPortal>,
}));

const { QueryClient, QueryClientProvider, QueryObserver, onlineManager } =
  await import('@tanstack/react-query');
const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { Search } = await import('../src/pages/search');
const { Home, homeTrendingMoviesQueryOptions } = await import('../src/pages/home');
const { api, DEFAULT_APP_UI_PREFERENCES } = await import('../src/lib/api');
const { queryClient } = await import('../src/lib/query-client');
const {
  APP_UI_PREFERENCES_QUERY_KEY,
  DETAILS_QUERY_KEY,
  RECENT_WATCH_SEED_QUERY_KEY,
  streamSelectorQueryKey,
} = await import('../src/lib/query-invalidation');
const { playerStreamRankingOptions } = await import('../src/lib/resolve-player-stream');
const { buildStreamRankingCacheKey } = await import('../src/lib/stream-ranking-cache-key');

const { StreamSelector } = await import('../src/components/stream-selector');
const { useRecentSearches } = await import('../src/hooks/use-app-ui-preferences');
const { flushPendingAppWrites } = await import('../src/lib/pending-app-writes');

test('Recent-search clear waits for a pending record and leaves cache and storage empty', async () => {
  const client = new QueryClient();
  let persisted = { ...DEFAULT_APP_UI_PREFERENCES, recentSearches: ['old'] };
  client.setQueryData(APP_UI_PREFERENCES_QUERY_KEY, persisted);
  const started = Promise.withResolvers<void>();
  const record = Promise.withResolvers<void>();
  const recordSearch = spyOn(api, 'recordRecentSearch').mockImplementation(async (query) => {
    started.resolve();
    await record.promise;
    persisted = { ...persisted, recentSearches: [query, ...persisted.recentSearches] };
    return persisted;
  });
  const savePreferences = spyOn(api, 'saveAppUiPreferences').mockImplementation(async (patch) => {
    persisted = { ...persisted, ...patch };
    return persisted;
  });
  const history = Promise.withResolvers<ReturnType<typeof useRecentSearches>>();
  function SearchHistory() {
    history.resolve(useRecentSearches());
    return null;
  }
  try {
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <SearchHistory />
      </QueryClientProvider>,
    );
    const searches = await history.promise;
    searches.recordRecentSearch('pending');
    await started.promise;
    const cleared = searches.clearRecentSearches();
    record.resolve();
    await cleared;
    expect(
      client.getQueryData<typeof persisted>(APP_UI_PREFERENCES_QUERY_KEY)?.recentSearches,
    ).toEqual([]);
    expect(persisted.recentSearches).toEqual([]);
  } finally {
    record.resolve();
    await flushPendingAppWrites();
    recordSearch.mockRestore();
    savePreferences.mockRestore();
    client.clear();
  }
});

function renderPage(
  Page: ComponentType,
  route: string,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  }),
) {
  // The Hero reads native window location; keep this server fixture on the rails.
  client.setQueryData(homeTrendingMoviesQueryOptions.queryKey, []);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <Page />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

test.each(['/search', '/search?q=matrix', '/search?type=anime&genre=Action'])(
  'Search renders its own tooltip provider at %s',
  (route) => {
    const markup = renderPage(Search, route);
    expect(markup).toContain('data-search-input');
    expect(markup).toContain('About unified catalog results');
  },
);

test('Home keeps Animation beside Movies and Series in the same category control', () => {
  const markup = renderPage(Home, '/home');
  expect(markup).toMatch(/Movies<\/button>[\s\S]*Series<\/button>[\s\S]*Animation<\/button>/);
  expect(markup).toContain('All genres');
  expect(markup).not.toContain('Trending Animation');
});

test.each([false, true])(
  'Home offers recommendation retry only for a failed seed (failed=%s)',
  async (failed) => {
    const client = new QueryClient();
    await client.prefetchQuery({
      queryKey: RECENT_WATCH_SEED_QUERY_KEY,
      queryFn: () => {
        if (failed) throw new Error('History unavailable');
        return null;
      },
      retry: false,
    });
    const markup = renderPage(Home, '/home', client);
    expect(markup.includes('load recommendations.')).toBe(failed);
    expect(markup).not.toContain('Because you watched');
  },
);

test.each([
  { available: true, configFailed: true },
  { available: false, configFailed: true },
  { available: false, configFailed: false },
])(
  'Stream selector preserves its available/error/no-addons state (%j)',
  async ({ available, configFailed }) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
    });
    const target = { type: 'movie' as const, id: 'selector-test' };
    const failure = new Error('Addon configuration unavailable');
    try {
      // Reject a cold config query: no previously successful addon list can mask the failure.
      await client.prefetchQuery({
        ...api.addonConfigsQueryOptions(),
        queryFn: () => {
          if (configFailed) throw failure;
          return [];
        },
      });
      const data: StreamSelectorData = {
        streams: available
          ? [
              {
                streamKey: 'available-stream',
                matchBadgeKinds: [],
                matchTier: null,
                showPackBadge: false,
                presentation: {
                  sourceName: 'Available source',
                  streamTitle: 'Available release',
                  resolution: '1080p',
                  deliveryKind: 'http',
                  deliveryLabel: 'HTTP',
                  isInstantlyPlayable: true,
                  isBatch: false,
                },
              },
            ]
          : [],
        sourceSummaries: available
          ? [
              {
                id: 'available-source',
                name: 'Available source',
                status: 'healthy',
                streamCount: 1,
              },
            ]
          : [],
        stats: {
          resCounts: { '4k': 0, '1080p': Number(available), '720p': 0, sd: 0 },
          playableCount: Number(available),
          p2pCount: 0,
          cachedCount: 0,
          batchCount: 0,
          episodeLikeCount: 0,
          sourceHealth: { degraded: 0, offline: 0, pending: 0 },
        },
      };
      client.setQueryData(
        streamSelectorQueryKey(
          target.type,
          target.id,
          undefined,
          undefined,
          undefined,
          buildStreamRankingCacheKey(
            playerStreamRankingOptions({ mediaId: target.id, mediaType: target.type }),
          ),
        ),
        data,
      );
      renderSelectorPortal = true;
      const markup = renderPage(
        () => <StreamSelector open onClose={() => {}} target={target} />,
        '/details/movie/selector-test',
        client,
      );
      expect(markup.includes('Search streams by release, codec or keyword')).toBe(available);
      expect(markup.includes(failure.message)).toBe(!available && configFailed);
      expect(markup.includes('Retry</button>')).toBe(!available && configFailed);
      expect(markup.includes('No enabled stream sources.')).toBe(!available && !configFailed);
      expect(markup.includes('Manage addons')).toBe(!available && !configFailed);
    } finally {
      renderSelectorPortal = false;
      client.clear();
    }
  },
);

test.each([false, true])(
  'Offline native preferences finish their one retry (persistent=%s)',
  async (persistent) => {
    const wasOnline = onlineManager.isOnline();
    const storedPreferences = { ...DEFAULT_APP_UI_PREFERENCES, playerVolume: 42 };
    const failure = new Error('Native preference store unavailable');
    let calls = 0;
    let unsubscribe: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      onlineManager.setOnline(false);
      const observer = new QueryObserver(queryClient, {
        queryKey: APP_UI_PREFERENCES_QUERY_KEY,
        queryFn: async () => {
          calls += 1;
          if (persistent || calls === 1) throw failure;
          return storedPreferences;
        },
        staleTime: Infinity,
        gcTime: Infinity,
        placeholderData: DEFAULT_APP_UI_PREFERENCES,
        retryDelay: 0,
      });
      expect(observer.getCurrentResult().isPlaceholderData).toBe(true);
      const result = await new Promise<ReturnType<typeof observer.getCurrentResult>>(
        (resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Native read did not settle')), 1_000);
          unsubscribe = observer.subscribe((next) => {
            if (
              next.fetchStatus === 'paused' ||
              (next.fetchStatus === 'idle' && !next.isPlaceholderData)
            )
              resolve(next);
          });
        },
      );
      expect(result.fetchStatus).toBe('idle');
      expect(calls).toBe(2);
      expect(result.isSuccess).toBe(!persistent);
      expect(result.isError).toBe(persistent);
      expect(result.isPlaceholderData).toBe(false);
      expect(result.data).toEqual(persistent ? undefined : storedPreferences);
      expect(result.error).toBe(persistent ? failure : null);
      const isHydrating = !result.isSuccess || result.isPlaceholderData;
      expect(isHydrating).toBe(persistent);
    } finally {
      unsubscribe?.();
      clearTimeout(timeout);
      queryClient.removeQueries({ queryKey: APP_UI_PREFERENCES_QUERY_KEY, exact: true });
      onlineManager.setOnline(wasOnline);
    }
  },
);

test('An active native read recovers on reconnect after exhausting its offline retry', async () => {
  const wasOnline = onlineManager.isOnline();
  const queryKey = [...DETAILS_QUERY_KEY, 'movie', 'offline-reconnect-test'];
  let calls = 0;
  let unsubscribe: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    onlineManager.setOnline(false);
    queryClient.mount();
    const observer = new QueryObserver(queryClient, {
      queryKey,
      queryFn: async () => {
        calls += 1;
        if (!onlineManager.isOnline()) throw new Error('Native request failed offline');
        return 'Recovered details';
      },
      retryDelay: 0,
    });
    let offlineError: ReturnType<typeof observer.getCurrentResult> | undefined;
    const result = await new Promise<ReturnType<typeof observer.getCurrentResult>>(
      (resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Native read did not recover on reconnect')),
          1_000,
        );
        unsubscribe = observer.subscribe((next) => {
          if (next.fetchStatus !== 'idle') return;
          if (next.isError && !onlineManager.isOnline()) {
            offlineError = next;
            onlineManager.setOnline(true);
          } else if (next.isSuccess) resolve(next);
        });
      },
    );
    expect(offlineError?.isError).toBe(true);
    expect(offlineError?.failureCount).toBe(2);
    expect(calls).toBe(3);
    expect(result.isSuccess).toBe(true);
    expect(result.data).toBe('Recovered details');
  } finally {
    unsubscribe?.();
    clearTimeout(timeout);
    queryClient.removeQueries({ queryKey, exact: true });
    queryClient.unmount();
    onlineManager.setOnline(wasOnline);
  }
});
