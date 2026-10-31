import { expect, mock, spyOn, test } from 'bun:test';
import type {
  ComponentProps,
  ComponentType,
  DependencyList,
  EffectCallback,
  KeyboardEvent,
} from 'react';
import type {
  CalendarSchedule,
  DetailsPrefetchBundle,
  EpisodesWatchedResult,
  MediaDetails,
  StreamSelectorData,
  TitleCredits,
} from '../src/lib/api';
import type { QueryObserverOptions } from '@tanstack/react-query';

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
let renderDialogPortal = false;
// Expose dialog content during page renders; retain the real Radix dialog.
mock.module('@radix-ui/react-dialog', () => ({
  ...radixDialog,
  Portal: ({ children, ...props }: ComponentProps<typeof DialogPortal>) =>
    renderDialogPortal ? children : <DialogPortal {...props}>{children}</DialogPortal>,
}));

const { QueryClient, QueryClientProvider, QueryObserver, onlineManager } =
  await import('@tanstack/react-query');
const { renderToStaticMarkup } = await import('react-dom/server');
const router = await import('react-router');
const { MemoryRouter, Route, Routes } = router;
const { Search } = await import('../src/pages/search');
const { Details } = await import('../src/pages/details');
const { Calendar } = await import('../src/pages/calendar');
const { Home, homeTrendingMoviesQueryOptions } = await import('../src/pages/home');
const { api, DEFAULT_APP_UI_PREFERENCES } = await import('../src/lib/api');
const { queryClient } = await import('../src/lib/query-client');
const {
  APP_UI_PREFERENCES_QUERY_KEY,
  DETAILS_QUERY_KEY,
  RECENT_WATCH_SEED_QUERY_KEY,
  detailsCardQueryKey,
  invalidateDiscoveryQueries,
  profileLibraryQueryKey,
  streamSelectorQueryKey,
  titleWatchProgressQueryKey,
} = await import('../src/lib/query-invalidation');
const { pendingDetailsPrefetch, prefetchDetailsRouteData } =
  await import('../src/lib/details-prefetch');
const { playerStreamRankingOptions } = await import('../src/lib/resolve-player-stream');
const { buildStreamRankingCacheKey } = await import('../src/lib/stream-ranking-cache-key');

const { StreamSelector } = await import('../src/components/stream-selector');
const { AddTitlesDialog } = await import('../src/components/list/add-titles-dialog');
const { DetailsSections, DetailsSectionTabs, NextAiringChip } =
  await import('../src/components/details-sections');
const { useNearViewport } = await import('../src/hooks/use-near-viewport');
const { useRecentSearches } = await import('../src/hooks/use-app-ui-preferences');
const { useMarkSeasonWatched } = await import('../src/hooks/use-media-library');
const { flushPendingAppWrites } = await import('../src/lib/pending-app-writes');
const playerMpv = await import('../src/lib/player-mpv');
const tauriCore = await import('@tauri-apps/api/core');
const { createPlaybackClock } = await import('../src/lib/player-clock');
const { PlayerSessionProvider, usePlayerSession } = await import('../src/lib/player-session');
const { useOptimisticSeek } = await import('../src/hooks/use-optimistic-seek');
const { usePlayerResumeController } = await import('../src/hooks/use-player-resume-controller');
const { usePlayerTrackController } = await import('../src/hooks/use-player-track-controller');
const { useMpvSetScheduler } = await import('../src/hooks/use-mpv-set-scheduler');
const { useTitleSearch } = await import('../src/hooks/use-item-search');
const { useSearchPageState } = await import('../src/hooks/use-search-page-state');
const { usePlayerAddonSubtitles } = await import('../src/hooks/use-player-addon-subtitles');
const { useHistoryPlayback } = await import('../src/hooks/use-history-playback');
const { claimPlaybackLaunch } = await import('../src/lib/player-navigation');
const { toast } = await import('sonner');

test.each([
  ['genre', 'dune', false, 'dune'],
  ['feed', 'dune', false, 'dune'],
  ['clear', 'dune', false, 'dune'],
  ['reset', 'dune', false, 'dune'],
  ['type', 'dune', false, 'dune'],
  ['genre', 'dune', true, 'du'],
  ['genre', 'stremiro://details/movie/tt1', false, 'du'],
] as const)(
  'Filter %s commits only eligible drafts (%s, composing=%j)',
  async (action, draft, composing, expectedQuery) => {
    const params = new URLSearchParams('q=du&type=movie&genre=Action&feed=featured');
    const commit = mock((_next?: unknown) => {});
    const readParams = spyOn(router, 'useSearchParams').mockReturnValue([params, commit]);
    const controller = Promise.withResolvers<ReturnType<typeof useSearchPageState>>();
    function FilterFixture() {
      const current = useSearchPageState();
      if (current.query !== draft) current.setQuery(draft);
      else if (current.isComposing !== composing) current.setIsComposing(composing);
      else controller.resolve(current);
      return null;
    }
    try {
      renderToStaticMarkup(
        <MemoryRouter>
          <FilterFixture />
        </MemoryRouter>,
      );
      const state = await controller.promise;
      switch (action) {
        case 'genre':
          state.handleGenreChange('Crime');
          break;
        case 'feed':
          state.handleFeedChange('new');
          break;
        case 'clear':
          state.clearGenre();
          break;
        case 'reset':
          state.resetFilters();
          break;
        case 'type':
          state.handleTypeChange('series');
          break;
      }
      expect(commit).toHaveBeenCalledTimes(1);
      const next = commit.mock.calls[0]?.[0] as URLSearchParams;
      expect(next.get('q')).toBe(expectedQuery);
      if (action === 'genre') expect(next.get('genre')).toBe('Crime');
      if (action === 'feed') expect(next.get('feed')).toBe('new');
      if (action === 'clear' || action === 'reset') expect(next.has('genre')).toBe(false);
      if (action === 'reset') expect(next.has('type') || next.has('feed')).toBe(false);
      if (action === 'type') expect(next.get('type')).toBe('series');
    } finally {
      readParams.mockRestore();
    }
  },
);

