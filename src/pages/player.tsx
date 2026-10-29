import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toLocalDate } from '@/lib/schedule-dates';
import { Copy, Loader2 } from 'lucide-react';
import {
  useCallback,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type WheelEvent,
} from 'react';
import { DesktopTitlebar } from '@/components/desktop-titlebar';
import { isEpisodeSpoiler } from '@/components/details-episode-card';
import { MiniPlayer } from '@/components/mini-player';
import { PlayerSkipButton } from '@/components/player-action-overlays';
import { PlayerControlsRow, PlayerTopChrome, SPEED_OPTIONS } from '@/components/player-chrome';
import {
  CHROME_ENTER_TIMING_CLASS,
  CHROME_EXIT_TIMING_CLASS,
} from '@/components/player-chrome-styles';
import { PlayerEpisodesPanel } from '@/components/player-episodes-panel';
import { PlayerOsdOverlay } from '@/components/player-osd-overlay';
import { PlayerEdgeProgress, PlayerProgressBar } from '@/components/player-progress-bar';
import { PlayerPipChrome } from '@/components/player-pip-chrome';
import { PlayerShortcutsOverlay } from '@/components/player-shortcuts-overlay';
import { AudioTrackSelector, SubtitleTrackSelector } from '@/components/player-track-selectors';
import { StreamSelector } from '@/components/stream-selector';
import {
  PlayerEndCard,
  PlayerErrorOverlay,
  PlayerIdleOverlay,
  PlayerPauseResumeButton,
  PlayerUpNextCard,
} from '@/components/player-state-overlays';
import { Sidebar } from '@/components/sidebar';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useAppUiPreferences, usePlayerKeymap } from '@/hooks/use-app-ui-preferences';
import { useDelayedUnmount } from '@/hooks/use-delayed-unmount';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useLocalDay } from '@/hooks/use-local-day';
import { useTitleWatchProgress } from '@/hooks/use-media-library';
import { useMediaSession } from '@/hooks/use-media-session';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { useMpvSetScheduler } from '@/hooks/use-mpv-set-scheduler';
import { useOptimisticSeek } from '@/hooks/use-optimistic-seek';
import { usePlaybackProgressPersistence } from '@/hooks/use-playback-progress-persistence';
import { usePlaybackStreamHealth } from '@/hooks/use-playback-stream-health';
import { usePlayerResumeController } from '@/hooks/use-player-resume-controller';
import { usePlayerTrackController } from '@/hooks/use-player-track-controller';
import { usePlayerAddonSubtitles } from '@/hooks/use-player-addon-subtitles';
import { usePlayerAutoResolve } from '@/hooks/use-player-auto-resolve';
import { usePlayerHotkeys } from '@/hooks/use-player-hotkeys';
import { usePlayerIdleOverlay } from '@/hooks/use-player-idle-overlay';
import { getPlayerStreamLoadKey, usePlayerMpvLifecycle } from '@/hooks/use-player-mpv-lifecycle';
import { usePlayerStreamSession } from '@/hooks/use-player-stream-session';
import {
  type MiniVideoRect,
  useMiniPlayerSurface,
  usePlayerSurfaceLayout,
} from '@/hooks/use-player-surface-layout';
import { usePlayerUiTimers } from '@/hooks/use-player-ui-timers';
import { usePlayerViewportMode } from '@/hooks/use-player-viewport-mode';
import { usePlayerVolumeControls } from '@/hooks/use-player-volume-controls';
import { useStreamRecovery } from '@/hooks/use-stream-recovery';
import { useSubtitleAdjustments } from '@/hooks/use-subtitle-adjustments';
import {
  api,
  type AppUiPreferences,
  type Episode,
  getErrorMessage,
  type MediaDetails,
  type PlaybackLanguagePreferences,
  type SkipSegment,
  type SkipTimesResult,
} from '@/lib/api';
import { getCachedResultRefreshDelayMs } from '@/lib/api-cache';
import {
  buildEpisodeStreamTarget,
  findEpisodeByCoordinates,
  type NextEpisodeStreamCoordinates,
  sameEpisodeCoordinates,
} from '@/lib/episode-stream-target';
import {
  type DetailsHistoryRouteState,
  playableResumePosition,
  episodeProgressKey,
  formatPlaybackLanding,
  getLatestEpisodeResumeStartTime,
  MIN_RESUME_POSITION_SECS,
} from '@/lib/history-playback';
import {
  boundNavigate,
  currentPathWithSearch,
  navigateApp,
  pathBelowTop,
  stashDetailsReturnState,
} from '@/lib/navigation';
import { copyText, notifyAction } from '@/lib/notify';
import {
  buildDetailsRoute,
  claimPlaybackLaunch,
  isCurrentPlaybackLaunch,
  launchResolvedStream,
  resolvePlayerLaunch,
  resolveSafeInternalReturnPath,
} from '@/lib/player-navigation';
import { createPlaybackClock } from '@/lib/player-clock';
import {
  blurActivePlayerControl,
  createWheelSeekAccumulator,
  isPlayerInteractiveTarget,
  restorePlayerBackground,
  setPlayerDocumentBackground,
  shouldIgnorePlayerSurfaceInteraction,
} from '@/lib/player-dom';
import { mpvCommand, setMpvProperty } from '@/lib/player-mpv';
import { isNearMediaEnd, SKIP_SEGMENT_LABELS } from '@/lib/player-skip';
import {
  clearPlayerLoading,
  expandedSessionState,
  type PlayerLoadingActions,
  publishPlayerLoading,
  usePlayerSession,
} from '@/lib/player-session';
import { trackDisplayLabel } from '@/lib/player-track-utils';
import {
  detailsQueryKey,
  invalidatePlaybackHistoryQueries,
  DETAILS_GC_TIME_MS,
  SKIP_TIMES_EMPTY_STALE_TIME_MS,
  SKIP_TIMES_STALE_TIME_MS,
} from '@/lib/query-invalidation';
import { type PlayerStreamRequest, resolvePlayerStream } from '@/lib/resolve-player-stream';
import type { StreamSelectorTarget } from '@/lib/stream-selector-target';
import { createSubscribableStore } from '@/lib/subscribable-store';
import {
  clearTimer,
  cn,
  formatEpisodeHeading,
  formatSeasonEpisode,
  getEpisodeTitle,
  isSeriesLikeMediaType,
  nonBlank,
  prefersReducedMotion,
  type TimerHandle,
  withTimeout,
} from '@/lib/utils';

const PLAYBACK_READY_AUTO_HIDE_DELAY_MS = 2600;
const POINTER_CONTROLS_IDLE_MS = 1200;
// A cold addon resolve can take ~14s — past this the picker beats a blank loader.
const NEXT_EPISODE_AUTO_RESOLVE_TIMEOUT_MS = 12_000;
// Remaining seconds that count as credits when SkipDB has no tail segment.
const CREDITS_NEXT_EPISODE_LEAD_SECS = 30;
// An estimated intro skip is offered only over the opening stretch, never auto-applied.
const INTRO_ESTIMATE_WINDOW_SECS = 600;
// Mini chrome lingers so the undock dissolve plays under the fading-in player.
const MINI_EXIT_MS = 180;
type SelectedEpisodeStreamTarget = NextEpisodeStreamCoordinates & { startTime?: number };

interface StreamSelectorState {
  open: boolean;
  target: SelectedEpisodeStreamTarget | null;
  // Retained through the exit animation, then released with the target.
  mounted: boolean;
}

const CLOSED_STREAM_SELECTOR_STATE: StreamSelectorState = {
  open: false,
  target: null,
  mounted: false,
};

const EMPTY_EPISODES: Episode[] = [];
const EMPTY_SEASONS: NonNullable<MediaDetails['seasons']> = [];
const EMPTY_SKIP_SEGMENTS: SkipSegment[] = [];

const selectPlayerPreferences = ({
  playerVolume,
  playerSpeed,
  subtitleDelay,
  subtitlePos,
  subtitleScale,
  autoPlayNext,
  nextEpisodeCountdownSecs,
  controlsHideDelayMs,
  autoSkipIntro,
  autoLoadAddonSubtitles,
  spoilerProtection,
}: AppUiPreferences) => ({
  playerVolume,
  playerSpeed,
  subtitleDelay,
  subtitlePos,
  subtitleScale,
  autoPlayNext,
  nextEpisodeCountdownSecs,
  controlsHideDelayMs,
  autoSkipIntro,
  autoLoadAddonSubtitles,
  spoilerProtection,
});

