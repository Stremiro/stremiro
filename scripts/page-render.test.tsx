import { expect, mock, test } from 'bun:test';
import {
  captureWithClient,
  markupWithClient,
  queryClientFixture,
  restoreSpies,
  spyFixture,
} from './render-helpers';
import type { CloseRequestedEvent, Window as TauriWindow } from '@tauri-apps/api/window';
import type { ComponentProps, ComponentType, DependencyList, EffectCallback } from 'react';
import type {
  CalendarSchedule,
  DetailsPrefetchBundle,
  EpisodesWatchedResult,
  MediaDetails,
  MediaItem,
  StreamSelectorData,
  TitleCredits,
  UserList,
} from '../src/lib/api';
import type {
  QueryClient,
  QueryObserver as QueryObserverType,
  QueryObserverOptions,
} from '@tanstack/react-query';

// Bun's navigator has no connectivity snapshot; render the pages as online.
Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });

const react = await import('react');
const readStore = react.useSyncExternalStore;
const runEffect = react.useEffect;
const runEffectEvent = react.useEffectEvent;
let capturedEffects: EffectCallback[] | null = null;

// Desktop stores omit SSR snapshots; use their real client snapshots for this smoke test.
mock.module('react', () => ({
  ...react,
  useEffect(effect: EffectCallback, deps?: DependencyList) {
    capturedEffects?.push(effect);
    runEffect(effect, deps);
  },
  useEffectEvent<T extends (...args: never[]) => unknown>(callback: T): T {
    return capturedEffects ? callback : runEffectEvent(callback);
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

const { QueryObserver, onlineManager } = await import('@tanstack/react-query');
const { renderToStaticMarkup } = await import('react-dom/server');
const router = await import('react-router');
const { MemoryRouter, Route, Routes } = router;
const { Search } = await import('../src/pages/search');
const { Details } = await import('../src/pages/details');
const { Calendar } = await import('../src/pages/calendar');
const { Home, homeTrendingQueryOptions } = await import('../src/pages/home');
const { api, DEFAULT_APP_UI_PREFERENCES } = await import('../src/lib/api');
const { queryClient } = await import('../src/lib/query-client');
const {
  APP_UI_PREFERENCES_QUERY_KEY,
  DEFAULT_PLAYER_KEYBINDINGS_QUERY_KEY,
  DETAILS_QUERY_KEY,
  RECENT_WATCH_SEED_QUERY_KEY,
  detailsCardQueryKey,
  invalidateDiscoveryQueries,
  listSummariesQueryKey,
  profileLibraryQueryKey,
  invalidateAddonCapabilityQueries,
  SEARCH_CATALOG_QUERY_KEY,
  streamSelectorQueryKey,
  STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
  titleWatchProgressQueryKey,
} = await import('../src/lib/query-invalidation');
const { pendingDetailsPrefetch, prefetchDetailsRouteData } =
  await import('../src/lib/details-prefetch');
const { playerStreamRankingOptions } = await import('../src/lib/resolve-player-stream');
const { buildStreamRankingCacheKey } = await import('../src/lib/stream-ranking-cache-key');

const { StreamSelector } = await import('../src/components/stream-selector');
const { StreamFilterToolbar, StreamListFilteredEmptyState } =
  await import('../src/components/stream-selector-panel');
const { AddTitlesDialog } = await import('../src/components/list/add-titles-dialog');
const { SaveToCollectionPanel } = await import('../src/components/list/save-to-collection');
const { DetailsSections, NextAiringChip } = await import('../src/components/details-sections');
const { useNearViewport } = await import('../src/hooks/use-near-viewport');
const { useWindowRelease } = await import('../src/hooks/use-window-release');
const { usePlayerKeymap, useRecentSearches } = await import('../src/hooks/use-app-ui-preferences');
const { useBulkAddToList, useMarkSeasonWatched, useMediaCollectionActions } =
  await import('../src/hooks/use-media-library');
const { flushPendingAppWrites } = await import('../src/lib/pending-app-writes');
const playerMpv = await import('../src/lib/player-mpv');
const tauriCore = await import('@tauri-apps/api/core');
const { createPlaybackClock } = await import('../src/lib/player-clock');
const { SettingsSelect } = await import('../src/pages/settings/chrome');
const { SearchInput } = await import('../src/components/ui/search-input');
const { RetryBanner } = await import('../src/components/retry-banner');
const { useCollectionSelection } = await import('../src/components/profile-library-controls');
const { PlayerSessionProvider, usePlayerSession } = await import('../src/lib/player-session');
const { useOptimisticSeek } = await import('../src/hooks/use-optimistic-seek');
const { usePlayerAutoResolve } = await import('../src/hooks/use-player-auto-resolve');
const { getPlayerStreamLoadKey, usePlayerMpvLifecycle } =
  await import('../src/hooks/use-player-mpv-lifecycle');
const mpvEvents = await import('tauri-plugin-libmpv-api');
const { usePlayerResumeController } = await import('../src/hooks/use-player-resume-controller');
const { useMpvSetScheduler } = await import('../src/hooks/use-mpv-set-scheduler');
const { useTitleSearch } = await import('../src/hooks/use-item-search');
const { useSearchPageState } = await import('../src/hooks/use-search-page-state');
const { searchCatalogQueryOptions } = await import('../src/lib/search-catalog');
const { usePlayerAddonSubtitles } = await import('../src/hooks/use-player-addon-subtitles');
const { useStreamSelectorController } = await import('../src/hooks/use-stream-selector-controller');
const { DEFAULT_FILTERS } = await import('../src/lib/stream-selector-utils');
const { useHistoryPlayback } = await import('../src/hooks/use-history-playback');
const { useBrowseHotkeys } = await import('../src/hooks/use-browse-hotkeys');
const appNavigation = await import('../src/lib/navigation');
const searchPageState = await import('../src/lib/search-page-state');
const { claimPlaybackLaunch } = await import('../src/lib/player-navigation');
const { toast } = await import('sonner');
const { AppCloseManager } = await import('../src/components/app-close-manager');
const { Sidebar } = await import('../src/components/sidebar');
const appUpdater = await import('../src/lib/app-updater');
const playerSession = await import('../src/lib/player-session');
const playerPip = await import('../src/lib/player-pip');
const pendingWrites = await import('../src/lib/pending-app-writes');
const tauriWindow = await import('@tauri-apps/api/window');
const { createSubscribableStore } = await import('../src/lib/subscribable-store');

// Stubs a global for the test's duration; the returned restore puts back the original descriptor.
function stubGlobal(name: string, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  };
}

function runEffects(effects: EffectCallback[] | null, cleanups: (() => void)[]) {
  capturedEffects = null;
  for (const effect of effects ?? []) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
}

function cleanupEffects(cleanups: ReturnType<EffectCallback>[]) {
  capturedEffects = null;
  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
}

// Resolves a hook's return value through `captured` during a server render.
function captureHook<T>(use: () => T): {
  Fixture: () => null;
  captured: PromiseWithResolvers<T>;
} {
  const captured = Promise.withResolvers<T>();
  function Fixture() {
    captured.resolve(use());
    return null;
  }
  return { Fixture, captured } as const;
}

const spyOn = spyFixture();
function mockInitialState(from: unknown, to: unknown) {
  const useState = react.useState;
  return spyOn(react, 'useState').mockImplementation((initial: unknown) =>
    useState(initial === from ? to : initial),
  );
}

const createClient = queryClientFixture();
const testClient = (retryOnMount = true) =>
  createClient({
    defaultOptions: { queries: { retry: false, retryOnMount, gcTime: Infinity } },
  });

type AddonSubtitleArgs = Parameters<typeof usePlayerAddonSubtitles>[0];
function addonSubtitleArgs(overrides: Partial<AddonSubtitleArgs>): AddonSubtitleArgs {
  return {
    activeStreamLoadKey: 'stream',
    announce: () => {},
    autoLoadLanguage: null,
    effectiveResolveMediaType: 'movie',
    id: 'tt1',
    menuOpen: false,
    mountedRef: { current: true },
    selectAddonSubtitle: async () => false,
    setTrack: async () => false,
    subTracks: [],
    ...overrides,
  };
}

test.each([false, true])(
  'Window release preserves optional pointer-exit behavior (%s)',
  (pointerExit) => {
    const appWindow = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const restoreWindow = stubGlobal('window', appWindow);
    const restoreDocument = stubGlobal('document', doc);
    const release = mock(() => {});
    const onPointerOut = mock(() => {});
    function Probe() {
      useWindowRelease(release, pointerExit ? onPointerOut : undefined);
      return null;
    }
    const cleanups: (() => void)[] = [];
    capturedEffects = [];
    try {
      renderToStaticMarkup(<Probe />);
      runEffects(capturedEffects, cleanups);
      appWindow.dispatchEvent(new Event('blur'));
      doc.dispatchEvent(new Event('visibilitychange'));
      expect(release).toHaveBeenCalledTimes(1);
      doc.visibilityState = 'hidden';
      doc.dispatchEvent(new Event('visibilitychange'));
      expect(release).toHaveBeenCalledTimes(2);
      doc.dispatchEvent(Object.assign(new Event('pointerout'), { relatedTarget: appWindow }));
      expect(onPointerOut).not.toHaveBeenCalled();
      doc.dispatchEvent(Object.assign(new Event('pointerout'), { relatedTarget: null }));
      expect(onPointerOut).toHaveBeenCalledTimes(pointerExit ? 1 : 0);
      cleanupEffects(cleanups);
      cleanups.length = 0;
      appWindow.dispatchEvent(new Event('blur'));
      doc.dispatchEvent(new Event('visibilitychange'));
      expect(release).toHaveBeenCalledTimes(2);
    } finally {
      cleanupEffects(cleanups);
      restoreWindow();
      restoreDocument();
    }
  },
);

test.each([
  { active: false, saveFails: false },
  { active: true, saveFails: false },
  { active: true, saveFails: true },
])('Reload keys and tray close respect the player session (%j)', async ({ active, saveFails }) => {
  const target = new EventTarget();
  const restoreWindow = stubGlobal('window', target);
  let closeRequested: Parameters<TauriWindow['onCloseRequested']>[0] | undefined;
  let quitRequested: (() => void) | undefined;
  const disposeClose = mock(() => {});
  const disposeQuit = mock(() => {});
  const listenersReady = Promise.withResolvers<void>();
  const appWindow = {
    onCloseRequested: async (handler: typeof closeRequested) => {
      closeRequested = handler;
      await listenersReady.promise;
      return disposeClose;
    },
    listen: async (_event: string, handler: () => void) => {
      quitRequested = handler;
      await listenersReady.promise;
      return disposeQuit;
    },
    close: mock(async () => {}),
  };
  const trayPause = createSubscribableStore(false);
  const context: ReturnType<typeof usePlayerSession> = {
    session: active
      ? { key: 'test', type: 'movie', id: 'tt1', playerPath: '/player/movie/tt1', state: {} }
      : null,
    presentation: 'mini',
    trayPause,
    launch: () => {},
    close: () => {},
    getMiniPosition: () => null,
    setMiniPosition: () => {},
  };
  const saved = Promise.withResolvers<void>();
  const spies = [
    spyOn(appUpdater, 'isTauriDesktopRuntime').mockReturnValue(true),
    spyOn(playerSession, 'usePlayerSession').mockReturnValue(context),
    spyOn(tauriWindow, 'getCurrentWindow').mockReturnValue(appWindow),
    spyOn(api, 'markFrontendQuitReady').mockResolvedValue(undefined),
    spyOn(playerPip, 'waitForViewportTransition').mockResolvedValue(undefined),
    spyOn(playerPip, 'isPlayerPip').mockReturnValue(false),
  ];
  const hide = spyOn(api, 'closeMainWindowToTray').mockResolvedValue(true);
  const pause = spyOn(playerMpv, 'setMpvProperty').mockResolvedValue([]);
  const destroy = spyOn(playerMpv, 'mpvDestroy').mockResolvedValue(undefined);
  const flush = spyOn(pendingWrites, 'flushPendingAppWrites').mockReturnValue(saved.promise);
  const notice = spyOn(toast, 'error').mockImplementation(() => 'notice');
  const cleanups: (() => void)[] = [];
  let closing: void | Promise<void>;
  try {
    capturedEffects = [];
    renderToStaticMarkup(<AppCloseManager />);
    runEffects(capturedEffects, cleanups);
    if (active) listenersReady.resolve();
    await Bun.sleep(0);
    for (const presentation of ['expanded', 'mini'] as const) {
      context.presentation = presentation;
      for (const keys of [
        { key: 'r', ctrlKey: true },
        { key: 'R', ctrlKey: true, shiftKey: true },
        { key: 'F5' },
        { key: 'F5', ctrlKey: true },
      ]) {
        const event = Object.assign(new Event('keydown', { cancelable: true }), keys);
        target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(active);
      }
    }
    const ordinaryKey = Object.assign(new Event('keydown', { cancelable: true }), { key: 'r' });
    target.dispatchEvent(ordinaryKey);
    expect(ordinaryKey.defaultPrevented).toBe(false);
    if (!active) return;

    const veto = mock(() => {});
    if (!closeRequested) throw new Error('Missing close listener');
    closing = closeRequested({ preventDefault: veto } as CloseRequestedEvent);
    await Bun.sleep(0);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(veto).toHaveBeenCalledTimes(1);
    expect(trayPause.getSnapshot()).toBe(true);
    expect(pause).toHaveBeenCalledWith('pause', true);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    const repeatVeto = mock(() => {});
    await closeRequested({ preventDefault: repeatVeto } as CloseRequestedEvent);
    expect(repeatVeto).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    quitRequested?.();
    expect(appWindow.close).not.toHaveBeenCalled();
    if (saveFails) saved.reject(new Error('Disk unavailable'));
    else saved.resolve();
    await closing;

    if (saveFails) {
      expect(appWindow.close).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(notice).toHaveBeenCalledWith('Could not save playback progress.', {
        description: 'Close again to quit anyway.',
      });
      flush.mockResolvedValue(undefined);
      await closeRequested({ preventDefault: veto } as CloseRequestedEvent);
      expect(destroy).toHaveBeenCalledTimes(1);
      return;
    }
    expect(appWindow.close).toHaveBeenCalledTimes(1);
    await closeRequested({ preventDefault: veto } as CloseRequestedEvent);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(veto).toHaveBeenCalledTimes(1);

    flush.mockRejectedValue(new Error('Disk unavailable'));
    await closeRequested({ preventDefault: veto } as CloseRequestedEvent);
    expect(veto).toHaveBeenCalledTimes(2);
    expect(notice).toHaveBeenCalledWith('Could not save playback progress.', {
      description: 'Close again to quit anyway.',
    });
    await closeRequested({ preventDefault: veto } as CloseRequestedEvent);
    expect(veto).toHaveBeenCalledTimes(2);
  } finally {
    saved.resolve();
    await closing;
    cleanupEffects(cleanups);
    restoreSpies(...spies, hide, pause, destroy, flush, notice);
    restoreWindow();
    listenersReady.resolve();
    await Bun.sleep(0);
    expect(disposeClose).toHaveBeenCalledTimes(1);
    expect(disposeQuit).toHaveBeenCalledTimes(1);
    const reload = Object.assign(new Event('keydown', { cancelable: true }), { key: 'F5' });
    target.dispatchEvent(reload);
    expect(reload.defaultPrevented).toBe(false);
  }
});

function BrowseHotkeysFixture() {
  useBrowseHotkeys();
  return null;
}

test('Browse hotkeys map Alt sections/history and yield to owned contexts', async () => {
  class ElementStub {
    isContentEditable = false;
    constructor(private readonly hits: (selector: string) => unknown = () => null) {}
    closest(selector: string): unknown {
      return this.hits(selector);
    }
    querySelector(_selector: string): unknown {
      return null;
    }
  }
  class HTMLElementStub extends ElementStub {}

  const windowTarget = new EventTarget();
  const location = { pathname: '/browse' };
  Object.assign(windowTarget, { location });
  const searchInput = { focus: mock(() => {}), select: mock(() => {}) };
  let dialogOpen = false;
  let tooltipOpen = false;
  let popperLayers: { querySelector: (selector: string) => unknown }[] = [];
  const documentStub = {
    activeElement: null,
    querySelector(selector: string) {
      if (selector === '[role="dialog"][data-state="open"]') return dialogOpen ? {} : null;
      if (selector === '[data-search-input]') return searchInput;
      if (selector === '[role="tooltip"]') return tooltipOpen ? {} : null;
      return null;
    },
    querySelectorAll(selector: string) {
      return selector === '[data-radix-popper-content-wrapper]' ? popperLayers : [];
    },
  };
  const restores = [
    stubGlobal('window', windowTarget),
    stubGlobal('document', documentStub),
    stubGlobal('Element', ElementStub),
    stubGlobal('HTMLElement', HTMLElementStub),
  ];

  const navigateTo = spyOn(appNavigation, 'navigateApp').mockReturnValue(true);
  const back = spyOn(appNavigation, 'navigateBack').mockReturnValue(true);
  const forward = spyOn(appNavigation, 'navigateForward').mockReturnValue(true);
  const searchPath = spyOn(searchPageState, 'lastSearchPath').mockReturnValue(
    '/search?genre=Action',
  );
  const clearCalls = () => {
    for (const spy of [navigateTo, back, forward, searchInput.focus, searchInput.select])
      spy.mockClear();
  };
  const navigationCalls = () =>
    navigateTo.mock.calls.length + back.mock.calls.length + forward.mock.calls.length;
  const fireKey = ({ target, ...init }: Record<string, unknown>) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), init);
    if (target !== undefined)
      Object.defineProperty(event, 'target', { value: target, configurable: true });
    windowTarget.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const cleanups: (() => void)[] = [];
  try {
    capturedEffects = [];
    renderToStaticMarkup(<BrowseHotkeysFixture />);
    runEffects(capturedEffects, cleanups);

    for (const [key, expected] of [
      ['1', '/'],
      ['2', '/search?genre=Action'],
      ['3', '/calendar'],
      ['4', '/library'],
      ['5', '/settings'],
    ] as const) {
      expect(fireKey({ key, altKey: true })).toBe(true);
      expect(navigateTo).toHaveBeenLastCalledWith(expected);
      clearCalls();
    }
    expect(fireKey({ key: 'arrowleft', altKey: true })).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
    expect(fireKey({ key: 'arrowright', altKey: true })).toBe(true);
    expect(forward).toHaveBeenCalledTimes(1);
    clearCalls();

    // Repeats consume the key without navigating again; foreign modifiers and
    // non-shortcut keys pass through untouched.
    for (const init of [
      { key: '3', altKey: true, repeat: true },
      { key: 'arrowleft', altKey: true, repeat: true },
    ]) {
      expect(fireKey(init)).toBe(true);
      expect(navigationCalls()).toBe(0);
    }
    for (const init of [
      { key: '2', altKey: true, ctrlKey: true },
      { key: '2', altKey: true, metaKey: true },
      { key: '2', altKey: true, shiftKey: true },
      { key: 'f', altKey: true },
      { key: '3' },
    ]) {
      expect(fireKey(init)).toBe(false);
      expect(navigationCalls()).toBe(0);
    }

    // Editable/owned/key-capture targets, open interactive layers, IME
    // composition, prior prevention and player routes keep their keys.
    const editable = new HTMLElementStub();
    editable.isContentEditable = true;
    const ownedLayer = new HTMLElementStub((selector) =>
      selector.includes('[data-mini-player]') ? {} : null,
    );
    const keyCapture = new ElementStub((selector) =>
      selector === '[data-key-capture]' ? {} : null,
    );
    for (const target of [editable, ownedLayer, keyCapture])
      expect(fireKey({ key: '1', altKey: true, target })).toBe(false);
    dialogOpen = true;
    expect(fireKey({ key: '1', altKey: true })).toBe(false);
    dialogOpen = false;
    popperLayers = [{ querySelector: () => null }];
    expect(fireKey({ key: '1', altKey: true })).toBe(false);
    popperLayers = [];
    expect(fireKey({ key: '1', altKey: true, isComposing: true })).toBe(false);
    const prevented = Object.assign(new Event('keydown', { cancelable: true }), {
      key: '1',
      altKey: true,
    });
    Object.defineProperty(prevented, 'defaultPrevented', { value: true });
    windowTarget.dispatchEvent(prevented);
    location.pathname = '/player/movie/tt1';
    expect(fireKey({ key: '1', altKey: true })).toBe(false);
    location.pathname = '/browse';
    expect(navigationCalls()).toBe(0);

    // Ctrl/Cmd+K still reaches Search from inside an input; unmodified keys
    // keep their search/back behavior and tooltip-captured Escape.
    location.pathname = '/search';
    expect(fireKey({ key: 'k', ctrlKey: true, target: editable })).toBe(true);
    expect(searchInput.focus).toHaveBeenCalledTimes(1);
    expect(searchInput.select).toHaveBeenCalledTimes(1);
    location.pathname = '/browse';
    expect(fireKey({ key: 'k', metaKey: true })).toBe(true);
    expect(navigateTo).toHaveBeenLastCalledWith('/search?genre=Action');
    clearCalls();
    expect(fireKey({ key: '/' })).toBe(true);
    expect(navigateTo).toHaveBeenLastCalledWith('/search?genre=Action');
    expect(fireKey({ key: 'escape' })).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
    tooltipOpen = true;
    expect(fireKey({ key: 'escape' })).toBe(false);
    tooltipOpen = false;
  } finally {
    cleanupEffects(cleanups);
    restoreSpies(navigateTo, back, forward, searchPath);
    for (const restore of restores) restore();
  }
});

const caseInsensitiveCatalogOptions = (query: string, genre: string) =>
  searchCatalogQueryOptions({ query, genre, type: 'all', feed: 'popular' }, 2026);

test('Case-only title and genre edits share the catalog cache', async () => {
  const client = createClient();
  const fetch = spyOn(api, 'querySearchCatalogPage').mockResolvedValue({
    items: [],
    exhausted: true,
    partial: false,
    continuation: { seenKeys: [] },
  });
  await client.prefetchInfiniteQuery(caseInsensitiveCatalogOptions('Dune', 'Drama'));
  await client.prefetchInfiniteQuery(caseInsensitiveCatalogOptions('DUNE', 'DRAMA'));
  await client.prefetchInfiniteQuery(caseInsensitiveCatalogOptions('dune', 'drama'));
  expect(fetch).toHaveBeenCalledTimes(1);
});

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
    spyOn(router, 'useSearchParams').mockReturnValue([params, commit]);
    const controller = Promise.withResolvers<ReturnType<typeof useSearchPageState>>();
    function FilterFixture() {
      const current = useSearchPageState();
      if (current.query !== draft) current.setQuery(draft);
      else if (current.isComposing !== composing) current.setIsComposing(composing);
      else controller.resolve(current);
      return null;
    }
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
  },
);