test('Reopening addon subtitles rechecks Rust before automatic selection', async () => {
  const client = new QueryClient();
  const key = ['addonSubtitles', 'movie', 'tt1', null, null] as const;
  const cached = [
    {
      id: 'en',
      selectionKey: 'en',
      url: 'https://subs.test/old.srt',
      mpvTitle: 'English',
      sourceId: 'subs',
      sourceName: 'Subs',
    },
  ];
  client.setQueryData(key, cached);
  const fetch = spyOn(api, 'getAddonSubtitles').mockResolvedValue([]);
  const matchLanguage = spyOn(api, 'resolvePreferredTrackSelection').mockResolvedValue({});
  let menuOpen = false;
  function Subtitles() {
    usePlayerAddonSubtitles({
      activeStreamLoadKey: 'stream',
      announce: () => {},
      autoLoadLanguage: 'eng',
      effectiveResolveMediaType: 'movie',
      id: key[2],
      menuOpen,
      mountedRef: { current: true },
      selectAddonSubtitle: async () => false,
      setTrack: async () => false,
      subTracks: [],
    });
    return null;
  }
  let unsubscribe: (() => void) | undefined;
  const cleanups: (() => void)[] = [];
  const view = (
    <QueryClientProvider client={client}>
      <Subtitles />
    </QueryClientProvider>
  );
  try {
    capturedEffects = [];
    renderToStaticMarkup(view);
    const effects = capturedEffects;
    capturedEffects = null;
    for (const effect of effects) {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    }
    expect(matchLanguage).not.toHaveBeenCalled();
    const query = client.getQueryCache().find({ queryKey: key })!;
    const observer = new QueryObserver(client, query.options);
    unsubscribe = observer.subscribe(() => {});
    await query.promise;
    expect(fetch).toHaveBeenCalledTimes(1);
    menuOpen = true;
    capturedEffects = [];
    renderToStaticMarkup(view);
    const openEffects = capturedEffects;
    capturedEffects = null;
    for (const effect of openEffects) {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    }
    await query.promise;
    expect(fetch).toHaveBeenCalledTimes(2);
    menuOpen = false;

    client.setDefaultOptions({ queries: { refetchOnMount: false } });
    client.setQueryData(key, cached);
    capturedEffects = [];
    renderToStaticMarkup(view);
    const readyEffects = capturedEffects;
    capturedEffects = null;
    for (const effect of readyEffects) {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    }
    expect(matchLanguage).toHaveBeenCalledTimes(1);
  } finally {
    capturedEffects = null;
    cleanups.forEach((cleanup) => cleanup());
    unsubscribe?.();
    client.clear();
    fetch.mockRestore();
    matchLanguage.mockRestore();
  }
});

test('Subtitle results stay available while mounted but leave the cache after playback', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 30 * 60_000 } } });
  const fetch = spyOn(api, 'getAddonSubtitles').mockResolvedValue([]);
  let episode = 1;
  const releases: (() => void)[] = [];
  function Fixture() {
    usePlayerAddonSubtitles({
      activeStreamLoadKey: `episode-${episode}`,
      announce: () => {},
      autoLoadLanguage: null,
      effectiveResolveMediaType: 'series',
      id: 'tt1',
      menuOpen: false,
      mountedRef: { current: true },
      resolvedStreamSeason: 1,
      resolvedStreamEpisode: episode,
      selectAddonSubtitle: async () => false,
      setTrack: async () => false,
      subTracks: [],
    });
    return null;
  }
  try {
    for (; episode <= 24; episode++) {
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <Fixture />
        </QueryClientProvider>,
      );
      const key = ['addonSubtitles', 'series', 'tt1', 1, episode];
      const query = client.getQueryCache().find({ queryKey: key })!;
      const observer = new QueryObserver(client, query.options);
      releases.push(observer.subscribe(() => {}));
      client.setQueryData(
        key,
        Array.from({ length: 50 }, (_, id) => ({ id: `${id}` })),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.getQueryCache().getAll()).toHaveLength(24);
    expect(fetch).not.toHaveBeenCalled();
    releases.splice(0).forEach((release) => release());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  } finally {
    releases.forEach((release) => release());
    client.clear();
    fetch.mockRestore();
  }
});