export function Player() {
  const { session, presentation, close, getMiniPosition, setMiniPosition, trayPause } =
    usePlayerSession();
  const pausedByTrayHide = useSyncExternalStore(trayPause.subscribe, trayPause.getSnapshot);
  const isExpanded = presentation === 'expanded';
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const topChromeRef = useRef<HTMLDivElement | null>(null);
  const bottomChromeRef = useRef<HTMLDivElement | null>(null);
  const capturedControlsPointerRef = useRef<{ target: Element; pointerId: number } | null>(null);
  const windowActiveRef = useRef(document.hasFocus());
  const episodesPanelFrameRef = useRef<HTMLElement | null>(null);
  const miniVideoRectRef = useRef<MiniVideoRect | null>(null);

  const {
    backdrop,
    effectiveResolveMediaType,
    episodeParam: episode,
    from,
    id,
    isHistoryResume,
    logo,
    openingStreamName,
    openingStreamSource,
    originFrom,
    poster,
    routeAbsoluteEpisode,
    routeAbsoluteSeason,
    routeEpisode,
    routeSeason,
    requestedStreamKey: routeRequestedStreamKey,
    selectedStreamKey: routeSelectedStreamKey,
    streamSourceId: routeSourceId,
    streamSourceName: routeSourceName,
    streamEpisode: routeStreamEpisode,
    streamFamily: routeStreamFamily,
    streamLookupId: routeStreamLookupId,
    streamSeason: routeStreamSeason,
    seasonParam: season,
    startTime,
    title,
    resolveTitle,
    type,
  } = resolvePlayerLaunch(session ?? {});

  // -- State --
  const stream = usePlayerStreamSession({
    routeSourceId,
    routeSourceName,
    routeStreamFamily,
    routeSelectedStreamKey,
    streamLookupId: routeStreamLookupId || id || undefined,
    mediaId: id,
    season: routeSeason,
    episode: routeEpisode,
  });
  const {
    activeStreamUrl,
    activeStreamKey,
    activeStreamSourceName,
    setActiveStreamUrl,
    activeStreamSourceIdRef,
    activeStreamSourceNameRef,
    activeStreamFamilyRef,
    streamLookupIdRef,
    committedStreamUrlRef,
  } = stream;
  const activeStreamLoadKey = getPlayerStreamLoadKey(stream);
  const handleCopyStreamLink = () => {
    const url = committedStreamUrlRef.current;
    if (url) void copyText(url, { success: 'Stream link copied' });
  };
  const { preferences: appUiPreferences, updatePreferences: updateAppUiPreferences } =
    useAppUiPreferences(selectPlayerPreferences);

  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(false);
  const [openSettingsMenu, setOpenSettingsMenu] = useState<'audio' | 'subtitles' | 'speed' | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [hasPlaybackStarted, setHasPlaybackStarted] = useState(false);
  const [hasPlaybackAdvanced, setHasPlaybackAdvanced] = useState(false);
  /** Reactive mirror of playbackEndedRef so the EOF "Up Next" card can render. */
  const [hasEnded, setHasEnded] = useState(false);
  const [autoPlayCountdown] = useState(() => createSubscribableStore<number | null>(null));
  const [eofAutoPlayCancelled, setEofAutoPlayCancelled] = useState(false);
  const cancelAutoPlayNext = () => {
    setEofAutoPlayCancelled(true);
    autoPlayCountdown.publish(null);
  };
  const [resolveStatus, setResolveStatus] = useState<string | null>(null);
  const isResolving = resolveStatus !== null;
  const [error, setErrorState] = useState<string | null>(null);
  const [playbackSpeed, setPlaybackSpeed] = useState(() => appUiPreferences.playerSpeed);
  const [showEpisodes, setShowEpisodes] = useState(false);
  const keymap = usePlayerKeymap();
  // Shortcuts overlay — topmost layer like the episodes panel; Esc closes it first.
  const [showShortcuts, setShowShortcuts] = useState(false);
  const toggleShortcuts = () => setShowShortcuts((open) => !open);
  const closeShortcuts = () => setShowShortcuts(false);
  // Mount-once: never-opened pays no DOM cost; staying mounted keeps the slide transition.
  const [episodesPanelMounted, setEpisodesPanelMounted] = useState(false);
  const [selectedSeason, setSelectedSeason] = useState<number>(() => {
    return routeAbsoluteSeason ?? 1;
  });

  const closeEpisodesPanel = () => {
    // Return focus to the surface before the panel goes inert and swallows hotkeys.
    const panel = episodesPanelFrameRef.current;
    if (panel && panel.contains(document.activeElement)) {
      blurActivePlayerControl();
    }
    setShowEpisodes(false);
  };

  const [streamSelectorState, setStreamSelectorState] = useState<StreamSelectorState>(
    CLOSED_STREAM_SELECTOR_STATE,
  );
  const showStreamSelector = streamSelectorState.open;
  // The pick target persists through the close animation so it doesn't revert mid-exit.
  const selectedEpisodeStreamTarget = streamSelectorState.target;

  const [mpvSurfaceReady, setMpvSurfaceReady] = useState(false);
  // One-beat linger for the undock dissolve (MINI_EXIT_MS).
  const [miniExiting, setMiniExiting] = useState(false);
  const miniExitTimerRef = useRef<TimerHandle | null>(null);
  const showErrorOverlay = !!error && !isResolving && !isLoading;

  const handleBeforeEnterFullscreen = () => {
    closeEpisodesPanel();
    setShowShortcuts(false);
  };

  const {
    isFullscreen,
    isPip,
    canPip,
    togglePip,
    returnFromPip,
    viewportTransition,
    prepareForInternalPlayerNavigation,
    toggleFullscreen,
  } = usePlayerViewportMode({
    onBeforeEnterFullscreen: handleBeforeEnterFullscreen,
    expanded: isExpanded,
  });

  // -- Refs --
  const forceShowTimeoutRef = useRef<TimerHandle | null>(null);
  // Playback time lives in an external store so ticks only re-render subscribed leaves.
  const [clock] = useState(createPlaybackClock);
  // Reading `clock.ref` directly in render makes the React Compiler treat `clock` as a ref and bail out.
  const [currentTimeRef] = useState(() => clock.ref);
  // Same external-store pattern so seekbar updates skip the player tree.
  const [bufferedClock] = useState(() => createPlaybackClock());
  const observedPositionRef = useRef<number | null>(null);
  const durationRef = useRef(0);
  const isDestroyedRef = useRef(false);
  const nextEpisodeRequestRef = useRef<AbortController | null>(null);
  // Must survive stream swaps so stale-link recovery can re-resolve on the same screen.
  const mountedRef = useMountedRef(() => {
    clearTimer(miniExitTimerRef);
    nextEpisodeRequestRef.current?.abort();
  });
  const mpvInitializedRef = useRef(false);
  const appliedSpeedRef = useRef(appUiPreferences.playerSpeed);
  // Guards late auto-resolve winners so manual selector fallback always wins.
  const autoResolveGenRef = useRef(0);
  /** True when the selector paused live playback — a dismiss resumes it. */
  const resumeAfterSelectorDismissRef = useRef(false);
  const selectorCommittedReloadRef = useRef<{ state: unknown; url: string } | null>(null);
  const manualSelectionGenerationRef = useRef<number | null>(null);
  const errorRef = useRef<string | null>(error);
  const recoverableStreamErrorRef = useRef<string | null>(null);
  const setError = (value: string | null) => {
    errorRef.current = value;
    recoverableStreamErrorRef.current = null;
    setErrorState(value);
  };
  const setStreamError = (value: string) => {
    setError(value);
    recoverableStreamErrorRef.current = value;
  };
  const isResolvingRef = useRef(false);
  const selectorOpenRequestIdRef = useRef(0);
  /** Always-current playing state — used in closures to avoid stale captures. */
  const isPlayingRef = useRef(false);
  const idleDismissedByClickRef = useRef(false);
  /** Timestamp (ms) when playback was first verified — used to suppress transient idle events. */
  const playbackVerifiedAtRef = useRef(0);
  /** mpv reported end-of-file for the current stream — Back may reopen the selector. */
  const playbackEndedRef = useRef(false);
  // Position where the previous stream died, captured before the swap zeroes currentTimeRef.
  const failoverResumePositionRef = useRef(0);
  const resetStreamScopedState = useEffectEvent(() => {
    observedPositionRef.current = null;
    setHasPlaybackStarted(false);
    setHasPlaybackAdvanced(false);
    clock.publish(0);
    durationRef.current = 0;
    playbackVerifiedAtRef.current = 0;
    playbackEndedRef.current = false;
    setHasEnded(false);
    setDuration(0);
  });
  const isPlayerChromeEngaged = () => {
    const captured = capturedControlsPointerRef.current;
    return (
      windowActiveRef.current &&
      document.visibilityState !== 'hidden' &&
      ((captured !== null && captured.target.hasPointerCapture(captured.pointerId)) ||
        document.querySelector('[data-player-popover][data-state="open"]') !== null)
    );
  };
  const {
    announce,
    clearControlsAutoHide,
    clearUiTimers: clearManagedUiTimers,
    osdStore,
    scheduleControlsAutoHide,
    showControlsWithAutoHide,
    triggerOsd,
  } = usePlayerUiTimers({
    controlsHideDelayMs: appUiPreferences.controlsHideDelayMs,
    isPlayingRef,
    mountedRef,
    osdEnabled:
      isExpanded &&
      !isResolving &&
      !error &&
      !hasEnded &&
      !showStreamSelector &&
      !showEpisodes &&
      !showShortcuts,
    setShowControls,
    shouldHoldControls: isPlayerChromeEngaged,
  });
  const clearUiTimers = useCallback(() => {
    clearManagedUiTimers();
    clearTimer(forceShowTimeoutRef);
  }, [clearManagedUiTimers]);
  const handleResumeMessage = (text: string) => {
    announce(text, 'history');
  };

  useEffect(() => {
    const nextSpeed = appUiPreferences.playerSpeed;
    const speedChanged = appliedSpeedRef.current !== nextSpeed;
    appliedSpeedRef.current = nextSpeed;
    setPlaybackSpeed(nextSpeed);

    if (mpvInitializedRef.current && speedChanged) {
      void setMpvProperty('speed', nextSpeed).catch(() => undefined);
    }
  }, [appUiPreferences.playerSpeed]);

  // Async selector-open continuations bail once a newer request exists or the player unmounted.
  const isSelectorRequestStale = (requestId: number) =>
    requestId !== selectorOpenRequestIdRef.current || !mountedRef.current;

  const clearNextEpisodeRequest = useCallback(
    (request?: AbortController | null) => {
      if (request === undefined) request = nextEpisodeRequestRef.current;
      // A late continuation must not clear a newer episode's resolving state.
      if (!request || nextEpisodeRequestRef.current !== request) return;
      request.abort();
      nextEpisodeRequestRef.current = null;
      setResolveStatus(null);
    },
    [setResolveStatus],
  );

  useEffect(() => {
    // Stream cleanup snapshots the old observed position before this reset.
    resetStreamScopedState();
  }, [activeStreamLoadKey]);

  // -- Queries --
  // Shared details key reuses the cached entry; movies fetch too — `imdbId` widens the SkipDB anchor.
  const {
    data: details,
    dataUpdatedAt: detailsDataUpdatedAt,
    isLoading: isLoadingDetails,
  } = useQuery({
    ...api.detailsQueryOptions(
      effectiveResolveMediaType,
      id,
      'Media ID is required for player details lookup.',
    ),
    enabled: !!type && !!id,
  });
  const rankingTitle = nonBlank(details?.title) ?? resolveTitle;
  const episodes = details?.episodes;

  // Route season/episode may be anime stream-query coords — prefer the absolute match; season-less absolute routes match on episode number alone.
  const currentEpisode =
    findEpisodeByCoordinates(episodes, routeAbsoluteSeason, routeAbsoluteEpisode) ??
    findEpisodeByCoordinates(episodes, routeSeason, routeEpisode) ??
    (routeAbsoluteSeason === undefined && routeAbsoluteEpisode !== undefined
      ? episodes?.find((ep) => ep.episode === routeAbsoluteEpisode)
      : undefined) ??
    null;

  const isSeriesLike = isSeriesLikeMediaType(effectiveResolveMediaType);
  const localToday = toLocalDate(useLocalDay()).toString();
  const episodeNavigationScopeKey = [
    ...detailsQueryKey(effectiveResolveMediaType, id),
    'episode-navigation',
    currentEpisode?.season,
    currentEpisode?.episode,
  ];
  const { data: episodeNavigation, isFetching: isLoadingEpisodeNavigation } = useQuery({
    queryKey: [...episodeNavigationScopeKey, localToday, detailsDataUpdatedAt],
    queryFn: () =>
      api.getEpisodeNavigation({
        episodes: episodes!,
        season: currentEpisode!.season,
        episode: currentEpisode!.episode,
        today: localToday,
      }),
    // Movies never chain: no Next, no warming, no auto-play.
    enabled: isSeriesLike && !!episodes && !!currentEpisode,
    placeholderData: (previous, previousQuery) =>
      episodeNavigationScopeKey.every((part, index) => previousQuery?.queryKey[index] === part)
        ? previous
        : undefined,
    staleTime: Infinity,
    gcTime: DETAILS_GC_TIME_MS,
  });
  const previousEpisode = episodeNavigation?.previous;
  const nextEpisode = episodeNavigation?.next;

  const currentEpisodeStream =
    currentEpisode && type && id
      ? buildEpisodeStreamTarget(routeStreamLookupId || details?.imdbId || id, currentEpisode)
      : null;

  // -- Skip Times --
  // SkipDB keys on IMDb id; anime-history `kitsu:` ids carry no anchor and return no segments.
  // Same query as details, so arriving from there is a cache hit.
  const { data: titleWatchProgress } = useTitleWatchProgress(id, {
    enabled: isSeriesLike && isExpanded && showEpisodes,
  });
  const episodeProgress = titleWatchProgress?.episodeProgress;
  const episodeProgressFor = (ep: Episode) =>
    id ? episodeProgress?.[episodeProgressKey(id, ep.season, ep.episode)] : undefined;
  // The backend's resumable pick — the latest history row can be a finished episode, which must not badge "Resume".
  const episodeResumeTarget = {
    season: titleWatchProgress?.seriesResumeEntry?.absolute_season ?? undefined,
    episode: titleWatchProgress?.seriesResumeEntry?.absolute_episode ?? undefined,
  };
  const resolvedAbsoluteSeason = currentEpisode?.season ?? routeAbsoluteSeason;
  const resolvedAbsoluteEpisode = currentEpisode?.episode ?? routeAbsoluteEpisode;
  const resolvedStreamSeason =
    routeStreamSeason ?? currentEpisodeStream?.streamSeason ?? routeSeason;
  const resolvedStreamEpisode =
    routeStreamEpisode ?? currentEpisodeStream?.streamEpisode ?? routeEpisode;
  // Latch the first duration per stream — mpv refines it mid-play and each new second would refetch skip times.
  const [skipDurationLatch, setSkipDurationLatch] = useState<{
    url: string | undefined;
    secs: number;
  } | null>(null);
  if (duration <= 0) {
    if (skipDurationLatch) setSkipDurationLatch(null);
  } else if (!skipDurationLatch) {
    setSkipDurationLatch({ url: activeStreamUrl, secs: Math.round(duration) });
  }
  const skipTimesDurationSecs =
    skipDurationLatch?.url === activeStreamUrl ? skipDurationLatch?.secs : undefined;
  const skipTimesStreamLookupId = routeStreamLookupId || currentEpisodeStream?.streamLookupId;
  const skipTimesEnabled =
    !!type &&
    !!id &&
    !!(nonBlank(details?.imdbId) || nonBlank(id) || nonBlank(skipTimesStreamLookupId)) &&
    skipTimesDurationSecs !== undefined &&
    (!isSeriesLike ||
      (resolvedAbsoluteSeason !== undefined && resolvedAbsoluteEpisode !== undefined));

  const { data: skipTimes } = useQuery<SkipTimesResult>({
    // SkipDB shifts segments to fit the reported duration, so the key buckets by it.
    queryKey: [
      'skip-times',
      effectiveResolveMediaType,
      id,
      resolvedAbsoluteSeason,
      resolvedAbsoluteEpisode,
      resolvedStreamSeason,
      resolvedStreamEpisode,
      details?.imdbId ?? '',
      skipTimesStreamLookupId ?? '',
      skipTimesDurationSecs ?? 0,
    ],
    queryFn: () =>
      api.getSkipTimes({
        mediaType: effectiveResolveMediaType,
        id: id!,
        imdbId: details?.imdbId,
        streamLookupId: skipTimesStreamLookupId,
        season: resolvedAbsoluteSeason,
        episode: resolvedAbsoluteEpisode,
        streamSeason: resolvedStreamSeason,
        streamEpisode: resolvedStreamEpisode,
        durationSecs: skipTimesDurationSecs,
      }),
    enabled: skipTimesEnabled,
    // Match Rust's shorter "no segments yet" lifetime so newly published data shows up.
    staleTime: (query) =>
      query.state.data?.segments.length ? SKIP_TIMES_STALE_TIME_MS : SKIP_TIMES_EMPTY_STALE_TIME_MS,
    retry: 1,
  });

  const skipSegments = skipTimes?.segments ?? EMPTY_SKIP_SEGMENTS;

  // -- Derived State --
  // Details payload carries seasons already sorted.
  const seasons = details?.seasons ?? EMPTY_SEASONS;

  // Render-phase correction: adopt a valid season before paint.
  if (seasons.length > 0 && !seasons.some((s) => s.number === selectedSeason)) {
    const fallbackSeason =
      currentEpisode?.season ??
      (resolvedAbsoluteSeason !== undefined &&
      seasons.some((s) => s.number === resolvedAbsoluteSeason)
        ? resolvedAbsoluteSeason
        : seasons[0]?.number);
    if (fallbackSeason !== undefined && fallbackSeason !== selectedSeason) {
      setSelectedSeason(fallbackSeason);
    }
  }

  const episodeCountInSeason =
    resolvedAbsoluteSeason === undefined || !episodes
      ? null
      : (seasons.find((s) => s.number === resolvedAbsoluteSeason)?.episodeCount ?? 0);

  const detailsImdbId = details?.imdbId;
  const streamLookupId =
    routeStreamLookupId || currentEpisodeStream?.streamLookupId || detailsImdbId || id;
  // A `kitsu:` seed resolving to `tt` must save the richer id — the backend rejects non-`tt` anchors.
  useEffect(() => {
    streamLookupIdRef.current = streamLookupId;
  }, [streamLookupId, streamLookupIdRef]);
  const shouldWaitForResolvedLookupId =
    !!type &&
    isSeriesLike &&
    !!id &&
    isLoadingDetails &&
    ((!routeStreamLookupId && !id.startsWith('tt') && !detailsImdbId) ||
      ((resolvedAbsoluteEpisode !== undefined || resolvedAbsoluteSeason !== undefined) &&
        routeStreamSeason === undefined &&
        routeStreamEpisode === undefined &&
        !currentEpisodeStream));

  const resumesFromStartTime = startTime !== undefined && startTime >= MIN_RESUME_POSITION_SECS;
  const openingSelectedStream = openingStreamName && activeStreamKey === routeSelectedStreamKey;
  const playerLoadingHeadline =
    resolveStatus ||
    (!activeStreamUrl
      ? 'Finding the best stream'
      : openingSelectedStream
        ? 'Opening selected stream'
        : resumesFromStartTime
          ? 'Resuming playback'
          : 'Starting playback');
  const playerLoadingDetail =
    !resolveStatus && activeStreamUrl && openingSelectedStream
      ? nonBlank(openingStreamSource) || openingStreamName.trim()
      : undefined;

  /** Skip segment under the playhead (1s lead-in); clock-subscribed so only segment changes re-render. */
  const activeSkipSegment = useSyncExternalStore(clock.subscribe, () => {
    if (!skipSegments.length || !duration) return null;
    const time = clock.getSnapshot();
    return skipSegments.find((seg) => time >= seg.start_time - 1 && time < seg.end_time) ?? null;
  });
  const hasActiveSkipSegmentStarted = useSyncExternalStore(
    clock.subscribe,
    () => activeSkipSegment !== null && clock.getSnapshot() >= activeSkipSegment.start_time,
  );
  const inCreditsWindow = useSyncExternalStore(clock.subscribe, () => {
    const time = clock.getSnapshot();
    return duration > 0 && time > 0 && duration - time <= CREDITS_NEXT_EPISODE_LEAD_SECS;
  });
  // SkipDB's "skip ~Xs" fallback for episodes without intro timestamps: once per episode, only while
  // the chrome is up so it never sits over the opening scenes.
  const introEstimateSecs = skipTimes?.intro_estimate_secs;
  const introEstimateKey = `${activeStreamUrl}:${resolvedAbsoluteSeason}:${resolvedAbsoluteEpisode}`;
  const [introEstimateUsedKey, setIntroEstimateUsedKey] = useState<string | null>(null);
  const introEstimateOffered = useSyncExternalStore(clock.subscribe, () => {
    if (!introEstimateSecs || introEstimateUsedKey === introEstimateKey || activeSkipSegment)
      return false;
    if (!isExpanded || (isPlaying && !showControls)) return false;
    const time = clock.getSnapshot();
    return time > 0 && time < Math.min(INTRO_ESTIMATE_WINDOW_SECS, duration / 4);
  });

  // The frameless window hides document.title; it still feeds the OS taskbar tooltip.
  const currentEpisodeLabel = formatSeasonEpisode(resolvedAbsoluteSeason, resolvedAbsoluteEpisode);
  const playerLoadingContext = formatPlaybackLanding(
    resolvedAbsoluteSeason,
    resolvedAbsoluteEpisode,
    startTime,
  );
  const currentEpisodeHeading = formatEpisodeHeading(
    resolvedAbsoluteSeason,
    resolvedAbsoluteEpisode,
    currentEpisode?.title,
  );
  useDocumentTitle(
    title ? `${title}${currentEpisodeLabel ? ` · ${currentEpisodeLabel}` : ''}` : undefined,
    isExpanded,
  );

  const queryClient = useQueryClient();
  const playbackLanguagePreferencesRef = useRef<PlaybackLanguagePreferences>({});
  const saveProgressRef = useRef<
    ReturnType<typeof usePlaybackProgressPersistence>['saveProgress'] | undefined
  >(undefined);

  const {
    addonSubtitleLanguage,
    audioTracks,
    cycleTrack,
    notifyObservedTrackSelection,
    playbackLanguagePreferences,
    refreshTracks,
    selectAddonSubtitle,
    setTrack,
    subTracks,
    trackSwitching,
  } = usePlayerTrackController({
    mediaId: id,
    mediaType: effectiveResolveMediaType,
    activeStreamUrl,
    hasPlaybackStarted,
    isLoading,
    isResolving,
    resetKey: JSON.stringify([activeStreamLoadKey, id, season, episode, effectiveResolveMediaType]),
  });

  const { saveProgress } = usePlaybackProgressPersistence({
    mediaId: id,
    mediaType: type,
    title,
    poster,
    backdrop,
    absoluteSeason: resolvedAbsoluteSeason,
    absoluteEpisode: resolvedAbsoluteEpisode,
    streamSeason: resolvedStreamSeason,
    streamEpisode: resolvedStreamEpisode,
    isPlaying,
    observedPositionRef,
    durationRef,
    stream,
  });

  const { reportFailure: reportStreamFailure, reportVerified: reportStreamVerified } =
    usePlaybackStreamHealth({
      mediaId: id,
      mediaType: type,
      absoluteSeason: resolvedAbsoluteSeason,
      absoluteEpisode: resolvedAbsoluteEpisode,
      stream,
    });

  const {
    applyResumeIfReady,
    cancelAutomaticResume,
    clearResumeRetryTimer,
    isResumePending,
    getResumeSeekTarget,
    confirmResumeSeek,
    prepareForStreamLoad,
    takeResumePause,
  } = usePlayerResumeController({
    mediaId: id,
    mediaType: type,
    activeStreamUrl,
    activeStreamLoadKey,
    startTime,
    absoluteSeason: resolvedAbsoluteSeason,
    absoluteEpisode: resolvedAbsoluteEpisode,
    isHistoryResume,
    suspended: error !== null,
    mountedRef,
    isDestroyedRef,
    currentTimeRef,
    durationRef,
    failoverResumePositionRef,
    onResumeMessage: handleResumeMessage,
  });

  useEffect(() => {
    playbackLanguagePreferencesRef.current = playbackLanguagePreferences;
  }, [playbackLanguagePreferences]);

  useEffect(() => {
    saveProgressRef.current = saveProgress;
  }, [saveProgress]);

  // Invalidate after the save so Continue Watching refetches the final position;
  // overlapping flushes dedupe in the save queue. Capped at 2s — a slow save still lands after.
  const flushPlaybackBeforeNavigation = useCallback(async () => {
    const flush = Promise.resolve(saveProgressRef.current?.()).then(() =>
      invalidatePlaybackHistoryQueries(queryClient, id),
    );
    // A slow save must still invalidate after it lands.
    await withTimeout(flush, 2000, () => undefined);
  }, [id, queryClient]);

  const navigationGuardEnabled = !!type && !!id && !!activeStreamUrl;

  // Single exit flush for session close, remount, and stream teardown — reads the latest save via ref.
  useEffect(() => {
    if (!navigationGuardEnabled) return;
    return () => {
      void flushPlaybackBeforeNavigation();
    };
  }, [navigationGuardEnabled, flushPlaybackBeforeNavigation]);

  const handleUserSeek = () => {
    cancelAutomaticResume();
    if (playbackEndedRef.current) cancelAutoPlayNext();
  };
  const { confirmSeek, getSeekTarget, isSeekPending, observeTimeUpdate, seek, seekRelative } =
    useOptimisticSeek({
      clock,
      durationRef,
      mpvInitializedRef,
      resetKey: activeStreamLoadKey,
      onUserSeek: handleUserSeek,
      triggerOsd,
    });

  // -- Addon subtitles (manifest-routed) --
  const {
    activeAddonSubtitleId,
    addonSubtitleLoadingId,
    addonSubtitles,
    addonSubtitlesError,
    addonSubtitlesFetching,
    addonSubtitlesLoading,
    addonSubtitlesAvailable,
    handleAddonSubtitleSelect,
    handleSubTrackSelect,
    refetchAddonSubtitles,
  } = usePlayerAddonSubtitles({
    activeStreamLoadKey,
    announce,
    autoLoadLanguage: appUiPreferences.autoLoadAddonSubtitles ? addonSubtitleLanguage : null,
    effectiveResolveMediaType,
    id,
    menuOpen: isExpanded && !isPip && openSettingsMenu === 'subtitles',
    mountedRef,
    resolvedStreamEpisode,
    resolvedStreamSeason,
    selectAddonSubtitle,
    setTrack,
    streamLookupId,
    subTracks,
  });

  const handleSettingsMenuOpenChange = (menu: 'audio' | 'subtitles' | 'speed', open: boolean) => {
    // Ignore a late dismiss from the menu being replaced.
    setOpenSettingsMenu((current) => (open ? menu : current === menu ? null : current));
  };

  useEffect(() => {
    setOpenSettingsMenu(null);
  }, [activeStreamLoadKey, isExpanded, isPip, showEpisodes, showShortcuts, showStreamSelector]);

  const handleAudioTrackSelect = (trackId: number) => {
    void setTrack('audio', trackId, { persistPreference: true }).then((applied) => {
      if (!applied) return;
      announce(`Audio: ${trackDisplayLabel(audioTracks, trackId)}`, 'audio');
    });
  };

  // Read live refs at back-time so the callback identity stays stable.
  const shouldReopenStreamSelector = useCallback(
    () =>
      errorRef.current !== null || playbackEndedRef.current || playbackVerifiedAtRef.current === 0,
    [],
  );
  // Replace the player in history so Back never re-launches it; Back drops
  // to the mini player and the dock transition flushes progress.
  const navigateBack = useCallback(async () => {
    setShowControls(true);
    setShowEpisodes(false);
    // The selector/Esc can swallow Back mid-pick, so only route coordinates can ride the back target.
    const backStartTime = playableResumePosition(
      observedPositionRef.current === null ? undefined : currentTimeRef.current,
      startTime,
    );
    // Reopen state: 0 stays valid, episode needs a season, start time positive.
    const safeFrom = resolveSafeInternalReturnPath(from);
    const safeOriginFrom = resolveSafeInternalReturnPath(originFrom);
    const detailsTarget = safeFrom?.startsWith('/details/')
      ? safeFrom
      : buildDetailsRoute(effectiveResolveMediaType, id ?? '');
    const reopenSelectorState: DetailsHistoryRouteState = {
      reopenStreamSelector: shouldReopenStreamSelector(),
    };
    // `from` is the launch page's origin — writing the details path would dead-end titlebar Back.
    if (safeOriginFrom && safeOriginFrom !== detailsTarget) {
      reopenSelectorState.from = safeOriginFrom;
    }
    if (routeAbsoluteSeason !== undefined) {
      reopenSelectorState.season = routeAbsoluteSeason;
      reopenSelectorState.reopenStreamSeason = routeAbsoluteSeason;
    }
    if (routeAbsoluteEpisode !== undefined && routeAbsoluteSeason !== undefined) {
      reopenSelectorState.reopenStreamEpisode = routeAbsoluteEpisode;
    }
    if (backStartTime !== undefined) {
      reopenSelectorState.reopenStartTime = backStartTime;
    }

    // If the launch entry sits directly below the player, pop onto it — a replace
    // would stack a duplicate. History state can't ride a POP, so the reopen handoff uses the path-keyed stash.
    if (safeFrom && pathBelowTop() === safeFrom) {
      if (safeFrom.startsWith('/details/')) {
        stashDetailsReturnState(safeFrom, reopenSelectorState);
      }
      navigateApp(-1);
      return;
    }

    navigateApp(safeFrom ?? detailsTarget, {
      replace: true,
      state: !safeFrom || safeFrom.startsWith('/details/') ? reopenSelectorState : undefined,
    });
  }, [
    routeAbsoluteSeason,
    routeAbsoluteEpisode,
    from,
    originFrom,
    effectiveResolveMediaType,
    id,
    startTime,
    setShowEpisodes,
    setShowControls,
    currentTimeRef,
    observedPositionRef,
    shouldReopenStreamSelector,
  ]);

  // -- Helpers --

  const stopLoading = (makeTransparent = false) => {
    setIsLoading(false);
    if (makeTransparent) {
      setPlayerDocumentBackground(true);
    }
  };

  const { requestMarginApply: requestSurfaceRefresh, getExpandedVideoRect } =
    usePlayerSurfaceLayout({
      playerContainerRef,
      topChromeRef,
      bottomChromeRef,
      activeStreamUrl,
      mpvSurfaceReady,
      isFullscreen,
      isPip,
      isLoading,
      isResolving,
      showErrorOverlay,
      presentation: isExpanded ? 'expanded' : 'mini',
    });

  const applyMiniSurface = useMiniPlayerSurface({
    enabled: !isExpanded,
    videoRectRef: miniVideoRectRef,
    surfaceReady: mpvSurfaceReady,
    // The mini chrome unmounts a commit before the margin apply lands — hold the hole so a playing surface can't bleed desktop through.
    holdHoleOnRelease: () => session !== null && window.location.pathname === session.playerPath,
  });

  const handleMiniVideoRectChange = (rect: MiniVideoRect | null) => {
    miniVideoRectRef.current = rect;
    return applyMiniSurface();
  };

  const openPreparedStreamSelector = (nextTarget: SelectedEpisodeStreamTarget | null) => {
    selectorCommittedReloadRef.current = null;
    selectorOpenRequestIdRef.current += 1;
    clearNextEpisodeRequest();
    setStreamSelectorState({
      open: true,
      target: nextTarget,
      mounted: true,
    });
    closeEpisodesPanel();
  };

  const reopenSelectorForSavedStreamFailure = () => {
    setResolveStatus(null);
    setShowControls(true);
    openPreparedStreamSelector(null);
  };

  const {
    cancelRecovery,
    releaseManualSelection,
    clearRecoveryTimers,
    markPlaybackStarted,
    recoverFromSlowStartup,
  } = useStreamRecovery({
    stream,
    isHistoryResume,
    mediaType: effectiveResolveMediaType,
    mediaId: id,
    title: rankingTitle,
    resolveSeason: resolvedStreamSeason,
    resolveEpisode: resolvedStreamEpisode,
    absoluteSeason: resolvedAbsoluteSeason,
    absoluteEpisode: resolvedAbsoluteEpisode,
    streamLookupId,
    currentTimeRef,
    isLoading,
    isPlaying,
    isPlayingRef,
    isResumePending,
    mountedRef,
    errorRef,
    failoverResumePositionRef,
    stopLoading,
    setError,
    setStreamError,
    setResolveStatus,
    onSavedStreamUnavailable: reopenSelectorForSavedStreamFailure,
  });

  const cancelAutomaticStreamSelection = () => {
    autoResolveGenRef.current += 1;
    manualSelectionGenerationRef.current = cancelRecovery();
    setResolveStatus(null);
  };

  // An early load failure leaves the watchdog armed; hold the manual lease so it cannot swap behind the selector.
  const reopenSelectorForSavedStreamLoadFailure = () => {
    cancelAutomaticStreamSelection();
    reopenSelectorForSavedStreamFailure();
  };

  const closeStreamSelector = () => {
    selectorOpenRequestIdRef.current += 1;
    clearNextEpisodeRequest();
    // Dismiss without a pick hands back the pause the selector took on the way in.
    if (resumeAfterSelectorDismissRef.current) {
      resumeAfterSelectorDismissRef.current = false;
      if (!trayPause.getSnapshot()) {
        void setMpvProperty('pause', false).catch(() => undefined);
        setIsPlaying(true);
      }
    }
    const generation = manualSelectionGenerationRef.current;
    manualSelectionGenerationRef.current = null;
    if (generation !== null) {
      releaseManualSelection(generation);
    }
    // Keep target/mounted until the exit animation finishes.
    setStreamSelectorState((state) => (state.mounted ? { ...state, open: false } : state));
  };

  const handleStreamSelectorClosed = () => {
    setStreamSelectorState((state) => (state.open ? state : CLOSED_STREAM_SELECTOR_STATE));
  };

  const markPlaybackReady = () => {
    stopLoading(true);
    setHasPlaybackStarted(true);
    clearTimer(forceShowTimeoutRef);
    showControlsWithAutoHide(PLAYBACK_READY_AUTO_HIDE_DELAY_MS);
  };

  // Only an advancing playhead proves the stream: duration alone can precede a stall, and must neither cancel recovery nor credit the source.
  const markPlaybackVerified = () => {
    if (errorRef.current) {
      if (recoverableStreamErrorRef.current !== errorRef.current) return;
      setError(null);
      markPlaybackReady();
    }
    confirmSeek();
    confirmResumeSeek();
    if (playbackVerifiedAtRef.current > 0) return;
    setHasPlaybackAdvanced(true);
    markPlaybackStarted();
    playbackVerifiedAtRef.current = performance.now();
    reportStreamVerified();
  };

  useEffect(() => {
    isResolvingRef.current = isResolving;
    isPlayingRef.current = isPlaying;
    // Resuming past EOF retires the "Up Next" card and the Back→selector latch.
    if (isPlaying && hasEnded) {
      playbackEndedRef.current = false;
      setHasEnded(false);
    }
  }, [hasEnded, isResolving, isPlaying]);

  useEffect(() => {
    const committed = selectorCommittedReloadRef.current;
    if (!committed || committed.state === session?.state) return;
    selectorCommittedReloadRef.current = null;
    // A changed route seed already drops the native URL; a retained one (same stream picked) must reload.
    if (activeStreamUrl === committed.url) setActiveStreamUrl(undefined);
  }, [activeStreamUrl, session?.state, setActiveStreamUrl]);

  const prepareForPlayerNavigation = (flushProgress = true) => {
    resumeAfterSelectorDismissRef.current = false;
    prepareForInternalPlayerNavigation();
    setShowControls(true);
    setShowEpisodes(false);
    // Synchronous progress snapshot; also covers same-session stream picks that skip the exit guard.
    if (flushProgress) void flushPlaybackBeforeNavigation();
  };

  const prepareForSelectorNavigation = () => {
    trayPause.publish(false);
    selectorCommittedReloadRef.current = activeStreamUrl
      ? { state: session?.state, url: activeStreamUrl }
      : null;
    prepareForPlayerNavigation();
  };

  const expandPlayer = () => {
    if (!session) return;
    // One-beat linger (MINI_EXIT_MS) so it dissolves out; reduced-motion unmounts plainly.
    if (!prefersReducedMotion()) {
      setMiniExiting(true);
      clearTimer(miniExitTimerRef);
      miniExitTimerRef.current = window.setTimeout(() => {
        miniExitTimerRef.current = null;
        setMiniExiting(false);
      }, MINI_EXIT_MS);
    }
    // Re-apply launch state (no remount); `from` rewrites to the expand origin so Back returns here.
    navigateApp(session.playerPath, {
      state: {
        ...expandedSessionState(session, currentPathWithSearch()),
        preserveTrayPause: true,
      },
    });
  };

  // Minimize keeps the player mounted — save progress on the expanded→mini transition, not unmount.
  // Overlays close too: any route change docks, and a stale flag would reopen them on expand.
  const wasExpandedRef = useRef(isExpanded);
  const [hasExpanded, setHasExpanded] = useState(isExpanded);
  if (isExpanded && !hasExpanded) setHasExpanded(true);
  useEffect(() => {
    const wasExpanded = wasExpandedRef.current;
    wasExpandedRef.current = isExpanded;
    if (wasExpanded && !isExpanded) {
      setShowEpisodes(false);
      setShowShortcuts(false);
      // Back abandons a pending next-episode resolve — its completion would navigate back into the expanded player.
      if (nextEpisodeRequestRef.current !== null) {
        selectorOpenRequestIdRef.current += 1;
        clearNextEpisodeRequest();
      }
      void flushPlaybackBeforeNavigation();
    }
  }, [clearNextEpisodeRequest, flushPlaybackBeforeNavigation, isExpanded]);

  const handleEndedChange = (ended: boolean) => {
    if (playbackEndedRef.current === ended) return;
    playbackEndedRef.current = ended;
    setHasEnded(ended);
    void saveProgressRef.current?.({ completed: ended });
    if (!ended) return;
    setIsPlaying(false);
    void flushPlaybackBeforeNavigation();
    // Pin chrome for the EOF card — isPlayingRef can read stale-true here, so drive controls directly.
    clearControlsAutoHide();
    setShowControls(true);
  };

  const scheduleMpvSet = useMpvSetScheduler(activeStreamLoadKey);
  const {
    subtitleDelay,
    subtitlePos,
    subtitleScale,
    subtitleSettingsRef,
    applySubtitleDelay,
    applySubtitlePos,
    applySubtitleScale,
    stepSubtitleDelay,
    resetSubtitleSettings,
  } = useSubtitleAdjustments({
    preferences: appUiPreferences,
    updatePreferences: updateAppUiPreferences,
    scheduleMpvSet,
  });

  const {
    volume,
    applyNativeVolume,
    isMuted,
    applyNativeMute,
    isMutedRef,
    volumeRef,
    handleVolumeChange,
    handleVolumeWheel,
    stepVolume,
    toggleMute,
  } = usePlayerVolumeControls({
    playerVolume: appUiPreferences.playerVolume,
    updatePreferences: updateAppUiPreferences,
    mpvInitializedRef,
    scheduleMpvSet,
    triggerOsd,
  });

  const { isBuffering, nextEpisodePrefetchDue } = usePlayerMpvLifecycle({
    stream,
    isHistoryResume,
    // Read the live ref — a mid-init pref change still applies the newest speed.
    playbackSpeedRef: appliedSpeedRef,
    subtitleSettingsRef,
    playbackLanguagePreferencesRef,
    volumeRef,
    isMutedRef,
    mountedRef,
    isDestroyedRef,
    mpvInitializedRef,
    isLoading,
    isPlayingRef,
    clock,
    observedPositionRef,
    bufferedClock,
    durationRef,
    playbackVerifiedAtRef,
    errorRef,
    recoverableStreamErrorRef,
    forceShowTimeoutRef,
    saveProgressRef,
    setIsLoading,
    setError,
    setStreamError,
    setDuration,
    setIsPlaying,
    applyNativeVolume,
    applyNativeMute,
    setPlaybackSpeed,
    setMpvSurfaceReady,
    requestSurfaceRefresh,
    clearUiTimers,
    clearResumeRetryTimer,
    clearRecoveryTimers,
    prepareForStreamLoad,
    markPlaybackReady,
    markPlaybackVerified,
    applyResumeIfReady,
    onEndedChange: handleEndedChange,
    observeTimeUpdate,
    isSeekPending,
    getSeekTarget: () => getSeekTarget() ?? getResumeSeekTarget(),
    isResumePending,
    onObservedTrackSelection: notifyObservedTrackSelection,
    refreshTracks,
    reportStreamFailure,
    recoverFromSlowStartup,
    isResolvingRef,
    reopenSelectorForSavedStreamFailure: reopenSelectorForSavedStreamLoadFailure,
    stopLoading,
    setTransparent: setPlayerDocumentBackground,
    restorePlayerSurface: restorePlayerBackground,
    // Stuck loads keep controls pinned — auto-hide would bury the escape hatch.
    revealControls: () => setShowControls(true),
  });

  // Idle card: a zero-input stretch while paused dims the frame; any input dismisses.
  const { idle: idleOverlayVisible, wake: wakePlayerIdle } = usePlayerIdleOverlay({
    enabled:
      isExpanded &&
      !isPip &&
      hasPlaybackAdvanced &&
      !isPlaying &&
      !hasEnded &&
      !isLoading &&
      !isResolving &&
      !isBuffering &&
      !error &&
      !showStreamSelector &&
      !showEpisodes &&
      !showShortcuts &&
      openSettingsMenu === null,
    mountedRef,
  });

  const playbackControlEpochRef = useRef(0);
  useEffect(() => {
    return () => {
      playbackControlEpochRef.current += 1;
    };
  }, [activeStreamLoadKey]);

  const restartPlayback = async () => {
    trayPause.publish(false);
    const epoch = playbackControlEpochRef.current;
    await seek(0);
    if (
      epoch !== playbackControlEpochRef.current ||
      !mountedRef.current ||
      isDestroyedRef.current ||
      trayPause.getSnapshot()
    )
      return;
    await setMpvProperty('pause', false);
  };

  // keep-open parks mpv on the last frame at terminal EOF — Play must rewind and resume, not just clear `pause`.
  const isTerminalEof = () =>
    playbackEndedRef.current &&
    (durationRef.current <= 0 || isNearMediaEnd(currentTimeRef.current, durationRef.current));

  // Seeking back after EOF resumes the selected position; Watch again always restarts.
  const togglePlay = async () => {
    // Mid-startup, init re-applies its start pause after this consumed the resume pause, stranding playback
    // paused at the resume point. An errored instance has nothing to toggle.
    if (isLoading || error) return;
    trayPause.publish(false);
    takeResumePause();
    return isTerminalEof() ? restartPlayback() : mpvCommand('cycle', ['pause']);
  };

  const openStreamSelectorForEpisode = (
    selectedEpisode: Episode,
    options?: {
      pauseCurrentPlayback?: boolean;
      resumeStartTimePromise?: Promise<number | undefined>;
    },
  ) => {
    if (!id) {
      return;
    }

    cancelAutomaticStreamSelection();
    if (options?.pauseCurrentPlayback) {
      // Fire-and-forget pause under the selector; remember pre-pause state so dismiss can resume.
      const resumeOwnedPause = takeResumePause();
      resumeAfterSelectorDismissRef.current = isPlayingRef.current || resumeOwnedPause;
      void setMpvProperty('pause', true).catch(() => undefined);
      setIsPlaying(false);
    }

    const target = buildEpisodeStreamTarget(streamLookupId || id, selectedEpisode);

    // The resume lookup is advisory for a different episode only — a same-episode pick reads the live clock.
    const targetsCurrentEpisode = sameEpisodeCoordinates(target, {
      absoluteSeason: resolvedAbsoluteSeason,
      absoluteEpisode: resolvedAbsoluteEpisode,
      streamSeason: resolvedStreamSeason,
      streamEpisode: resolvedStreamEpisode,
    });

    // Open immediately — the advisory lookup fills startTime behind the dialog before any pick.
    openPreparedStreamSelector(target);
    const requestId = selectorOpenRequestIdRef.current;

    if (!targetsCurrentEpisode) {
      const resumeStartTimePromise =
        options?.resumeStartTimePromise ??
        getLatestEpisodeResumeStartTime(
          id,
          effectiveResolveMediaType,
          target.absoluteSeason,
          target.absoluteEpisode,
        );
      void resumeStartTimePromise.then((nextStartTime) => {
        if (isSelectorRequestStale(requestId) || nextStartTime === undefined) {
          return;
        }

        setStreamSelectorState((state) =>
          state.open && state.target
            ? { ...state, target: { ...state.target, startTime: nextStartTime } }
            : state,
        );
      });
    }
  };

  const previousEpisodeLabel = previousEpisode
    ? `Previous: ${formatEpisodeHeading(previousEpisode.season, previousEpisode.episode, previousEpisode.title)}`
    : undefined;

  const nextEpisodeLabel = nextEpisode
    ? `Next: ${formatEpisodeHeading(nextEpisode.season, nextEpisode.episode, nextEpisode.title)}`
    : undefined;

  // Prefetch and advance share the same source hints and cache key.
  const resolveEpisodeStream = useCallback(
    (ep: Episode, mediaId: string, signal?: AbortSignal) => {
      const target = buildEpisodeStreamTarget(streamLookupId || mediaId, ep);
      const request: PlayerStreamRequest = {
        mediaType: effectiveResolveMediaType,
        mediaId,
        streamLookupId: target.streamLookupId,
        streamSeason: target.streamSeason,
        streamEpisode: target.streamEpisode,
        absoluteSeason: target.absoluteSeason,
        absoluteEpisode: target.absoluteEpisode,
        title: rankingTitle,
      };
      return {
        target,
        request,
        resolve: resolvePlayerStream({
          ...request,
          signal,
          preferred: {
            // Soft-match the just-played release/source for a seamless advance.
            sourceId: activeStreamSourceIdRef.current,
            sourceName: activeStreamSourceNameRef.current,
            streamFamily: activeStreamFamilyRef.current,
          },
        }),
      };
    },
    [
      activeStreamFamilyRef,
      activeStreamSourceIdRef,
      activeStreamSourceNameRef,
      effectiveResolveMediaType,
      rankingTitle,
      streamLookupId,
    ],
  );

  // Silent ranked resolve first — the just-played source usually wins; timeout/failure falls back to the selector.
  const playAdjacentEpisode = (ep: Episode | undefined, direction: 'next' | 'previous') => {
    if (isResolving) return;
    if (!ep || !id || nextEpisodeRequestRef.current !== null) {
      if (!ep && nextEpisodeRequestRef.current === null) {
        announce(`No ${direction} episode`);
      }
      return;
    }

    const requestId = ++selectorOpenRequestIdRef.current;
    const abort = new AbortController();
    const launchGeneration = claimPlaybackLaunch();
    const isStale = () =>
      isSelectorRequestStale(requestId) ||
      trayPause.getSnapshot() ||
      !isCurrentPlaybackLaunch(launchGeneration);
    trayPause.publish(false);
    nextEpisodeRequestRef.current = abort;
    const { target, request, resolve } = resolveEpisodeStream(ep, id, abort.signal);
    setResolveStatus(`Loading ${direction} episode`);

    const resumeStartTimePromise = getLatestEpisodeResumeStartTime(
      id,
      effectiveResolveMediaType,
      target.absoluteSeason,
      target.absoluteEpisode,
    );
    const resolveWork = Promise.all([resolve, resumeStartTimePromise]);
    void withTimeout(resolveWork, NEXT_EPISODE_AUTO_RESOLVE_TIMEOUT_MS, () => {
      throw new Error('adjacent-episode resolve timed out');
    })
      .then(([resolved, resumeStartTime]) => {
        if (isStale()) {
          clearNextEpisodeRequest(abort);
          return;
        }
        if (!resolved?.url) throw new Error('No streams found for the adjacent episode.');

        prepareForPlayerNavigation();
        launchResolvedStream(boundNavigate, request, resolved, {
          backdrop,
          from,
          logo,
          originFrom,
          poster,
          startTime: resumeStartTime,
        });
      })
      .catch(() => {
        clearNextEpisodeRequest(abort);
        if (isStale()) return;
        openStreamSelectorForEpisode(ep, {
          pauseCurrentPlayback: true,
          resumeStartTimePromise,
        });
      })
      .finally(() => {
        if (nextEpisodeRequestRef.current === abort) {
          nextEpisodeRequestRef.current = null;
        }
      });
  };

  const playNextEpisode = () => playAdjacentEpisode(nextEpisode, 'next');

  const playPreviousEpisode = () => playAdjacentEpisode(previousEpisode, 'previous');

  // One EOF gate for both cards; the variant depends on whether an episode follows.
  // Auto-play counts down to the same silent resolve `N` runs — a gate flip disarms the timer.
  const playbackIntact = !error && !isLoading && !isResolving;
  const panelsOwnSurface = showStreamSelector || showEpisodes || showShortcuts;
  const eofCardOpen =
    hasEnded && playbackIntact && !panelsOwnSurface && !isLoadingEpisodeNavigation;
  const showUpNextCard = eofCardOpen && !!nextEpisode;
  const showEndCard = eofCardOpen && !nextEpisode;
  useEffect(() => {
    setEofAutoPlayCancelled(false);
  }, [
    id,
    resolvedAbsoluteSeason,
    resolvedAbsoluteEpisode,
    nextEpisode?.season,
    nextEpisode?.episode,
  ]);

  // Docked EOF never counts down — the advance would yank the user into the expanded player with no visible cancel.
  const canAutoPlayNext =
    appUiPreferences.autoPlayNext &&
    showUpNextCard &&
    isExpanded &&
    !eofAutoPlayCancelled &&
    !pausedByTrayHide;
  const advanceAfterCountdown = useEffectEvent(() => {
    if (canAutoPlayNext && !trayPause.getSnapshot()) playNextEpisode();
  });
  useEffect(() => {
    if (!canAutoPlayNext) {
      autoPlayCountdown.publish(null);
      return;
    }
    autoPlayCountdown.publish(appUiPreferences.nextEpisodeCountdownSecs);
    const timer = window.setInterval(() => {
      const current = autoPlayCountdown.getSnapshot();
      if (current === null) return;
      const next = current - 1;
      autoPlayCountdown.publish(next === 0 ? null : next);
      if (next === 0) {
        window.clearInterval(timer);
        advanceAfterCountdown();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [appUiPreferences.nextEpisodeCountdownSecs, autoPlayCountdown, canAutoPlayNext]);

  // Every EOF play affordance uses the same rewind-and-resume path.
  const replayFromStart = () => {
    void restartPlayback().catch(() => undefined);
  };

  const backToTitle = () => {
    if (!id) {
      void navigateBack().catch(() => undefined);
      return;
    }
    // Expanded navigation retains the session; the docking effect owns its progress flush.
    prepareForPlayerNavigation(!isExpanded);
    navigateApp(buildDetailsRoute(type, id), {
      replace: true,
      state:
        resolvedAbsoluteSeason !== undefined
          ? { from, season: resolvedAbsoluteSeason, episode: resolvedAbsoluteEpisode }
          : { from },
    });
  };

  // OS media keys; stays mounted when docked so they keep driving playback.
  // `previoustrack` restarts the title — no playlist-back concept.
  useMediaSession({
    title: activeStreamUrl ? (title ?? '') : '',
    artist: currentEpisodeHeading || undefined,
    artworkSrcs: [poster, backdrop, logo],
    duration,
    isPlaying,
    playbackSpeed,
    clock,
    onPlay: () => {
      trayPause.publish(false);
      void (isTerminalEof() ? restartPlayback() : setMpvProperty('pause', false)).catch(
        () => undefined,
      );
    },
    onPause: () => {
      // An explicit pause owns the pause, so resume finalization must not undo it.
      takeResumePause();
      if (playbackEndedRef.current) cancelAutoPlayNext();
      void setMpvProperty('pause', true).catch(() => undefined);
    },
    onPreviousTrack: () => void seek(0).catch(() => undefined),
    onNextTrack: nextEpisode ? playNextEpisode : undefined,
    onSeekTo: (seconds) => void seek(seconds).catch(() => undefined),
    onSeekBy: (seconds) => void seekRelative(seconds).catch(() => undefined),
  });

  // A segment reaching file end is the episode tail — seeking into EOF parks on a dead frame.
  const tailSegmentActive =
    activeSkipSegment != null && isNearMediaEnd(activeSkipSegment.end_time, duration);
  const nextEpisodeTailActive =
    !!nextEpisode && (tailSegmentActive || (!activeSkipSegment && inCreditsWindow));
  useEffect(() => {
    if (!id || !nextEpisode || error) return;
    if (isLoading || isResolving || showStreamSelector || shouldWaitForResolvedLookupId) return;
    if (pausedByTrayHide || (!isPlaying && !hasEnded)) return;
    if (!isExpanded && !hasEnded && !nextEpisodeTailActive) return;
    if (
      !hasEnded &&
      !nextEpisodeTailActive &&
      !(appUiPreferences.autoPlayNext && nextEpisodePrefetchDue)
    )
      return;

    const abort = new AbortController();
    let refreshTimer: TimerHandle | null = null;
    const warm = () => {
      void resolveEpisodeStream(nextEpisode, id, abort.signal)
        .resolve.then((resolved) => {
          if (abort.signal.aborted || resolved.cacheTtlMs <= 0 || (hasEnded && !canAutoPlayNext))
            return;
          // Slow playback can outlive the pool TTL; never extend a signed URL's lifetime.
          refreshTimer = setTimeout(
            warm,
            Math.max(5000, getCachedResultRefreshDelayMs(resolved) + 250),
          );
        })
        .catch(() => undefined);
    };
    warm();
    return () => {
      abort.abort();
      if (refreshTimer !== null) clearTimeout(refreshTimer);
    };
  }, [
    activeStreamLoadKey,
    appUiPreferences.autoPlayNext,
    canAutoPlayNext,
    nextEpisodeTailActive,
    error,
    hasEnded,
    id,
    isLoading,
    isResolving,
    isExpanded,
    isPlaying,
    nextEpisode,
    nextEpisodePrefetchDue,
    pausedByTrayHide,
    resolveEpisodeStream,
    shouldWaitForResolvedLookupId,
    showStreamSelector,
    streamLookupId,
  ]);

  const skipAction = nextEpisodeTailActive
    ? { label: 'Next episode', onSkip: playNextEpisode }
    : activeSkipSegment
      ? {
          label: `Skip ${SKIP_SEGMENT_LABELS[activeSkipSegment.type]}`,
          onSkip: (source: 'user' | 'automatic' = 'user') => {
            void seek(activeSkipSegment.end_time, source, () =>
              announce(`Skipped ${SKIP_SEGMENT_LABELS[activeSkipSegment.type]}`, 'skip'),
            ).catch(() => undefined);
          },
        }
      : introEstimateOffered && introEstimateSecs
        ? {
            label: `Skip intro ~${introEstimateSecs}s`,
            onSkip: () => {
              setIntroEstimateUsedKey(introEstimateKey);
              void seek(
                Math.min(duration, currentTimeRef.current + introEstimateSecs),
                'user',
                () => announce('Skipped intro', 'skip'),
              ).catch(() => undefined);
            },
          }
        : null;

  // EOF and open panels own the action lane, even if mpv's last clock tick is inside an outro.
  const canSkip =
    !hasEnded &&
    playbackIntact &&
    !panelsOwnSurface &&
    (nextEpisodeTailActive || !!activeSkipSegment || introEstimateOffered);
  const activeSkipAction = canSkip ? skipAction : null;

  // Auto-skip fires once per intro/recap segment, even after seeking back into it; the tail stays manual — that's `autoPlayNext`'s job.
  const autoSkipIntro = appUiPreferences.autoSkipIntro;
  const autoSkippedSegmentsRef = useRef(new Set<string>());
  useEffect(() => {
    if (
      !autoSkipIntro ||
      !activeSkipAction ||
      !activeSkipSegment ||
      !hasActiveSkipSegmentStarted ||
      tailSegmentActive
    )
      return;
    const { type: segmentType, start_time: start, end_time: end } = activeSkipSegment;
    if (segmentType !== 'intro' && segmentType !== 'recap') return;
    const segmentKey = `${id}:${resolvedAbsoluteSeason}:${resolvedAbsoluteEpisode}:${segmentType}:${start}:${end}`;
    if (autoSkippedSegmentsRef.current.has(segmentKey)) return;
    autoSkippedSegmentsRef.current.add(segmentKey);
    activeSkipAction.onSkip('automatic');
  }, [
    activeSkipAction,
    activeSkipSegment,
    autoSkipIntro,
    hasActiveSkipSegmentStarted,
    id,
    resolvedAbsoluteEpisode,
    resolvedAbsoluteSeason,
    tailSegmentActive,
  ]);

  const openManualStreamFallback = () => {
    if (isSeriesLike && currentEpisode) {
      openStreamSelectorForEpisode(currentEpisode);
      return;
    }
    // Movies and pre-details series open against route coords with the remembered timestamp.
    cancelAutomaticStreamSelection();
    openPreparedStreamSelector(null);
  };

  // Clear the failed stream and error so auto-resolve re-ranks and retries in place.
  const handleRetryFailedStream = () => {
    trayPause.publish(false);
    // A manual retry is a same-title failover — preserve the live playhead so the re-resolve resumes here.
    failoverResumePositionRef.current = currentTimeRef.current;
    setActiveStreamUrl(undefined);
    setError(null);
  };

  // `cycleTrack` runs switch-flag + persist bookkeeping a bare `cycle` skips — without it the language auto-apply reverts.
  const cycleSubtitles = async () => {
    // Cycling with no tracks lands on 'no' and would persist "subtitles off" as the global preference.
    if (subTracks.length === 0) {
      announce('No subtitle tracks', 'subtitles');
      return;
    }
    const landed = await cycleTrack('sub');
    if (landed === null) return;
    announce(
      landed === 'no' ? 'Subtitles off' : `Subtitles: ${trackDisplayLabel(subTracks, landed)}`,
      'subtitles',
    );
  };

  const cycleAudioTrack = async () => {
    if (audioTracks.length < 2) {
      announce('No other audio tracks', 'audio');
      return;
    }
    const landed = await cycleTrack('audio');
    if (landed === null) return;
    announce(
      landed === 'no' ? 'Audio off' : `Audio: ${trackDisplayLabel(audioTracks, landed)}`,
      'audio',
    );
  };

  const handleSpeedSelect = (speed: number) => {
    setPlaybackSpeed(speed);
    appliedSpeedRef.current = speed;
    updateAppUiPreferences({ playerSpeed: speed });
    if (!mpvInitializedRef.current) {
      announce(`Speed: ${speed}x`, 'gauge');
      return;
    }
    const epoch = playbackControlEpochRef.current;
    const isStale = () =>
      epoch !== playbackControlEpochRef.current || !mountedRef.current || isDestroyedRef.current;
    void setMpvProperty('speed', speed).then(
      () => {
        if (!isStale()) announce(`Speed: ${speed}x`, 'gauge');
      },
      (err: unknown) => {
        if (!isStale())
          notifyAction("Couldn't apply playback speed", {
            detail: getErrorMessage(err),
            tone: 'error',
          });
      },
    );
  };

  // `[`/`]` step the preset ladder; at the edge the press no-ops, so re-announce the current speed.
  const stepSpeed = (direction: 1 | -1) => {
    const next =
      direction > 0
        ? (SPEED_OPTIONS.find((s) => s > playbackSpeed) ?? playbackSpeed)
        : (SPEED_OPTIONS.findLast((s) => s < playbackSpeed) ?? playbackSpeed);
    if (next !== playbackSpeed) {
      handleSpeedSelect(next);
      return;
    }
    announce(`Speed: ${next}x`, 'gauge');
  };

  // `z`/`x` nudge subtitle delay by one slider quantum.
  const nudgeSubtitleDelay = (direction: 1 | -1) => {
    void stepSubtitleDelay(direction).then((next) => {
      if (next !== undefined) {
        announce(`Subtitles ${next > 0 ? '+' : ''}${next.toFixed(1)}s`, 'subtitles');
      }
    });
  };

  const toggleEpisodesPanel = () => {
    if (showEpisodes) {
      closeEpisodesPanel();
    } else {
      setEpisodesPanelMounted(true);
      setShowEpisodes(true);
    }
  };

  // -- Hotkeys --
  const hasEpisodes = (episodes?.length ?? 0) > 0;

  usePlayerHotkeys({
    closeEpisodesPanel,
    closeStreamSelector,
    cycleAudioTrack,
    cycleSubtitles,
    durationRef,
    expandPlayer,
    stepVolume,
    hasEpisodes,
    isExpanded,
    isFullscreen,
    keymap,
    navigateBack: isPip ? returnFromPip : navigateBack,
    nudgeSubtitleDelay,
    openStreamSelector: id ? openManualStreamFallback : null,
    playPreviousEpisode,
    playNextEpisode,
    seek,
    seekRelative,
    showEpisodes,
    showShortcuts,
    showStreamSelector,
    skipAction: activeSkipAction,
    stepSpeed,
    resetSpeed: () => handleSpeedSelect(1),
    closeShortcuts,
    toggleEpisodes: toggleEpisodesPanel,
    toggleShortcuts,
    toggleFullscreen,
    toggleMute,
    togglePlay,
  });

  // -- Effects --

  usePlayerAutoResolve({
    stream,
    autoResolveGenRef,
    effectiveResolveMediaType,
    error,
    id,
    isResolving,
    mountedRef,
    resolvedAbsoluteEpisode,
    resolvedAbsoluteSeason,
    resolvedStreamEpisode,
    resolvedStreamSeason,
    routeRequestedStreamKey,
    routeSelectedStreamKey,
    setError,
    setResolveStatus,
    shouldWaitForResolvedLookupId,
    showStreamSelector,
    stopLoading,
    streamLookupId,
    title: resolveTitle,
    type,
  });

  // Only visible, continuous motion is throttled; surface movement gets a short idle tail.
  const lastControlsWakeAtRef = useRef(0);
  const lastControlsPointerRef = useRef({ x: Number.NaN, y: Number.NaN });
  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (
      document.visibilityState === 'hidden' ||
      (event.target instanceof Element && event.target.closest('[data-player-navigation]'))
    )
      return;
    const previous = lastControlsPointerRef.current;
    if (previous.x === event.clientX && previous.y === event.clientY) return;
    previous.x = event.clientX;
    previous.y = event.clientY;
    // Native surface creation can blur the WebView without a later focus event; real motion re-arms it.
    windowActiveRef.current = true;
    const now = performance.now();
    if (showControls && now - lastControlsWakeAtRef.current < 100) return;
    lastControlsWakeAtRef.current = now;
    if (
      event.target instanceof Node &&
      (topChromeRef.current?.contains(event.target) ||
        bottomChromeRef.current?.contains(event.target) ||
        (event.target instanceof Element && event.target.closest('[data-player-pip-chrome]')))
    ) {
      showControlsWithAutoHide();
    } else {
      showControlsWithAutoHide(POINTER_CONTROLS_IDLE_MS);
    }
  };

  const handleMouseLeave = () => {
    lastControlsPointerRef.current.x = Number.NaN;
    lastControlsPointerRef.current.y = Number.NaN;
    if (!isPlayingRef.current) return;
    // Portaled popovers leave the container — a hide here would unmount chrome under an open menu.
    if (isPlayerChromeEngaged()) {
      scheduleControlsAutoHide(POINTER_CONTROLS_IDLE_MS);
      return;
    }
    clearControlsAutoHide();
    setShowControls(false);
  };

  const releaseInactiveControls = useEffectEvent(() => {
    windowActiveRef.current = false;
    handleMouseLeave();
  });
  const releaseOutsideControls = useEffectEvent(() => handleMouseLeave());
  useEffect(() => {
    const handleBlur = () => releaseInactiveControls();
    const handleFocus = () => {
      windowActiveRef.current = document.visibilityState !== 'hidden';
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') releaseInactiveControls();
      else windowActiveRef.current = document.hasFocus();
    };
    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) releaseOutsideControls();
    };
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('pointerout', handlePointerOut);
    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('pointerout', handlePointerOut);
    };
  }, []);

  const [accumulateWheelSeek] = useState(createWheelSeekAccumulator);
  const handlePlayerWheel = (event: WheelEvent<HTMLElement>) => {
    if (showStreamSelector || showEpisodes || showShortcuts) return;
    if (isPlayerInteractiveTarget(event.target)) return;
    if (event.deltaY === 0) return;
    if (event.shiftKey) {
      const seconds = accumulateWheelSeek(event);
      if (seconds !== 0) void seekRelative(seconds).catch(() => undefined);
    } else {
      void handleVolumeWheel(event).catch(() => undefined);
    }
  };

  // Paused pins the chrome — once the idle card owns the frame both dissolve; any input brings them back.
  useEffect(() => {
    if (!isExpanded) return;
    if (idleOverlayVisible) {
      clearControlsAutoHide();
      setShowControls(false);
    } else {
      showControlsWithAutoHide();
    }
  }, [clearControlsAutoHide, idleOverlayVisible, isExpanded, isPlaying, showControlsWithAutoHide]);

  useEffect(() => {
    return () => {
      clearUiTimers();
      clearRecoveryTimers();
    };
  }, [clearRecoveryTimers, clearUiTimers]);

  const handlePlayerClick = (event: MouseEvent<HTMLElement>) => {
    if (shouldIgnorePlayerSurfaceInteraction(event)) return;

    const dismissedIdle = idleDismissedByClickRef.current;
    idleDismissedByClickRef.current = false;
    blurActivePlayerControl();

    if (showEpisodes) {
      closeEpisodesPanel();
      return;
    }

    // First click dismisses the idle card and wakes the chrome, not pause.
    if (idleOverlayVisible) {
      idleDismissedByClickRef.current = event.detail === 1;
      wakePlayerIdle();
      showControlsWithAutoHide(POINTER_CONTROLS_IDLE_MS);
      return;
    }

    if (event.detail === 2 && dismissedIdle) return;
    if (isLoading || isResolving || error) return;

    // Toggle immediately — the second click toggles back before dblclick fullscreen lands; no disambiguation delay.
    setShowControls(true);
    void togglePlay().catch(() => undefined);
  };

  const handlePlayerDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if (shouldIgnorePlayerSurfaceInteraction(event)) return;

    blurActivePlayerControl();

    void toggleFullscreen().catch(() => undefined);
  };

  // Keyboard focus and key presses on chrome wake it with the normal delay, never hold it:
  // focus stays on a faded control, so a hold would outlive the interaction indefinitely.
  const handleControlsKeyboardInput = (event: SyntheticEvent<HTMLDivElement>) => {
    if (
      windowActiveRef.current &&
      document.hasFocus() &&
      document.visibilityState !== 'hidden' &&
      event.target instanceof Element &&
      (topChromeRef.current?.contains(event.target) ||
        bottomChromeRef.current?.contains(event.target) ||
        event.target.closest('[data-player-pip-chrome]')) &&
      event.target.matches(':focus-visible')
    ) {
      showControlsWithAutoHide();
    }
  };
  const handleControlsHover = (hovered: boolean) => {
    if (!windowActiveRef.current || document.visibilityState === 'hidden' || idleOverlayVisible)
      return;
    // A CSS-generated leave must never bring hidden chrome back.
    if (hovered) showControlsWithAutoHide();
    else scheduleControlsAutoHide(POINTER_CONTROLS_IDLE_MS);
  };
  const handleControlsPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!windowActiveRef.current || document.visibilityState === 'hidden') return;
    if (
      event.target instanceof Element &&
      (topChromeRef.current?.contains(event.target) ||
        bottomChromeRef.current?.contains(event.target) ||
        event.target.closest('[data-player-pip-chrome], [data-player-popover]'))
    ) {
      capturedControlsPointerRef.current = { target: event.target, pointerId: event.pointerId };
      showControlsWithAutoHide(POINTER_CONTROLS_IDLE_MS);
    }
  };
  const handleControlsPointerRelease = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (capturedControlsPointerRef.current?.pointerId !== event.pointerId) return;
    capturedControlsPointerRef.current = null;
    scheduleControlsAutoHide(POINTER_CONTROLS_IDLE_MS);
  };

  // -- Render Logic --
  const selectorAbsoluteSeason =
    selectedEpisodeStreamTarget?.absoluteSeason ?? resolvedAbsoluteSeason;
  const selectorAbsoluteEpisode =
    selectedEpisodeStreamTarget?.absoluteEpisode ?? resolvedAbsoluteEpisode;
  const selectorStreamLookupId = selectedEpisodeStreamTarget?.streamLookupId ?? streamLookupId;
  const selectorStreamSeason = selectedEpisodeStreamTarget?.streamSeason ?? resolvedStreamSeason;
  const selectorStreamEpisode = selectedEpisodeStreamTarget?.streamEpisode ?? resolvedStreamEpisode;
  const isSelectorForCurrentEpisode = sameEpisodeCoordinates(
    {
      absoluteSeason: selectorAbsoluteSeason,
      absoluteEpisode: selectorAbsoluteEpisode,
      streamSeason: selectorStreamSeason,
      streamEpisode: selectorStreamEpisode,
    },
    {
      absoluteSeason: resolvedAbsoluteSeason,
      absoluteEpisode: resolvedAbsoluteEpisode,
      streamSeason: resolvedStreamSeason,
      streamEpisode: resolvedStreamEpisode,
    },
  );
  // At EOF a resume press would just re-hit EOF.
  const atEndOfStream = useSyncExternalStore(
    clock.subscribe,
    () => duration > 0 && clock.getSnapshot() >= Math.max(duration - 0.5, 0),
  );
  const showPauseResume =
    !isPlaying &&
    hasPlaybackAdvanced &&
    !hasEnded &&
    !atEndOfStream &&
    !canSkip &&
    !idleOverlayVisible &&
    playbackIntact &&
    !panelsOwnSurface;
  const selectorEpisode = findEpisodeByCoordinates(
    details?.episodes,
    selectorAbsoluteSeason,
    selectorAbsoluteEpisode,
  );
  const hideSelectorSpoiler = Boolean(
    selectorEpisode &&
    isEpisodeSpoiler(
      selectorEpisode,
      appUiPreferences.spoilerProtection,
      titleWatchProgress?.watchedEpisodeCeiling,
      episodeProgressFor(selectorEpisode),
      isSelectorForCurrentEpisode,
    ),
  );
  // Held a beat past the flag so the loading card dissolves out.
  const startupLoading = isLoading || isResolving || (isBuffering && !hasPlaybackAdvanced);
  const [loadingProgress, setLoadingProgress] = useState({
    key: activeStreamLoadKey,
    resolving: isResolving,
    started: isLoading,
    stage: isResolving || !activeStreamUrl ? 0 : 1,
  });
  const newLoadingAttempt =
    loadingProgress.key !== activeStreamLoadKey || (isResolving && !loadingProgress.resolving);
  const loadStarted = isLoading || (!newLoadingAttempt && loadingProgress.started);
  // Ignore the previous file's cache flag until mpv starts this load, then never rewind an attempt.
  const observedLoadingStage =
    isResolving || !activeStreamUrl
      ? 0
      : isLoading || !loadStarted
        ? 1
        : isBuffering && !hasPlaybackAdvanced
          ? 2
          : 1;
  const playerLoadingStage = newLoadingAttempt
    ? observedLoadingStage
    : startupLoading
      ? Math.max(loadingProgress.stage, observedLoadingStage)
      : loadingProgress.stage;
  if (
    loadingProgress.key !== activeStreamLoadKey ||
    loadingProgress.resolving !== isResolving ||
    loadingProgress.started !== loadStarted ||
    loadingProgress.stage !== playerLoadingStage
  ) {
    setLoadingProgress({
      key: activeStreamLoadKey,
      resolving: isResolving,
      started: loadStarted,
      stage: playerLoadingStage,
    });
  }
  const loadingOverlay = useDelayedUnmount(startupLoading && !error, 180);
  const loadingBackdrop = useDelayedUnmount(isLoading, 500);
  // PlayerHost renders the one loading screen from launch to first frame; the player only reports it.
  const loadingActionsRef = useRef<PlayerLoadingActions | null>(null);
  const sessionKey = session?.key ?? '';
  useLayoutEffect(() => {
    loadingActionsRef.current = {
      chooseStream: openManualStreamFallback,
      back: () => void navigateBack(),
    };
    publishPlayerLoading({
      sessionKey,
      backdropMounted: loadingBackdrop.mounted,
      backdropExiting: loadingBackdrop.exiting,
      cardMounted: !isPip && loadingOverlay.mounted && !error && !panelsOwnSurface,
      cardExiting: loadingOverlay.exiting,
      headline: playerLoadingHeadline,
      detail: playerLoadingDetail,
      // Stage 0 is the host's "Starting player" before this chunk mounted.
      stageIndex: playerLoadingStage + 1,
      context: playerLoadingContext,
      actions: loadingActionsRef,
    });
  });
  useEffect(() => () => clearPlayerLoading(sessionKey), [sessionKey]);
  // Same dissolve for the stall spinner.
  const bufferingOverlay = useDelayedUnmount(
    isBuffering &&
      hasPlaybackAdvanced &&
      playbackIntact &&
      !hasEnded &&
      !panelsOwnSurface &&
      !loadingOverlay.mounted,
    150,
  );
  const centerStatusVisible = loadingOverlay.mounted || bufferingOverlay.mounted || !!error;
  const selectorTarget: StreamSelectorTarget = {
    type: effectiveResolveMediaType,
    // The render gate below refuses to mount without a truthy id.
    id: id ?? '',
    streamId: selectorStreamLookupId,
    season: selectorStreamSeason,
    episode: selectorStreamEpisode,
    absoluteSeason: selectorAbsoluteSeason,
    absoluteEpisode: selectorAbsoluteEpisode,
    title: rankingTitle,
    episodeTitle: selectorEpisode
      ? getEpisodeTitle(
          hideSelectorSpoiler ? undefined : selectorEpisode.title,
          selectorEpisode.episode,
        )
      : undefined,
    targetMasked: hideSelectorSpoiler,
    overview: hideSelectorSpoiler
      ? details?.description
      : selectorEpisode?.overview || details?.description,
    poster,
    backdrop,
    logo,
    episodes: details?.episodes,
    from,
    originFrom,
  };

  // The selector portals over either surface; `mounted` (not `open`) gates the tree so the exit animation plays.
  const streamSelectorNode =
    streamSelectorState.mounted && type && id ? (
      <StreamSelector
        open={showStreamSelector}
        onClose={closeStreamSelector}
        onClosed={handleStreamSelectorClosed}
        onBeforePlayerNavigation={prepareForSelectorNavigation}
        target={selectorTarget}
        getStartTime={() =>
          isSelectorForCurrentEpisode
            ? playableResumePosition(
                observedPositionRef.current === null ? undefined : clock.getSnapshot(),
                startTime,
              )
            : (selectedEpisodeStreamTarget?.startTime ?? 0)
        }
        currentStreamKey={activeStreamKey}
      />
    ) : null;

  // Docked EOF gate: expanded-only panels can't cover the mini, but a resolve or the selector must not leave strips clickable beneath.
  const miniEofOpen =
    hasEnded && playbackIntact && !showStreamSelector && !isLoadingEpisodeNavigation;
  const nextEpisodeThumbnail = nextEpisode?.thumbnail ?? backdrop ?? poster;
  const canGoPrevious = !!previousEpisode && !isResolving;
  const canGoNext = !!nextEpisode && !isResolving;
  const miniPlayerUpNext =
    miniEofOpen && nextEpisode
      ? {
          label: formatEpisodeHeading(nextEpisode.season, nextEpisode.episode, nextEpisode.title),
        }
      : undefined;

  // FLIP source for the dock entrance, memoized once per dock: the last expanded mpv rect.
  const miniDockOrigin = isExpanded ? null : getExpandedVideoRect();

  const miniPlayerNode = (exiting: boolean) => (
    <MiniPlayer
      exiting={exiting}
      title={title}
      episodeLabel={currentEpisodeLabel || undefined}
      backdrop={backdrop ?? poster}
      isPlaying={isPlaying}
      isWorking={startupLoading || isBuffering}
      statusText={startupLoading ? playerLoadingHeadline : 'Buffering'}
      error={showErrorOverlay ? error : null}
      clock={clock}
      duration={duration}
      canGoPrevious={canGoPrevious}
      canGoNext={canGoNext}
      hasVideo={mpvSurfaceReady && !!activeStreamUrl && !isLoading && !showErrorOverlay}
      isMuted={isMuted}
      volume={volume}
      upNext={miniPlayerUpNext}
      endOfMedia={miniEofOpen && !nextEpisode}
      skipAction={activeSkipAction}
      onReplay={replayFromStart}
      onBackToTitle={backToTitle}
      getInitialPosition={getMiniPosition}
      // FLIP source rect — null until a margin was sent (e.g. mount straight into mini → plain entrance).
      dockOrigin={miniDockOrigin}
      // Focus claims only on the dock transition — a docked session remount must not yank browse focus.
      claimFocusOnMount={hasExpanded && !isExpanded}
      onVideoRectChange={handleMiniVideoRectChange}
      onPositionChange={setMiniPosition}
      onTogglePlay={() => void togglePlay().catch(() => undefined)}
      onToggleMute={() => void toggleMute().catch(() => undefined)}
      onVolumeChange={(next) => void handleVolumeChange(next).catch(() => undefined)}
      onVolumeWheel={handleVolumeWheel}
      onSeek={(seconds) => void seek(seconds).catch(() => undefined)}
      onSeekRelative={(delta) => void seekRelative(delta).catch(() => undefined)}
      onExpand={expandPlayer}
      onClose={close}
      onPreviousEpisode={playPreviousEpisode}
      onNextEpisode={playNextEpisode}
    />
  );

  useEffect(() => {
    // Panels and recovery selectors need the full app viewport.
    if (isPip && (showEpisodes || showShortcuts || showStreamSelector)) {
      void returnFromPip().catch(() => undefined);
    }
  }, [isPip, returnFromPip, showEpisodes, showShortcuts, showStreamSelector]);

  if (!isExpanded) {
    // Docked: the app route keeps rendering while mpv plays in the corner surface.
    return (
      <>
        {miniPlayerNode(false)}
        {streamSelectorNode}
      </>
    );
  }

  const chromeVisible = !idleOverlayVisible && (showControls || !isPlaying);
  const chromeFadeTimingClass = chromeVisible
    ? cn(CHROME_ENTER_TIMING_CLASS, 'opacity-100')
    : cn(CHROME_EXIT_TIMING_CLASS, 'opacity-0');
  const chromeFadeClass = cn(
    'transition-[opacity,translate] motion-reduce:transition-none',
    chromeFadeTimingClass,
    chromeVisible ? 'pointer-events-auto' : 'pointer-events-none',
  );
  const chromeScrimClass = cn(
    'absolute inset-x-0 transition-opacity motion-reduce:transition-none',
    chromeFadeTimingClass,
  );

  return (
    // Cursor auto-hide plus wheel volume/seek on the role=application surface.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={playerContainerRef}
      role='application'
      aria-label='Player viewport'
      className={cn(
        // clip, not hidden: a hidden box is still programmatically scrollable, so focus or
        // scrollIntoView inside the off-canvas episodes panel would shift the whole player sideways.
        // No bare `group` here: it would satisfy every descendant `group-hover:` while the pointer is anywhere on the player.
        'relative w-full h-screen overflow-clip bg-transparent text-white',
        !isFullscreen && !isPip && 'pl-[60px]',
      )}
      onMouseEnter={handleMouseMove}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onFocusCapture={handleControlsKeyboardInput}
      onKeyDownCapture={handleControlsKeyboardInput}
      onGotPointerCaptureCapture={handleControlsPointerCapture}
      onLostPointerCaptureCapture={handleControlsPointerRelease}
      onWheel={handlePlayerWheel}
      id='mpv-container'
    >
      <ContextMenu
        onOpenChange={(open) => {
          if (!open) {
            scheduleControlsAutoHide(POINTER_CONTROLS_IDLE_MS);
            return;
          }
          wakePlayerIdle();
          showControlsWithAutoHide(POINTER_CONTROLS_IDLE_MS);
        }}
      >
        <ContextMenuTrigger asChild>
          <div
            aria-hidden='true'
            className={cn(
              'absolute inset-0 z-10',
              (!showControls && isPlaying) || idleOverlayVisible ? 'cursor-none' : 'cursor-auto',
            )}
            onClick={handlePlayerClick}
            onDoubleClick={handlePlayerDoubleClick}
          />
        </ContextMenuTrigger>
        <ContextMenuContent data-player-popover onKeyDown={(event) => event.stopPropagation()}>
          <ContextMenuItem disabled={!activeStreamUrl} onSelect={handleCopyStreamLink}>
            <Copy className='h-4 w-4' />
            Copy stream link
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {!isFullscreen && !isPip && (
        <div
          data-player-navigation
          className='contents'
          onPointerEnter={handleMouseLeave}
          onMouseMove={(event) => event.stopPropagation()}
        >
          <DesktopTitlebar className='z-85 bg-linear-to-b from-black/70 via-black/35 to-transparent' />
        </div>
      )}
      {!isFullscreen && !isPip && (
        <div
          data-player-interactive
          data-player-navigation
          className='fixed left-0 top-0 z-70 h-screen pointer-events-auto'
          onPointerEnter={handleMouseLeave}
          onMouseMove={(event) => event.stopPropagation()}
        >
          <Sidebar className='flex' />
        </div>
      )}
      {!isPip && showErrorOverlay && !panelsOwnSurface && (
        <PlayerErrorOverlay
          message={error ?? ''}
          onRetry={handleRetryFailedStream}
          onChooseStream={openManualStreamFallback}
          onBack={() => void navigateBack()}
        />
      )}

      {/* Buffering: a bare spinner mid-playback, not the full loading card. */}
      {!isPip &&
        bufferingOverlay.mounted &&
        !loadingOverlay.mounted &&
        !error &&
        !hasEnded &&
        !panelsOwnSurface && (
          // The entrance fade debounces one-frame stalls; the parent holds the mount a beat so recovery dissolves out.
          <div
            className={cn(
              'pointer-events-none absolute inset-0 z-40 flex items-center justify-center',
              bufferingOverlay.exiting
                ? 'opacity-0 animate-out fade-out duration-150 fill-mode-forwards motion-reduce:animate-none'
                : 'animate-in fade-in duration-150 motion-reduce:animate-none',
            )}
          >
            <Loader2 className='h-9 w-9 animate-spin text-white/55 drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]' />
          </div>
        )}

      {/* Idle card — sits under the chrome (z-40) so woken controls draw above. */}
      {!isPip && hasPlaybackStarted && (
        <PlayerIdleOverlay
          visible={idleOverlayVisible}
          isFullscreen={isFullscreen}
          logo={logo || details?.logo}
          title={title}
          episodeLabel={currentEpisodeLabel || undefined}
          episodeTitle={currentEpisode?.title}
          overview={currentEpisode?.overview || details?.description}
        />
      )}

      {!isFullscreen && !isPip && (
        <PlayerEdgeProgress
          clock={clock}
          duration={duration}
          visible={
            !chromeVisible &&
            hasPlaybackStarted &&
            duration > 0 &&
            playbackIntact &&
            !hasEnded &&
            !idleOverlayVisible
          }
        />
      )}

      {/* Controls overlay — edge scrims only; the frame itself stays clear. */}
      {!isPip && (
        <div
          className={cn(
            // Mount fade lives here, not on the root — the root also holds the
            // sidebar and titlebar, which must not fade or shift on open.
            'page-enter absolute inset-0 z-40 pointer-events-none flex flex-col',
            'justify-between pb-6',
            !isFullscreen && 'pt-12',
            isFullscreen && 'pt-6',
            isFullscreen ? 'px-8' : 'pl-[84px] pr-6',
          )}
        >
          <div
            aria-hidden='true'
            className={cn(
              chromeScrimClass,
              'top-0 h-32 bg-linear-to-b from-black/65 via-black/25 to-transparent',
            )}
          />
          <div
            aria-hidden='true'
            className={cn(
              chromeScrimClass,
              'bottom-0 h-36 bg-linear-to-t from-black/70 via-black/25 to-transparent',
            )}
          />
          <div
            className={cn(chromeFadeClass, !chromeVisible && 'motion-safe:-translate-y-1')}
            onPointerEnter={() => handleControlsHover(true)}
            onPointerLeave={() => handleControlsHover(false)}
          >
            <PlayerTopChrome
              chromeRef={topChromeRef}
              title={title}
              season={resolvedAbsoluteSeason}
              episode={resolvedAbsoluteEpisode}
              episodeCountInSeason={episodeCountInSeason}
              episodeTitle={currentEpisode?.title}
              streamSourceName={activeStreamSourceName}
              onBack={navigateBack}
              isFullscreen={isFullscreen}
              onToggleFullscreen={toggleFullscreen}
            />
          </div>

          <div
            ref={bottomChromeRef}
            data-player-interactive
            className='pointer-events-none cursor-auto relative'
            onPointerEnter={() => handleControlsHover(true)}
            onPointerLeave={() => handleControlsHover(false)}
          >
            {/* Seek previews include a segment badge; keep the action lane above their full height. */}
            <div className='pointer-events-none absolute bottom-full right-0 flex max-w-full items-end justify-end pb-12'>
              {canSkip && !idleOverlayVisible && (
                <div
                  data-player-interactive
                  className='pointer-events-auto flex max-w-full items-end'
                >
                  <PlayerSkipButton
                    action={activeSkipAction!}
                    keymap={keymap}
                    clock={clock}
                    segmentStart={activeSkipSegment?.start_time}
                    segmentEnd={activeSkipSegment?.end_time}
                  />
                </div>
              )}
              {showUpNextCard && nextEpisode && (
                <PlayerUpNextCard
                  episode={nextEpisode}
                  thumbnail={nextEpisodeThumbnail}
                  autoPlayCountdown={autoPlayCountdown}
                  autoPlayDurationSeconds={appUiPreferences.nextEpisodeCountdownSecs}
                  onCancelAutoPlay={cancelAutoPlayNext}
                  onPlayNext={playNextEpisode}
                />
              )}
              {showEndCard && (
                <PlayerEndCard
                  title={currentEpisodeHeading || title || ''}
                  thumbnail={currentEpisode?.thumbnail ?? backdrop ?? poster}
                  onReplay={replayFromStart}
                  onBackToTitle={backToTitle}
                />
              )}
            </div>
            <div className={cn(chromeFadeClass, !chromeVisible && 'motion-safe:translate-y-1')}>
              <PlayerProgressBar
                active={chromeVisible}
                duration={duration}
                clock={clock}
                bufferedClock={bufferedClock}
                skipSegments={skipSegments}
                resetKey={activeStreamLoadKey}
                onSeek={seek}
              />

              <PlayerControlsRow
                clock={clock}
                duration={duration}
                active={chromeVisible}
                onTogglePip={canPip ? togglePip : undefined}
                isPlaying={isPlaying}
                onTogglePlay={togglePlay}
                onSeekRelative={seekRelative}
                volume={volume}
                isMuted={isMuted}
                onToggleMute={toggleMute}
                onVolumeChange={handleVolumeChange}
                onVolumeWheel={handleVolumeWheel}
                playbackSpeed={playbackSpeed}
                onSpeedChange={handleSpeedSelect}
                speedMenuOpen={openSettingsMenu === 'speed'}
                onSpeedMenuOpenChange={(open) => handleSettingsMenuOpenChange('speed', open)}
                hasEpisodes={hasEpisodes}
                episodesOpen={showEpisodes}
                onToggleEpisodes={toggleEpisodesPanel}
                canChooseStream={!!id}
                streamSelectorOpen={showStreamSelector}
                onOpenStreamSelector={openManualStreamFallback}
                canGoPrevious={canGoPrevious}
                onPreviousEpisode={playPreviousEpisode}
                previousEpisodeLabel={previousEpisodeLabel}
                canGoNext={canGoNext}
                onNextEpisode={playNextEpisode}
                nextEpisodeLabel={nextEpisodeLabel}
                trackSelectors={
                  <>
                    <SubtitleTrackSelector
                      open={openSettingsMenu === 'subtitles'}
                      subTracks={subTracks}
                      trackSwitching={trackSwitching}
                      subtitleDelay={subtitleDelay}
                      subtitlePos={subtitlePos}
                      subtitleScale={subtitleScale}
                      addonSubtitles={addonSubtitles}
                      addonSubtitlesLoading={addonSubtitlesLoading}
                      addonSubtitlesFetching={addonSubtitlesFetching}
                      addonSubtitlesError={addonSubtitlesError}
                      onRetryAddonSubtitles={() => void refetchAddonSubtitles()}
                      addonSubtitlesAvailable={addonSubtitlesAvailable}
                      activeAddonSubtitleId={activeAddonSubtitleId}
                      addonSubtitleLoadingId={addonSubtitleLoadingId}
                      onSubtitleMenuOpenChange={(open) =>
                        handleSettingsMenuOpenChange('subtitles', open)
                      }
                      onSelectAddonSubtitle={(subtitle) => void handleAddonSubtitleSelect(subtitle)}
                      onResetSubtitleSettings={resetSubtitleSettings}
                      onApplySubtitleDelay={(value) => void applySubtitleDelay(value)}
                      onApplySubtitlePos={(value) => void applySubtitlePos(value)}
                      onApplySubtitleScale={(value) => void applySubtitleScale(value)}
                      onSelectSubTrack={handleSubTrackSelect}
                    />
                    <AudioTrackSelector
                      open={openSettingsMenu === 'audio'}
                      onOpenChange={(open) => handleSettingsMenuOpenChange('audio', open)}
                      audioTracks={audioTracks}
                      trackSwitching={trackSwitching}
                      onSelectTrack={handleAudioTrackSelect}
                    />
                  </>
                }
              />
            </div>
          </div>
        </div>
      )}
      {!isPip && !centerStatusVisible && !panelsOwnSurface && (
        <PlayerPauseResumeButton visible={showPauseResume} onResume={togglePlay} />
      )}

      <PlayerOsdOverlay
        store={osdStore}
        allowed={
          playbackIntact &&
          !loadingOverlay.mounted &&
          !panelsOwnSurface &&
          !idleOverlayVisible &&
          !hasEnded &&
          (!isPip || !bufferingOverlay.mounted)
        }
        isFullscreen={isFullscreen}
        compact={isPip}
      />

      {episodesPanelMounted && (
        <PlayerEpisodesPanel
          panelRef={episodesPanelFrameRef}
          open={showEpisodes}
          isFullscreen={isFullscreen}
          seasons={seasons}
          selectedSeason={selectedSeason}
          onSeasonChange={setSelectedSeason}
          episodes={episodes ?? EMPTY_EPISODES}
          currentSeason={resolvedAbsoluteSeason}
          currentEpisode={resolvedAbsoluteEpisode}
          backdrop={backdrop}
          episodeProgressFor={episodeProgressFor}
          watchedEpisodeCeiling={titleWatchProgress?.watchedEpisodeCeiling}
          resumeTarget={episodeResumeTarget}
          onEpisodeSelect={(ep) => openStreamSelectorForEpisode(ep, { pauseCurrentPlayback: true })}
          onClose={closeEpisodesPanel}
        />
      )}

      {showShortcuts && <PlayerShortcutsOverlay keymap={keymap} onClose={closeShortcuts} />}

      {streamSelectorNode}

      {isPip && (
        <PlayerPipChrome
          title={title}
          episodeLabel={currentEpisodeLabel || undefined}
          visible={showControls}
          leaving={viewportTransition === 'leavingPip'}
          isPlaying={isPlaying}
          isMuted={isMuted}
          volume={volume}
          clock={clock}
          bufferedClock={bufferedClock}
          duration={duration}
          playbackSpeed={playbackSpeed}
          skipSegments={skipSegments}
          resetKey={activeStreamLoadKey}
          status={startupLoading ? playerLoadingHeadline : isBuffering ? 'Buffering' : undefined}
          error={error}
          ended={hasEnded && !isResolving}
          autoPlayCountdown={autoPlayCountdown}
          canGoNext={canGoNext}
          skipAction={activeSkipAction}
          onReturn={returnFromPip}
          onTogglePlay={togglePlay}
          onToggleMute={toggleMute}
          onVolumeWheel={handleVolumeWheel}
          onSeek={(seconds) => void seek(seconds).catch(() => undefined)}
          onNext={playNextEpisode}
          onReplay={replayFromStart}
          onRetry={handleRetryFailedStream}
          onCancelAutoPlay={cancelAutoPlayNext}
          onControlsHover={handleControlsHover}
        />
      )}
      <div
        aria-hidden='true'
        className={cn(
          'pointer-events-none absolute inset-0 z-90 bg-black transition-opacity ease-out motion-reduce:transition-none',
          viewportTransition === 'curtain'
            ? 'opacity-100 duration-[90ms]'
            : 'opacity-0 duration-[180ms]',
        )}
      />
      {/* Expand handoff: the mini chrome lingers one beat and dissolves out. */}
      {miniExiting && miniPlayerNode(true)}
    </div>
  );
}