test('Reopening addon subtitles rechecks Rust before automatic selection', async () => {
  const client = createClient();
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
    usePlayerAddonSubtitles(addonSubtitleArgs({ autoLoadLanguage: 'eng', id: key[2], menuOpen }));
    return null;
  }
  let unsubscribe: (() => void) | undefined;
  const cleanups: (() => void)[] = [];
  const render = () => markupWithClient(client, <Subtitles />);
  try {
    capturedEffects = [];
    render();
    runEffects(capturedEffects, cleanups);
    expect(matchLanguage).not.toHaveBeenCalled();
    const query = client.getQueryCache().find({ queryKey: key })!;
    const observer = new QueryObserver(client, query.options);
    unsubscribe = observer.subscribe(() => {});
    await query.promise;
    expect(fetch).toHaveBeenCalledTimes(1);
    menuOpen = true;
    capturedEffects = [];
    render();
    runEffects(capturedEffects, cleanups);
    await query.promise;
    expect(fetch).toHaveBeenCalledTimes(2);
    menuOpen = false;

    client.setDefaultOptions({ queries: { refetchOnMount: false } });
    client.setQueryData(key, cached);
    capturedEffects = [];
    render();
    runEffects(capturedEffects, cleanups);
    expect(matchLanguage).toHaveBeenCalledTimes(1);
  } finally {
    capturedEffects = null;
    cleanups.forEach((cleanup) => cleanup());
    unsubscribe?.();
    restoreSpies(fetch, matchLanguage);
  }
});