test.each([
  { automatic: false, cancelled: false },
  { automatic: true, cancelled: false },
  { automatic: false, cancelled: true },
])(
  'Subtitle download failures explain only the current manual selection (%j)',
  async ({ automatic, cancelled }) => {
    const client = new QueryClient();
    const native = Promise.withResolvers<boolean>();
    const controller = Promise.withResolvers<ReturnType<typeof usePlayerAddonSubtitles>>();
    const notice = spyOn(toast, 'error').mockImplementation(() => 'notice');
    const cleanups: (() => void)[] = [];
    function Fixture() {
      controller.resolve(
        usePlayerAddonSubtitles({
          activeStreamLoadKey: 'stream',
          announce: () => {},
          autoLoadLanguage: null,
          effectiveResolveMediaType: 'movie',
          id: 'tt1',
          menuOpen: false,
          mountedRef: { current: true },
          selectAddonSubtitle: () => native.promise,
          setTrack: async () => false,
          subTracks: [],
        }),
      );
      return null;
    }
    try {
      capturedEffects = [];
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <Fixture />
        </QueryClientProvider>,
      );
      const effects = capturedEffects;
      capturedEffects = null;
      for (const effect of effects) {
        const cleanup = effect();
        if (cleanup) cleanups.push(cleanup);
      }
      const hook = await controller.promise;
      const pending = hook.handleAddonSubtitleSelect(
        {
          id: 'sub',
          selectionKey: 'sub',
          url: 'https://example.com/sub',
          mpvTitle: 'English',
          sourceId: 'addon',
          sourceName: 'Addon',
        },
        { automatic },
      );
      if (cancelled) cleanups.splice(0).forEach((cleanup) => cleanup());
      native.reject(new Error('Subtitle exceeds the 8 MiB limit.'));
      await pending;
      expect(notice).toHaveBeenCalledTimes(automatic || cancelled ? 0 : 1);
      if (!automatic && !cancelled)
        expect(notice).toHaveBeenCalledWith('Failed to load addon subtitle', {
          description: 'Subtitle exceeds the 8 MiB limit.',
        });
    } finally {
      capturedEffects = null;
      cleanups.forEach((cleanup) => cleanup());
      notice.mockRestore();
      client.clear();
    }
  },
);

test.each([
  { cancelled: false, failed: false },
  { cancelled: false, failed: true },
  { cancelled: true, failed: false },
  { cancelled: true, failed: true },
])('Play next reports only the current lookup result (%j)', async ({ cancelled, failed }) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { pathname: '/profile', search: '' } },
  });
  const client = new QueryClient();
  const lookup = Promise.withResolvers<Awaited<ReturnType<typeof api.getNextEpisodeRow>>>();
  const next = spyOn(api, 'getNextEpisodeRow').mockImplementation(() => lookup.promise);
  const info = spyOn(toast, 'info').mockImplementation(() => 'notice');
  const error = spyOn(toast, 'error').mockImplementation(() => 'error');
  const controller = Promise.withResolvers<ReturnType<typeof useHistoryPlayback>>();
  function History() {
    controller.resolve(
      useHistoryPlayback(
        {
          id: 'tt1',
          type_: 'series',
          season: 1,
          episode: 1,
          position: 100,
          duration: 1000,
          last_watched: 1,
          title: 'Series',
        },
        'Failed to resume',
      ),
    );
    return null;
  }
  try {
    renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <PlayerSessionProvider>
            <History />
          </PlayerSessionProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const playback = await controller.promise;
    const pending = playback.playNext();
    expect(next).toHaveBeenCalledTimes(1);
    if (cancelled) claimPlaybackLaunch();
    if (failed) lookup.reject(new Error('Lookup failed'));
    else lookup.resolve(null);
    await pending;
    expect(info).toHaveBeenCalledTimes(!cancelled && !failed ? 1 : 0);
    expect(error).toHaveBeenCalledTimes(!cancelled && failed ? 1 : 0);
  } finally {
    lookup.resolve(null);
    for (const spy of [next, info, error]) spy.mockRestore();
    client.clear();
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test.each([
  { query: '', enabled: true, expectedQueries: 1 },
  { query: 'Title', enabled: false, expectedQueries: 1 },
  { query: 'Title', enabled: true, expectedQueries: 30 },
])(
  'Collection search retains distinct snapshots only while searching (%j)',
  ({ query, enabled, expectedQueries }) => {
    const client = new QueryClient();
    function Collection({ revision }: { revision: number }) {
      const items = [{ title: `Title ${revision}` }];
      const { filteredItems } = useTitleSearch(items, query, enabled);
      expect(filteredItems).toBe(items);
      return null;
    }
    try {
      for (let revision = 0; revision < 30; revision++) {
        renderToStaticMarkup(
          <QueryClientProvider client={client}>
            <Collection revision={revision} />
          </QueryClientProvider>,
        );
      }
      expect(client.getQueryCache().findAll({ queryKey: ['title-search'] })).toHaveLength(
        expectedQueries,
      );
    } finally {
      client.clear();
    }
  },
);

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

test('Track changes send a native intent and return its confirmed snapshot', async () => {
  const snapshot = [{ id: 2, type: 'audio' as const, displayLabel: 'English', selected: true }];
  const invoke = spyOn(tauriCore, 'invoke').mockResolvedValue(snapshot);
  try {
    const changes = [
      ['audio', 2],
      ['sub', 'no'],
      ['sub', 'cycle'],
    ] as const;
    await Promise.all(
      changes.map(async ([kind, target]) => {
        expect(await playerMpv.changePlayerTrack(kind, target)).toBe(snapshot);
        expect(invoke).toHaveBeenCalledWith('player_mpv_change_track', { kind, target });
      }),
    );
    invoke.mockRejectedValueOnce(new Error('Track unavailable'));
    await expect(playerMpv.changePlayerTrack('audio', 3)).rejects.toThrow('Track unavailable');
  } finally {
    invoke.mockRestore();
  }
});

test('Manual subtitles Off wins, and stale refreshes cannot erase a confirmed addon track', async () => {
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
  const tracks = spyOn(playerMpv, 'readPlayerTrackList').mockResolvedValue([embedded]);
  const confirmed = [
    embedded,
    { ...embedded, id: 2, external: true, externalFilename: subtitle.url },
    { ...embedded, id: 3, selected: true, external: true, externalFilename: subtitle.url },
  ];
  const add = spyOn(playerMpv, 'addSubtitleTrack').mockResolvedValue(confirmed);
  const staleTracks =
    Promise.withResolvers<Awaited<ReturnType<typeof playerMpv.readPlayerTrackList>>>();
  const write = spyOn(playerMpv, 'setMpvProperty').mockResolvedValue([]);
  const change = spyOn(playerMpv, 'changePlayerTrack').mockResolvedValue([embedded]);
  const notice = spyOn(toast, 'error').mockReturnValue('track-error');
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
    expect(change).toHaveBeenCalledWith('sub', 'no');
    expect(await player.selectAddonSubtitle(subtitle, { automatic: true })).toBe(false);
    expect(add).not.toHaveBeenCalled();
    tracks.mockImplementationOnce(() => staleTracks.promise);
    const refresh = player.refreshTracks();
    expect(await player.selectAddonSubtitle(subtitle)).toBe(true);
    await flushPendingAppWrites();
    expect(save.mock.calls.at(-1)?.[1]?.id).toBe(3);
    staleTracks.resolve([embedded]);
    await refresh;
    const repeatedSnapshot =
      Promise.withResolvers<Awaited<ReturnType<typeof playerMpv.readPlayerTrackList>>>();
    tracks.mockImplementationOnce(() => repeatedSnapshot.promise);
    const repeatedRefresh = player.refreshTracks();
    change.mockResolvedValue(confirmed);
    expect(await player.setTrack('sub', 3)).toBe(true);
    repeatedSnapshot.resolve([embedded]);
    expect(await repeatedRefresh).toEqual(confirmed);
    player.notifyObservedTrackSelection('audio', null);
    player.notifyObservedTrackSelection('sub', 1);
    const observedSnapshot =
      Promise.withResolvers<Awaited<ReturnType<typeof playerMpv.readPlayerTrackList>>>();
    tracks.mockImplementationOnce(() => observedSnapshot.promise);
    const observedRefresh = player.refreshTracks();
    expect(tracks).toHaveBeenLastCalledWith({ audio: null, sub: 1 });
    player.notifyObservedTrackSelection('sub', 3);
    observedSnapshot.resolve([{ ...embedded, selected: true }]);
    expect(await observedRefresh).toEqual(confirmed);
    tracks.mockResolvedValueOnce(confirmed);
    expect(await player.refreshTracks()).toEqual(confirmed);
    expect(tracks).toHaveBeenLastCalledWith({ audio: null, sub: 3 });
    expect(await player.selectAddonSubtitle(subtitle)).toBe(true);
    expect(change).toHaveBeenLastCalledWith('sub', 3);
    expect(add).toHaveBeenCalledTimes(1);
    expect(await player.cycleTrack('sub')).toBe(3);
    expect(change).toHaveBeenLastCalledWith('sub', 'cycle');
    change.mockRejectedValueOnce(new Error('Track unavailable'));
    expect(await player.setTrack('sub', 2)).toBe(false);
    expect(notice).toHaveBeenLastCalledWith('Failed to switch track');
    expect(await player.selectAddonSubtitle(subtitle)).toBe(true);
    expect(change).toHaveBeenLastCalledWith('sub', 3);
  } finally {
    await flushPendingAppWrites();
    for (const spy of [tracks, add, write, change, save, notice]) spy.mockRestore();
    client.clear();
  }
});

