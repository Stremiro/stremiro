import { expect, mock, test } from 'bun:test';
import {
  addonSubtitleFixture,
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
  SearchCatalogPage,
  StreamSelectorData,
  TitleCredits,
  UserList,
} from '../src/lib/api';
import type {
  QueryClient,
  QueryObserver as QueryObserverType,
  QueryObserverOptions,
  QueryObserverResult,
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

const { InfiniteQueryObserver, QueryObserver, QueryClientProvider, onlineManager } =
  await import('@tanstack/react-query');
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
  CALENDAR_EVENTS_STALE_TIME_MS,
  CALENDAR_PARTIAL_STALE_TIME_MS,
  DEFAULT_PLAYER_KEYBINDINGS_QUERY_KEY,
  DETAILS_QUERY_KEY,
  RECENT_WATCH_SEED_QUERY_KEY,
  addonSubtitlesQueryKey,
  calendarEventsQueryKey,
  detailsCardQueryKey,
  invalidateDiscoveryQueries,
  listSummariesQueryKey,
  profileLibraryQueryKey,
  resumeRailQueryKey,
  invalidateAddonCapabilityQueries,
  SEARCH_CATALOG_QUERY_KEY,
  streamSelectorQueryKey,
  STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
  titleWatchProgressQueryKey,
} = await import('../src/lib/query-invalidation');
const { pendingDetailsPrefetch, prefetchDetailsRouteData } =
  await import('../src/lib/details-prefetch');
const { applyResolvedStreamToSession, playerStreamRankingOptions } =
  await import('../src/lib/resolve-player-stream');
const { buildStreamRankingCacheKey } = await import('../src/lib/stream-ranking-cache-key');

const { StreamSelector } = await import('../src/components/stream-selector');
const { StreamFilterToolbar, StreamListFilteredEmptyState } =
  await import('../src/components/stream-selector-panel');
const { AddTitlesDialog } = await import('../src/components/list/add-titles-dialog');
const { SaveToCollectionPanel } = await import('../src/components/list/save-to-collection');
const { DetailsSections, NextAiringChip } = await import('../src/components/details-sections');
const { useNearViewport } = await import('../src/hooks/use-near-viewport');
const detailsSelector = await import('../src/hooks/use-details-stream-selector');
const detailsPane = await import('../src/hooks/use-details-episode-pane');
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
const { usePlaybackProgressPersistence } =
  await import('../src/hooks/use-playback-progress-persistence');
const { getPlayerStreamLoadKey, usePlayerMpvLifecycle } =
  await import('../src/hooks/use-player-mpv-lifecycle');
const { usePlayerResumeController } = await import('../src/hooks/use-player-resume-controller');
const { useMpvSetScheduler } = await import('../src/hooks/use-mpv-set-scheduler');
const { useSubtitleAdjustments } = await import('../src/hooks/use-subtitle-adjustments');
const { PlayerUpNextCard } = await import('../src/components/player-state-overlays');
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
const { claimPlaybackLaunch, launchResolvedStream, resolvePlayerLaunch } =
  await import('../src/lib/player-navigation');
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

// Arms the effect capture around a render; returns its value and captured effects.
function captureRenderEffects<T>(render: () => T): [T, EffectCallback[]] {
  capturedEffects = [];
  const value = render();
  const effects = capturedEffects ?? [];
  capturedEffects = null;
  return [value, effects];
}

// Renders and drains the captured effects into `cleanups`.
function renderWithEffects<T>(render: () => T, cleanups: (() => void)[] = []): T {
  const [value, effects] = captureRenderEffects(render);
  runEffects(effects, cleanups);
  return value;
}