test('Subtitle results stay available while mounted but leave the cache after playback', async () => {
  const client = createClient({ defaultOptions: { queries: { gcTime: 30 * 60_000 } } });
  const fetch = spyOn(api, 'getAddonSubtitles').mockResolvedValue([]);
  let episode = 1;
  const releases: (() => void)[] = [];
  function Fixture() {
    usePlayerAddonSubtitles(
      addonSubtitleArgs({
        activeStreamLoadKey: `episode-${episode}`,
        effectiveResolveMediaType: 'series',
        resolvedStreamSeason: 1,
        resolvedStreamEpisode: episode,
      }),
    );
    return null;
  }
  try {
    for (; episode <= 24; episode++) {
      markupWithClient(client, <Fixture />);
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
    fetch.mockRestore();
  }
});

test.each([
  { automatic: false, cancelled: false },
  { automatic: true, cancelled: false },
  { automatic: false, cancelled: true },
])(
  'Subtitle selections serialize rapid input and fence failures across stream resets (%j)',
  async ({ automatic, cancelled }) => {
    const client = createClient();
    const native = Promise.withResolvers<boolean>();
    const replacement = Promise.withResolvers<boolean>();
    const select = mock(() => native.promise);
    const notice = spyOn(toast, 'error').mockImplementation(() => 'notice');
    const cleanups: (() => void)[] = [];
    try {
      capturedEffects = [];
      const hook = captureWithClient(client, () =>
        usePlayerAddonSubtitles(addonSubtitleArgs({ selectAddonSubtitle: select })),
      );
      const effects = capturedEffects;
      runEffects(effects, cleanups);
      const subtitle = {
        id: 'sub',
        selectionKey: 'sub',
        url: 'https://example.com/sub',
        mpvTitle: 'English',
        sourceId: 'addon',
        sourceName: 'Addon',
      };
      const pending = hook.handleAddonSubtitleSelect(subtitle, { automatic });
      const duplicate = hook.handleAddonSubtitleSelect(subtitle, { automatic });
      let replacementSelection: Promise<void> | undefined;
      if (cancelled) {
        cleanups.splice(0).forEach((cleanup) => cleanup());
        runEffects(effects, cleanups);
        select.mockImplementationOnce(() => replacement.promise);
        replacementSelection = hook.handleAddonSubtitleSelect(subtitle);
      }
      native.reject(new Error('Subtitle exceeds the 8 MiB limit.'));
      await Promise.all([pending, duplicate]);
      expect(select).toHaveBeenCalledTimes(cancelled ? 2 : 1);
      expect(notice).toHaveBeenCalledTimes(automatic || cancelled ? 0 : 1);
      if (!automatic && !cancelled)
        expect(notice).toHaveBeenCalledWith('Failed to load addon subtitle', {
          description: 'Subtitle exceeds the 8 MiB limit.',
        });
      if (cancelled) {
        // The old rejection must not release the new stream's selection gate.
        await hook.handleAddonSubtitleSelect(subtitle);
        expect(select).toHaveBeenCalledTimes(2);
        replacement.resolve(true);
        await replacementSelection;
      } else {
        await hook.handleAddonSubtitleSelect(subtitle, { automatic });
        expect(select).toHaveBeenCalledTimes(2);
      }
    } finally {
      replacement.resolve(false);
      capturedEffects = null;
      cleanups.forEach((cleanup) => cleanup());
      notice.mockRestore();
    }
  },
);

test.each([
  { cancelled: false, failed: false },
  { cancelled: false, failed: true },
  { cancelled: true, failed: false },
  { cancelled: true, failed: true },
])('Play next reports only the current lookup result (%j)', async ({ cancelled, failed }) => {
  const restoreWindow = stubGlobal('window', {
    location: { pathname: '/profile', search: '' },
  });
  const client = createClient();
  const lookup = Promise.withResolvers<Awaited<ReturnType<typeof api.getNextEpisodeRow>>>();
  const next = spyOn(api, 'getNextEpisodeRow').mockImplementation(() => lookup.promise);
  const info = spyOn(toast, 'info').mockImplementation(() => 'notice');
  const error = spyOn(toast, 'error').mockImplementation(() => 'error');
  const { Fixture: History, captured: controller } = captureHook(() =>
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
  try {
    markupWithClient(
      client,
      <PlayerSessionProvider>
        <History />
      </PlayerSessionProvider>,
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
    restoreSpies(next, info, error);
    restoreWindow();
  }
});

test.each([
  { query: '', enabled: true, expectedQueries: 1 },
  { query: 'Title', enabled: false, expectedQueries: 1 },
  { query: 'Title', enabled: true, expectedQueries: 30 },
])(
  'Collection search retains distinct snapshots only while searching (%j)',
  ({ query, enabled, expectedQueries }) => {
    const client = createClient();
    function Collection({ revision }: { revision: number }) {
      const items = [{ title: `Title ${revision}` }];
      const { filteredItems } = useTitleSearch(items, query, enabled);
      expect(filteredItems).toBe(items);
      return null;
    }
    for (let revision = 0; revision < 30; revision++) {
      markupWithClient(client, <Collection revision={revision} />);
    }
    expect(client.getQueryCache().findAll({ queryKey: ['title-search'] })).toHaveLength(
      expectedQueries,
    );
  },
);

test('Volume and unmute share one native batch with no delayed unmute after a newer mute', async () => {
  const frames: FrameRequestCallback[] = [];
  const restoreWindow = stubGlobal('window', {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return 1;
    },
    cancelAnimationFrame: () => {},
  });
  const pending = Promise.withResolvers<[]>();
  const batch = spyOn(playerMpv, 'setMpvProperties')
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue([]);
  const single = spyOn(playerMpv, 'setMpvProperty').mockResolvedValue([]);
  const { Fixture: AudioFixture, captured: controller } = captureHook(useMpvSetScheduler);
  const writes: Promise<unknown>[] = [];
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
    restoreSpies(batch, single);
    restoreWindow();
  }
});

test('Track changes send a native intent and return its confirmed snapshot', async () => {
  const snapshot = [{ id: 2, type: 'audio' as const, displayLabel: 'English', selected: true }];
  const invoke = spyOn(tauriCore, 'invoke').mockResolvedValue(snapshot);
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
});

test.each([
  [100, true, false],
  [1000, false, false],
  [1000, true, true],
] as const)(
  'Seek failure verdict includes IPC wait time (%s ms)',
  async (elapsed, failed, latched) => {
    spyOn(tauriCore, 'invoke').mockResolvedValue({
      timePos: 120,
      bufferedAhead: 0,
      nearCompletion: true,
      nextEpisodePrefetchDue: true,
      seekFailureWindowSecs: 0.25,
    });
    const now = spyOn(performance, 'now').mockReturnValue(0);
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
  },
);

test('Startup seeks leave pending resume and the playback clock untouched until mpv is ready', async () => {
  const nativeSeek = spyOn(playerMpv, 'seekAbsoluteSeconds').mockResolvedValue();
  const nativeCommand = spyOn(playerMpv, 'mpvCommand').mockResolvedValue();
  const onUserSeek = mock(() => {});
  const onConfirmed = mock(() => {});
  const clock = createPlaybackClock();
  clock.publish(900);
  const durationRef = { current: 0 };
  const mpvInitializedRef = { current: false };
  const { Fixture: SeekFixture, captured: controller } = captureHook(() =>
    useOptimisticSeek({
      clock,
      durationRef,
      mpvInitializedRef,
      onUserSeek,
      triggerOsd: () => {},
    }),
  );
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
    return [seeking.seek(910, 'user', onConfirmed), seeking.seekRelative(10)];
  });
  await Promise.all(ignoredSeeks);
  expect(onUserSeek).not.toHaveBeenCalled();
  expect(nativeSeek).not.toHaveBeenCalled();
  expect(nativeCommand).not.toHaveBeenCalled();
  expect(onConfirmed).not.toHaveBeenCalled();
  expect(clock.getSnapshot()).toBe(900);
  expect(seeking.isSeekPending()).toBe(false);
  expect(seeking.getSeekTarget()).toBeNull();
  mpvInitializedRef.current = true;
  durationRef.current = 3600;
  await Promise.all([
    seeking.seekRelative(10),
    seeking.seekRelative(10),
    seeking.seekRelative(-10),
  ]);
  expect(nativeSeek.mock.calls).toEqual([[910], [920], [910]]);
  expect(nativeCommand).not.toHaveBeenCalled();
  await seeking.seek(950, 'user', onConfirmed);
  expect(onConfirmed).toHaveBeenCalledTimes(1);
  expect(nativeSeek).toHaveBeenCalledWith(950);
  expect(onUserSeek).toHaveBeenCalledTimes(4);
  expect(clock.getSnapshot()).toBe(950);
  expect(seeking.observeTimeUpdate(950, performance.now())).toBe(false);
  expect(seeking.isSeekPending()).toBe(false);
  expect(seeking.getSeekTarget()?.seconds).toBe(950);
  seeking.confirmSeek();
  expect(seeking.getSeekTarget()).toBeNull();
  nativeSeek.mockRejectedValueOnce(new Error('Seek rejected'));
  await expect(seeking.seek(1000, 'user', onConfirmed)).rejects.toThrow('Seek rejected');
  expect(onConfirmed).toHaveBeenCalledTimes(1);
  expect(clock.getSnapshot()).toBe(950);
  expect(seeking.isSeekPending()).toBe(false);
  await seeking.seek(1000, 'user', onConfirmed);
  expect(onConfirmed).toHaveBeenCalledTimes(2);
});