test.each([
  [100, true, false],
  [1000, false, false],
  [1000, true, true],
] as const)(
  'Seek failure verdict includes IPC wait time (%s ms)',
  async (elapsed, failed, latched) => {
    const invoke = spyOn(tauriCore, 'invoke').mockResolvedValue({
      timePos: 120,
      bufferedAhead: 0,
      nearCompletion: true,
      nextEpisodePrefetchDue: true,
      seekFailureWindowSecs: 0.25,
    });
    const now = spyOn(performance, 'now').mockReturnValue(0);
    try {
      const pending = playerMpv.readPlaybackPositionProbe(120, {
        seconds: 117,
        startedAt: 0,
        failed: latched,
      });
      now.mockReturnValue(elapsed);
      const probe = await pending;
      expect(probe.seekFailed).toBe(failed);
      expect(probe.nearCompletion).toBe(!failed);
      expect(probe.nextEpisodePrefetchDue).toBe(!failed);
    } finally {
      invoke.mockRestore();
      now.mockRestore();
    }
  },
);

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
    expect(seeking.getSeekTarget()).toBeNull();
    mpvInitializedRef.current = true;
    durationRef.current = 3600;
    await seeking.seekRelative(10);
    await seeking.seek(950);
    expect(nativeCommand).toHaveBeenCalledWith('seek', ['10', 'relative']);
    expect(nativeSeek).toHaveBeenCalledWith(950);
    expect(onUserSeek).toHaveBeenCalledTimes(2);
    expect(clock.getSnapshot()).toBe(950);
    expect(seeking.observeTimeUpdate(950, performance.now())).toBe(false);
    expect(seeking.isSeekPending()).toBe(false);
    expect(seeking.getSeekTarget()?.seconds).toBe(950);
    seeking.confirmSeek();
    expect(seeking.getSeekTarget()).toBeNull();
  } finally {
    for (const spy of [nativeSeek, nativeCommand]) spy.mockRestore();
  }
});

