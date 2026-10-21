import { useQuery } from '@tanstack/react-query';
import { toLocalDate } from '@/lib/schedule-dates';
import { Copy, Loader2 } from 'lucide-react';
import {
  useCallback,
  type MouseEvent,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type WheelEvent,
} from 'react';
import { DesktopTitlebar } from '@/components/desktop-titlebar';
import { isEpisodeSpoiler } from '@/components/details-episode-card';
import { MiniPlayer } from '@/components/mini-player';
import { PlayerActionOverlays } from '@/components/player-action-overlays';
import { PlayerControlsRow, PlayerTopChrome, SPEED_OPTIONS } from '@/components/player-chrome';
import { PlayerEpisodesPanel } from '@/components/player-episodes-panel';
import { type PlayerOsdAction, PlayerOsdOverlay } from '@/components/player-osd-overlay';
import { PlayerEdgeProgress, PlayerProgressBar } from '@/components/player-progress-bar';
import { PlayerPipChrome } from '@/components/player-pip-chrome';
import { PlayerShortcutsOverlay } from '@/components/player-shortcuts-overlay';
import { PlayerStreamSelector } from '@/components/player-stream-selector';
import {
  PlayerEndCard,
  PlayerErrorOverlay,
  PlayerIdleOverlay,
  PlayerLoadingOverlay,
  PlayerPauseResumeButton,
  PlayerUpNextCard,
} from '@/components/player-state-overlays';
import { RemoteImage } from '@/components/remote-image';
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
import { usePlayerAddonSubtitles } from '@/hooks/use-player-addon-subtitles';
import { usePlayerAutoResolve } from '@/hooks/use-player-auto-resolve';
import { usePlayerBackNavigation } from '@/hooks/use-player-back-navigation';
import { usePlayerHotkeys } from '@/hooks/use-player-hotkeys';
import { usePlayerIdleOverlay } from '@/hooks/use-player-idle-overlay';
import { getPlayerStreamLoadKey, usePlayerMpvLifecycle } from '@/hooks/use-player-mpv-lifecycle';
import { usePlayerRouteState } from '@/hooks/use-player-route-state';
import { usePlayerSessionBoundary } from '@/hooks/use-player-session-boundary';
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
  type MediaDetails,
  type SkipSegment,
  type SkipTimesResult,
} from '@/lib/api';
import { RADIX_POPPER_CONTENT_SELECTOR } from '@/lib/dom';
import { getCachedResultRefreshDelayMs } from '@/lib/api-cache';
import {
  buildEpisodeStreamTarget,
  findEpisodeByCoordinates,
  type NextEpisodeStreamCoordinates,
  sameEpisodeCoordinates,
} from '@/lib/episode-stream-target';
import {
  episodeProgressKey,
  getLatestEpisodeResumeStartTime,
  MIN_RESUME_POSITION_SECS,
} from '@/lib/history-playback';
import { boundNavigate, currentPathWithSearch, navigateApp } from '@/lib/navigation';
import { copyText } from '@/lib/notify';
import {
  buildDetailsRoute,
  claimPlaybackLaunch,
  isCurrentPlaybackLaunch,
  launchResolvedStream,
} from '@/lib/player-navigation';
import { createPlaybackClock } from '@/lib/player-clock';
import {
  blurActivePlayerControl,
  createWheelSeekAccumulator,
  isPlayerInteractiveTarget,
  restorePlayerBackground,
  restorePlayerCursor,
  setPlayerDocumentBackground,
  shouldIgnorePlayerSurfaceInteraction,
} from '@/lib/player-dom';
import { mpvCommand, setMpvProperty } from '@/lib/player-mpv';
import { isNearMediaEnd, SKIP_SEGMENT_LABELS } from '@/lib/player-skip';
import { expandedSessionState, usePlayerSession } from '@/lib/player-session';
import { trackDisplayLabel } from '@/lib/player-track-utils';
import {
  detailsQueryKey,
  DETAILS_GC_TIME_MS,
  SKIP_TIMES_GC_TIME_MS,
  SKIP_TIMES_STALE_TIME_MS,
  skipTimesQueryKey,
} from '@/lib/query-invalidation';
import { type PlayerStreamRequest, resolvePlayerStream } from '@/lib/resolve-player-stream';
import type { StreamSelectorTarget } from '@/lib/stream-selector-target';
import { createSubscribableStore } from '@/lib/subscribable-store';
import {
  clearTimer,
  cn,
  formatEpisodeHeading,
  formatSeasonEpisode,
  formatTime,
  getEpisodeTitle,
  isHttpUrl,
  isSeriesLikeMediaType,
  nonBlank,
  prefersReducedMotion,
  type TimerHandle,
  withTimeout,
} from '@/lib/utils';