test('manual stream retry bypasses the cached URL and rejects a late resolve winner', async () => {
  const runtime = spyOn(appUpdater, 'isTauriDesktopRuntime').mockReturnValue(true);
  const initial = { url: 'https://example.com/old', streamKey: 's:retry', cacheTtlMs: 60_000 };
  const fresh = { ...initial, url: 'https://example.com/fresh' };
  const late = Promise.withResolvers<typeof initial>();
  const invoke = spyOn(tauriCore, 'invoke').mockResolvedValue(initial);
  const stream: Parameters<typeof usePlayerAutoResolve>[0]['stream'] = {
    reloadStream: () => {},
    activeStreamSourceIdRef: { current: undefined },
    activeStreamSourceNameRef: { current: undefined },
    activeStreamFamilyRef: { current: undefined },
    selectedStreamKeyRef: { current: undefined },
    streamLookupIdRef: { current: 'tt-retry' },
    committedStreamUrlRef: { current: undefined },
    setActiveStreamUrl: mock((url) => {
      stream.activeStreamUrl = url;
    }),
  };
  const setError = mock(() => {});
  const effects: EffectCallback[] = [];
  const cleanups: ReturnType<EffectCallback>[] = [];
  const { Fixture, captured: controller } = captureHook(() =>
    usePlayerAutoResolve({
      stream,
      autoResolveGenRef: { current: 0 },
      effectiveResolveMediaType: 'movie',
      error: null,
      id: 'tt-retry',
      isResolving: false,
      mountedRef: { current: true },
      routeSelectedStreamKey: 's:retry',
      setError,
      setResolveStatus: () => {},
      shouldWaitForResolvedLookupId: false,
      showStreamSelector: false,
      stopLoading: () => {},
      type: 'movie',
    }),
  );
  try {
    capturedEffects = effects;
    renderToStaticMarkup(<Fixture />);
    capturedEffects = null;
    const retry = await controller.promise;
    const resolve = effects.at(-1)!;
    cleanups.push(resolve());
    await Bun.sleep(0);
    expect(stream.activeStreamUrl).toBe(initial.url);
    const firstLoadKey = getPlayerStreamLoadKey(stream);
    stream.loadRevision = 1;
    expect(getPlayerStreamLoadKey(stream)).not.toBe(firstLoadKey);
    invoke.mockReturnValueOnce(late.promise);
    retry!();
    expect(stream.activeStreamUrl).toBeUndefined();
    expect(setError).toHaveBeenLastCalledWith(null);
    cleanups.push(resolve());
    await Bun.sleep(0);
    expect(invoke.mock.calls.filter(([name]) => name === 'resolve_best_stream')).toHaveLength(2);
    retry!();
    invoke.mockResolvedValueOnce(fresh);
    cleanups.push(resolve());
    await Bun.sleep(0);
    late.resolve({ ...initial, url: 'https://example.com/late' });
    await Bun.sleep(0);
    expect(stream.activeStreamUrl).toBe(fresh.url);
    expect(invoke.mock.calls.filter(([name]) => name === 'resolve_best_stream')).toHaveLength(3);
  } finally {
    late.resolve(initial);
    cleanupEffects(cleanups);
    await Bun.sleep(0);
    restoreSpies(runtime, invoke);
  }
});