test.each([null, 'watched'] as const)(
  'Season completion refreshes library relations and Undo restores status %s',
  async (previousStatus) => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const item: MediaDetails = {
      id: 'season-library',
      title: 'One season',
      type: 'series',
      isAnime: false,
      episodes: [{ id: 'e1', season: 1, episode: 1 }],
    };
    const progress = { episodeProgress: {}, watchedEpisodeCeiling: {} };
    const mark = spyOn(api, 'setEpisodesWatched').mockResolvedValue([
      progress,
      [],
      { previousStatus, status: 'watched' },
    ] satisfies EpisodesWatchedResult);
    const restored = Promise.withResolvers<void>();
    const restoreStatus = spyOn(api, 'setWatchStatus').mockImplementation(async () => {
      restored.resolve();
      return null;
    });
    const notice = spyOn(toast, 'success').mockReturnValue('season-notice');
    const controller = Promise.withResolvers<ReturnType<typeof useMarkSeasonWatched>>();
    function Fixture() {
      controller.resolve(useMarkSeasonWatched({ item }));
      return null;
    }
    const keys = [
      ['library'],
      ['watch-statuses'],
      ['profile-library'],
      ['lists'],
      ['list-summaries'],
    ];
    try {
      for (const key of keys) client.setQueryData(key, []);
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <Fixture />
        </QueryClientProvider>,
      );
      await (await controller.promise).mutateAsync({ episodes: item.episodes!, watched: true });
      expect(mark).toHaveBeenCalledWith(item, item.episodes, true);
      for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
      const action = notice.mock.calls[0]?.[1]?.action;
      if (!action || typeof action !== 'object' || !('onClick' in action))
        throw new Error('Missing season Undo');
      action.onClick({});
      await restored.promise;
      expect(mark).toHaveBeenLastCalledWith(item, item.episodes, false);
      expect(restoreStatus).toHaveBeenCalledWith(item, previousStatus);
    } finally {
      mark.mockRestore();
      restoreStatus.mockRestore();
      notice.mockRestore();
      client.clear();
    }
  },
);

test.each([false, true])(
  'Accepted resume seeks wait for settlement before retrying (tray paused=%s)',
  async (trayPaused) => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
    const nativeSeek = spyOn(playerMpv, 'seekAbsoluteSeconds').mockResolvedValue();
    const pauseWrite = spyOn(playerMpv, 'setMpvProperty').mockResolvedValue([]);
    const now = spyOn(performance, 'now').mockReturnValue(0);
    const invoke = spyOn(tauriCore, 'invoke').mockResolvedValue({
      timePos: 3600,
      bufferedAhead: 0,
      nearCompletion: true,
      nextEpisodePrefetchDue: true,
      seekFailureWindowSecs: (3600 - 900 - 2) / 4,
      prematureEof: false,
    });
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
      expect(resume.getResumeSeekTarget()).toEqual({ seconds: 900, startedAt: 0 });
      const failed = await playerMpv.readPlaybackPositionProbe(3600, resume.getResumeSeekTarget());
      expect(failed.seekFailed).toBe(true);
      expect(failed.nearCompletion).toBe(false);
      expect(failed.nextEpisodePrefetchDue).toBe(false);
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
      resume.confirmResumeSeek();
      expect(resume.getResumeSeekTarget()).toBeNull();
      expect(pauseWrite).toHaveBeenCalledTimes(trayPaused ? 0 : 1);
      if (!trayPaused) expect(pauseWrite).toHaveBeenCalledWith('pause', false);
    } finally {
      capturedEffects = null;
      for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
      for (const spy of [nativeSeek, pauseWrite, now, invoke]) spy.mockRestore();
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
  renderDialogPortal = true;
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <Page />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  } finally {
    renderDialogPortal = false;
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

test('Calendar keeps upcoming placeholders only for the same watched filter', () => {
  const client = new QueryClient();
  try {
    client.setQueryData(APP_UI_PREFERENCES_QUERY_KEY, {
      ...DEFAULT_APP_UI_PREFERENCES,
      calendarHideWatched: true,
    });
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Calendar />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const query = client
      .getQueryCache()
      .find<CalendarSchedule>({ queryKey: ['calendar-events'], exact: false });
    if (!query) throw new Error('Calendar query missing');
    const { placeholderData } = query.options as QueryObserverOptions<CalendarSchedule>;
    const options = { queryKey: query.queryKey, placeholderData };
    const previous: CalendarSchedule = { trackedCount: 1, missingCount: 0, days: [], upcoming: [] };
    const observer = new QueryObserver(client, {
      ...options,
      enabled: false,
      initialData: previous,
      queryKey: [...query.queryKey.slice(0, 4), false],
    });
    observer.setOptions({ ...options, enabled: false });
    expect(observer.getCurrentResult().data).toBeUndefined();
    client.setQueryData(query.queryKey, previous);
    observer.setOptions({ ...options, enabled: false });
    observer.setOptions({
      ...options,
      enabled: false,
      queryKey: [query.queryKey[0], 'another month', ...query.queryKey.slice(2)],
    });
    expect(observer.getCurrentResult().data).toEqual(previous);
    observer.destroy();
  } finally {
    client.clear();
  }
});

test.each([false, true])(
  'Add Titles keeps cached rows available after a refresh failure (cached=%s)',
  async (cached) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
    });
    const queryKey = profileLibraryQueryKey({ query: '', sort: 'title-asc' });
    if (cached) {
      client.setQueryData(queryKey, {
        items: [{ id: 'saved-title', title: 'Saved title', type: 'movie' }],
        allIds: ['saved-title'],
      });
    }
    await client.prefetchQuery({
      queryKey,
      queryFn: () => {
        throw new Error('Library unavailable');
      },
    });
    const markup = renderPage(
      () => (
        <AddTitlesDialog
          list={{ id: 'test-list', name: 'Test list', icon: 'list', item_ids: [] }}
          onOpenChange={() => {}}
          returnFocusRef={{ current: null }}
        />
      ),
      '/profile?tab=lists',
      client,
    );
    expect(markup).toContain('load your library.');
    expect(markup.includes('aria-label="Library titles"')).toBe(cached);
    expect(markup.includes('aria-label="Saved title"')).toBe(cached);
    expect(markup).not.toContain('Your library is empty');
  },
);