const stubLocation = (pathname: string) =>
  stubGlobal('window', { location: { pathname, search: '' } });

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
    try {
      renderWithEffects(() => renderToStaticMarkup(<Probe />), cleanups);
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
    renderWithEffects(() => renderToStaticMarkup(<AppCloseManager />), cleanups);
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

test('A selected stream reaches the player once even when its reuse TTL is exhausted', async () => {
  const restoreWindow = stubGlobal('window', { location: { pathname: '/details/movie/tt1' } });
  const cleanups: (() => void)[] = [];
  const result = {
    url: 'https://video.example/clip',
    cacheTtlMs: 0,
    mpvHttpHeaderFields: 'Fixture header',
    streamKey: 'the winner',
  };
  const fetch = spyOn(api, 'resolveBestStream').mockResolvedValue(result);
  const navigate = mock((_path: unknown, _options?: { state?: unknown }) => {});
  const setActiveStreamUrl = mock(() => {});
  try {
    launchResolvedStream(
      navigate,
      { mediaId: 'tt1', mediaType: 'movie' },
      result,
      {},
      {
        streamKey: 'original pick',
      },
    );
    const state = navigate.mock.calls[0]?.[1]?.state;
    expect(JSON.stringify(state)).not.toContain(result.url);
    expect(JSON.stringify(state)).not.toContain(result.mpvHttpHeaderFields);
    const launch = resolvePlayerLaunch({ type: 'movie', id: 'tt1', state });
    expect(launch.requestedStreamKey).toBe('original pick');
    function PlayerMount() {
      usePlayerAutoResolve({
        autoResolveGenRef: { current: 0 },
        effectiveResolveMediaType: 'movie',
        error: null,
        id: launch.id,
        isResolving: false,
        mountedRef: { current: true },
        resolvedLaunchId: launch.resolvedLaunchId,
        routeRequestedStreamKey: launch.requestedStreamKey,
        stream: {
          activeStreamSourceIdRef: { current: undefined },
          activeStreamSourceNameRef: { current: undefined },
          activeStreamFamilyRef: { current: undefined },
          committedStreamUrlRef: { current: undefined },
          selectedStreamKeyRef: { current: undefined },
          streamLookupIdRef: { current: undefined },
          reloadStream: () => {},
          setActiveStreamUrl,
        },
        setError: () => {},
        setResolveStatus: () => {},
        shouldWaitForResolvedLookupId: true,
        showStreamSelector: false,
        stopLoading: () => {},
        type: launch.type,
      });
      return null;
    }
    renderWithEffects(() => renderToStaticMarkup(<PlayerMount />), cleanups);
    await Promise.resolve();
    expect(setActiveStreamUrl).toHaveBeenCalledWith(
      result.url,
      result.mpvHttpHeaderFields,
      result.streamKey,
      undefined,
    );
    expect(fetch).not.toHaveBeenCalled();
    renderWithEffects(() => renderToStaticMarkup(<PlayerMount />), cleanups);
    await Promise.resolve();
    expect(setActiveStreamUrl).toHaveBeenCalledTimes(1);
  } finally {
    cleanupEffects(cleanups);
    fetch.mockRestore();
    restoreWindow();
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
    renderWithEffects(() => renderToStaticMarkup(<BrowseHotkeysFixture />), cleanups);

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

test('Case-only text shares the catalog cache and stale first pages refresh in place', async () => {
  const client = createClient();
  const options = caseInsensitiveCatalogOptions('Dune', 'Drama');
  const fetch = spyOn(api, 'querySearchCatalogPage').mockResolvedValue({
    items: [],
    exhausted: true,
    partial: false,
    continuation: { seenKeys: [] },
  });
  await client.prefetchInfiniteQuery(options);
  await client.prefetchInfiniteQuery(caseInsensitiveCatalogOptions('DUNE', 'DRAMA'));
  await client.prefetchInfiniteQuery(caseInsensitiveCatalogOptions('dune', 'drama'));
  expect(fetch).toHaveBeenCalledTimes(1);

  const cached = client.getQueryData(options.queryKey);
  client.setQueryData(options.queryKey, cached, { updatedAt: Date.now() - 31_000 });
  const refresh = client.prefetchInfiniteQuery(options);
  expect(client.getQueryData(options.queryKey)).toBe(cached);
  await refresh;
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('Catalog IPC stays live until the last observer leaves', async () => {
  const page = Promise.withResolvers<SearchCatalogPage>();
  const started = Promise.withResolvers<string>();
  const invoke = mock((command: string, args: { requestId: string }) => {
    if (command === 'query_search_catalog') {
      started.resolve(args.requestId);
      return page.promise;
    }
    return Promise.resolve();
  });
  const restore = stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
  const client = createClient();
  const options = caseInsensitiveCatalogOptions('Interstellar', 'Drama');
  const first = new InfiniteQueryObserver(client, options).subscribe(() => {});
  const second = new InfiniteQueryObserver(client, options).subscribe(() => {});
  try {
    const requestId = await started.promise;
    first();
    expect(invoke).toHaveBeenCalledTimes(1);
    second();
    expect(invoke).toHaveBeenLastCalledWith('cancel_stream_request', { requestId }, undefined);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
  } finally {
    first();
    second();
    page.resolve({ items: [], exhausted: true, partial: false, continuation: { seenKeys: [] } });
    restore();
  }
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
    addonSubtitleFixture('en', 'https://subs.test/old.srt', {
      sourceId: 'subs',
      sourceName: 'Subs',
    }),
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
    renderWithEffects(render, cleanups);
    expect(matchLanguage).not.toHaveBeenCalled();
    const query = client.getQueryCache().find({ queryKey: key })!;
    const observer = new QueryObserver(client, query.options);
    unsubscribe = observer.subscribe(() => {});
    await query.promise;
    expect(fetch).toHaveBeenCalledTimes(1);
    menuOpen = true;
    renderWithEffects(render, cleanups);
    await query.promise;
    expect(fetch).toHaveBeenCalledTimes(2);
    menuOpen = false;

    client.setDefaultOptions({ queries: { refetchOnMount: false } });
    client.setQueryData(key, cached);
    renderWithEffects(render, cleanups);
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

test('Automatic subtitles try the next ranked file when the first download fails', async () => {
  const client = createClient({ defaultOptions: { queries: { refetchOnMount: false } } });
  const key = ['addonSubtitles', 'movie', 'tt1', null, null];
  const first = addonSubtitleFixture('eng', 'https://subs.test/unavailable.srt');
  const backup = addonSubtitleFixture('eng', 'https://subs.test/backup.srt');
  client.setQueryData(key, [first, { ...first, id: 'same-file' }, backup]);
  const rank = spyOn(api, 'resolvePreferredTrackSelection').mockImplementation(async (tracks) => ({
    selectedMatches: false,
    matchedTrackId: tracks[0]?.id,
  }));
  const selected = Promise.withResolvers<void>();
  const attempts: string[] = [];
  const cleanups: (() => void)[] = [];
  try {
    renderWithEffects(
      () =>
        captureWithClient(client, () =>
          usePlayerAddonSubtitles(
            addonSubtitleArgs({
              autoLoadLanguage: 'eng',
              selectAddonSubtitle: async ({ url }) => {
                attempts.push(url);
                if (url !== backup.url) return false;
                selected.resolve();
                return true;
              },
            }),
          ),
        ),
      cleanups,
    );
    await selected.promise;
    expect(attempts).toEqual([first.url, backup.url]);
    expect(rank).toHaveBeenCalledTimes(2);
  } finally {
    cleanupEffects(cleanups);
    rank.mockRestore();
  }
});

test('Exhausted automatic subtitles do not re-trigger when reopening the subtitles menu', async () => {
  const client = createClient({ defaultOptions: { queries: { refetchOnMount: false } } });
  const key = ['addonSubtitles', 'movie', 'tt1', null, null];
  const broken = addonSubtitleFixture('eng', 'https://subs.test/broken.srt');
  client.setQueryData(key, [broken]);
  const rank = spyOn(api, 'resolvePreferredTrackSelection').mockResolvedValue({
    selectedMatches: false,
    matchedTrackId: 0,
  });
  const done = Promise.withResolvers<void>();
  const select = mock(async () => {
    done.resolve();
    return false;
  });
  const cleanups: (() => void)[] = [];
  try {
    const [, effects] = captureRenderEffects(() =>
      captureWithClient(client, () =>
        usePlayerAddonSubtitles(
          addonSubtitleArgs({
            autoLoadLanguage: 'eng',
            selectAddonSubtitle: select,
          }),
        ),
      ),
    );
    runEffects(effects, cleanups);
    await done.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(select).toHaveBeenCalledTimes(1);
    expect(rank).toHaveBeenCalledTimes(1);

    // Re-running the auto-load effect models a menu-open refetch bumping dataUpdatedAt.
    const autoLoadEffect = effects.at(-1)!;
    const cleanup = autoLoadEffect();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(select).toHaveBeenCalledTimes(1);
    expect(rank).toHaveBeenCalledTimes(1);
  } finally {
    cleanupEffects(cleanups);
    rank.mockRestore();
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
      const [hook, effects] = captureRenderEffects(() =>
        captureWithClient(client, () =>
          usePlayerAddonSubtitles(addonSubtitleArgs({ selectAddonSubtitle: select })),
        ),
      );
      runEffects(effects, cleanups);
      const subtitle = addonSubtitleFixture('sub', 'https://example.com/sub');
      const pending = hook.handleAddonSubtitleSelect(subtitle, { automatic });
      const duplicate = hook.handleAddonSubtitleSelect(subtitle, { automatic });
      let replacementSelection: ReturnType<typeof hook.handleAddonSubtitleSelect> | undefined;
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
  const restoreWindow = stubLocation('/profile');
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

test('progress saves preserve playback identity and recency during pauses and replacements', async () => {
  const restoreWindow = stubGlobal('window', new EventTarget());
  const restoreDocument = stubGlobal('document', new EventTarget());
  const client = testClient();
  const save = spyOn(api, 'saveWatchProgress').mockResolvedValue(undefined);
  const now = spyOn(Date, 'now').mockReturnValue(1_000_000);
  const stream: Parameters<typeof usePlaybackProgressPersistence>[0]['stream'] = {
    activeStreamUrl: 'https://example.com/a',
    activeStreamKey: 's:a',
    reloadStream: () => {},
    activeStreamSourceIdRef: { current: 'a' },
    activeStreamSourceNameRef: { current: 'Source A' },
    activeStreamFamilyRef: { current: 'family:a' },
    selectedStreamKeyRef: { current: 's:a' },
    streamLookupIdRef: { current: 'tt-progress' },
    committedStreamUrlRef: { current: undefined },
    setActiveStreamUrl: (url, _headers, key) => {
      stream.activeStreamUrl = url;
      stream.activeStreamKey = key;
    },
  };
  const observedPositionRef = { current: 120 };
  const durationRef = { current: 600 };
  const { Fixture, captured } = captureHook(() =>
    usePlaybackProgressPersistence({
      activeStreamLoadKey: getPlayerStreamLoadKey(stream),
      mediaId: 'tt-progress',
      mediaType: 'movie',
      title: 'Progress',
      isPlaying: false,
      observedPositionRef,
      durationRef,
      stream,
    }),
  );
  const cleanups: (() => void)[] = [];
  try {
    const [, effects] = captureRenderEffects(() => markupWithClient(client, <Fixture />));
    runEffects(effects, cleanups);
    const { saveProgress } = await captured.promise;
    await saveProgress();
    now.mockReturnValue(1_060_000);
    applyResolvedStreamToSession(stream, {
      url: 'https://example.com/b',
      cacheTtlMs: 0,
      streamKey: 's:b',
      sourceId: 'b',
      sourceName: 'Source B',
      streamFamily: 'family:b',
    });
    stream.streamLookupIdRef.current = 'tt-updated-lookup';
    await saveProgress();
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        position: 120,
        last_watched: 1_000_000,
        last_stream_lookup_id: 'tt-updated-lookup',
        last_stream_key: 's:a',
        source_id: 'a',
        source_name: 'Source A',
        stream_family: 'family:a',
      }),
    );
    observedPositionRef.current = 121;
    await saveProgress();
    expect(save.mock.calls.at(-1)?.[0].last_watched).toBe(1_060_000);
    cleanupEffects(cleanups);
    cleanups.length = 0;
    runEffects(effects, cleanups);
    observedPositionRef.current = 30;
    await saveProgress();
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        position: 30,
        last_watched: 1_060_000,
        last_stream_key: 's:b',
        source_id: 'b',
        source_name: 'Source B',
        stream_family: 'family:b',
      }),
    );
  } finally {
    cleanupEffects(cleanups);
    restoreSpies(save, now);
    restoreWindow();
    restoreDocument();
  }
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
    const [, effects] = captureRenderEffects(() => renderToStaticMarkup(<Fixture />));
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

const mpvLifecycleModes = [
  'seek',
  'unknown-duration-eof',
  'startup-idle',
  'failed-load',
  'late-listener',
  'slow-probe',
  'cancel-before-init',
] as const;
test.each(mpvLifecycleModes)('mpv lifecycle (%s)', async (mode) => {
  const positionTimers = mock(setTimeout);
  const restoreWindow = stubGlobal('window', {
    setTimeout: positionTimers,
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
  const startup = mode === 'startup-idle' || mode === 'failed-load';
  const lateListener = Promise.withResolvers<() => void>();
  const unlisten = mock(() => {});
  let emit: Parameters<typeof playerMpv.listenMpvEvents>[0] | undefined;
  const listen = spyOn(playerMpv, 'listenMpvEvents').mockImplementation(async (callback) => {
    emit = callback;
    if (mode === 'late-listener') return lateListener.promise;
    if (startup) callback({ event: 'property-change', name: 'idle-active', data: true });
    return unlisten;
  });
  const loadAck = Promise.withResolvers<void>();
  const recover = mock(async () => false);
  const command = spyOn(playerMpv, 'mpvCommand').mockImplementation(async (name) => {
    if (name === 'loadfile' && startup) {
      expect(recover).not.toHaveBeenCalled();
      emit?.({ event: 'start-file', playlist_entry_id: 1 });
      emit?.({ event: 'property-change', name: 'idle-active', data: false });
      if (mode === 'failed-load')
        emit?.({ event: 'property-change', name: 'idle-active', data: true });
      await loadAck.promise;
    }
  });
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
    const stream = {
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
    };
    usePlayerMpvLifecycle({
      stream,
      activeStreamLoadKey: getPlayerStreamLoadKey(stream),
      isHistoryResume: false,
      playbackSpeedRef: { current: 1 },
      subtitleSettingsRef: { current: { delay: 0, pos: 100, scale: 1 } },
      playbackLanguagePreferencesRef: { current: {} },
      volumeRef: { current: 100 },
      isMutedRef: { current: false },
      mountedRef: { current: true },
      isDestroyedRef: { current: false },
      mpvInitializedRef,
      isLoading: startup,
      isPlayingRef: { current: true },
      clock,
      observedPositionRef: { current: null },
      bufferedClock: createPlaybackClock(),
      durationRef,
      playbackVerifiedAtRef: { current: startup ? 0 : 1000 },
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
      recoverFromSlowStartup: recover,
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
    const [, effects] = captureRenderEffects(() =>
      markupWithClient(
        client,
        <PlayerSessionProvider>
          <Fixture />
        </PlayerSessionProvider>,
      ),
    );
    const seeking = await controller.promise;
    runEffects(effects, cleanups);
    if (mode === 'cancel-before-init') {
      cleanupEffects(cleanups.splice(0));
      await Bun.sleep(0);
      expect(init).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      return;
    }
    await Bun.sleep(0);
    if (mode === 'late-listener') {
      expect(listen).toHaveBeenCalledTimes(1);
      for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
      lateListener.resolve(unlisten);
      await Bun.sleep(0);
      expect(unlisten).toHaveBeenCalledTimes(1);
      property('duration', 240);
      expect(durationRef.current).toBe(0);
      expect(command).not.toHaveBeenCalledWith('loadfile', ['https://example.com/seek', 'replace']);
      return;
    }
    expect(mpvInitializedRef.current).toBe(true);
    if (mode === 'slow-probe') {
      const pending = Promise.withResolvers<typeof snapshot>();
      probe.mockReturnValueOnce(pending.promise);
      property('pause', false);
      property('paused-for-cache', true);
      property('paused-for-cache', false);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(positionTimers).toHaveBeenCalledTimes(1);
      pending.resolve(snapshot);
      await Bun.sleep(0);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(positionTimers).toHaveBeenCalledTimes(2);
      expect(clock.ref.current).toBe(snapshot.timePos);
      return;
    }
    if (mode === 'unknown-duration-eof') {
      expect(durationRef.current).toBe(0);
      const stale = Promise.withResolvers<typeof snapshot>();
      probe.mockReturnValueOnce(stale.promise);
      property('eof-reached', true);
      expect(onEndedChange).not.toHaveBeenCalled();
      stale.resolve({ ...snapshot, eofReached: false });
      await Bun.sleep(0);
      expect(onEndedChange).not.toHaveBeenCalledWith(true);
      const confirmed = Promise.withResolvers<typeof snapshot>();
      probe.mockReturnValueOnce(confirmed.promise);
      property('eof-reached', true);
      confirmed.resolve({ ...snapshot, eofReached: true });
      await Bun.sleep(0);
      expect(onEndedChange).toHaveBeenCalledWith(true);
      return;
    }
    if (startup) {
      expect(command).toHaveBeenCalledWith('loadfile', ['https://example.com/seek', 'replace']);
      if (mode === 'failed-load') {
        expect(recover).toHaveBeenCalledTimes(1);
        expect(setStreamError).toHaveBeenCalledWith('Stream failed to load. Try another stream.');
      } else {
        expect(recover).not.toHaveBeenCalled();
        expect(setStreamError).not.toHaveBeenCalled();
      }
      loadAck.resolve();
      await Bun.sleep(0);
      return;
    }
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
    probe.mockResolvedValue({
      ...snapshot,
      timePos: 120,
      nearCompletion: true,
      eofReached: true,
    });
    property('eof-reached', true);
    await Bun.sleep(0);
    expect(onEndedChange).toHaveBeenCalledWith(true);
    expect(save).toHaveBeenCalledTimes(1);
  } finally {
    capturedEffects = null;
    loadAck.resolve();
    lateListener.resolve(unlisten);
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
      const [, effects] = captureRenderEffects(() =>
        renderToStaticMarkup(
          <MemoryRouter>
            <PlayerSessionProvider>
              <ResumeFixture />
            </PlayerSessionProvider>
          </MemoryRouter>,
        ),
      );
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

// Runs the real React Compiler pipeline — heavyweight, needs a wider timeout than the 5s default.
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
}, 20_000);

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

test.each(['empty', 'resume', 'offline'] as const)(
  'Home keeps the resume rail independent of stream addon guidance (%s)',
  (state) => {
    const client = testClient();
    const connectivity = Object.getOwnPropertyDescriptor(navigator, 'onLine')!;
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: state !== 'offline' });
    client.setQueryData(homeTrendingQueryOptions.queryKey, []);
    client.setQueryData(
      resumeRailQueryKey(Temporal.Now.plainDateISO().toString()),
      state === 'resume'
        ? [
            {
              row: {
                id: 'resume-fixture',
                type_: 'movie',
                title: 'Partially Watched',
                position: 900,
                duration: 5400,
                last_watched: 1000,
              },
            },
          ]
        : [],
    );
    client.setQueryData(api.addonConfigsQueryOptions().queryKey, [
      {
        id: 'catalog-addon',
        name: 'Catalog fixture',
        enabled: true,
        resources: ['catalog', 'meta'],
      },
    ]);
    try {
      const markup = markupWithClient(
        client,
        <PlayerSessionProvider>
          <Home />
        </PlayerSessionProvider>,
      );
      expect(markup).not.toMatch(/(?:Add|Enable) a stream addon to watch titles\./);
      expect(markup.includes('offline. Reconnect')).toBe(state === 'offline');
      expect(markup.includes('data-resume-section')).toBe(state === 'resume');
      if (state === 'resume') expect(markup).toContain('Partially Watched');
    } finally {
      client.clear();
      Object.defineProperty(navigator, 'onLine', connectivity);
    }
  },
);

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

const DETAILS_FLOW_ITEM: MediaDetails = {
  id: 'details-flow',
  type: 'series',
  title: 'Details flow',
  description: 'Series summary',
  episodes: [
    { id: 'e1', season: 1, episode: 1, title: 'Pilot', overview: 'Pilot overview' },
    { id: 'e2', season: 1, episode: 2, title: 'Secret reveal', overview: 'Secret overview' },
  ],
  seasons: [{ number: 1, episodeCount: 2 }],
};

test.each(['pending', 'error', 'enabled', 'disabled'] as const)(
  'Details selector shares the cards hydration-safe spoiler policy (%s)',
  (preference) => {
    const client = testClient(false);
    const route = `/details/series/${DETAILS_FLOW_ITEM.id}`;
    client.setQueryData(
      api.detailsQueryOptions('series', DETAILS_FLOW_ITEM.id).queryKey,
      DETAILS_FLOW_ITEM,
    );
    if (preference === 'enabled' || preference === 'disabled') {
      client.setQueryData(APP_UI_PREFERENCES_QUERY_KEY, {
        ...DEFAULT_APP_UI_PREFERENCES,
        spoilerProtection: preference === 'enabled',
      });
    } else if (preference === 'error') {
      client
        .getQueryCache()
        .build(client, { queryKey: APP_UI_PREFERENCES_QUERY_KEY })
        .setState({
          status: 'error',
          error: new Error('Preferences unavailable'),
        });
    }
    const original = detailsSelector.useDetailsStreamSelector;
    let args!: Parameters<typeof original>[0];
    const selector = spyOn(detailsSelector, 'useDetailsStreamSelector').mockImplementation(
      (input) => {
        args = input;
        return original(input);
      },
    );
    renderDetails(client, route);
    selector.mockRestore();
    const masked = preference !== 'disabled';
    expect(args.spoilerProtection).toBe(masked);
    const restoreWindow = stubLocation(route);
    spyOn(appNavigation, 'navigateApp').mockReturnValue(true);
    const initialState = react.useState;
    let target: unknown;
    const state = spyOn(react, 'useState').mockImplementation((initial: unknown) => {
      const result = initialState(initial);
      return initial === null
        ? [
            result[0],
            (next: unknown) => {
              target = next;
            },
          ]
        : result;
    });
    try {
      for (const reopen of [false, true]) {
        target = undefined;
        const [controller, effects] = captureRenderEffects(() =>
          captureWithClient(client, () =>
            original({
              ...args,
              locationState: reopen
                ? { reopenStreamSelector: true, reopenStreamSeason: 1, reopenStreamEpisode: 2 }
                : undefined,
            }),
          ),
        );
        if (reopen) runEffects(effects, []);
        else controller.openEpisodeStreamSelector(DETAILS_FLOW_ITEM.episodes![1]);
        expect(target).toMatchObject({
          targetMasked: masked,
          episodeTitle: masked ? 'Episode 2' : 'Secret reveal',
          overview: masked ? 'Series summary' : 'Secret overview',
        });
      }
      target = undefined;
      const [pilotController] = captureRenderEffects(() =>
        captureWithClient(client, () => original({ ...args, locationState: undefined })),
      );
      pilotController.openEpisodeStreamSelector(DETAILS_FLOW_ITEM.episodes![0]);
      expect(target).toMatchObject({
        targetMasked: false,
        episodeTitle: 'Pilot',
        overview: 'Pilot overview',
      });
    } finally {
      capturedEffects = null;
      state.mockRestore();
      restoreWindow();
    }
  },
);

test.each([
  { reopen: false, search: false },
  { reopen: true, search: false },
  { reopen: false, search: true },
  { reopen: true, search: true },
])('Player return cleanup preserves episode pane memory (%j)', async ({ reopen, search }) => {
  const client = testClient();
  const item: MediaDetails = {
    ...DETAILS_FLOW_ITEM,
    id: `${DETAILS_FLOW_ITEM.id}-${reopen}-${search}`,
    episodes: Array.from({ length: 80 }, (_, index) => ({
      id: `e${index + 1}`,
      season: 1,
      episode: index + 1,
    })),
    seasons: [{ number: 1, episodeCount: 80 }],
  };
  const route = `/details/series/${item.id}`;
  client.setQueryData(api.detailsQueryOptions('series', item.id).queryKey, item);
  client.setQueryData(APP_UI_PREFERENCES_QUERY_KEY, DEFAULT_APP_UI_PREFERENCES);
  const memory = router.createMemoryRouter(
    [
      {
        path: '/details/:type/:id',
        element: (
          <PlayerSessionProvider>
            <Details />
          </PlayerSessionProvider>
        ),
      },
    ],
    { initialEntries: [route] },
  );
  const restoreWindow = stubLocation(route);
  const originalPane = detailsPane.useDetailsEpisodePane;
  const originalSelector = detailsSelector.useDetailsStreamSelector;
  let pane!: ReturnType<typeof originalPane>;
  let effects: EffectCallback[] = [];
  spyOn(detailsPane, 'useDetailsEpisodePane').mockImplementation((input) => {
    pane = originalPane(input);
    return pane;
  });
  spyOn(detailsSelector, 'useDetailsStreamSelector').mockImplementation((input) => {
    const previous = capturedEffects;
    capturedEffects = effects;
    try {
      return originalSelector(input);
    } finally {
      capturedEffects = previous;
    }
  });
  let replacing = Promise.resolve();
  spyOn(appNavigation, 'navigateApp').mockImplementation((to, options) => {
    replacing = memory.navigate(to as string, options);
    return true;
  });
  const render = () => {
    effects = [];
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <router.RouterProvider router={memory} />
      </QueryClientProvider>,
    );
  };
  try {
    render();
    if (search) pane.setEpisodeSearch('Episode 41');
    else pane.jumpToEpisode(1, 73);
    render();
    const expectedSearch = search ? 'Episode 41' : '';
    const expectedPage = search ? 0 : 2;
    expect(pane.episodeSearch).toBe(expectedSearch);
    expect(pane.activeEpisodePageIndex).toBe(expectedPage);
    pane.retainEpisodePosition();
    const returnFromPlayer = async () => {
      const originalKey = memory.state.location.key;
      appNavigation.stashDetailsReturnState(route, {
        from: '/search',
        season: 1,
        reopenStreamSelector: reopen,
        reopenStreamSeason: 1,
        reopenStreamEpisode: 1,
      });
      render();
      runEffects(effects, []);
      await replacing;
      expect(memory.state.location.key).not.toBe(originalKey);
      render();
      expect(pane.episodeSearch).toBe(expectedSearch);
      expect(pane.activeEpisodePageIndex).toBe(expectedPage);
    };
    await returnFromPlayer();
    await returnFromPlayer();
    await memory.navigate(route);
    render();
    expect(pane.episodeSearch).toBe('');
    await memory.navigate(-1);
    render();
    expect(pane.episodeSearch).toBe(expectedSearch);
    expect(pane.activeEpisodePageIndex).toBe(expectedPage);
  } finally {
    memory.dispose();
    appNavigation.takeDetailsReturnState(route);
    restoreWindow();
  }
});

test('Incomplete Search results remain retryable', () => {
  const client = createClient();
  const options = searchCatalogQueryOptions(
    { query: 'dune', type: 'movie', feed: 'popular' },
    2026,
  );
  client.setQueryData(options.queryKey, {
    pages: [
      {
        items: [{ id: 'tt1160419', type: 'movie', title: 'Dune' }],
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
  const previous: CalendarSchedule = { trackedCount: 1, missingCount: 0, days: [], upcoming: [] };
  const placeholder = (queryKey: unknown[]) =>
    typeof placeholderData === 'function'
      ? placeholderData(previous, { queryKey } as never)
      : undefined;
  // A previous query under another filter must not seed placeholders.
  expect(placeholder([...query.queryKey.slice(0, 4), false])).toBeUndefined();
  // The same range + filter reuses the previous page, minus stale days.
  expect(placeholder(query.queryKey)).toEqual(previous);
});

test('Leaving a calendar range cancels its native request', async () => {
  const client = createClient();
  markupWithClient(client, <Calendar />, '/calendar?month=2026-07');
  const query = client
    .getQueryCache()
    .find<CalendarSchedule>({ queryKey: ['calendar-events'], exact: false });
  if (!query) throw new Error('Calendar query missing');
  const response = Promise.withResolvers<CalendarSchedule>();
  const invoke = mock((command: string, _args: { requestId: string }) =>
    command === 'get_calendar_events' ? response.promise : Promise.resolve(),
  );
  const restore = stubGlobal('window', {
    __TAURI_INTERNALS__: { invoke, transformCallback: () => 1 },
  });
  const observer = new QueryObserver(
    client,
    query.options as QueryObserverOptions<CalendarSchedule>,
  );
  const stop = observer.subscribe(() => {});
  try {
    const requestId = invoke.mock.calls.find(([command]) => command === 'get_calendar_events')?.[1]
      .requestId;
    expect(requestId).toEqual(expect.any(String));
    stop();
    expect(invoke).toHaveBeenLastCalledWith('cancel_stream_request', { requestId }, undefined);
  } finally {
    stop();
    response.resolve({ trackedCount: 0, missingCount: 0, days: [], upcoming: [] });
    restore();
  }
});

test('Calendar keeps valid releases visible when a cached date is invalid', () => {
  const client = createClient();
  const route = '/calendar?month=2026-07';
  markupWithClient(client, <Calendar />, route);
  const query = client.getQueryCache().find({ queryKey: ['calendar-events'], exact: false });
  if (!query) throw new Error('Calendar query missing');
  const valid = {
    id: 'tt-calendar',
    mediaId: 'tt-calendar',
    mediaType: 'movie',
    type: 'movie',
    title: 'Valid release',
    seriesTitle: 'Valid release',
    releaseDate: '2026-07-12',
  } as const;
  client.setQueryData<CalendarSchedule>(query.queryKey, {
    trackedCount: 2,
    missingCount: 0,
    days: [{ date: valid.releaseDate, events: [valid] }],
    upcoming: [
      valid,
      {
        ...valid,
        id: 'invalid',
        title: 'Invalid release',
        seriesTitle: 'Invalid release',
        releaseDate: '2026-02-31',
      },
    ],
  });
  const markup = markupWithClient(client, <Calendar />, route);
  expect(markup).toContain('Valid release');
  expect(markup).not.toContain('Invalid release');
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

// The selector's source-query key for a target, including its ranking cache segment.
function selectorSourceKey(
  target: { type: string; id: string },
  season?: number,
  episode?: number,
) {
  return streamSelectorQueryKey(
    target.type,
    target.id,
    season,
    episode,
    undefined,
    buildStreamRankingCacheKey(
      playerStreamRankingOptions({ mediaId: target.id, mediaType: target.type }),
    ),
  );
}

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
    expect(markup).toContain('>18</span>');
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
    client.setQueryData(selectorSourceKey(target), data);
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

test.each([false, true])(
  'Selector retries share the source request (cached=%s)',
  async (cached) => {
    const restoreWindow = stubGlobal('window', {
      __TAURI_INTERNALS__: { transformCallback: () => 1 },
    });
    const client = testClient(false);
    const target = { type: 'movie' as const, id: 'selector-retry-test' };
    const key = selectorSourceKey(target);
    const data = streamSelectorFixture();
    if (cached) client.setQueryData(key, data);
    const pending = Promise.withResolvers<StreamSelectorData>();
    const fetch = spyOn(api, 'getStreamSelectorData').mockReturnValue(pending.promise);
    try {
      const view = captureWithClient(client, () =>
        useStreamSelectorController({ target, open: true, onClose: () => {} }),
      );
      view.refetchStreams();
      view.refetchStreams();
      expect(fetch).toHaveBeenCalledTimes(1);
      const progress = fetch.mock.calls[0]![6];
      if (cached) {
        expect(progress).toBeUndefined();
      } else {
        expect(progress).toBeDefined();
        progress!.onmessage(data);
      }
      expect(client.getQueryData<StreamSelectorData>(key)?.streams).toEqual(data.streams);
      const settled = streamSelectorFixture(false);
      pending.resolve(settled);
      await client.getQueryCache().find({ queryKey: key })!.promise;
      expect(client.getQueryData<StreamSelectorData>(key)?.streams).toEqual([]);
    } finally {
      pending.resolve(data);
      fetch.mockRestore();
      restoreWindow();
    }
  },
);

test('Selector pool eviction preserves live observers, placeholders, and current filter caches', async () => {
  type View = { streams: StreamSelectorData['streams'] };
  const client = testClient(false);
  const target = { type: 'series' as const, id: 'selector-pool-test', season: 1, episode: 1 };
  // `source` keeps the index query enabled — batch alone now splits client-side.
  const filters = { ...DEFAULT_FILTERS, batch: 'episodes' as const, source: 'cached' as const };
  const sourceKey = selectorSourceKey(target, 1, 1);
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
    const [, effects] = captureRenderEffects(() =>
      captureWithClient(client, () =>
        useStreamSelectorController({ target, open: true, onClose: () => {} }),
      ),
    );
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

// Subscribes a query observer until `pick` accepts a result or the 1s guard expires.
function observeUntil<T>(
  options: QueryObserverOptions<T>,
  pick: (result: QueryObserverResult<T>) => boolean,
  timeoutMessage: string,
) {
  const observer = new QueryObserver(queryClient, options);
  const settled = Promise.withResolvers<QueryObserverResult<T>>();
  const timeout = setTimeout(() => settled.reject(new Error(timeoutMessage)), 1_000);
  const unsubscribe = observer.subscribe((next) => {
    if (pick(next)) settled.resolve(next);
  });
  return {
    observer,
    result: settled.promise.finally(() => {
      clearTimeout(timeout);
      unsubscribe();
      observer.destroy();
    }),
  };
}

test.each([false, true])(
  'Offline native preferences finish their one retry (persistent=%s)',
  async (persistent) => {
    const wasOnline = onlineManager.isOnline();
    const storedPreferences = { ...DEFAULT_APP_UI_PREFERENCES, playerVolume: 42 };
    const failure = new Error('Native preference store unavailable');
    let calls = 0;
    try {
      onlineManager.setOnline(false);
      const { observer, result } = observeUntil(
        {
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
        },
        (next) =>
          next.fetchStatus === 'paused' || (next.fetchStatus === 'idle' && !next.isPlaceholderData),
        'Native read did not settle',
      );
      expect(observer.getCurrentResult().isPlaceholderData).toBe(true);
      const settled = await result;
      expect(settled.fetchStatus).toBe('idle');
      expect(calls).toBe(2);
      expect(settled.isSuccess).toBe(!persistent);
      expect(settled.isError).toBe(persistent);
      expect(settled.isPlaceholderData).toBe(false);
      expect(settled.data).toEqual(persistent ? undefined : storedPreferences);
      expect(settled.error).toBe(persistent ? failure : null);
    } finally {
      queryClient.removeQueries({ queryKey: APP_UI_PREFERENCES_QUERY_KEY, exact: true });
      onlineManager.setOnline(wasOnline);
    }
  },
);

test('An active native read recovers on reconnect after exhausting its offline retry', async () => {
  const wasOnline = onlineManager.isOnline();
  const queryKey = [...DETAILS_QUERY_KEY, 'movie', 'offline-reconnect-test'];
  let calls = 0;
  let offlineError: QueryObserverResult<string> | undefined;
  try {
    onlineManager.setOnline(false);
    queryClient.mount();
    const { result } = observeUntil(
      {
        queryKey,
        queryFn: async () => {
          calls += 1;
          if (!onlineManager.isOnline()) throw new Error('Native request failed offline');
          return 'Recovered details';
        },
        retryDelay: 0,
      },
      (next) => {
        if (next.fetchStatus !== 'idle') return false;
        if (next.isError && !onlineManager.isOnline()) {
          offlineError = next;
          onlineManager.setOnline(true);
          return false;
        }
        return next.isSuccess;
      },
      'Native read did not recover on reconnect',
    );
    const settled = await result;
    expect(offlineError?.isError).toBe(true);
    expect(offlineError?.failureCount).toBe(2);
    expect(calls).toBe(3);
    expect(settled.isSuccess).toBe(true);
    expect(settled.data).toBe('Recovered details');
  } finally {
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
  const fakeAnchor = {} as HTMLDivElement;
  const probeRefs: { current: HTMLDivElement | null }[] = [];
  function ViewportProbe({ enabled }: { enabled: boolean }) {
    probeRefs.push(useNearViewport(enabled).anchorRef);
    return null;
  }
  try {
    const [, disabledEffects] = captureRenderEffects(() =>
      renderToStaticMarkup(<ViewportProbe enabled={false} />),
    );
    probeRefs.at(-1)!.current = fakeAnchor;
    const disabledCleanup = disabledEffects.at(-1)?.();
    expect(observe).not.toHaveBeenCalled();
    expect(disabledCleanup).toBeUndefined();

    const [, enabledEffects] = captureRenderEffects(() =>
      renderToStaticMarkup(<ViewportProbe enabled />),
    );
    probeRefs.at(-1)!.current = fakeAnchor;
    const cleanup = enabledEffects.at(-1)?.();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(fakeAnchor);
    cleanup?.();
    expect(disconnect).toHaveBeenCalledTimes(1);
  } finally {
    restoreObserver();
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

test('Title action menus handle normal, disabled and keep-open actions', async () => {
  const { InlineMenu } = await import('../src/components/inline-menu');
  const { Play, Info } = await import('lucide-react');
  const onAction = mock(() => {});
  const onSelect = mock((_event: unknown) => {});
  const preventDefault = mock(() => {});
  const event = { preventDefault };
  const actions = [
    { key: 'play', label: 'Resume season 12, episode 104', icon: Play, onSelect },
    { key: 'pending', label: 'Opening…', icon: Play, disabled: true, onSelect },
    { key: 'lists', label: 'Add to list', icon: Info, keepOpen: true, onSelect },
    { key: 'details', label: 'Open details', icon: Info, href: '/details/series/title', onSelect },
  ];
  const props = {
    presence: { mounted: true, exiting: false },
    label: 'Title actions',
    actions,
    onAction,
  };
  const menu = InlineMenu({ ...props, layout: 'flow' })!;
  const rows = menu.props.children;
  const markup = renderToStaticMarkup(menu);
  expect(markup).toContain('href="/details/series/title"');
  rows[0]!.props.onClick(event);
  expect(onSelect).toHaveBeenCalledWith(event);
  expect(onAction).toHaveBeenCalledTimes(1);
  rows[1]!.props.onClick(event);
  expect(preventDefault).toHaveBeenCalledTimes(1);
  expect(onSelect).toHaveBeenCalledTimes(1);
  rows[2]!.props.onClick(event);
  expect(onSelect).toHaveBeenCalledTimes(2);
  expect(onAction).toHaveBeenCalledTimes(1);
  expect(renderToStaticMarkup(<InlineMenu {...props} orientation='horizontal' />)).toContain(
    'aria-orientation="horizontal"',
  );
  expect(InlineMenu({ ...props, presence: { mounted: false, exiting: false } })).toBeNull();
});

test('Horizontal drag-scroll suppresses post-drag clicks without eating plain clicks or cancelled drags', async () => {
  const { useHorizontalDragScroll } = await import('../src/hooks/use-scroll-edge-indicators');
  const captured: ReturnType<typeof useHorizontalDragScroll<HTMLDivElement>>[] = [];
  function DragProbe() {
    captured.push(useHorizontalDragScroll<HTMLDivElement>());
    return null;
  }
  renderToStaticMarkup(<DragProbe />);
  const handlers = captured[0];

  let capturedId: number | null = null;
  const scroller = {
    scrollLeft: 40,
    scrollWidth: 900,
    clientWidth: 300,
    dataset: {} as DOMStringMap,
    style: { scrollSnapType: '' } as CSSStyleDeclaration,
    setPointerCapture: (id: number) => {
      capturedId = id;
    },
    hasPointerCapture: (id: number) => capturedId === id,
    releasePointerCapture: () => {
      capturedId = null;
    },
  } as unknown as HTMLDivElement;

  const pointerEvent = (x: number, id = 1, buttons = 1) =>
    ({
      pointerId: id,
      pointerType: 'mouse',
      button: 0,
      buttons,
      clientX: x,
      currentTarget: scroller,
      target: null,
    }) as unknown as Parameters<typeof handlers.onPointerDown>[0];

  const clickAttempt = () => {
    let prevented = false;
    let stopped = false;
    handlers.onClickCapture({
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
    } as unknown as Parameters<typeof handlers.onClickCapture>[0]);
    return prevented && stopped;
  };

  // Sub-threshold movement stays a normal click.
  handlers.onPointerDown(pointerEvent(100));
  handlers.onPointerMove(pointerEvent(102));
  handlers.onPointerUp(pointerEvent(102));
  expect(scroller.scrollLeft).toBe(40);
  expect(clickAttempt()).toBe(false);

  // A release outside the rail before capture must end the pending drag.
  handlers.onPointerDown(pointerEvent(100));
  handlers.onPointerMove(pointerEvent(102));
  handlers.onPointerMove(pointerEvent(70, 1, 0));
  expect(scroller.scrollLeft).toBe(40);
  expect(scroller.style.scrollSnapType).toBe('');
  expect(capturedId).toBeNull();
  expect(clickAttempt()).toBe(false);

  // Dragging past the 4px dead-zone scrolls 1:1 and suppresses the synthetic release click.
  handlers.onPointerDown(pointerEvent(100));
  handlers.onPointerMove(pointerEvent(70));
  expect(scroller.scrollLeft).toBe(70);
  expect(scroller.style.scrollSnapType).toBe('none');
  expect(capturedId).toBe(1);
  handlers.onPointerUp(pointerEvent(70));
  expect(capturedId).toBeNull();
  expect(clickAttempt()).toBe(true);
  expect(clickAttempt()).toBe(false);

  // Cancelled drags never arm click suppression for the next real click.
  handlers.onPointerDown(pointerEvent(100, 2));
  handlers.onPointerMove(pointerEvent(60, 2));
  handlers.onPointerCancel(pointerEvent(60, 2));
  expect(clickAttempt()).toBe(false);
  handlers.onWheel();
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
  const markup = render();
  expect(markup).toContain('Mark season watched');
  expect(markup).toContain('id="details-episodes-grid"');
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

test.each([
  { currentValue: 'auto', otherValue: 'high' },
  { currentValue: 10, otherValue: 30 },
])(
  'Settings menu selection preserves values and skips the current value (%j)',
  ({ currentValue, otherValue }) => {
    const onChange = mock((_value: string | number) => {});
    const menu = SettingsSelect({
      ariaLabel: 'Quality',
      value: currentValue,
      valueLabel: String(currentValue),
      options: [
        { value: currentValue, label: String(currentValue) },
        { value: otherValue, label: String(otherValue) },
      ],
      onChange,
    });
    const [, content] = menu.props.children;
    const [current, other] = content.props.children;
    current.props.onSelect();
    expect(onChange).not.toHaveBeenCalled();
    other.props.onSelect();
    expect(onChange.mock.calls).toEqual([[otherValue]]);
  },
);

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
  try {
    renderWithEffects(() => renderToStaticMarkup(<Collection />), cleanups);
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

test('Unknown-duration streams allow explicit rewind to zero without unlocking arbitrary seeks', async () => {
  const nativeSeek = spyOn(playerMpv, 'seekAbsoluteSeconds').mockResolvedValue();
  const onUserSeek = mock(() => {});
  const clock = createPlaybackClock();
  clock.publish(42);
  const durationRef = { current: 0 };
  const mpvInitializedRef = { current: true };
  try {
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
    expect(await seeking.seek(30)).toBe(false);
    expect(await seeking.seekRelative(10)).toBe(false);
    expect(nativeSeek).not.toHaveBeenCalled();

    expect(await seeking.seek(0)).toBe(true);
    expect(nativeSeek.mock.calls).toEqual([[0]]);
    expect(clock.getSnapshot()).toBe(0);

    durationRef.current = 120;
    const firstAck = Promise.withResolvers<void>();
    const secondAck = Promise.withResolvers<void>();
    nativeSeek.mockReturnValueOnce(firstAck.promise).mockReturnValueOnce(secondAck.promise);
    const superseded = seeking.seek(0);
    const latest = seeking.seek(45);
    secondAck.resolve();
    firstAck.resolve();
    expect(await superseded).toBe(false);
    expect(await latest).toBe(true);

    mpvInitializedRef.current = false;
    expect(await seeking.seek(0)).toBe(false);
    expect(nativeSeek).toHaveBeenCalledTimes(3);
  } finally {
    nativeSeek.mockRestore();
  }
});

test('Failed subtitle-delay writes still persist normalized prefs without announcing native success', async () => {
  const restoreWindow = stubGlobal('window', {
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout,
  });
  const setProperties = spyOn(playerMpv, 'setMpvProperties');
  const updatePreferences = mock(() => {});
  try {
    const { Fixture, captured } = captureHook(() => {
      const scheduleMpvSet = useMpvSetScheduler('sub-delay-test');
      return useSubtitleAdjustments({
        preferences: { subtitleDelay: 0, subtitlePos: 100, subtitleScale: 1 },
        updatePreferences,
        scheduleMpvSet,
      });
    });
    renderToStaticMarkup(<Fixture />);
    const adjustments = await captured.promise;

    setProperties.mockRejectedValueOnce({
      message: 'mpv unavailable',
      subtitleProperties: [['sub-delay', 0.1]],
    });
    const failedResult = await adjustments.stepSubtitleDelay(1);
    expect(failedResult).toBeUndefined();
    expect(adjustments.subtitleSettingsRef.current.delay).toBe(0.1);

    setProperties.mockResolvedValueOnce([['sub-delay', 0.2]]);
    const okResult = await adjustments.stepSubtitleDelay(1);
    expect(okResult).toBe(0.2);
    expect(adjustments.subtitleSettingsRef.current.delay).toBe(0.2);
  } finally {
    setProperties.mockRestore();
    restoreWindow();
  }
});

test.each([true, false])(
  'PlayerUpNextCard enforces spoiler protection on episode title and thumbnail (hideSpoiler=%s)',
  (hideSpoiler) => {
    const client = createClient();
    const countdown = createSubscribableStore<number | null>(null);
    const episode = {
      id: 'tt1:1:2',
      title: 'The Secret Villain Reveal',
      season: 1,
      episode: 2,
      thumbnail: 'https://cdn.example/spoiler-still.jpg',
    };
    const markup = markupWithClient(
      client,
      <PlayerUpNextCard
        episode={episode}
        thumbnail={episode.thumbnail}
        fallbackThumbnail='https://cdn.example/series-backdrop.jpg'
        hideSpoiler={hideSpoiler}
        autoPlayCountdown={countdown}
        autoPlayDurationSeconds={10}
        onCancelAutoPlay={() => {}}
        onPlayNext={() => {}}
      />,
    );
    expect(markup.includes('The Secret Villain Reveal')).toBe(!hideSpoiler);
    expect(markup.includes('spoiler-still.jpg')).toBe(!hideSpoiler);
    expect(markup.includes('S1:E2 · Episode 2')).toBe(hideSpoiler);
    expect(markup.includes('series-backdrop.jpg')).toBe(hideSpoiler);
  },
);

test('Calendar applies shorter freshness to partial schedules than complete schedules', () => {
  const client = createClient();
  markupWithClient(client, <Calendar />);
  const query = client
    .getQueryCache()
    .find<CalendarSchedule>({ queryKey: ['calendar-events'], exact: false });
  if (!query) throw new Error('Calendar query missing');
  const { staleTime } = query.options as QueryObserverOptions<CalendarSchedule>;
  expect(typeof staleTime).toBe('function');
  const resolveStaleTime = staleTime as (q: typeof query) => number;
  const partial: CalendarSchedule = { trackedCount: 2, missingCount: 1, days: [], upcoming: [] };
  const complete: CalendarSchedule = { trackedCount: 2, missingCount: 0, days: [], upcoming: [] };
  expect(
    resolveStaleTime({ ...query, state: { ...query.state, data: partial } } as typeof query),
  ).toBe(CALENDAR_PARTIAL_STALE_TIME_MS);
  expect(
    resolveStaleTime({ ...query, state: { ...query.state, data: complete } } as typeof query),
  ).toBe(CALENDAR_EVENTS_STALE_TIME_MS);
});

test('Background manifest routing refresh invalidates details, calendar, and addon subtitles', async () => {
  const client = testClient();
  const detailsKey = [...DETAILS_QUERY_KEY, 'series', 'tt123'];
  const calendarKey = calendarEventsQueryKey({
    visibleStart: '2026-11-01',
    visibleEnd: '2026-12-01',
    upcomingStart: '2026-11-20',
    hideWatched: false,
  });
  const subtitlesKey = addonSubtitlesQueryKey('series', 'tt123', 1, 1);
  for (const key of [detailsKey, calendarKey, subtitlesKey]) {
    client.setQueryData(key, { ok: true });
  }

  await invalidateAddonCapabilityQueries(client, false);
  for (const key of [detailsKey, calendarKey, subtitlesKey]) {
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  }

  await invalidateAddonCapabilityQueries(client, true);
  for (const key of [detailsKey, calendarKey, subtitlesKey]) {
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  }
});