test('seek lifecycle discards old probes and waits for confirmed EOF before failing or ending', async () => {
  const restoreWindow = stubGlobal('window', {
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout,
  });
  const restoreDocument = stubGlobal(
    'document',
    Object.assign(new EventTarget(), { hidden: false }),
  );
  const client = createClient();
  client.setQueryData(APP_UI_PREFERENCES_QUERY_KEY, DEFAULT_APP_UI_PREFERENCES);
  let emit: Parameters<typeof mpvEvents.listenEvents>[0] | undefined;
  const listen = spyOn(mpvEvents, 'listenEvents').mockImplementation(async (callback) => {
    emit = callback;
    return () => {};
  });
  const command = spyOn(playerMpv, 'mpvCommand').mockResolvedValue();
  const init = spyOn(playerMpv, 'mpvInit').mockResolvedValue('ready');
  const destroy = spyOn(playerMpv, 'mpvDestroy').mockResolvedValue();
  const properties = spyOn(playerMpv, 'setMpvProperties').mockResolvedValue([]);
  const audio = spyOn(playerMpv, 'setMpvAudioSettings').mockResolvedValue();
  const subtitles = spyOn(playerMpv, 'setMpvSubtitleAppearance').mockResolvedValue();
  const nativeSeek = spyOn(playerMpv, 'seekAbsoluteSeconds').mockResolvedValue();
  const snapshot = {
    timePos: 20,
    bufferedAhead: 1,
    nearCompletion: false,
    nextEpisodePrefetchDue: false,
    seekFailed: false,
    prematureEof: false,
    eofReached: false,
  };
  const probe = spyOn(playerMpv, 'readPlaybackPositionProbe').mockResolvedValue(snapshot);
  const now = spyOn(performance, 'now').mockReturnValue(1000);
  const clock = createPlaybackClock();
  const durationRef = { current: 120 };
  const mpvInitializedRef = { current: false };
  const errorRef = { current: null as string | null };
  const onEndedChange = mock(() => {});
  const setStreamError = mock((value: string) => {
    errorRef.current = value;
  });
  const save = mock(async () => {});
  const retryFailedSeek = mock((_position: number) => false);
  const forceShowTimeoutRef = { current: null as ReturnType<typeof setTimeout> | null };
  const effects: EffectCallback[] = [];
  const cleanups: (() => void)[] = [];
  const controller = Promise.withResolvers<ReturnType<typeof useOptimisticSeek>>();
  function Fixture() {
    const seeking = useOptimisticSeek({
      clock,
      durationRef,
      mpvInitializedRef,
      onUserSeek: () => {},
      triggerOsd: () => {},
    });
    controller.resolve(seeking);
    usePlayerMpvLifecycle({
      stream: {
        reloadStream: () => {},
        activeStreamUrl: 'https://example.com/seek',
        activeStreamKey: 'seek',
        committedStreamUrlRef: { current: 'https://example.com/seek' },
        selectedStreamKeyRef: { current: 'seek' },
        streamLookupIdRef: { current: 'tt1' },
        activeStreamSourceIdRef: { current: undefined },
        activeStreamSourceNameRef: { current: undefined },
        activeStreamFamilyRef: { current: undefined },
        setActiveStreamUrl: () => {},
      },
      isHistoryResume: false,
      playbackSpeedRef: { current: 1 },
      subtitleSettingsRef: { current: { delay: 0, pos: 100, scale: 1 } },
      playbackLanguagePreferencesRef: { current: {} },
      volumeRef: { current: 100 },
      isMutedRef: { current: false },
      mountedRef: { current: true },
      isDestroyedRef: { current: false },
      mpvInitializedRef,
      isLoading: false,
      isPlayingRef: { current: true },
      clock,
      observedPositionRef: { current: null },
      bufferedClock: createPlaybackClock(),
      durationRef,
      playbackVerifiedAtRef: { current: 1000 },
      errorRef,
      recoverableStreamErrorRef: { current: null },
      forceShowTimeoutRef,
      saveProgressRef: { current: save },
      setIsLoading: () => {},
      setError: () => {},
      setStreamError,
      setDuration: () => {},
      setIsPlaying: () => {},
      applyNativeVolume: () => {},
      applyNativeMute: () => {},
      setPlaybackSpeed: () => {},
      setMpvSurfaceReady: () => {},
      requestSurfaceRefresh: () => {},
      isResolvingRef: { current: false },
      clearUiTimers: () => {},
      clearResumeRetryTimer: () => {},
      clearRecoveryTimers: () => {},
      prepareForStreamLoad: () => false,
      markPlaybackReady: () => {},
      markPlaybackVerified: () => {},
      applyResumeIfReady: async () => {},
      onEndedChange,
      observeTimeUpdate: seeking.observeTimeUpdate,
      isSeekPending: seeking.isSeekPending,
      getSeekTarget: seeking.getSeekTarget,
      retryFailedSeek,
      isResumePending: () => false,
      onObservedTrackSelection: () => false,
      refreshTracks: async () => {},
      reportStreamFailure: () => {},
      recoverFromSlowStartup: async () => false,
      reopenSelectorForSavedStreamFailure: () => {},
      stopLoading: () => {},
      setTransparent: () => {},
      restorePlayerSurface: () => {},
      revealControls: () => {},
    });
    return null;
  }
  const property = (name: string, data: number | boolean) =>
    emit?.({ event: 'property-change', name, data });
  try {
    capturedEffects = effects;
    markupWithClient(
      client,
      <PlayerSessionProvider>
        <Fixture />
      </PlayerSessionProvider>,
    );
    capturedEffects = null;
    const seeking = await controller.promise;
    runEffects(effects, cleanups);
    await Bun.sleep(0);
    expect(mpvInitializedRef.current).toBe(true);
    property('duration', 120);
    await seeking!.seek(90);
    const old = Promise.withResolvers<typeof snapshot>();
    probe.mockReturnValueOnce(old.promise);
    property('eof-reached', true);
    await seeking!.seek(30);
    old.resolve({ ...snapshot, timePos: 120, seekFailed: true, eofReached: true });
    await Bun.sleep(0);
    expect(setStreamError).not.toHaveBeenCalled();
    expect(clock.ref.current).toBe(30);
    const ack = Promise.withResolvers<void>();
    nativeSeek.mockReturnValueOnce(ack.promise);
    const slowSeek = seeking.seek(40);
    emit?.({ event: 'seek' });
    now.mockReturnValue(5000);
    expect(seeking.isSeekPending()).toBe(false);
    expect(seeking.getSeekTarget()?.commandPending).toBe(true);
    probe.mockResolvedValue({ ...snapshot, timePos: 120, seekFailed: true });
    property('eof-reached', true);
    await Bun.sleep(0);
    expect(probe.mock.calls.at(-1)?.[2]).toBe(false);
    expect(setStreamError).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    ack.resolve();
    await slowSeek;
    expect(seeking.getSeekTarget()?.commandPending).toBe(false);
    // A late EOF event alone cannot end playback when the native probe no longer confirms EOF.
    probe.mockResolvedValue({ ...snapshot, timePos: 120 });
    emit?.({ event: 'playback-restart' });
    await Bun.sleep(0);
    expect(onEndedChange).not.toHaveBeenCalledWith(true);
    // One recovery attempt keeps the error/end cards hidden; a failed retry stays actionable.
    retryFailedSeek.mockReturnValueOnce(true);
    probe.mockResolvedValue({ ...snapshot, timePos: 120, seekFailed: true, eofReached: true });
    property('eof-reached', true);
    await Bun.sleep(0);
    expect(retryFailedSeek).toHaveBeenLastCalledWith(40);
    expect(setStreamError).not.toHaveBeenCalled();
    property('eof-reached', true);
    await Bun.sleep(0);
    expect(setStreamError).toHaveBeenCalledWith(
      'Could not resume at 00:40. Retry playback or choose another stream.',
    );
    expect(save).not.toHaveBeenCalled();
    expect(onEndedChange).not.toHaveBeenCalledWith(true);
    errorRef.current = null;
    await seeking!.seek(120);
    seeking!.observeTimeUpdate(120, performance.now());
    probe.mockResolvedValue({ ...snapshot, timePos: 120, nearCompletion: true, eofReached: true });
    property('eof-reached', true);
    await Bun.sleep(0);
    expect(onEndedChange).toHaveBeenCalledWith(true);
    expect(save).toHaveBeenCalledTimes(1);
  } finally {
    capturedEffects = null;
    for (const cleanup of cleanups.toReversed()) if (typeof cleanup === 'function') cleanup();
    if (forceShowTimeoutRef.current !== null) clearTimeout(forceShowTimeoutRef.current);
    await Bun.sleep(170);
    restoreSpies(
      listen,
      command,
      init,
      destroy,
      properties,
      audio,
      subtitles,
      nativeSeek,
      probe,
      now,
    );
    restoreWindow();
    restoreDocument();
  }
});

test.each([null, 'watched'] as const)(
  'Season completion refreshes library relations and Undo restores status %s',
  async (previousStatus) => {
    const client = createClient({ defaultOptions: { queries: { gcTime: Infinity } } });
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
    const keys = [
      ['library'],
      ['watch-statuses'],
      ['profile-library'],
      ['lists'],
      ['list-summaries'],
    ];
    for (const key of keys) client.setQueryData(key, []);
    const controller = captureWithClient(client, () => useMarkSeasonWatched({ item }));
    await controller.mutateAsync({ episodes: item.episodes!, watched: true });
    expect(mark).toHaveBeenCalledWith(item, item.episodes, true);
    for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    const action = notice.mock.calls[0]?.[1]?.action;
    if (!action || typeof action !== 'object' || !('onClick' in action))
      throw new Error('Missing season Undo');
    action.onClick({});
    await restored.promise;
    expect(mark).toHaveBeenLastCalledWith(item, item.episodes, false);
    expect(restoreStatus).toHaveBeenCalledWith(item, previousStatus);
  },
);

test.each([false, true])(
  'Accepted resume seeks wait for settlement before retrying (tray paused=%s)',
  async (trayPaused) => {
    const restoreWindow = stubGlobal('window', globalThis);
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
    const cleanups: (() => void)[] = [];
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
      runEffects(effects, cleanups);
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
      cleanupEffects(cleanups);
      restoreSpies(nativeSeek, pauseWrite, now, invoke);
      restoreWindow();
    }
  },
);

test('Compiled preference writes persist the merged pending patch', async () => {
  const { transformSync } = await import('@babel/core');
  const { reactCompilerPreset } = await import('@vitejs/plugin-react');
  const source = await Bun.file(
    new URL('../src/hooks/use-app-ui-preferences.ts', import.meta.url),
  ).text();
  const javascript = new Bun.Transpiler({ loader: 'ts', target: 'browser' }).transformSync(source);
  const compiled = transformSync(javascript, {
    filename: 'src/hooks/use-app-ui-preferences.ts',
    configFile: false,
    babelrc: false,
    presets: [reactCompilerPreset().preset],
  })?.code;
  if (!compiled) throw new Error('React Compiler produced no preference hook.');
  const registration = 'registerPendingAppWriteFlusher(flushAppUiPreferenceWrites);';
  if (!compiled.includes(registration)) throw new Error('Preference flusher registration missing.');
  const code = compiled
    .replace(registration, `export const unregisterCompiledFlusher = ${registration}`)
    .replace(
      /from\s+["']([^"']+)["']/g,
      (_match, specifier: string) =>
        `from ${JSON.stringify(import.meta.resolve(specifier.startsWith('@/') ? `../src/${specifier.slice(2)}` : specifier))}`,
    );
  const { useAppUiPreferences: useCompiledPreferences, unregisterCompiledFlusher } = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  );
  const client = createClient();
  client.setQueryData(APP_UI_PREFERENCES_QUERY_KEY, DEFAULT_APP_UI_PREFERENCES);
  const savePreferences = spyOn(api, 'saveAppUiPreferences').mockImplementation(async (patch) => ({
    ...DEFAULT_APP_UI_PREFERENCES,
    ...patch,
  }));
  try {
    const preferences = captureWithClient(client, useCompiledPreferences);
    preferences.updatePreferences({ spoilerProtection: false });
    await preferences.savePreferences({ trailerPreviews: false });
    expect(savePreferences).toHaveBeenCalledWith({
      spoilerProtection: false,
      trailerPreviews: false,
    });
  } finally {
    unregisterCompiledFlusher();
    savePreferences.mockRestore();
  }
});