test.each([false, true])(
  'Details hero renders writer, country and awards facts only when metadata provides them (populated=%s)',
  (populated) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
    });
    const id = 'details-credits-test';
    const details: MediaDetails = {
      id,
      type: 'movie',
      title: 'Metadata film',
      isAnime: true,
      displayYear: '1999',
      runtime: '2h 16m',
      cast: ['Actor One', 'Actor Two', 'Actor Three', 'Actor Four', 'Actor Five'],
      directors: ['Lana Wachowski', 'Lilly Wachowski'],
      ...(populated
        ? {
            writers: ['Writer One', 'Writer Two'],
            country: 'United States',
            awards: 'Won 4 Oscars. 42 wins & 52 nominations total',
          }
        : {}),
    };
    client.setQueryData(api.detailsQueryOptions('movie', id).queryKey, details);
    client.setQueryData(api.titleCreditsQueryOptions('anime', id).queryKey, {
      source: 'anilist',
      people: [],
      facts: {},
      streamingLinks: [],
      nextAiringEpisode: { episode: 7, airingAt: 4_000_000_000 },
    } satisfies TitleCredits);
    client.setQueryData(APP_UI_PREFERENCES_QUERY_KEY, DEFAULT_APP_UI_PREFERENCES);
    let markup: string;
    renderDialogPortal = true;
    try {
      markup = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[`/details/movie/${id}`]}>
            <PlayerSessionProvider>
              <Routes>
                <Route path='/details/:type/:id' element={<Details />} />
              </Routes>
            </PlayerSessionProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    } finally {
      renderDialogPortal = false;
      client.clear();
    }

    // The original rows keep their labels and the +N full-cast popover.
    expect(markup).toContain('Starring');
    expect(markup).toContain('Directors');
    expect(markup).toContain('aria-label="Full cast"');
    expect(markup).toContain('>+1</button>');
    expect(markup).toContain('href="/search?q=Lilly%20Wachowski"');
    expect(markup).not.toContain('Next: Episode');
    expect(markup).not.toContain('Title sections');
    if (populated) {
      expect(markup).toContain('Writers');
      expect(markup).toContain('href="/search?q=Writer%20One"');
      expect(markup).toContain('United States');
      expect(markup).toContain('Won 4 Oscars');
      expect(markup).toContain('>Awards: </span>');
    } else {
      expect(markup).not.toContain('Writers');
      expect(markup).not.toContain('United States');
      expect(markup).not.toContain('Writer One');
      expect(markup).not.toContain('Won 4 Oscars');
      expect(markup).not.toContain('>Awards: </span>');
    }
  },
);

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

test('Discovery changes detach stale prefetches without breaking current single-flight', async () => {
  const client = new QueryClient();
  const mediaId = 'prefetch-generation-fixture';
  const detailsKey = detailsCardQueryKey('movie', mediaId);
  const progressKey = titleWatchProgressQueryKey(mediaId);
  const bundles = [
    Promise.withResolvers<DetailsPrefetchBundle>(),
    Promise.withResolvers<DetailsPrefetchBundle>(),
  ];
  let bundleCall = 0;
  const fetchBundle = spyOn(api, 'getDetailsPrefetchBundle').mockImplementation(
    () => bundles[bundleCall++]!.promise,
  );
  const bundleFor = (title: string, ceiling: number): DetailsPrefetchBundle => ({
    details: { id: mediaId, type: 'movie', title },
    progress: {
      episodeProgress: {},
      watchedEpisodeCeiling: ceiling ? { '1': ceiling } : {},
    },
  });
  const prefetch = () =>
    prefetchDetailsRouteData(client, { mediaId, mediaType: 'movie', warmChunk: false });
  const settled: Promise<unknown>[] = [];
  try {
    prefetch();
    const firstPending = pendingDetailsPrefetch('movie', mediaId);
    expect(firstPending).toBeDefined();
    settled.push(firstPending!);
    prefetch();
    expect(fetchBundle).toHaveBeenCalledTimes(1);
    expect(pendingDetailsPrefetch('movie', mediaId)).toBe(firstPending);

    await invalidateDiscoveryQueries(client);
    expect(pendingDetailsPrefetch('movie', mediaId)).toBeUndefined();

    prefetch();
    const secondPending = pendingDetailsPrefetch('movie', mediaId);
    expect(secondPending).toBeDefined();
    settled.push(secondPending!);
    expect(secondPending).not.toBe(firstPending);
    prefetch();
    expect(fetchBundle).toHaveBeenCalledTimes(2);
    expect(pendingDetailsPrefetch('movie', mediaId)).toBe(secondPending);

    bundles[0]!.resolve(bundleFor('Old provider', 2));
    expect(await firstPending).toBeUndefined();
    expect(client.getQueryData(detailsKey)).toBeUndefined();
    expect(client.getQueryData(progressKey)).toBeUndefined();
    expect(pendingDetailsPrefetch('movie', mediaId)).toBe(secondPending);

    const fresh = bundleFor('New provider', 4);
    bundles[1]!.resolve(fresh);
    expect(await secondPending).toEqual(fresh);
    expect(client.getQueryData(detailsKey)).toEqual(fresh.details);
    expect(client.getQueryData(progressKey)).toEqual(fresh.progress);
    expect(pendingDetailsPrefetch('movie', mediaId)).toBeUndefined();
  } finally {
    for (const deferred of bundles) deferred.resolve(bundleFor('Cleanup', 0));
    await Promise.allSettled(settled);
    fetchBundle.mockRestore();
    client.clear();
  }
});

const SECTION_ITEM = {
  id: 'tt0944947',
  type: 'series',
  title: 'Game of Thrones',
  runtime: '60 min',
} as MediaDetails;