const PLAYBACK_READY_AUTO_HIDE_DELAY_MS = 2600;
// A cold addon resolve can take ~14s — past this the picker beats a blank loader.
const NEXT_EPISODE_AUTO_RESOLVE_TIMEOUT_MS = 12_000;
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
  spoilerProtection,
});

export function Player() {
  const { session } = usePlayerSession();
  if (!session) return null;
  return <InnerPlayer key={session.key} />;
}

function InnerPlayer() {
  const { session, presentation, close, getMiniPosition, setMiniPosition, trayPause } =
    usePlayerSession();
  const pausedByTrayHide = useSyncExternalStore(trayPause.subscribe, trayPause.getSnapshot);
  const isExpanded = presentation === 'expanded';
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const topChromeRef = useRef<HTMLDivElement | null>(null);
  const bottomChromeRef = useRef<HTMLDivElement | null>(null);
  const pointerOverControlsRef = useRef(false);
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
    routeRequestedStreamKey,
    routeSelectedStreamKey,
    routeSourceId,
    routeSourceName,
    routeStreamEpisode,
    routeStreamFamily,
    routeStreamLookupId,
    routeStreamSeason,
    seasonParam: season,
    startTime,
    title,
    resolveTitle,
    type,
  } = usePlayerRouteState();

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
    if (url) void copyText(url, 'Stream link copied');
  };
  const { preferences: appUiPreferences, updatePreferences: updateAppUiPreferences } =
    useAppUiPreferences(selectPlayerPreferences);

  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(false);
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

  const [osdAction, setOsdAction] = useState<PlayerOsdAction | null>(null);
  const [osdVisible, setOsdVisible] = useState(false);

  const restoreCursorVisibility = () => {
    restorePlayerCursor(playerContainerRef.current);
  };

  const restorePlayerSurface = () => {
    restoreCursorVisibility();
    restorePlayerBackground();
  };

  const handleBeforeEnterFullscreen = () => {
    closeEpisodesPanel();
    setShowShortcuts(false);
    restoreCursorVisibility();
  };

  const {
    isFullscreen,
    isPip,
    canPip,
    togglePip,
    returnFromPip,
    isViewportTransitioning,
    prepareForInternalPlayerNavigation,
    toggleFullscreen,
  } = usePlayerViewportMode({
    onBeforeEnterFullscreen: handleBeforeEnterFullscreen,
    expanded: isExpanded,
  });

  useEffect(() => {
    pointerOverControlsRef.current = false;
  }, [isPip]);

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
  const isBufferingRef = useRef(false);
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
  const isPlayerChromeEngaged = () =>
    !!topChromeRef.current?.matches(':hover, :focus-within') ||
    !!bottomChromeRef.current?.querySelector(':focus-visible') ||
    document.querySelector(RADIX_POPPER_CONTENT_SELECTOR) !== null;
  const {
    announce,
    clearControlsAutoHide,
    clearUiTimers: clearManagedUiTimers,
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
    setOsdAction,
    setOsdVisible,
    setShowControls,
    shouldHoldControls: () => pointerOverControlsRef.current || isPlayerChromeEngaged(),
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
  const skipTimesEnabled =
    !!type &&
    !!id &&
    !!(nonBlank(details?.imdbId) || nonBlank(id) || nonBlank(routeStreamLookupId)) &&
    skipTimesDurationSecs !== undefined &&
    (!isSeriesLike ||
      (resolvedAbsoluteSeason !== undefined && resolvedAbsoluteEpisode !== undefined));

  const { data: skipTimes } = useQuery<SkipTimesResult>({
    queryKey: skipTimesQueryKey(
      effectiveResolveMediaType,
      id,
      resolvedAbsoluteSeason,
      resolvedAbsoluteEpisode,
      details?.imdbId,
      routeStreamLookupId,
      skipTimesDurationSecs,
    ),
    queryFn: () =>
      api.getSkipTimes(
        effectiveResolveMediaType,
        id!,
        details?.imdbId,
        routeStreamLookupId,
        resolvedAbsoluteSeason,
        resolvedAbsoluteEpisode,
        skipTimesDurationSecs,
      ),
    enabled: skipTimesEnabled,
    staleTime: SKIP_TIMES_STALE_TIME_MS,
    gcTime: SKIP_TIMES_GC_TIME_MS,
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
  const shouldWaitForResolvedLookupId = !!(
    !!type &&
    isSeriesLike &&
    !!id &&
    isLoadingDetails &&
    ((!routeStreamLookupId && !id.startsWith('tt') && !detailsImdbId) ||
      ((resolvedAbsoluteEpisode !== undefined || resolvedAbsoluteSeason !== undefined) &&
        routeStreamSeason === undefined &&
        routeStreamEpisode === undefined &&
        !currentEpisodeStream))
  );

  const resumesFromStartTime = startTime !== undefined && startTime >= MIN_RESUME_POSITION_SECS;
  const playerLoadingHeadline =
    resolveStatus ||
    (!activeStreamUrl
      ? 'Finding the best stream'
      : openingStreamName
        ? 'Opening selected stream'
        : resumesFromStartTime
          ? 'Resuming playback'
          : 'Starting playback');
  const playerLoadingDetail =
    !resolveStatus && activeStreamUrl && openingStreamName
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

  // The frameless window hides document.title; it still feeds the OS taskbar tooltip.
  const currentEpisodeLabel = formatSeasonEpisode(resolvedAbsoluteSeason, resolvedAbsoluteEpisode);
  const playerLoadingContext =
    [currentEpisodeLabel, resumesFromStartTime ? `From ${formatTime(startTime)}` : '']
      .filter(Boolean)
      .join(' · ') || undefined;
  const currentEpisodeHeading = formatEpisodeHeading(
    resolvedAbsoluteSeason,
    resolvedAbsoluteEpisode,
    currentEpisode?.title,
  );
  useDocumentTitle(
    title ? `${title}${currentEpisodeLabel ? ` · ${currentEpisodeLabel}` : ''}` : undefined,
    isExpanded,
  );

  const {
    applyResumeIfReady,
    audioTracks,
    cancelAutomaticResume,
    clearResumeRetryTimer,
    cycleTrack,
    flushPlaybackBeforeNavigation,
    isResumePending,
    notifyObservedTrackSelection,
    playbackLanguagePreferencesRef,
    prepareForStreamLoad,
    refreshTracks,
    reportStreamFailure,
    reportStreamVerified,
    saveProgressRef,
    selectAddonSubtitle,
    setTrack,
    subTracks,
    takeResumePause,
    trackSwitching,
  } = usePlayerSessionBoundary({
    absoluteEpisode: resolvedAbsoluteEpisode,
    absoluteSeason: resolvedAbsoluteSeason,
    activeStreamLoadKey,
    activeStreamResetKey: JSON.stringify([
      activeStreamLoadKey,
      id,
      season,
      episode,
      effectiveResolveMediaType,
    ]),
    stream,
    backdrop,
    clock,
    durationRef,
    hasPlaybackStarted,
    isDestroyedRef,
    isHistoryResume,
    isLoading,
    isPlaying,
    isResolving,
    mediaId: id,
    mediaType: type,
    mountedRef,
    observedPositionRef,
    onResumeMessage: handleResumeMessage,
    playbackLanguageMediaType: effectiveResolveMediaType,
    poster,
    resumeSuspended: error !== null,
    startTime,
    streamEpisode: resolvedStreamEpisode,
    streamSeason: resolvedStreamSeason,
    failoverResumePositionRef,
    title,
  });
  const handleUserSeek = () => {
    cancelAutomaticResume();
    if (playbackEndedRef.current) cancelAutoPlayNext();
  };
  const { isSeekPending, observeTimeUpdate, seek, seekRelative } = useOptimisticSeek({
    clock,
    durationRef,
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
    addonSubtitlesQueried,
    handleAddonSubtitleSelect,
    handleSubTrackSelect,
    handleSubtitleMenuOpenChange,
    refetchAddonSubtitles,
  } = usePlayerAddonSubtitles({
    activeStreamLoadKey,
    announce,
    effectiveResolveMediaType,
    id,
    menuAvailable: isExpanded && !isPip,
    mountedRef,
    resolvedStreamEpisode,
    resolvedStreamSeason,
    selectAddonSubtitle,
    setTrack,
    streamLookupId,
    subTracks,
  });

  const handleAudioTrackSelect = (
    trackType: 'audio',
    trackId: number,
    options?: { persistPreference?: boolean },
  ) => {
    void setTrack(trackType, trackId, options).then((applied) => {
      if (!applied) return;
      announce(`Audio: ${trackDisplayLabel(audioTracks, trackId)}`, 'audio');
    });
  };

  // Read live refs at back-time so the callback identity stays stable.
  const shouldReopenStreamSelector = () =>
    errorRef.current !== null || playbackEndedRef.current || playbackVerifiedAtRef.current === 0;
  const { navigateBack } = usePlayerBackNavigation({
    currentTimeRef,
    observedPositionRef,
    effectiveResolveMediaType,
    from,
    id,
    originFrom,
    restoreCursorVisibility,
    routeAbsoluteEpisode,
    routeAbsoluteSeason,
    setShowControls,
    setShowEpisodes,
    // Reopen the selector on landing only for recovery (error, unverified, ended); a clean exit just minimizes.
    shouldReopenStreamSelector,
    startTime,
  });

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
    setError(null);
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

  // Metadata or a first tick lifts the loading card; the startup watchdog still owns a pre-playhead stall.
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
  useEffect(() => {
    if (isExpanded) setHasExpanded(true);
    const wasExpanded = wasExpandedRef.current;
    wasExpandedRef.current = isExpanded;
    if (wasExpanded && !isExpanded) {
      pointerOverControlsRef.current = false;
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

  const scheduleMpvSet = useMpvSetScheduler();
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
    isBufferingRef,
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
    isResumePending,
    onObservedTrackSelection: notifyObservedTrackSelection,
    refreshTracks,
    reportStreamFailure,
    recoverFromSlowStartup,
    isResolvingRef,
    reopenSelectorForSavedStreamFailure: reopenSelectorForSavedStreamLoadFailure,
    stopLoading,
    setTransparent: setPlayerDocumentBackground,
    restorePlayerSurface,
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
      !showShortcuts,
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
  useEffect(() => {
    if (!id || !nextEpisode || error) return;
    if (isLoading || isResolving || showStreamSelector || shouldWaitForResolvedLookupId) return;
    if (pausedByTrayHide || (!isPlaying && !hasEnded)) return;
    if (!isExpanded && !hasEnded && !tailSegmentActive) return;
    if (
      !hasEnded &&
      !tailSegmentActive &&
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
    tailSegmentActive,
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

  const skipAction = !activeSkipSegment
    ? null
    : tailSegmentActive && nextEpisode
      ? { label: 'Next Episode', onSkip: playNextEpisode }
      : {
          label: `Skip ${SKIP_SEGMENT_LABELS[activeSkipSegment.type]}`,
          onSkip: (source: 'user' | 'automatic' = 'user') => {
            void seek(activeSkipSegment.end_time, source, () =>
              announce(`Skipped ${SKIP_SEGMENT_LABELS[activeSkipSegment.type]}`, 'skip'),
            ).catch(() => undefined);
          },
        };

  // EOF and open panels own the action lane, even if mpv's last clock tick is inside an outro.
  const canSkip = !hasEnded && playbackIntact && !panelsOwnSurface && !!activeSkipSegment;
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
    void updateAppUiPreferences({ playerSpeed: speed });
    void setMpvProperty('speed', speed).catch(() => undefined);
    announce(`Speed: ${speed}x`, 'gauge');
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
    stepVolume,
    hasEpisodes,
    isExpanded,
    isFullscreen,
    keymap,
    mountedRef,
    navigateBack: isPip ? returnFromPip : navigateBack,
    nudgeSubtitleDelay,
    openStreamSelector: id ? openManualStreamFallback : null,
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

  // Rate-limit the 3s auto-hide re-arm — a steady mousemove shouldn't churn a timer per event.
  const lastControlsWakeAtRef = useRef(0);
  const handleMouseMove = () => {
    const now = performance.now();
    // Throttle while hidden too — events between the wake's state write and commit would re-arm.
    if (now - lastControlsWakeAtRef.current < 250) return;
    lastControlsWakeAtRef.current = now;
    showControlsWithAutoHide();
  };

  const handleMouseLeave = () => {
    if (!isPlaying) return;
    // Portaled popovers leave the container — a hide here would unmount chrome under an open menu.
    if (isPlayerChromeEngaged()) return;
    clearControlsAutoHide();
    setShowControls(false);
  };

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

    blurActivePlayerControl();

    if (showEpisodes) {
      closeEpisodesPanel();
      return;
    }

    // First click dismisses the idle card and wakes the chrome, not pause.
    if (idleOverlayVisible) {
      wakePlayerIdle();
      showControlsWithAutoHide();
      return;
    }

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

  const handleMiniTogglePlay = () => {
    void togglePlay().catch(() => undefined);
  };
  const handleMiniToggleMute = () => {
    void toggleMute().catch(() => undefined);
  };
  const handleMiniVolumeChange = (next: number) => {
    void handleVolumeChange(next).catch(() => undefined);
  };
  const handleVolumeStep = (delta: number) => {
    void stepVolume(delta).catch(() => undefined);
  };
  const handleControlsHover = (hovered: boolean) => {
    pointerOverControlsRef.current = hovered;
  };
  const handleMiniSeek = (seconds: number) => {
    void seek(seconds).catch(() => undefined);
  };
  const handleMiniSeekRelative = (delta: number) => {
    void seekRelative(delta).catch(() => undefined);
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
      <PlayerStreamSelector
        clock={clock}
        observedPositionRef={observedPositionRef}
        open={showStreamSelector}
        onClose={closeStreamSelector}
        onClosed={handleStreamSelectorClosed}
        onBeforePlayerNavigation={prepareForSelectorNavigation}
        target={selectorTarget}
        isCurrentEpisode={isSelectorForCurrentEpisode}
        routeStartTime={startTime}
        targetStartTime={selectedEpisodeStreamTarget?.startTime ?? 0}
        currentStreamKey={activeStreamKey}
      />
    ) : null;

  // Docked EOF gate: expanded-only panels can't cover the mini, but a resolve or the selector must not leave strips clickable beneath.
  const miniEofOpen =
    hasEnded && playbackIntact && !showStreamSelector && !isLoadingEpisodeNavigation;
  const nextEpisodeThumbnail = nextEpisode?.thumbnail ?? backdrop ?? poster;
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
      onTogglePlay={handleMiniTogglePlay}
      onToggleMute={handleMiniToggleMute}
      onVolumeChange={handleMiniVolumeChange}
      onVolumeWheel={handleVolumeWheel}
      onVolumeStep={handleVolumeStep}
      onSeek={handleMiniSeek}
      onSeekRelative={handleMiniSeekRelative}
      onExpand={expandPlayer}
      onClose={close}
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
  const chromeFadeClass = cn(
    'transition-opacity duration-150 ease-out motion-reduce:transition-none has-[:focus-visible]:opacity-100',
    chromeVisible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
  );
  const chromeScrimClass = cn(
    'absolute inset-x-0 transition-opacity duration-150 ease-out motion-reduce:transition-none',
    chromeVisible ? 'opacity-100' : 'opacity-0',
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
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onWheel={handlePlayerWheel}
      id='mpv-container'
    >
      <ContextMenu
        onOpenChange={(open) => {
          if (!open) return;
          wakePlayerIdle();
          restoreCursorVisibility();
          showControlsWithAutoHide();
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
        <ContextMenuContent onKeyDown={(event) => event.stopPropagation()}>
          <ContextMenuItem disabled={!activeStreamUrl} onSelect={handleCopyStreamLink}>
            <Copy className='h-4 w-4' />
            Copy stream link
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {!isFullscreen && !isPip && (
        <DesktopTitlebar className='z-85 bg-linear-to-b from-black/70 via-black/35 to-transparent' />
      )}
      {!isFullscreen && !isPip && (
        <div
          data-player-interactive
          className='fixed left-0 top-0 z-70 h-screen pointer-events-auto'
        >
          <Sidebar className='flex' />
        </div>
      )}
      {loadingBackdrop.mounted && (
        <div
          className={cn(
            // Quick in so a stream swap lands on artwork, not mpv's blank frame; slow out so the first frame dissolves in.
            'absolute inset-0 z-0 transition-opacity motion-reduce:transition-none motion-reduce:animate-none',
            loadingBackdrop.exiting
              ? 'opacity-0 duration-500 pointer-events-none'
              : 'opacity-100 duration-150 animate-in fade-in',
          )}
        >
          {isHttpUrl(backdrop) && (
            <>
              <RemoteImage
                src={backdrop}
                className='w-full h-full object-cover opacity-50'
                alt=''
                loading='eager'
              />
              <div className='absolute inset-0 bg-black/50 backdrop-blur-xs' />
            </>
          )}
        </div>
      )}

      {!isPip && showErrorOverlay && !panelsOwnSurface && (
        <PlayerErrorOverlay
          message={error ?? ''}
          onRetry={handleRetryFailedStream}
          onChooseStream={openManualStreamFallback}
          onBack={navigateBack}
        />
      )}

      {/* Loading — held mounted a beat past the flag so the card dissolves. */}
      {!isPip && loadingOverlay.mounted && !error && !panelsOwnSurface && (
        <PlayerLoadingOverlay
          headline={playerLoadingHeadline}
          detail={playerLoadingDetail}
          stageIndex={playerLoadingStage}
          logo={logo || details?.logo}
          title={title}
          context={playerLoadingContext}
          exiting={loadingOverlay.exiting}
          onChooseStream={openManualStreamFallback}
          onBack={navigateBack}
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
          onFocus={(event) => {
            if (event.target.matches(':focus-visible')) showControlsWithAutoHide();
          }}
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
          <div className={chromeFadeClass}>
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
                <PlayerActionOverlays
                  clock={clock}
                  skipAction={activeSkipAction}
                  segmentStart={activeSkipSegment?.start_time}
                  segmentEnd={activeSkipSegment?.end_time}
                />
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
            <div className={chromeFadeClass}>
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
                hasEpisodes={hasEpisodes}
                episodesOpen={showEpisodes}
                onToggleEpisodes={toggleEpisodesPanel}
                canChooseStream={!!id}
                streamSelectorOpen={showStreamSelector}
                onOpenStreamSelector={openManualStreamFallback}
                canGoPrevious={!!previousEpisode && !isResolving}
                onPreviousEpisode={playPreviousEpisode}
                previousEpisodeLabel={previousEpisodeLabel}
                canGoNext={canGoNext}
                onNextEpisode={playNextEpisode}
                nextEpisodeLabel={nextEpisodeLabel}
                audioTracks={audioTracks}
                trackSwitching={trackSwitching}
                onSelectAudioTrack={handleAudioTrackSelect}
                subTracks={subTracks}
                subtitleDelay={subtitleDelay}
                subtitlePos={subtitlePos}
                subtitleScale={subtitleScale}
                addonSubtitles={addonSubtitles}
                addonSubtitlesLoading={addonSubtitlesLoading}
                addonSubtitlesFetching={addonSubtitlesFetching}
                addonSubtitlesError={addonSubtitlesError}
                onRetryAddonSubtitles={refetchAddonSubtitles}
                addonSubtitlesQueried={addonSubtitlesQueried}
                activeAddonSubtitleId={activeAddonSubtitleId}
                addonSubtitleLoadingId={addonSubtitleLoadingId}
                onSubtitleMenuOpenChange={handleSubtitleMenuOpenChange}
                onSelectAddonSubtitle={handleAddonSubtitleSelect}
                onResetSubtitleSettings={resetSubtitleSettings}
                onApplySubtitleDelay={applySubtitleDelay}
                onApplySubtitlePos={applySubtitlePos}
                onApplySubtitleScale={applySubtitleScale}
                onSelectSubTrack={handleSubTrackSelect}
              />
            </div>
          </div>
        </div>
      )}
      {!isPip && !centerStatusVisible && !panelsOwnSurface && (
        <PlayerPauseResumeButton visible={showPauseResume} onResume={togglePlay} />
      )}

      <PlayerOsdOverlay
        action={osdAction}
        visible={
          osdVisible &&
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
          onSeek={seek}
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
          isViewportTransitioning ? 'opacity-100 duration-[90ms]' : 'opacity-0 duration-[180ms]',
        )}
      />
      {/* Expand handoff: the mini chrome lingers one beat and dissolves out. */}
      {miniExiting && miniPlayerNode(true)}
    </div>
  );
}