test('Recent-search clear waits for a pending record and leaves cache and storage empty', async () => {
  const client = createClient();
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
  try {
    const searches = captureWithClient(client, useRecentSearches);
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
    restoreSpies(recordSearch, savePreferences);
  }
});

function renderPage(Page: ComponentType, route: string, client = testClient()) {
  // The Hero reads native window location; keep this server fixture on the rails.
  client.setQueryData(homeTrendingQueryOptions.queryKey, []);
  renderDialogPortal = true;
  try {
    return markupWithClient(client, <Page />, route);
  } finally {
    renderDialogPortal = false;
    client.clear();
  }
}

// Details renders through its route so nested player-session context resolves like the app's.
function renderDetails(client: QueryClient, route: string) {
  return markupWithClient(
    client,
    <PlayerSessionProvider>
      <Routes>
        <Route path='/details/:type/:id' element={<Details />} />
      </Routes>
    </PlayerSessionProvider>,
    route,
  );
}

test.each([false, true])('Incomplete Search results remain retryable (empty=%j)', (empty) => {
  const client = createClient();
  const options = searchCatalogQueryOptions(
    { query: 'dune', type: 'movie', feed: 'popular' },
    2026,
  );
  client.setQueryData(options.queryKey, {
    pages: [
      {
        items: empty ? [] : [{ id: 'tt1160419', type: 'movie', title: 'Dune' }],
        partial: true,
        exhausted: true,
        continuation: { seenKeys: [] },
      },
    ],
    pageParams: [undefined],
  });
  const markup = renderPage(Search, '/search?q=dune&type=movie', client);
  expect(markup).toContain('Retry missing results');
  expect(markup).toContain('Some sources didn');
  const retry = Array.from(markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)).find(([button]) =>
    button.includes('Retry missing results'),
  )?.[0];
  expect(retry).toBeDefined();
  expect(retry).not.toContain('aria-disabled="true"');
});

test('Calendar keeps upcoming placeholders only for the same watched filter', () => {
  const client = createClient();
  client.setQueryData(APP_UI_PREFERENCES_QUERY_KEY, {
    ...DEFAULT_APP_UI_PREFERENCES,
    calendarHideWatched: true,
  });
  markupWithClient(client, <Calendar />);
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
});

const ADD_TITLES_PROPS = {
  list: { id: 'test-list', name: 'Test list', icon: 'list', item_ids: [] },
  onOpenChange: () => {},
  returnFocusRef: { current: null },
};
const AddTitlesFixture = () => <AddTitlesDialog {...ADD_TITLES_PROPS} />;

test.each([false, true])(
  'Add Titles keeps cached rows available after a refresh failure (cached=%s)',
  async (cached) => {
    const client = testClient(false);
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
    const markup = renderPage(AddTitlesFixture, '/profile?tab=lists', client);
    expect(markup).toContain('load your library.');
    expect(markup.includes('aria-label="Library titles"')).toBe(cached);
    expect(markup.includes('aria-label="Saved title"')).toBe(cached);
    expect(markup).not.toContain('Your library is empty');
  },
);

test.each([false, true])('Incomplete Discover titles remain retryable (empty=%j)', (empty) => {
  const client = createClient();
  mockInitialState('library', 'discover');
  client.setQueryData([...SEARCH_CATALOG_QUERY_KEY, 'add-titles-discover', undefined], {
    items: empty ? [] : [{ id: 'saved-title', title: 'Saved title', type: 'movie' }],
    partial: true,
    exhausted: true,
    continuation: { seenKeys: [] },
  });
  const markup = renderPage(AddTitlesFixture, '/profile?tab=lists', client);
  expect(markup).toContain('Retry');
  expect(markup).toContain('Results may be incomplete.');
  expect(markup.includes('aria-label="Saved title"')).toBe(!empty);
});

test('Discover additions keep failed titles selected for retry', async () => {
  const client = createClient();
  const items = [
    { id: 'added', title: 'Added title', type: 'movie' },
    { id: 'retry', title: 'Retry title', type: 'movie' },
  ];
  let selected = new Map(items.map((item) => [item.id, item]));
  const originalState = react.useState;
  spyOn(react, 'useState').mockImplementation((initial: unknown) => {
    if (initial instanceof Map) {
      return [
        selected,
        (update: (current: typeof selected) => typeof selected) => {
          selected = update(selected);
        },
      ];
    }
    return originalState(initial === 'library' ? 'discover' : initial);
  });
  const summary = {
    id: 'test-list',
    name: 'Test list',
    icon: 'list',
    item_count: 1,
    contains_item: true,
  };
  const add = spyOn(api, 'addToList')
    .mockResolvedValueOnce(summary)
    .mockRejectedValueOnce({ kind: 'list_full', message: 'List is full.' })
    .mockResolvedValue(summary);
  let notified = Promise.withResolvers<void>();
  const notice = spyOn(toast, 'custom').mockImplementation(() => {
    notified.resolve();
    return 'add-notice';
  });
  const close = mock(() => {});
  const submit = () =>
    captureWithClient(client, () => {
      const dialog = AddTitlesDialog({ ...ADD_TITLES_PROPS, onOpenChange: close });
      const footer = dialog.props.children.props.children.at(-1);
      const [, actions] = footer.props.children;
      const [, addButton] = actions.props.children;
      return addButton.props.onClick;
    });
  submit()();
  await notified.promise;
  expect(close).not.toHaveBeenCalled();
  expect([...selected.keys()]).toEqual(['retry']);
  const feedback = notice.mock.calls[0][0]('add-notice');
  expect(feedback.props.tone).toBe('error');
  expect(feedback.props.detail).toBe('List is full.');
  notified = Promise.withResolvers<void>();
  submit()();
  await notified.promise;
  expect(add.mock.calls.map(([, item]) => item.id)).toEqual(['added', 'retry', 'retry']);
  expect(close).toHaveBeenCalledTimes(1);
  expect(selected.size).toBe(0);
});

test.each(['library', 'discover'])(
  'Add Titles queries only its %s source and refreshes Discover with addon routing',
  async (source) => {
    const client = testClient();
    const library = spyOn(api, 'getProfileLibrary').mockResolvedValue({ items: [], allIds: [] });
    const discover = spyOn(api, 'querySearchCatalogPage').mockResolvedValue({
      items: [],
      exhausted: true,
      partial: false,
      continuation: { seenKeys: [] },
    });
    const state = mockInitialState('library', source);
    const observers: InstanceType<typeof QueryObserver>[] = [];
    const unsubscribes: (() => void)[] = [];
    try {
      markupWithClient(client, <AddTitlesFixture />);
      for (const query of client.getQueryCache().getAll()) {
        const observer = new QueryObserver(client, query.options);
        observers.push(observer);
        unsubscribes.push(observer.subscribe(() => {}));
      }
      await client.refetchQueries({ type: 'active' });
      expect(library).toHaveBeenCalledTimes(source === 'library' ? 1 : 0);
      expect(discover).toHaveBeenCalledTimes(source === 'discover' ? 1 : 0);
      const discoverQuery = client.getQueryCache().findAll({
        queryKey: [...SEARCH_CATALOG_QUERY_KEY, 'add-titles-discover'],
      });
      expect(discoverQuery).toHaveLength(1);
      await invalidateDiscoveryQueries(client);
      expect(discover).toHaveBeenCalledTimes(source === 'discover' ? 2 : 0);
      expect(discoverQuery[0].state.isInvalidated).toBe(source === 'library');
      await invalidateAddonCapabilityQueries(client, true);
      expect(discover).toHaveBeenCalledTimes(source === 'discover' ? 3 : 0);
      expect(discoverQuery[0].state.isInvalidated).toBe(source === 'library');
    } finally {
      for (const unsubscribe of unsubscribes) unsubscribe();
      for (const observer of observers) observer.destroy();
      restoreSpies(state, library, discover);
    }
  },
);