test('Credits links pass the title identity to their scoped Rust command', async () => {
  const updater = await import('../src/lib/app-updater');
  const runtime = spyOn(updater, 'isTauriDesktopRuntime').mockReturnValue(true);
  const invoke = spyOn(tauriCore, 'invoke').mockResolvedValue(undefined);
  try {
    await api.openTitleCreditsLink('anime', 'kitsu:8671', 'tt2560140', 'https://anilist.co');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'open_title_credits_link',
      {
        mediaType: 'anime',
        id: 'kitsu:8671',
        imdbId: 'tt2560140',
        url: 'https://anilist.co',
      },
      undefined,
    );
  } finally {
    invoke.mockRestore();
    runtime.mockRestore();
  }
});

const renderSections = (props: Partial<ComponentProps<typeof DetailsSections>> = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <DetailsSections
        item={SECTION_ITEM}
        credits={SECTION_CREDITS}
        value='episodes'
        onValueChange={() => {}}
        hasEpisodes
        allowExtras
        {...props}
      >
        <p data-episodes-children>Episode pane</p>
      </DetailsSections>
    </MemoryRouter>,
  );
const SECTION_CREDITS: TitleCredits = {
  source: 'tvmaze',
  people: [
    {
      name: 'Peter Dinklage',
      imageUrl: 'https://static.tvmaze.com/p.jpg',
      role: 'Cast',
      character: 'Tyrion Lannister',
    },
  ],
  facts: { network: 'HBO', status: 'Ended', runtimeMinutes: 60 },
  streamingLinks: [{ site: 'Crunchyroll', url: 'http://crunchyroll.com/ep/1' }],
};

test('Details sections render ARIA tabs, always-mounted panes, and attribution', () => {
  const episodesMarkup = renderSections();
  expect(episodesMarkup).toContain('aria-selected="true"');
  expect(episodesMarkup).not.toContain('id="details-section-panel-episodes" hidden=""');
  const aboutMarkup = renderSections({ value: 'about' });
  expect(aboutMarkup).toContain('id="details-section-panel-episodes" hidden=""');
  expect(aboutMarkup).toContain('data-episodes-children');
  expect(aboutMarkup).toContain('role="tabpanel" tabindex="0"');
  const markup = renderSections({ value: 'cast' });
  expect(markup).toContain('role="tablist"');
  expect(markup).toContain('aria-label="Title sections"');
  expect(markup).toContain('id="details-episodes-heading"');
  expect(markup).toContain('id="details-section-tab-cast"');
  expect(markup).toContain('id="details-section-tab-about"');
  expect(markup).toContain('aria-selected="true"');
  // The episodes pane stays mounted but hidden; children survive the switch.
  expect(markup).toContain('id="details-section-panel-episodes" hidden=""');
  expect(markup).toContain('data-episodes-children');
  expect(markup).toContain('id="details-section-panel-cast"');
  // Cast content: search links, initials fallback, facts, links, footer.
  expect(markup).toContain('href="/search?q=Peter%20Dinklage"');
  expect(markup).toContain('Tyrion Lannister');
  expect(markup).toContain('>PD<');
  expect(markup).toContain('HBO');
  expect(markup).toContain('http://crunchyroll.com/ep/1');
  expect(markup).toContain('https://www.tvmaze.com');
  expect(markup).toContain('https://creativecommons.org/licenses/by-sa/4.0/');
});

test('Details sections hide unavailable panes and label anime cast Characters', () => {
  const anime = {
    ...SECTION_ITEM,
    isAnime: true,
    type: 'series',
  } as MediaDetails;
  const animeCredits: TitleCredits = {
    ...SECTION_CREDITS,
    source: 'anilist',
    people: [
      {
        name: 'Eren Yeager',
        role: 'Main',
        voiceActor: 'Yuki Kaji',
      },
    ],
  };
  const markup = renderSections({ item: anime, credits: animeCredits, value: 'cast' });
  expect(markup).toContain('Characters');
  expect(markup).not.toContain('href="/search?q=Eren%20Yeager"');
  expect(markup).toContain('href="/search?q=Yuki%20Kaji"');
  expect(markup).toContain('href="https://anilist.co"');
  expect(markup).not.toContain('tvmaze.com');
  // Missing credits and no item runtime: no cast/about tabs, no attribution.
  const bareItem = { ...SECTION_ITEM, runtime: undefined } as MediaDetails;
  const sparse = renderSections({ item: bareItem, credits: undefined });
  expect(sparse).toContain('Episodes');
  expect(sparse).not.toContain('details-section-tab-cast');
  expect(sparse).not.toContain('details-section-tab-about');
  expect(sparse).not.toContain('creativecommons.org');
  // A single Episodes tab keeps the original h2 (no tablist).
  expect(sparse).not.toContain('role="tablist"');
  expect(sparse).toContain('id="details-episodes-heading"');
  // Movies never render the component.
  expect(renderSections({ item: { ...SECTION_ITEM, type: 'movie' } })).toBe('');
});

