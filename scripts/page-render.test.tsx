import { expect, mock, spyOn, test } from 'bun:test';
import type { ComponentProps, ComponentType, DependencyList, EffectCallback } from 'react';
import type { StreamSelectorData } from '../src/lib/api';

// Bun's navigator has no connectivity snapshot; render the pages as online.
Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });

const react = await import('react');
const readStore = react.useSyncExternalStore;
const runEffect = react.useEffect;
let capturedEffects: EffectCallback[] | null = null;

// Desktop stores omit SSR snapshots; use their real client snapshots for this smoke test.
mock.module('react', () => ({
  ...react,
  useEffect(effect: EffectCallback, deps?: DependencyList) {
    capturedEffects?.push(effect);
    runEffect(effect, deps);
  },
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
const playerMpv = await import('../src/lib/player-mpv');
const { createPlaybackClock } = await import('../src/lib/player-clock');
const { PlayerSessionProvider, usePlayerSession } = await import('../src/lib/player-session');
const { useOptimisticSeek } = await import('../src/hooks/use-optimistic-seek');
const { usePlayerResumeController } = await import('../src/hooks/use-player-resume-controller');
const { usePlayerTrackController } = await import('../src/hooks/use-player-track-controller');
const { useMpvSetScheduler } = await import('../src/hooks/use-mpv-set-scheduler');

test('Volume and unmute share one native batch with no delayed unmute after a newer mute', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const frames: FrameRequestCallback[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return 1;
      },
      cancelAnimationFrame: () => {},
    },
  });
  const pending = Promise.withResolvers<[]>();
  const batch = spyOn(playerMpv, 'setMpvProperties')
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue([]);
  const single = spyOn(playerMpv, 'setMpvProperty').mockResolvedValue([]);
  const controller = Promise.withResolvers<ReturnType<typeof useMpvSetScheduler>>();
  const writes: Promise<unknown>[] = [];
  function AudioFixture() {
    controller.resolve(useMpvSetScheduler());
    return null;
  }
  try {
    renderToStaticMarkup(<AudioFixture />);
    const schedule = await controller.promise;
    writes.push(schedule('volume', 20), schedule('mute', false));
    frames.shift()?.(0);
    expect(batch).toHaveBeenCalledWith([
      ['volume', 20],
      ['mute', false],
    ]);
    writes.push(schedule('mute', true));
    expect(batch).toHaveBeenLastCalledWith([['mute', true]]);
    pending.resolve([]);
    await Promise.all(writes);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(single).not.toHaveBeenCalled();
  } finally {
    pending.resolve([]);
    await Promise.allSettled(writes);
    batch.mockRestore();
    single.mockRestore();
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('Manual subtitles Off blocks a late automatic addon subtitle selection', async () => {
  const client = new QueryClient();
  const embedded = { id: 1, type: 'sub' as const, displayLabel: 'English' };
  const subtitle = {
    id: 'external',
    selectionKey: 'external',
    url: 'https://example.com/sub.srt',
    lang: 'en',
    label: 'English',
    mpvTitle: 'English',
    sourceId: 'addon',
    sourceName: 'Addon',
  };
  const tracks = spyOn(playerMpv, 'readPlayerTrackList')
    .mockResolvedValueOnce([embedded])
    .mockResolvedValue([
      embedded,
      { ...embedded, id: 2, selected: true, external: true, externalFilename: subtitle.url },
    ]);
  const count = spyOn(playerMpv, 'readPlayerTrackCount')
    .mockResolvedValueOnce(1)
    .mockResolvedValue(2);
  const add = spyOn(playerMpv, 'addSubtitleTrack').mockResolvedValue();
  const write = spyOn(playerMpv, 'setMpvProperty').mockResolvedValue([]);
  const save = spyOn(api, 'saveSelectedPlaybackLanguagePreference').mockResolvedValue({
    preferences: { preferredSubtitleLanguage: 'off' },
  });
  const controller = Promise.withResolvers<ReturnType<typeof usePlayerTrackController>>();
  function TrackFixture() {
    controller.resolve(
      usePlayerTrackController({
        mediaId: 'local',
        mediaType: 'movie',
        activeStreamUrl: 'https://example.com/video',
        hasPlaybackStarted: true,
        isLoading: false,
        isResolving: false,
        resetKey: 'manual-off',
      }),
    );
    return null;
  }
  try {
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TrackFixture />
      </QueryClientProvider>,
    );
    const player = await controller.promise;
    await player.refreshTracks();
    expect(await player.setTrack('sub', 'no', { persistPreference: true })).toBe(true);
    expect(await player.selectAddonSubtitle(subtitle, { automatic: true })).toBe(false);
    expect(add).not.toHaveBeenCalled();
    expect(await player.selectAddonSubtitle(subtitle)).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
  } finally {
    await flushPendingAppWrites();
    for (const spy of [tracks, count, add, write, save]) spy.mockRestore();
    client.clear();
  }
});

test('Startup seeks leave pending resume and the playback clock untouched until mpv is ready', async () => {
  const nativeSeek = spyOn(playerMpv, 'seekAbsoluteSeconds').mockResolvedValue();
  const nativeCommand = spyOn(playerMpv, 'mpvCommand').mockResolvedValue();
  const onUserSeek = mock(() => {});
  const clock = createPlaybackClock();
  clock.publish(900);
  const durationRef = { current: 0 };
  const mpvInitializedRef = { current: false };
  const controller = Promise.withResolvers<ReturnType<typeof useOptimisticSeek>>();
  function SeekFixture() {
    controller.resolve(
      useOptimisticSeek({
        clock,
        durationRef,
        mpvInitializedRef,
        onUserSeek,
        triggerOsd: () => {},
      }),
    );
    return null;
  }
  try {
    renderToStaticMarkup(<SeekFixture />);
    const seeking = await controller.promise;
    const ignoredSeeks = (
      [
        [false, 3600],
        [true, 0],
        [false, 0],
      ] as const
    ).flatMap(([initialized, duration]) => {
      mpvInitializedRef.current = initialized;
      durationRef.current = duration;
      return [seeking.seek(910), seeking.seekRelative(10)];
    });
    await Promise.all(ignoredSeeks);
    expect(onUserSeek).not.toHaveBeenCalled();
    expect(nativeSeek).not.toHaveBeenCalled();
    expect(nativeCommand).not.toHaveBeenCalled();
    expect(clock.getSnapshot()).toBe(900);
    expect(seeking.isSeekPending()).toBe(false);
    mpvInitializedRef.current = true;
    durationRef.current = 3600;
    await seeking.seekRelative(10);
    await seeking.seek(950);
    expect(nativeCommand).toHaveBeenCalledWith('seek', ['10', 'relative']);
    expect(nativeSeek).toHaveBeenCalledWith(950);
    expect(onUserSeek).toHaveBeenCalledTimes(2);
    expect(clock.getSnapshot()).toBe(950);
  } finally {
    for (const spy of [nativeSeek, nativeCommand]) spy.mockRestore();
  }
});

test.each([false, true])(
  'Accepted resume seeks wait for settlement before retrying (tray paused=%s)',
  async (trayPaused) => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
    const nativeSeek = spyOn(playerMpv, 'seekAbsoluteSeconds').mockResolvedValue();
    const pauseWrite = spyOn(playerMpv, 'setMpvProperty').mockResolvedValue([]);
    const now = spyOn(performance, 'now').mockReturnValue(0);
    const currentTimeRef = { current: 0 };
    const durationRef = { current: 0 };
    const effects: EffectCallback[] = [];
    const cleanups: ReturnType<EffectCallback>[] = [];
    const controller = Promise.withResolvers<ReturnType<typeof usePlayerResumeController>>();
    function ResumeFixture() {
      usePlayerSession().trayPause.publish(trayPaused);
      controller.resolve(
        usePlayerResumeController({
          mediaId: 'resume-startup-test',
          mediaType: 'movie',
          activeStreamUrl: 'https://example.com/video',
          activeStreamLoadKey: 'resume-startup-test',
          startTime: 900,
          isHistoryResume: true,
          suspended: false,
          mountedRef: { current: true },
          isDestroyedRef: { current: false },
          currentTimeRef,
          durationRef,
          failoverResumePositionRef: { current: 0 },
          onResumeMessage: () => {},
        }),
      );
      return null;
    }
    try {
      capturedEffects = effects;
      renderToStaticMarkup(
        <MemoryRouter>
          <PlayerSessionProvider>
            <ResumeFixture />
          </PlayerSessionProvider>
        </MemoryRouter>,
      );
      capturedEffects = null;
      const resume = await controller.promise;
      for (const effect of effects) cleanups.push(effect());
      expect(resume.prepareForStreamLoad()).toBe(true);
      durationRef.current = 3600;
      await resume.applyResumeIfReady();
      await Promise.all(
        [220, 360, 1499].map((time) => {
          now.mockReturnValue(time);
          return resume.applyResumeIfReady();
        }),
      );
      expect(nativeSeek).toHaveBeenCalledTimes(1);
      expect(nativeSeek).toHaveBeenCalledWith(900);
      expect(pauseWrite).not.toHaveBeenCalled();
      expect(resume.isResumePending()).toBe(true);
      now.mockReturnValue(1500);
      await resume.applyResumeIfReady();
      expect(nativeSeek).toHaveBeenCalledTimes(2);
      expect(pauseWrite).not.toHaveBeenCalled();
      currentTimeRef.current = 899;
      await resume.applyResumeIfReady();
      expect(resume.isResumePending()).toBe(false);
      expect(pauseWrite).toHaveBeenCalledTimes(trayPaused ? 0 : 1);
      if (!trayPaused) expect(pauseWrite).toHaveBeenCalledWith('pause', false);
    } finally {
      capturedEffects = null;
      for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
      for (const spy of [nativeSeek, pauseWrite, now]) spy.mockRestore();
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  },
);

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
  { available: true, selectorFailed: true, hasEnabledAddons: true },
  { available: false, selectorFailed: true, hasEnabledAddons: true },
  { available: false, selectorFailed: false, hasEnabledAddons: false },
  { available: false, selectorFailed: false, hasEnabledAddons: true },
])(
  'Stream selector preserves its available/error/no-addons state (%j)',
  async ({ available, selectorFailed, hasEnabledAddons }) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
    });
    const target = { type: 'movie' as const, id: 'selector-test' };
    const failure = new Error('Stream source unavailable');
    try {
      await client.prefetchQuery({
        ...api.addonConfigsQueryOptions(),
        queryFn: () => {
          throw new Error('Addon configuration unavailable');
        },
      });
      const data: StreamSelectorData = {
        hasEnabledAddons,
        fatalErrorMessage: selectorFailed ? failure.message : undefined,
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
      expect(markup).not.toContain('Addon configuration unavailable');
      expect(markup.includes(failure.message)).toBe(!available && selectorFailed);
      expect(markup.includes('Retry</button>')).toBe(!available && selectorFailed);
      expect(markup.includes('No enabled stream sources.')).toBe(
        !available && !selectorFailed && !hasEnabledAddons,
      );
      expect(markup.includes('No stream-capable addons enabled.')).toBe(
        !available && !selectorFailed && hasEnabledAddons,
      );
      expect(markup.includes('Manage addons')).toBe(!available && !selectorFailed);
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