test.each([false, true])(
  'Details hero renders writer, country and awards facts only when metadata provides them (populated=%s)',
  (populated) => {
    const client = testClient(false);
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
      markup = renderDetails(client, `/details/movie/${id}`);
    } finally {
      renderDialogPortal = false;
    }

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
    const client = createClient();
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

test('Home enables recommendation observation when its cold seed arrives', async () => {
  const viewport = await import('../src/hooks/use-near-viewport');
  const observation = spyOn(viewport, 'useNearViewport').mockImplementation((enabled = true) => ({
    anchorRef: { current: null },
    nearViewport: enabled,
  }));
  const client = testClient();
  renderPage(Home, '/home', client);
  expect(observation.mock.calls.at(-1)?.[0]).toBe(false);
  client.setQueryData(RECENT_WATCH_SEED_QUERY_KEY, {
    type: 'movie',
    id: 'tt123',
    title: 'Seed movie',
  });
  const markup = renderPage(Home, '/home', client);
  expect(observation.mock.calls.at(-1)?.[0]).toBe(true);
  expect(markup).toContain('Because you watched Seed movie');
});

function streamSelectorFixture(
  available = true,
  hasEnabledAddons = true,
  fatalErrorMessage?: string,
): StreamSelectorData {
  return {
    hasEnabledAddons,
    fatalErrorMessage,
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
}

test.each([false, true])(
  'Stream search keeps its controls and filtered pack count while pending=%s',
  (pending) => {
    const markup = renderToStaticMarkup(
      <StreamFilterToolbar
        batchCounts={{ all: 20, episodes: 2, packs: 18 }}
        filteredCount={18}
        totalCount={20}
        filters={{ ...DEFAULT_FILTERS, batch: 'packs', source: 'cached' }}
        hasActiveFilter
        isResolving={false}
        isSearchPending={pending}
        onFiltersChange={() => {}}
        onResetFilters={() => {}}
        onSearchQueryChange={() => {}}
        onSearchSubmit={() => {}}
        searchQuery='release'
        showBatchFilter
        stats={{ ...streamSelectorFixture().stats, batchCount: 18 }}
      />,
    );
    expect(markup.includes('aria-busy="true"')).toBe(pending);
    expect(markup).toContain('value="release"');
    expect(markup).toContain('Clear search');
    expect(markup).toContain('Reset');
    // Counts reflect the other active filters — never a pre-filter total.
    expect(markup).toContain('>18</span>');
    expect(markup).not.toContain('18 total');
    expect(markup).not.toContain('Total before other filters');
  },
);

test.each([false, true])(
  'Filtered-empty state offers a filter reset (resolving=%s)',
  (resolving) => {
    const clear = mock(() => {});
    const view = StreamListFilteredEmptyState({
      isResolving: resolving,
      onClearFilters: clear,
    });
    const markup = renderToStaticMarkup(view);
    expect(markup).toContain('No streams match these filters');
    expect(markup).toContain('Show all streams');
    view.props.action.props.onClick();
    expect(clear).toHaveBeenCalledTimes(resolving ? 0 : 1);
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
    const client = testClient(false);
    const target = { type: 'movie' as const, id: 'selector-test' };
    const failure = new Error('Stream source unavailable');
    await client.prefetchQuery({
      ...api.addonConfigsQueryOptions(),
      queryFn: () => {
        throw new Error('Addon configuration unavailable');
      },
    });
    const data = streamSelectorFixture(
      available,
      hasEnabledAddons,
      selectorFailed ? failure.message : undefined,
    );
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
    function DefaultViewCheck() {
      const view = client
        .getQueryCache()
        .find({ queryKey: ['stream-selector-view'], exact: false });
      expect(view?.state.data).toMatchObject({ streams: data.streams });
      expect(view?.state.fetchStatus).toBe('idle');
      return null;
    }
    const markup = renderPage(
      () => (
        <>
          <StreamSelector open onClose={() => {}} target={target} />
          {available && <DefaultViewCheck />}
        </>
      ),
      '/details/movie/selector-test',
      client,
    );
    expect(markup.includes('Search streams by release, codec or keyword')).toBe(available);
    if (available) {
      expect(markup).toContain('role="radiogroup" aria-label="Quality filter"');
      expect(markup).toContain('role="radiogroup" aria-label="Sort order"');
      expect(markup.match(/aria-checked="true" tabindex="0"/g)).toHaveLength(2);
      expect(markup.match(/role="radio"/g)).toHaveLength(5);
    }
    expect(markup).not.toContain('Addon configuration unavailable');
    expect(markup.includes(failure.message)).toBe(!available && selectorFailed);
    expect(markup.includes('Retry</button>')).toBe(!available && selectorFailed);
    expect(markup.includes('No enabled stream sources.')).toBe(
      !available && !selectorFailed && !hasEnabledAddons,
    );
    expect(markup.includes('No addon provides Movie streams.')).toBe(
      !available && !selectorFailed && hasEnabledAddons,
    );
    expect(markup.includes('Manage addons')).toBe(!available && !selectorFailed);
  },
);

test('Selector pool eviction preserves live observers, placeholders, and current filter caches', async () => {
  type View = { streams: StreamSelectorData['streams'] };
  const client = testClient(false);
  const target = { type: 'series' as const, id: 'selector-pool-test', season: 1, episode: 1 };
  // `source` keeps the index query enabled — batch alone now splits client-side.
  const filters = { ...DEFAULT_FILTERS, batch: 'episodes' as const, source: 'cached' as const };
  const sourceKey = streamSelectorQueryKey(
    target.type,
    target.id,
    1,
    1,
    undefined,
    buildStreamRankingCacheKey(
      playerStreamRankingOptions({ mediaId: target.id, mediaType: target.type }),
    ),
  );
  const data = streamSelectorFixture();
  const row = data.streams[0];
  const indices = spyOn(api, 'getStreamSelectorIndices').mockImplementation(async (streams) =>
    streams.map((_, index) => index),
  );
  const otherSessionKey = ['stream-selector-view', 'other-session', 0];
  client.setQueryData(otherSessionKey, { streams: [row] });
  const cleanups: (() => void)[] = [];
  let observer: QueryObserverType<View> | undefined;
  let oldObserver: QueryObserverType<View> | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeOld: (() => void) | undefined;
  const renderView = (streams: StreamSelectorData['streams'], quality = 'all') => {
    client.setQueryData(STREAM_SELECTOR_PREFERENCES_QUERY_KEY, {
      initialized: true,
      preferences: filters,
      defaultPreferences: DEFAULT_FILTERS,
      episodeDefaultPreferences: { ...filters, quality },
    });
    client.setQueryData<StreamSelectorData>(sourceKey, { ...data, streams });
    capturedEffects = [];
    captureWithClient(client, () =>
      useStreamSelectorController({ target, open: true, onClose: () => {} }),
    );
    const effects = capturedEffects;
    capturedEffects = null;
    const query = client
      .getQueryCache()
      .findAll({ queryKey: ['stream-selector-view'] })
      .at(-1)!;
    const options = query.options as QueryObserverOptions<View>;
    if (observer) observer.setOptions(options);
    else {
      observer = new QueryObserver(client, options);
      unsubscribe = observer.subscribe(() => {});
    }
    runEffects(effects, cleanups);
    return query;
  };
  try {
    const first = renderView([row]);
    await observer!.getCurrentQuery().promise;
    oldObserver = new QueryObserver(client, {
      ...(first.options as QueryObserverOptions<View>),
      enabled: false,
    });
    unsubscribeOld = oldObserver.subscribe(() => {});
    const rows = [row, { ...row, streamKey: 'second' }];
    const second = renderView(rows);
    expect(observer!.getCurrentResult().isPlaceholderData).toBe(true);
    expect(observer!.getCurrentResult().data?.streams).toEqual([row]);
    expect(first.isActive()).toBe(false);
    expect(client.getQueryCache().get(first.queryHash)).toBe(first);
    await observer!.getCurrentQuery().promise;
    const filtered = renderView(rows, '720p');
    await observer!.getCurrentQuery().promise;
    expect(client.getQueryCache().get(second.queryHash)).toBe(second);
    expect(client.getQueryCache().get(filtered.queryHash)).toBe(filtered);
    const calls = indices.mock.calls.length;
    observer!.setOptions(second.options as QueryObserverOptions<View>);
    expect(observer!.getCurrentResult().isPlaceholderData).toBe(false);
    expect(indices).toHaveBeenCalledTimes(calls);
    unsubscribeOld();
    oldObserver.destroy();
    renderView([...rows, { ...row, streamKey: 'third' }]);
    expect(observer!.getCurrentResult().data?.streams).toEqual(rows);
    expect(client.getQueryCache().get(first.queryHash)).toBeUndefined();
    expect(client.getQueryCache().get(second.queryHash)).toBeUndefined();
    expect(client.getQueryCache().get(filtered.queryHash)).toBeUndefined();
    expect(client.getQueryCache().findAll({ queryKey: ['stream-selector-view'] })).toHaveLength(2);
    expect(client.getQueryData(otherSessionKey)).toEqual({ streams: [row] });
    await observer!.getCurrentQuery().promise;
  } finally {
    capturedEffects = null;
    for (const cleanup of cleanups.toReversed()) cleanup();
    unsubscribeOld?.();
    unsubscribe?.();
    oldObserver?.destroy();
    observer?.destroy();
    indices.mockRestore();
  }
});

test.each([false, true])(
  'Player keymap falls back only after an initial preference failure (stored=%s)',
  async (stored) => {
    const client = testClient(false);
    const defaults = { togglePlay: [' '] };
    const saved = {
      ...DEFAULT_APP_UI_PREFERENCES,
      effectivePlayerKeybindings: { togglePlay: ['p'] },
      playerKeybindings: { togglePlay: ['p'] },
    };
    if (stored) client.setQueryData(APP_UI_PREFERENCES_QUERY_KEY, saved);
    await client
      .fetchQuery({
        queryKey: APP_UI_PREFERENCES_QUERY_KEY,
        queryFn: async () => {
          throw new Error('Preference read failed');
        },
      })
      .catch(() => {});
    const keymap = captureWithClient(client, usePlayerKeymap);
    expect(
      client.getQueryCache().find({ queryKey: DEFAULT_PLAYER_KEYBINDINGS_QUERY_KEY })?.options
        .enabled,
    ).toBe(!stored);
    client.setQueryData(DEFAULT_PLAYER_KEYBINDINGS_QUERY_KEY, defaults);
    const loaded = captureWithClient(client, usePlayerKeymap);
    expect(loaded.keys.togglePlay).toEqual(stored ? ['p'] : [' ']);
    expect(keymap.overrides).toEqual(stored ? saved.playerKeybindings : {});
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
  const client = createClient();
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
  }
});

const SECTION_ITEM = {
  id: 'tt0944947',
  type: 'series',
  title: 'Game of Thrones',
  runtime: '60 min',
} as MediaDetails;

test('Credits links pass the title identity to their scoped Rust command', async () => {
  spyOn(appUpdater, 'isTauriDesktopRuntime').mockReturnValue(true);
  const invoke = spyOn(tauriCore, 'invoke').mockResolvedValue(undefined);
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
});

const renderSections = (props: Partial<ComponentProps<typeof DetailsSections>> = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <DetailsSections
        item={SECTION_ITEM}
        credits={SECTION_CREDITS}
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
};

test('Details sections stack episodes and cast with attribution', () => {
  const markup = renderSections();
  expect(markup).not.toContain('role="tablist"');
  expect(markup).not.toContain('role="tab"');
  expect(markup).not.toContain('hidden=""');
  expect(markup).toContain('id="details-episodes-heading"');
  expect(markup).toContain('data-episodes-children');
  expect(markup).toContain('id="details-cast-heading"');
  expect(markup).toContain('href="/search?q=Peter%20Dinklage"');
  expect(markup).toContain('Tyrion Lannister');
  expect(markup).toContain('>PD<');
  expect(markup).toContain('https://www.tvmaze.com');
  expect(markup).toContain('https://creativecommons.org/licenses/by-sa/4.0/');
});

test('Details sections label anime cast Characters and handle sparse credits', () => {
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
  const markup = renderSections({ item: anime, credits: animeCredits });
  expect(markup).toContain('Characters');
  expect(markup).not.toContain('href="/search?q=Eren%20Yeager"');
  expect(markup).toContain('href="/search?q=Yuki%20Kaji"');
  expect(markup).toContain('href="https://anilist.co"');
  expect(markup).not.toContain('tvmaze.com');
  const sparse = renderSections({ credits: undefined });
  expect(sparse).toContain('Episodes');
  expect(sparse).toContain('data-episodes-children');
  expect(sparse).not.toContain('details-cast-heading');
  expect(sparse).not.toContain('creativecommons.org');
  expect(renderSections({ hasEpisodes: false, credits: undefined })).toBe('');
  expect(renderSections({ item: { ...SECTION_ITEM, type: 'movie' } })).toBe('');
});

test('Details viewport observer waits for the enabled late anchor', () => {
  const observe = mock((_element: unknown) => {});
  const disconnect = mock(() => {});
  const restoreObserver = stubGlobal('IntersectionObserver', function () {
    return { observe, disconnect };
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
    restoreObserver();
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
  const client = createClient({ defaultOptions: { queries: { retry: false } } });
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
    renderDetails(client, `/details/series/${id}`);
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
  }
});

test('Season completion remains available for the last unwatched episode', () => {
  const client = testClient();
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
  const render = () => renderDetails(client, `/details/series/${id}`);
  render();
  const unaired = client
    .getQueryCache()
    .getAll()
    .find((query) => query.queryKey.includes('unaired-episodes'));
  if (!unaired) throw new Error('Missing episode air-state query');
  client.setQueryData(unaired.queryKey, new Set());
  expect(render()).toContain('Mark season watched');
});

test.each([false, true])(
  'Shared search exposes pending state and clears without scrolling (%s)',
  (pending) => {
    const onValueChange = mock((_value: string) => {});
    const focus = mock(() => {});
    const inputRef = { current: { focus } } as unknown as ComponentProps<
      typeof SearchInput
    >['inputRef'];
    let element!: ReturnType<typeof SearchInput>;
    function Probe() {
      element = SearchInput({
        value: 'Dune',
        onValueChange,
        inputRef,
        pending,
        'aria-label': 'Find titles',
      });
      return element;
    }
    const html = renderToStaticMarkup(<Probe />);
    expect(html.includes('aria-busy="true"')).toBe(pending);
    expect(html).toContain('aria-label="Find titles"');
    element.props.children[2].props.onClick();
    expect(onValueChange.mock.calls).toEqual([['']]);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  },
);

test('Sidebar update indicator links directly to update settings', () => {
  const client = testClient();
  client.setQueryData(appUpdater.APP_UPDATE_STATE_QUERY_KEY, {
    ...appUpdater.getInitialAppUpdateState(),
    status: 'available',
    update: { version: '0.9.4', notificationEligible: false },
  });
  const html = renderPage(Sidebar, '/', client);
  const settingsLink = html.match(/<a\b[^>]*aria-label="Settings"[^>]*>/)?.[0];
  expect(settingsLink).toContain('href="/settings?section=updates"');
});

test('Settings menu selection skips the current value and accepts a different value', () => {
  const onChange = mock((_value: string) => {});
  const menu = SettingsSelect({
    ariaLabel: 'Quality',
    value: 'auto',
    valueLabel: 'Auto',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'high', label: 'High' },
    ],
    onChange,
  });
  const [, content] = menu.props.children;
  const [current, other] = content.props.children;
  current.props.onSelect();
  expect(onChange).not.toHaveBeenCalled();
  other.props.onSelect();
  expect(onChange.mock.calls).toEqual([['high']]);
});