test('Details section tabs navigate with arrows and edge keys', () => {
  const tabs = [
    { value: 'episodes', label: 'Episodes' },
    { value: 'cast', label: 'Cast' },
    { value: 'about', label: 'About' },
  ] as const;
  for (const [value, key, guard, expected] of [
    ['episodes', 'ArrowRight', {}, 'cast'],
    ['episodes', 'ArrowLeft', {}, 'about'],
    ['episodes', 'End', {}, 'about'],
    ['episodes', 'Home', {}, 'episodes'],
    ['about', 'ArrowRight', {}, 'episodes'],
    ['episodes', 'x', {}, null],
    ['episodes', 'ArrowRight', { ctrlKey: true }, null],
    ['episodes', 'ArrowRight', { defaultPrevented: true }, null],
  ] as const) {
    const change = mock((_next: string) => {});
    const focus = mock(() => {});
    const querySelector = mock((_selector: string) => ({ focus }));
    const preventDefault = mock(() => {});
    const element = DetailsSectionTabs({ tabs, value, onValueChange: change });
    const onKeyDown = element.props.onKeyDown as (event: KeyboardEvent<HTMLDivElement>) => void;
    onKeyDown({
      key,
      ...guard,
      preventDefault,
      currentTarget: { querySelector },
    } as unknown as KeyboardEvent<HTMLDivElement>);
    expect(change.mock.calls.map(([next]) => next)).toEqual(expected ? [expected] : []);
    expect(preventDefault).toHaveBeenCalledTimes(expected ? 1 : 0);
    expect(focus).toHaveBeenCalledTimes(expected ? 1 : 0);
    if (expected) {
      expect(querySelector).toHaveBeenCalledWith(
        expected === 'episodes' ? '#details-episodes-heading' : `#details-section-tab-${expected}`,
      );
    }
  }
});

test('Details viewport observer waits for the enabled late anchor', () => {
  const observe = mock((_element: unknown) => {});
  const disconnect = mock(() => {});
  const original = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    writable: true,
    value: function () {
      return { observe, disconnect };
    },
  });
  capturedEffects = [];
  const fakeAnchor = {} as HTMLDivElement;
  const probeRefs: { current: HTMLDivElement | null }[] = [];
  function ViewportProbe({ enabled }: { enabled: boolean }) {
    probeRefs.push(useNearViewport(enabled).anchorRef);
    return null;
  }
  try {
    renderToStaticMarkup(<ViewportProbe enabled={false} />);
    probeRefs.at(-1)!.current = fakeAnchor;
    const disabledCleanup = capturedEffects.at(-1)?.();
    expect(observe).not.toHaveBeenCalled();
    expect(disabledCleanup).toBeUndefined();

    renderToStaticMarkup(<ViewportProbe enabled />);
    probeRefs.at(-1)!.current = fakeAnchor;
    const cleanup = capturedEffects.at(-1)?.();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(fakeAnchor);
    cleanup?.();
    expect(disconnect).toHaveBeenCalledTimes(1);
  } finally {
    if (original) Object.defineProperty(globalThis, 'IntersectionObserver', original);
    else delete (globalThis as Record<string, unknown>).IntersectionObserver;
    capturedEffects = null;
  }
});
test('Next airing chip only renders future episodes with a dateTime', () => {
  const past = renderToStaticMarkup(<NextAiringChip episode={{ episode: 7, airingAt: 1 }} />);
  expect(past).toBe('');
  const future = renderToStaticMarkup(
    <NextAiringChip episode={{ episode: 7, airingAt: 4_000_000_000 }} />,
  );
  expect(future).toContain('Next: Episode 7');
  expect(future).toContain('dateTime=');
});

test('Details lazily creates one title credits query without an SSR fetch', async () => {
  const id = 'tt-sec';
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(api.detailsQueryOptions('series', id).queryKey, {
    id,
    type: 'series',
    title: 'Series',
    episodes: [],
    isAnime: false,
  });
  client.setQueryData(APP_UI_PREFERENCES_QUERY_KEY, DEFAULT_APP_UI_PREFERENCES);
  const spies = [spyOn(api, 'getTitleCredits'), spyOn(api, 'titleCreditsQueryOptions')];
  try {
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/details/series/${id}`]}>
          <PlayerSessionProvider>
            <Routes>
              <Route path='/details/:type/:id' element={<Details />} />
            </Routes>
          </PlayerSessionProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Cold SSR: exactly one title-credits query, created disabled and idle.
    // (assert before mockRestore - restore clears the recorded calls)
    expect(spies[1]).toHaveBeenCalledTimes(1);
    expect(spies[1]).toHaveBeenCalledWith('series', id, undefined);
    expect(spies[0]).not.toHaveBeenCalled();
    const creditsQueries = client.getQueryCache().findAll({
      queryKey: ['title-credits'],
    });
    expect(creditsQueries).toHaveLength(1);
    const options = creditsQueries[0].options as QueryObserverOptions<TitleCredits>;
    expect(options.enabled).toBe(false);
    expect(creditsQueries[0].state.fetchStatus).toBe('idle');
  } finally {
    spies.forEach((spy) => spy.mockRestore());
    client.clear();
  }
});

test('Season completion remains available for the last unwatched episode', () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const id = 'last-season-episode';
  const details: MediaDetails = {
    id,
    type: 'series',
    title: 'Season completion',
    episodes: [1, 2].map((episode) => ({ id: `e${episode}`, season: 1, episode })),
    seasons: [{ number: 1, episodeCount: 2 }],
  };
  client.setQueryData(api.detailsQueryOptions('series', id).queryKey, details);
  client.setQueryData(titleWatchProgressQueryKey(id), {
    episodeProgress: {
      [`${id}:1:1`]: { id, type_: 'series', position: 1, duration: 1, is_watched: true },
    },
    watchedEpisodeCeiling: {},
  });
  client.setQueryData(APP_UI_PREFERENCES_QUERY_KEY, DEFAULT_APP_UI_PREFERENCES);
  const render = () =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/details/series/${id}`]}>
          <PlayerSessionProvider>
            <Routes>
              <Route path='/details/:type/:id' element={<Details />} />
            </Routes>
          </PlayerSessionProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  try {
    render();
    const unaired = client
      .getQueryCache()
      .getAll()
      .find((query) => query.queryKey.includes('unaired-episodes'));
    if (!unaired) throw new Error('Missing episode air-state query');
    client.setQueryData(unaired.queryKey, new Set());
    expect(render()).toContain('Mark season watched');
  } finally {
    client.clear();
  }
});