test('Retry feedback blocks repeat activation while keeping the button focusable', () => {
  const onRetry = mock(() => {});
  const banner = RetryBanner({ message: 'Could not load titles.', isRetrying: true, onRetry });
  const [, button] = banner.props.children;
  button.props.onClick();
  expect(onRetry).not.toHaveBeenCalled();
  expect(button.props.disabled).toBeUndefined();
  expect(renderToStaticMarkup(banner)).toContain('Retrying…');
  const [, readyButton] = RetryBanner({ message: 'Could not load titles.', onRetry }).props
    .children;
  readyButton.props.onClick();
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('Collection shortcuts only act within the focused collection', () => {
  const appWindow = new EventTarget();
  let focusedCollection: { contains: (node: unknown) => boolean } | null = null;
  const restoreWindow = stubGlobal('window', appWindow);
  const restoreDocument = stubGlobal('document', {
    activeElement: { closest: () => focusedCollection },
    querySelector: () => null,
  });
  const restoreElement = stubGlobal('HTMLElement', EventTarget);
  const state = mockInitialState(false, true);
  const trigger = {} as HTMLButtonElement;
  function Collection() {
    useCollectionSelection(['title'], ['title'], true, false).triggerRef.current = trigger;
    return null;
  }
  const cleanups: (() => void)[] = [];
  capturedEffects = [];
  try {
    renderToStaticMarkup(<Collection />);
    runEffects(capturedEffects, cleanups);
    const selectAll = () => {
      const event = Object.assign(new Event('keydown', { cancelable: true }), {
        key: 'a',
        ctrlKey: true,
      });
      appWindow.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(selectAll()).toBe(false);
    focusedCollection = { contains: () => false };
    expect(selectAll()).toBe(false);
    focusedCollection = { contains: (node) => node === trigger };
    expect(selectAll()).toBe(true);
  } finally {
    cleanups.toReversed().forEach((cleanup) => cleanup());
    capturedEffects = null;
    state.mockRestore();
    restoreElement();
    restoreDocument();
    restoreWindow();
  }
});

test('Save picker distinguishes saved lists and names each membership action', () => {
  const client = createClient();
  const item = { id: 'save-picker', type: 'movie' as const, title: 'A film' };
  client.setQueryData(listSummariesQueryKey(item.id), [
    { id: 'saved', name: 'Weekend cinema', icon: 'Film', item_count: 12, contains_item: true },
    { id: 'other', name: 'Watch later', icon: 'Clock', item_count: 3, contains_item: false },
  ]);
  function Picker() {
    const actions = useMediaCollectionActions({ item, isInLibrary: true });
    return (
      <SaveToCollectionPanel
        item={item}
        isInLibrary
        showLibrary
        actions={actions}
        onCreateList={() => {}}
      />
    );
  }
  const markup = renderPage(Picker, '/details/movie/save-picker', client);
  expect(markup).toContain('aria-label="Remove from library"');
  expect(markup).toContain('aria-label="Remove from Weekend cinema"');
  expect(markup).toContain('aria-label="Add to Watch later"');
  expect(markup).toContain('Added · 12 titles');
  expect(markup).toContain('>3 titles<');
  expect(markup).toContain('title="Weekend cinema"');
});

const bulkListItem = (id: string): MediaItem => ({ id, type: 'movie', title: id });

test.each([false, true])(
  'Bulk list additions keep requested order and roll back on failure (%s)',
  async (fails) => {
    const client = testClient();
    const original = bulkListItem('saved');
    const refreshed = { ...bulkListItem('b'), title: 'Refreshed B' };
    client.setQueryData(['library'], [bulkListItem('a'), bulkListItem('b')]);
    client.setQueryData(profileLibraryQueryKey({}), {
      items: [refreshed, bulkListItem('c')],
      allIds: ['a', 'b', 'c'],
      statusCounts: {},
    });
    const list: UserList = {
      id: 'list_a',
      name: 'List',
      icon: 'Film',
      item_ids: ['saved'],
      items: [original],
    };
    client.setQueryData(['lists'], [list]);
    const native = Promise.withResolvers<number>();
    const started = Promise.withResolvers<void>();
    const add = spyOn(api, 'bulkAddToList').mockImplementation(() => {
      started.resolve();
      return native.promise;
    });
    let pending: Promise<number | undefined> | undefined;
    try {
      const mutation = captureWithClient(client, useBulkAddToList);
      pending = mutation
        .mutateAsync({ listId: list.id, itemIds: ['b', 'c', 'a', 'b', 'missing'] })
        .catch((error: unknown) => {
          if (!fails) throw error;
          return undefined;
        });
      await started.promise;
      const optimistic = client.getQueryData<UserList[]>(['lists'])![0];
      expect(optimistic.item_ids).toEqual(['saved', 'b', 'c', 'a']);
      expect(optimistic.items?.map((row) => row.id)).toEqual(optimistic.item_ids);
      expect(optimistic.items?.[1]?.title).toBe('Refreshed B');
      if (fails) native.reject(new Error('Write failed'));
      else native.resolve(3);
      await pending;
      if (fails) expect(client.getQueryData<UserList[]>(['lists'])).toEqual([list]);
    } finally {
      native.resolve(3);
      await pending;
      add.mockRestore();
    }
  },
);
