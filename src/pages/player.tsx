import { useQuery } from '@tanstack/react-query';
import { Copy, Loader2 } from 'lucide-react';
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type WheelEvent,
} from 'react';
import { useNavigate } from 'react-router';
import { DesktopTitlebar } from '@/components/desktop-titlebar';
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
import { usePlayerMpvLifecycle } from '@/hooks/use-player-mpv-lifecycle';
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
  watchProgressCoordinates,
} from '@/lib/history-playback';
import { currentPathWithSearch } from '@/lib/navigation';
import { copyText } from '@/lib/notify';
import { buildDetailsRoute, launchResolvedStream } from '@/lib/player-navigation';
import { createPlaybackClock } from '@/lib/player-clock';
import {
  blurActivePlayerControl,
  isPlayerInteractiveTarget,
  restorePlayerBackground,
  restorePlayerCursor,
  setPlayerDocumentBackground,
  shouldIgnorePlayerSurfaceInteraction,
} from '@/lib/player-dom';
import { mpvCommand, setMpvProperty } from '@/lib/player-mpv';
import { getSkipLabel, getSkippedLabel, isNearMediaEnd } from '@/lib/player-skip';
import { buildTrackLabelMap } from '@/lib/player-track-utils';
import { type MiniPlayerPosition, usePlayerSession } from '@/lib/player-session';
import {
  detailsQueryKey,
  DETAILS_GC_TIME_MS,
  DETAILS_STALE_TIME_MS,
  resolveSkipTimesImdbAnchor,
  SKIP_TIMES_GC_TIME_MS,
  SKIP_TIMES_STALE_TIME_MS,
  skipTimesQueryKey,
} from '@/lib/query-invalidation';
import { type PlayerStreamRequest, resolvePlayerStream } from '@/lib/resolve-player-stream';
import type { StreamSelectorTarget } from '@/lib/stream-selector-target';
import {
  clearTimer,
  cn,
  formatEpisodeHeading,
  formatSeasonEpisode,
  formatTime,
  isAiredByLocalDay,
  isHttpUrl,
  isSeriesLikeMediaType,
  nonBlank,
  prefersReducedMotion,
  type TimerHandle,
  withTimeout,
} from '@/lib/utils';

interface PlayerLoadingCopy {
  headline: string;
  detail: string;
}

const PLAYBACK_READY_AUTO_HIDE_DELAY_MS = 2600;
// A cold addon resolve can take ~14s — past this the picker beats a blank loader.
const NEXT_EPISODE_AUTO_RESOLVE_TIMEOUT_MS = 12_000;
// Mini chrome lingers so the undock dissolve plays under the fading-in player.
const MINI_EXIT_MS = 180;
type SelectedEpisodeStreamTarget = NextEpisodeStreamCoordinates & { startTime?: number };

interface StreamSelectorState {
  open: boolean;
  target: SelectedEpisodeStreamTarget | null;
  // Stays true after first open so the exit animation can play; same for target.
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
});

export function Player() {
  const { session } = usePlayerSession();
  if (!session) return null;
  return <InnerPlayer key={session.key} />;
}

function InnerPlayer() {
  const navigate = useNavigate();
  const { session, presentation, close, miniPositionRef } = usePlayerSession();
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
  const handleCopyStreamLink = useCallback(() => {
    const url = committedStreamUrlRef.current;
    if (url) void copyText(url, 'Stream link copied');
  }, [committedStreamUrlRef]);
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
  const [isResolving, setIsResolving] = useState(false);
  const [resolveStatus, setResolveStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [playbackSpeed, setPlaybackSpeed] = useState(() => appUiPreferences.playerSpeed);
  const [showEpisodes, setShowEpisodes] = useState(false);
  const keymap = usePlayerKeymap();
  // Shortcuts overlay — topmost layer like the episodes panel; Esc closes it first.
  const [showShortcuts, setShowShortcuts] = useState(false);
  const toggleShortcuts = useCallback(() => setShowShortcuts((open) => !open), []);
  const closeShortcuts = useCallback(() => setShowShortcuts(false), []);
  // Mount-once: never-opened pays no DOM cost; staying mounted keeps the slide transition.
  const [episodesPanelMounted, setEpisodesPanelMounted] = useState(false);
  const [selectedSeason, setSelectedSeason] = useState<number>(() => {
    return routeAbsoluteSeason ?? 1;
  });

  const closeEpisodesPanel = useCallback(() => {
    // Return focus to the surface before the panel goes inert and swallows hotkeys.
    const panel = episodesPanelFrameRef.current;
    if (panel && panel.contains(document.activeElement)) {
      blurActivePlayerControl();
    }
    setShowEpisodes(false);
  }, []);

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

  const restoreCursorVisibility = useCallback(() => {
    restorePlayerCursor(playerContainerRef.current);
  }, []);

  const restorePlayerSurface = useCallback(() => {
    restoreCursorVisibility();
    restorePlayerBackground();
  }, [restoreCursorVisibility]);

  const handleBeforeEnterFullscreen = useCallback(() => {
    closeEpisodesPanel();
    setShowShortcuts(false);
    restoreCursorVisibility();
  }, [closeEpisodesPanel, restoreCursorVisibility]);

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
  const [clock] = useState(() => createPlaybackClock());
  // Same external-store pattern so seekbar updates skip the player tree.
  const [bufferedClock] = useState(() => createPlaybackClock());
  const currentTimeRef = clock.ref;
  const durationRef = useRef(0);
  const isDestroyedRef = useRef(false);
  // Must survive stream swaps so stale-link recovery can re-resolve on the same screen.
  const mountedRef = useMountedRef(() => clearTimer(miniExitTimerRef));
  const mpvInitializedRef = useRef(false);
  const appliedSpeedRef = useRef(appUiPreferences.playerSpeed);
  // Guards late auto-resolve winners so manual selector fallback always wins.
  const autoResolveGenRef = useRef(0);
  /** True when the selector paused live playback — a dismiss resumes it. */
  const resumeAfterSelectorDismissRef = useRef(false);
  const selectorCommittedPauseRef = useRef<{ state: unknown; url: string } | null>(null);
  const errorRef = useRef<string | null>(error);
  const isResolvingRef = useRef(false);
  const selectorOpenRequestIdRef = useRef(0);
  // Shared adjacent-episode latch — `isResolving` isn't set fast enough to stop a double-click.
  const nextEpisodeRequestRef = useRef<number | null>(null);
  /** Always-current playing state — used in closures to avoid stale captures. */
  const isPlayingRef = useRef(false);
  /** Timestamp (ms) when playback was first verified — used to suppress transient idle events. */
  const playbackVerifiedAtRef = useRef(0);
  /** mpv reported end-of-file for the current stream — Back may reopen the selector. */
  const playbackEndedRef = useRef(false);
  // Position where the previous stream died, captured before the swap zeroes currentTimeRef.
  const failoverResumePositionRef = useRef(0);
  const resetStreamScopedState = useEffectEvent(() => {
    setHasPlaybackStarted(false);
    setHasPlaybackAdvanced(false);
    clock.publish(0);
    durationRef.current = 0;
    playbackVerifiedAtRef.current = 0;
    playbackEndedRef.current = false;
    setHasEnded(false);
    setDuration(0);
  });
  const isPlayerChromeEngaged = useCallback(
    () =>
      !!topChromeRef.current?.matches(':hover, :focus-within') ||
      !!bottomChromeRef.current?.querySelector(':focus-visible') ||
      document.querySelector(RADIX_POPPER_CONTENT_SELECTOR) !== null,
    [],
  );
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
  const { isSeekPending, observeTimeUpdate, seek, seekRelative } = useOptimisticSeek({
    clock,
    durationRef,
    resetKey: activeStreamUrl,
    triggerOsd,
  });
  const clearUiTimers = useCallback(() => {
    clearManagedUiTimers();
    clearTimer(forceShowTimeoutRef);
  }, [clearManagedUiTimers]);
  const handleResumeMessage = useCallback(
    (text: string) => {
      announce(text, 'history');
    },
    [announce],
  );

  useEffect(() => {
    const nextSpeed = appUiPreferences.playerSpeed;
    const speedChanged = appliedSpeedRef.current !== nextSpeed;
    appliedSpeedRef.current = nextSpeed;
    setPlaybackSpeed((current) => (current === nextSpeed ? current : nextSpeed));

    if (mpvInitializedRef.current && speedChanged) {
      void setMpvProperty('speed', nextSpeed).catch(() => undefined);
    }
  }, [appUiPreferences.playerSpeed]);

  // Async selector-open continuations bail once a newer request exists or the player unmounted.
  const isSelectorRequestStale = useCallback(
    (requestId: number) => requestId !== selectorOpenRequestIdRef.current || !mountedRef.current,
    [mountedRef],
  );

  const clearNextEpisodeRequest = useCallback((requestId?: number) => {
    // A late continuation must not clear a newer episode's resolving state.
    if (
      nextEpisodeRequestRef.current === null ||
      (requestId !== undefined && nextEpisodeRequestRef.current !== requestId)
    )
      return;
    nextEpisodeRequestRef.current = null;
    setIsResolving(false);
    setResolveStatus('');
  }, []);

  useEffect(() => {
    resetStreamScopedState();
  }, [activeStreamUrl]);

  // -- Queries --
  // Shared details key reuses the cached entry; movies fetch too — `imdbId` widens the SkipDB anchor.
  const { data: details, isLoading: isLoadingDetails } = useQuery({
    queryKey: detailsQueryKey(effectiveResolveMediaType, id),
    queryFn: () =>
      id
        ? api.getMediaDetails(effectiveResolveMediaType, id)
        : Promise.reject(new Error('Media ID is required for player details lookup.')),
    enabled: !!type && !!id,
    staleTime: DETAILS_STALE_TIME_MS,
    gcTime: DETAILS_GC_TIME_MS,
  });
  const episodes = details?.episodes;

  // Route season/episode may be anime stream-query coords — prefer the absolute match; season-less absolute routes match on episode number alone.
  const currentEpisode = useMemo(
    () =>
      findEpisodeByCoordinates(episodes, routeAbsoluteSeason, routeAbsoluteEpisode) ??
      findEpisodeByCoordinates(episodes, routeSeason, routeEpisode) ??
      (routeAbsoluteSeason === undefined && routeAbsoluteEpisode !== undefined
        ? episodes?.find((ep) => ep.episode === routeAbsoluteEpisode)
        : undefined) ??
      null,
    [episodes, routeSeason, routeEpisode, routeAbsoluteEpisode, routeAbsoluteSeason],
  );

  const currentEpisodeStream = useMemo(() => {
    if (!currentEpisode || !type || !id) return null;
    return buildEpisodeStreamTarget(routeStreamLookupId || details?.imdbId || id, currentEpisode);
  }, [currentEpisode, type, id, routeStreamLookupId, details?.imdbId]);

  // -- Skip Times --
  // SkipDB keys on IMDb id; anime-history `kitsu:` ids carry no anchor and return no segments.
  const isSeriesLike = isSeriesLikeMediaType(effectiveResolveMediaType);
  // Same query as details, so arriving from there is a cache hit.
  const { data: titleWatchProgress } = useTitleWatchProgress(id, {
    enabled: isSeriesLike && isExpanded && showEpisodes,
  });
  const episodeProgress = titleWatchProgress?.episodeProgress;
  const episodeProgressFor = useCallback(
    (ep: Episode) =>
      id ? episodeProgress?.[episodeProgressKey(id, ep.season, ep.episode)] : undefined,
    [episodeProgress, id],
  );
  // The backend's resumable pick — the latest history row can be a finished episode, which must not badge "Resume".
  const episodeResumeTarget = useMemo(
    () => watchProgressCoordinates(titleWatchProgress?.seriesResumeEntry),
    [titleWatchProgress],
  );
  const resolvedAbsoluteSeason = currentEpisode?.season ?? routeAbsoluteSeason;
  const resolvedAbsoluteEpisode = currentEpisode?.episode ?? routeAbsoluteEpisode;
  const resolvedStreamSeason =
    routeStreamSeason ?? currentEpisodeStream?.streamSeason ?? routeSeason;
  const resolvedStreamEpisode =
    routeStreamEpisode ?? currentEpisodeStream?.streamEpisode ?? routeEpisode;
  // SkipDB needs an IMDb anchor (loaded details or a tt-shaped id); the normalized anchor feeds key and call.
  const skipTimesImdbAnchor = resolveSkipTimesImdbAnchor(details?.imdbId, id, routeStreamLookupId);
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
    !!skipTimesImdbAnchor &&
    skipTimesDurationSecs !== undefined &&
    (!isSeriesLike ||
      (resolvedAbsoluteSeason !== undefined && resolvedAbsoluteEpisode !== undefined));

  const { data: skipTimes } = useQuery<SkipTimesResult>({
    queryKey: skipTimesQueryKey(
      effectiveResolveMediaType,
      id,
      resolvedAbsoluteSeason,
      resolvedAbsoluteEpisode,
      skipTimesImdbAnchor,
      skipTimesDurationSecs,
    ),
    queryFn: () =>
      id
        ? api.getSkipTimes(
            effectiveResolveMediaType,
            id,
            skipTimesImdbAnchor,
            resolvedAbsoluteSeason,
            resolvedAbsoluteEpisode,
            skipTimesDurationSecs,
          )
        : Promise.reject(new Error('Media ID is required for skip-time lookup.')),
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

  const episodeCountInSeason = useMemo(() => {
    if (resolvedAbsoluteSeason === undefined || !episodes) return null;
    return details?.seasons?.find((s) => s.number === resolvedAbsoluteSeason)?.episodeCount ?? 0;
  }, [details?.seasons, episodes, resolvedAbsoluteSeason]);

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

  const playerLoadingCopy = useMemo<PlayerLoadingCopy>(() => {
    if (isResolving) {
      return {
        headline: resolveStatus || 'Finding the best stream',
        detail: shouldWaitForResolvedLookupId
          ? 'Confirming the episode first'
          : 'Checking your sources for a fast, exact match',
      };
    }

    if (activeStreamUrl) {
      if (isHistoryResume) {
        return {
          headline:
            startTime !== undefined && startTime >= MIN_RESUME_POSITION_SECS
              ? 'Restoring saved stream'
              : 'Opening saved stream',
          detail: 'Using your last working source',
        };
      }

      if (openingStreamName) {
        return {
          headline: 'Opening selected stream',
          detail: nonBlank(openingStreamSource) || openingStreamName.trim(),
        };
      }

      return {
        headline: 'Opening stream',
        detail: 'Connecting and buffering',
      };
    }

    if (shouldWaitForResolvedLookupId) {
      return {
        headline: 'Matching the right episode',
        detail: 'Confirming the episode before searching',
      };
    }

    if (isHistoryResume) {
      return {
        headline: 'Resuming where you left off',
        detail: 'Picking the best stream',
      };
    }

    return {
      headline: 'Preparing playback',
      detail: 'Getting the player ready',
    };
  }, [
    activeStreamUrl,
    isHistoryResume,
    isResolving,
    resolveStatus,
    shouldWaitForResolvedLookupId,
    startTime,
    openingStreamName,
    openingStreamSource,
  ]);

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
    [
      currentEpisodeLabel,
      startTime !== undefined && startTime >= MIN_RESUME_POSITION_SECS
        ? `From ${formatTime(startTime)}`
        : '',
    ]
      .filter(Boolean)
      .join(' · ') || undefined;
  const currentEpisodeHeading = formatEpisodeHeading(
    resolvedAbsoluteSeason,
    resolvedAbsoluteEpisode,
    currentEpisode?.title,
  );
  useDocumentTitle(
    title ? `${title}${currentEpisodeLabel ? ` · ${currentEpisodeLabel}` : ''}` : undefined,
  );

  const {
    applyResumeIfReady,
    audioTracks,
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
    trackSwitching,
  } = usePlayerSessionBoundary({
    absoluteEpisode: resolvedAbsoluteEpisode,
    absoluteSeason: resolvedAbsoluteSeason,
    activeStreamResetKey: `${activeStreamUrl ?? 'stream'}:${id ?? 'id'}:${season ?? 'season'}:${episode ?? 'episode'}:${effectiveResolveMediaType}`,
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

  // -- Addon subtitles (manifest-routed) --
  const {
    activeAddonSubtitleId,
    addonSubtitleLoadingId,
    addonSubtitles,
    addonSubtitlesError,
    addonSubtitlesLoading,
    addonSubtitlesQueried,
    handleAddonSubtitleSelect,
    handleSubTrackSelect,
    handleSubtitleMenuOpenChange,
  } = usePlayerAddonSubtitles({
    activeStreamUrl,
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

  // Stable props for the memoized selectors — inline closures would defeat the memo.
  const handleAudioTrackSelect = useCallback(
    (trackType: 'audio', trackId: number, options?: { persistPreference?: boolean }) => {
      void setTrack(trackType, trackId, options).then((applied) => {
        if (!applied) return;
        const label = buildTrackLabelMap(audioTracks).get(trackId) ?? `Track ${trackId}`;
        announce(`Audio: ${label}`, 'audio');
      });
    },
    [announce, audioTracks, setTrack],
  );

  // Read live refs at back-time so the callback identity stays stable.
  const shouldReopenStreamSelector = useCallback(
    () =>
      errorRef.current !== null || playbackEndedRef.current || playbackVerifiedAtRef.current === 0,
    [errorRef, playbackEndedRef, playbackVerifiedAtRef],
  );
  const { navigateBack } = usePlayerBackNavigation({
    currentTimeRef,
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

  const stopLoading = useCallback((makeTransparent = false) => {
    setIsLoading(false);
    if (makeTransparent) {
      setPlayerDocumentBackground(true);
    }
  }, []);

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

  const handleMiniVideoRectChange = useCallback(
    (rect: MiniVideoRect | null) => {
      miniVideoRectRef.current = rect;
      return applyMiniSurface();
    },
    [applyMiniSurface],
  );

  const openPreparedStreamSelector = useCallback(
    (nextTarget: SelectedEpisodeStreamTarget | null) => {
      selectorOpenRequestIdRef.current += 1;
      clearNextEpisodeRequest();
      setError(null);
      setStreamSelectorState({
        open: true,
        target: nextTarget,
        mounted: true,
      });
      closeEpisodesPanel();
    },
    [clearNextEpisodeRequest, closeEpisodesPanel],
  );

  const closeStreamSelector = useCallback(() => {
    selectorOpenRequestIdRef.current += 1;
    clearNextEpisodeRequest();
    // Dismiss without a pick hands back the pause the selector took on the way in.
    if (resumeAfterSelectorDismissRef.current) {
      resumeAfterSelectorDismissRef.current = false;
      void setMpvProperty('pause', false).catch(() => undefined);
      setIsPlaying(true);
    }
    // Keep target/mounted so the exit animation can play; `open` alone drives behavior.
    setStreamSelectorState((state) => (state.mounted ? { ...state, open: false } : state));
  }, [clearNextEpisodeRequest]);

  const reopenSelectorForSavedStreamFailure = useCallback(() => {
    setIsResolving(false);
    setResolveStatus('');
    setShowControls(true);
    openPreparedStreamSelector(null);
  }, [openPreparedStreamSelector]);

  const { clearRecoveryTimers, markPlaybackStarted, recoverFromSlowStartup } = useStreamRecovery({
    stream,
    isHistoryResume,
    mediaType: effectiveResolveMediaType,
    mediaId: id,
    title: resolveTitle,
    resolveSeason: resolvedStreamSeason,
    resolveEpisode: resolvedStreamEpisode,
    absoluteSeason: resolvedAbsoluteSeason,
    absoluteEpisode: resolvedAbsoluteEpisode,
    streamLookupId,
    currentTimeRef,
    durationRef,
    isPlayingRef,
    mountedRef,
    errorRef,
    failoverResumePositionRef,
    stopLoading,
    setError,
    setIsResolving,
    setResolveStatus,
    onSavedStreamUnavailable: reopenSelectorForSavedStreamFailure,
  });

  // Metadata or a first tick lifts the loading card; the startup watchdog still owns a pre-playhead stall.
  const markPlaybackReady = useCallback(() => {
    stopLoading(true);
    setHasPlaybackStarted(true);
    setError(null);
    clearTimer(forceShowTimeoutRef);
    showControlsWithAutoHide(PLAYBACK_READY_AUTO_HIDE_DELAY_MS);
  }, [showControlsWithAutoHide, stopLoading]);

  // Only an advancing playhead proves the stream: duration alone can precede a stall, and must neither cancel recovery nor credit the source.
  const markPlaybackVerified = useCallback(() => {
    // Metadata and the paused resume seek can arrive before playback actually runs.
    if (isPlayingRef.current) setHasPlaybackAdvanced(true);
    if (playbackVerifiedAtRef.current > 0) return;
    markPlaybackStarted();
    playbackVerifiedAtRef.current = performance.now();
    reportStreamVerified();
  }, [markPlaybackStarted, reportStreamVerified]);

  useEffect(() => {
    errorRef.current = error;
    isResolvingRef.current = isResolving;
    isPlayingRef.current = isPlaying;
    // Resuming past EOF retires the "Up Next" card and the Back→selector latch.
    if (isPlaying && hasEnded) {
      playbackEndedRef.current = false;
      setHasEnded(false);
    }
  }, [error, hasEnded, isResolving, isPlaying]);

  useEffect(() => {
    const paused = selectorCommittedPauseRef.current;
    if (!paused || paused.state === session?.state) return;
    selectorCommittedPauseRef.current = null;
    // A changed route seed drops the native URL; only a retained stream needs the selector's pause released.
    if (activeStreamUrl === paused.url) {
      void setMpvProperty('pause', false).catch(() => undefined);
      setIsPlaying(true);
    }
  }, [activeStreamUrl, session?.state]);

  const prepareForPlayerNavigation = useCallback(
    (flushProgress = true) => {
      selectorCommittedPauseRef.current =
        resumeAfterSelectorDismissRef.current && activeStreamUrl
          ? { state: session?.state, url: activeStreamUrl }
          : null;
      resumeAfterSelectorDismissRef.current = false;
      prepareForInternalPlayerNavigation();
      setShowControls(true);
      setShowEpisodes(false);
      // Synchronous progress snapshot; also covers same-session stream picks that skip the exit guard.
      if (flushProgress) void flushPlaybackBeforeNavigation();
    },
    [
      activeStreamUrl,
      flushPlaybackBeforeNavigation,
      prepareForInternalPlayerNavigation,
      session?.state,
    ],
  );

  const expandPlayer = useCallback(() => {
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
    const baseState =
      typeof session.state === 'object' && session.state !== null ? session.state : {};
    navigate(session.playerPath, {
      state: { ...baseState, from: currentPathWithSearch() },
    });
  }, [navigate, session]);

  // Minimize keeps the player mounted — save progress on the expanded→mini transition, not unmount.
  // Overlays close too: any route change docks, and a stale flag would reopen them on expand.
  const wasExpandedRef = useRef(isExpanded);
  useEffect(() => {
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

  const handleEndedChange = useCallback(
    (ended: boolean) => {
      if (playbackEndedRef.current === ended) return;
      playbackEndedRef.current = ended;
      setHasEnded(ended);
      if (!ended) return;
      setIsPlaying(false);
      void saveProgressRef.current?.();
      // Pin chrome for the EOF card — isPlayingRef can read stale-true here, so drive controls directly.
      clearControlsAutoHide();
      setShowControls(true);
    },
    [clearControlsAutoHide, saveProgressRef],
  );

  const scheduleMpvSet = useMpvSetScheduler();
  const {
    subtitleDelay,
    subtitlePos,
    subtitleScale,
    subtitleSettingsRef,
    applySubtitleDelay,
    applySubtitlePos,
    applySubtitleScale,
    resetSubtitleSettings,
  } = useSubtitleAdjustments({
    preferences: appUiPreferences,
    updatePreferences: updateAppUiPreferences,
    scheduleMpvSet,
  });

  const {
    volume,
    setVolume,
    isMuted,
    setIsMuted,
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

  const { isBuffering, requestPositionRefresh } = usePlayerMpvLifecycle({
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
    bufferedClock,
    durationRef,
    playbackVerifiedAtRef,
    errorRef,
    forceShowTimeoutRef,
    saveProgressRef,
    setIsLoading,
    setError,
    setDuration,
    setIsPlaying,
    setVolume,
    setIsMuted,
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
    reopenSelectorForSavedStreamFailure,
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
  }, [activeStreamUrl]);

  const restartPlayback = useCallback(async () => {
    const epoch = playbackControlEpochRef.current;
    await seek(0);
    if (epoch !== playbackControlEpochRef.current || !mountedRef.current || isDestroyedRef.current)
      return;
    await setMpvProperty('pause', false);
  }, [mountedRef, seek]);

  // keep-open parks mpv on the last frame at terminal EOF — Play must rewind and resume, not just clear `pause`.
  const isTerminalEof = useCallback(
    () =>
      playbackEndedRef.current &&
      (durationRef.current <= 0 || isNearMediaEnd(currentTimeRef.current, durationRef.current)),
    [currentTimeRef, durationRef, playbackEndedRef],
  );

  // Seeking back after EOF resumes the selected position; Watch again always restarts.
  const togglePlay = useCallback(
    () => (isTerminalEof() ? restartPlayback() : mpvCommand('cycle', ['pause'])),
    [isTerminalEof, restartPlayback],
  );

  // mpv's frame steps pause internally; the `pause` property keeps `isPlaying` in sync.
  const frameStep = useCallback(
    async (direction: 1 | -1) => {
      await mpvCommand(direction > 0 ? 'frame-step' : 'frame-back-step');
      requestPositionRefresh();
    },
    [requestPositionRefresh],
  );

  const openStreamSelectorForEpisode = useCallback(
    (
      nextEpisode: Episode,
      options?: {
        pauseCurrentPlayback?: boolean;
        resumeStartTimePromise?: Promise<number | undefined>;
      },
    ) => {
      if (!id) {
        return;
      }

      if (options?.pauseCurrentPlayback) {
        // Fire-and-forget pause under the selector; remember pre-pause state so dismiss can resume.
        resumeAfterSelectorDismissRef.current = isPlayingRef.current;
        void setMpvProperty('pause', true).catch(() => undefined);
        setIsPlaying(false);
      }

      const target = buildEpisodeStreamTarget(streamLookupId || id, nextEpisode);

      // The resume lookup is advisory for a different episode only — a same-episode pick reads the live clock.
      const targetsCurrentEpisode = sameEpisodeCoordinates(target, {
        absoluteSeason: resolvedAbsoluteSeason,
        absoluteEpisode: resolvedAbsoluteEpisode,
        streamSeason: resolvedStreamSeason,
        streamEpisode: resolvedStreamEpisode,
      });

      // Open immediately — the advisory lookup fills startTime behind the dialog before any pick.
      openPreparedStreamSelector({ ...target });
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
    },
    [
      effectiveResolveMediaType,
      id,
      isSelectorRequestStale,
      openPreparedStreamSelector,
      resolvedAbsoluteEpisode,
      resolvedAbsoluteSeason,
      resolvedStreamEpisode,
      resolvedStreamSeason,
      streamLookupId,
    ],
  );

  const playEpisode = useCallback(
    (ep: Episode) => {
      openStreamSelectorForEpisode(ep, { pauseCurrentPlayback: true });
    },
    [openStreamSelectorForEpisode],
  );

  const localDayMs = useLocalDay().getTime();
  const previousEpisode = useMemo(() => {
    const current = currentEpisode;
    if (!episodes || !current) return undefined;
    return episodes.findLast(
      (ep) =>
        ep.season < current.season ||
        (ep.season === current.season && ep.episode < current.episode),
    );
  }, [episodes, currentEpisode]);

  const nextEpisode = useMemo(() => {
    const current = currentEpisode;
    if (!episodes || !current) return undefined;
    // Episodes arrive (season, episode)-sorted — first match after current is next; an unaired successor ends the run.
    const next = episodes.find(
      (ep) =>
        ep.season > current.season ||
        (ep.season === current.season && ep.episode > current.episode),
    );
    return next && isAiredByLocalDay(next.releaseDate, localDayMs) ? next : undefined;
  }, [episodes, currentEpisode, localDayMs]);

  const previousEpisodeLabel = previousEpisode
    ? `Previous: ${formatSeasonEpisode(previousEpisode.season, previousEpisode.episode)}${previousEpisode.title ? ` · ${previousEpisode.title}` : ''}`
    : undefined;

  const nextEpisodeLabel = nextEpisode
    ? `Next: ${formatSeasonEpisode(nextEpisode.season, nextEpisode.episode)}${nextEpisode.title ? ` · ${nextEpisode.title}` : ''}`
    : undefined;

  // Shared silent resolve so the EOF/tail prefetch warms the same cache key the click uses.
  const resolveEpisodeStream = useCallback(
    (ep: Episode, mediaId: string) => {
      const target = buildEpisodeStreamTarget(streamLookupId || mediaId, ep);
      const request: PlayerStreamRequest = {
        mediaType: effectiveResolveMediaType,
        mediaId,
        streamLookupId: target.streamLookupId,
        streamSeason: target.streamSeason,
        streamEpisode: target.streamEpisode,
        absoluteSeason: target.absoluteSeason,
        absoluteEpisode: target.absoluteEpisode,
        title: resolveTitle,
      };
      return {
        target,
        request,
        resolve: resolvePlayerStream({
          ...request,
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
      resolveTitle,
      streamLookupId,
    ],
  );

  // Silent ranked resolve first — the just-played source usually wins; timeout/failure falls back to the selector.
  const playAdjacentEpisode = useCallback(
    (ep: Episode | undefined, direction: 'next' | 'previous') => {
      if (!ep || !id || nextEpisodeRequestRef.current !== null) {
        if (!ep && nextEpisodeRequestRef.current === null) {
          announce(`No ${direction} episode`);
        }
        return;
      }

      const requestId = ++selectorOpenRequestIdRef.current;
      nextEpisodeRequestRef.current = requestId;
      const { target, request, resolve } = resolveEpisodeStream(ep, id);
      setIsResolving(true);
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
          if (isSelectorRequestStale(requestId)) {
            clearNextEpisodeRequest(requestId);
            return;
          }
          if (!resolved?.url) throw new Error('No streams found for the adjacent episode.');

          prepareForPlayerNavigation();
          launchResolvedStream(navigate, request, resolved, {
            backdrop,
            from,
            logo,
            poster,
            startTime: resumeStartTime,
          });
        })
        .catch(() => {
          if (isSelectorRequestStale(requestId)) {
            clearNextEpisodeRequest(requestId);
            return;
          }
          clearNextEpisodeRequest(requestId);
          openStreamSelectorForEpisode(ep, {
            pauseCurrentPlayback: true,
            resumeStartTimePromise,
          });
        })
        .finally(() => {
          if (nextEpisodeRequestRef.current === requestId) {
            nextEpisodeRequestRef.current = null;
          }
        });
    },
    [
      announce,
      backdrop,
      clearNextEpisodeRequest,
      effectiveResolveMediaType,
      from,
      id,
      isSelectorRequestStale,
      logo,
      navigate,
      openStreamSelectorForEpisode,
      poster,
      prepareForPlayerNavigation,
      resolveEpisodeStream,
    ],
  );

  const playNextEpisode = useCallback(
    () => playAdjacentEpisode(nextEpisode, 'next'),
    [nextEpisode, playAdjacentEpisode],
  );

  const playPreviousEpisode = useCallback(
    () => playAdjacentEpisode(previousEpisode, 'previous'),
    [previousEpisode, playAdjacentEpisode],
  );

  // One EOF gate for both cards; the variant depends on whether an episode follows.
  // Auto-play counts down to the same silent resolve `N` runs — a gate flip disarms the timer.
  const playbackIntact = !error && !isLoading && !isResolving;
  const panelsOwnSurface = showStreamSelector || showEpisodes || showShortcuts;
  const eofCardOpen = hasEnded && playbackIntact && !panelsOwnSurface;
  const showUpNextCard = eofCardOpen && !!nextEpisode;
  const showEndCard = eofCardOpen && !nextEpisode;
  const [autoPlayNextIn, setAutoPlayNextIn] = useState<number | null>(null);
  const [eofAutoPlayCancelled, setEofAutoPlayCancelled] = useState(false);

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
  const autoPlayNext = appUiPreferences.autoPlayNext;
  useEffect(() => {
    if (!autoPlayNext || !showUpNextCard || !isExpanded || eofAutoPlayCancelled) {
      setAutoPlayNextIn(null);
      return;
    }
    setAutoPlayNextIn(appUiPreferences.nextEpisodeCountdownSecs);
    const timer = window.setInterval(() => {
      setAutoPlayNextIn((current) => (current === null ? current : current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [
    appUiPreferences.nextEpisodeCountdownSecs,
    autoPlayNext,
    eofAutoPlayCancelled,
    isExpanded,
    showUpNextCard,
  ]);

  useEffect(() => {
    if (autoPlayNextIn !== 0) return;
    setAutoPlayNextIn(null);
    playNextEpisode();
  }, [autoPlayNextIn, playNextEpisode]);

  const cancelAutoPlayNext = useCallback(() => {
    setEofAutoPlayCancelled(true);
    setAutoPlayNextIn(null);
  }, []);

  // Every EOF play affordance uses the same rewind-and-resume path.
  const replayFromStart = useCallback(() => {
    void restartPlayback().catch(() => undefined);
  }, [restartPlayback]);

  const backToTitle = useCallback(() => {
    if (!id) {
      void navigateBack().catch(() => undefined);
      return;
    }
    // Expanded navigation retains the session; the docking effect owns its progress flush.
    prepareForPlayerNavigation(!isExpanded);
    navigate(buildDetailsRoute(type, id), {
      replace: true,
      state:
        resolvedAbsoluteSeason !== undefined
          ? { from, season: resolvedAbsoluteSeason, episode: resolvedAbsoluteEpisode }
          : { from },
    });
  }, [
    from,
    id,
    isExpanded,
    navigate,
    navigateBack,
    prepareForPlayerNavigation,
    resolvedAbsoluteEpisode,
    resolvedAbsoluteSeason,
    type,
  ]);

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
    onPlay: () =>
      void (isTerminalEof() ? restartPlayback() : setMpvProperty('pause', false)).catch(
        () => undefined,
      ),
    onPause: () => void setMpvProperty('pause', true).catch(() => undefined),
    onPreviousTrack: () => void seek(0).catch(() => undefined),
    onNextTrack: nextEpisode ? playNextEpisode : undefined,
    onSeekTo: (seconds) => void seek(seconds).catch(() => undefined),
    onSeekBy: (seconds) => void seekRelative(seconds).catch(() => undefined),
  });

  // Warm the next-episode resolve during tail/Up Next so the click is a cache hit;
  // one fan-out per episode, gated on the resolved lookup id (never a fallback id).
  const nextEpisodePrefetchKeyRef = useRef<string | null>(null);
  // A segment reaching file end is the episode tail — seeking into EOF parks on a dead frame.
  const tailSegmentActive =
    activeSkipSegment != null && isNearMediaEnd(activeSkipSegment.end_time, duration);
  useEffect(() => {
    if (!id || !nextEpisode || error) return;
    if (isLoading || isResolving || showStreamSelector || shouldWaitForResolvedLookupId) return;
    if (!hasEnded && !tailSegmentActive) return;

    // Key on the resolved lookup id — a mid-session `kitsu:`→`tt` upgrade re-warms instead of leaving the click cold.
    const prefetchLookupId = buildEpisodeStreamTarget(
      streamLookupId || id,
      nextEpisode,
    ).streamLookupId;
    const prefetchKey = `${id}:${nextEpisode.season}:${nextEpisode.episode}:${prefetchLookupId}`;
    if (nextEpisodePrefetchKeyRef.current === prefetchKey) return;
    nextEpisodePrefetchKeyRef.current = prefetchKey;

    void resolveEpisodeStream(nextEpisode, id).resolve.catch(() => undefined);
  }, [
    tailSegmentActive,
    error,
    hasEnded,
    id,
    isLoading,
    isResolving,
    nextEpisode,
    resolveEpisodeStream,
    shouldWaitForResolvedLookupId,
    showStreamSelector,
    streamLookupId,
  ]);

  const skipAction = useMemo(() => {
    if (!activeSkipSegment) return null;
    // A tail segment offers the standard next-episode flow instead.
    const runsToEnd = isNearMediaEnd(activeSkipSegment.end_time, duration);
    if (runsToEnd && nextEpisode) {
      return { label: 'Next Episode', onSkip: playNextEpisode };
    }
    return {
      label: getSkipLabel(activeSkipSegment.type),
      onSkip: () => {
        void seek(activeSkipSegment.end_time)
          .then(() => announce(getSkippedLabel(activeSkipSegment.type), 'skip'))
          .catch(() => undefined);
      },
    };
  }, [activeSkipSegment, announce, duration, nextEpisode, playNextEpisode, seek]);

  // EOF and open panels own the action lane, even if mpv's last clock tick is inside an outro.
  const activeSkipAction = !hasEnded && playbackIntact && !panelsOwnSurface ? skipAction : null;

  // Auto-skip fires once per intro/recap segment; the tail stays manual — that's `autoPlayNext`'s job.
  const autoSkipIntro = appUiPreferences.autoSkipIntro;
  const lastAutoSkipSegmentRef = useRef<string | null>(null);
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
    if (lastAutoSkipSegmentRef.current === segmentKey) return;
    lastAutoSkipSegmentRef.current = segmentKey;
    activeSkipAction.onSkip();
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

  const openManualStreamFallback = useCallback(() => {
    // Cancel in-flight auto-resolve first so a late result can't clobber the manual open.
    autoResolveGenRef.current += 1;
    setIsResolving(false);
    setResolveStatus('');
    if (isSeriesLike && currentEpisode) {
      openStreamSelectorForEpisode(currentEpisode);
      return;
    }
    // Movies and pre-details series open against route coords with the remembered timestamp.
    openPreparedStreamSelector(null);
  }, [isSeriesLike, openPreparedStreamSelector, openStreamSelectorForEpisode, currentEpisode]);

  // Clear the failed stream and error so auto-resolve re-ranks and retries in place.
  const handleRetryFailedStream = useCallback(() => {
    // A manual retry is a same-title failover — preserve the live playhead so the re-resolve resumes here.
    failoverResumePositionRef.current = currentTimeRef.current;
    setActiveStreamUrl(undefined);
    setError(null);
  }, [currentTimeRef, setActiveStreamUrl]);

  // `cycleTrack` runs switch-flag + persist bookkeeping a bare `cycle` skips — without it the language auto-apply reverts.
  const cycleSubtitles = useCallback(async () => {
    const landed = await cycleTrack('sub');
    if (landed === null) return;
    announce(landed === 'no' ? 'Subtitles off' : 'Subtitles on', 'subtitles');
  }, [announce, cycleTrack]);

  const cycleAudioTrack = useCallback(async () => {
    if (audioTracks.length < 2) {
      announce('No other audio tracks', 'audio');
      return;
    }
    const landed = await cycleTrack('audio');
    if (landed === null) return;
    announce(
      landed === 'no'
        ? 'Audio off'
        : `Audio: ${buildTrackLabelMap(audioTracks).get(landed) ?? `Track ${landed}`}`,
      'audio',
    );
  }, [announce, audioTracks, cycleTrack]);

  const handleSpeedSelect = useCallback(
    (speed: number) => {
      setPlaybackSpeed(speed);
      appliedSpeedRef.current = speed;
      void updateAppUiPreferences({ playerSpeed: speed });
      void setMpvProperty('speed', speed).catch(() => undefined);
      announce(`Speed: ${speed}x`, 'gauge');
    },
    [announce, updateAppUiPreferences],
  );

  // `[`/`]` step the preset ladder; at the edge the press no-ops, so re-announce the current speed.
  const stepSpeed = useCallback(
    (direction: 1 | -1) => {
      const next =
        direction > 0
          ? (SPEED_OPTIONS.find((s) => s > playbackSpeed) ?? playbackSpeed)
          : (SPEED_OPTIONS.findLast((s) => s < playbackSpeed) ?? playbackSpeed);
      if (next !== playbackSpeed) {
        handleSpeedSelect(next);
        return;
      }
      announce(`Speed: ${next}x`, 'gauge');
    },
    [announce, handleSpeedSelect, playbackSpeed],
  );

  // `z`/`x` nudge subtitle delay by one slider quantum.
  const nudgeSubtitleDelay = useCallback(
    (direction: 1 | -1) => {
      const next = applySubtitleDelay(subtitleDelay + direction * 0.1);
      announce(`Subtitles ${next > 0 ? '+' : ''}${next.toFixed(1)}s`, 'subtitles');
    },
    [announce, applySubtitleDelay, subtitleDelay],
  );

  const toggleEpisodesPanel = useCallback(() => {
    if (showEpisodes) {
      closeEpisodesPanel();
    } else {
      setEpisodesPanelMounted(true);
      setShowEpisodes(true);
    }
  }, [closeEpisodesPanel, showEpisodes]);

  // -- Hotkeys --
  const hasEpisodes = (episodes?.length ?? 0) > 0;

  usePlayerHotkeys({
    closeEpisodesPanel,
    closeStreamSelector,
    cycleAudioTrack,
    cycleSubtitles,
    durationRef,
    frameStep,
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
    setIsResolving,
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
  const handleMouseMove = useCallback(() => {
    const now = performance.now();
    // Throttle while hidden too — events between the wake's state write and commit would re-arm.
    if (now - lastControlsWakeAtRef.current < 250) return;
    lastControlsWakeAtRef.current = now;
    showControlsWithAutoHide();
  }, [showControlsWithAutoHide]);

  const handleMouseLeave = useCallback(() => {
    if (!isPlaying) return;
    // Portaled popovers leave the container — a hide here would unmount chrome under an open menu.
    if (isPlayerChromeEngaged()) return;
    clearControlsAutoHide();
    setShowControls(false);
  }, [clearControlsAutoHide, isPlaying, isPlayerChromeEngaged]);

  const handlePlayerWheel = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      if (showStreamSelector || showEpisodes || showShortcuts) return;
      if (isPlayerInteractiveTarget(event.target)) return;
      if (event.deltaY === 0) return;
      if (event.shiftKey) {
        void seekRelative(event.deltaY < 0 ? 5 : -5).catch(() => undefined);
      } else {
        void handleVolumeWheel(event).catch(() => undefined);
      }
    },
    [handleVolumeWheel, seekRelative, showEpisodes, showShortcuts, showStreamSelector],
  );

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

  const handlePlayerClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
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
    },
    [
      showEpisodes,
      closeEpisodesPanel,
      idleOverlayVisible,
      wakePlayerIdle,
      showControlsWithAutoHide,
      isLoading,
      isResolving,
      error,
      togglePlay,
    ],
  );

  const handlePlayerDoubleClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (shouldIgnorePlayerSurfaceInteraction(event)) return;

      blurActivePlayerControl();

      void toggleFullscreen().catch(() => undefined);
    },
    [toggleFullscreen],
  );

  // Stable MiniPlayer props — fresh handler identities would defeat the memoized portal.
  const handleMiniPositionChange = useCallback(
    (position: MiniPlayerPosition) => {
      miniPositionRef.current = position;
    },
    [miniPositionRef],
  );
  const handleMiniTogglePlay = useCallback(() => {
    void togglePlay().catch(() => undefined);
  }, [togglePlay]);
  const handleMiniToggleMute = useCallback(() => {
    void toggleMute().catch(() => undefined);
  }, [toggleMute]);
  const handleMiniVolumeChange = useCallback(
    (next: number) => {
      void handleVolumeChange(next).catch(() => undefined);
    },
    [handleVolumeChange],
  );
  const handleVolumeStep = useCallback(
    (delta: number) => {
      void stepVolume(delta).catch(() => undefined);
    },
    [stepVolume],
  );
  const handleControlsHover = useCallback((hovered: boolean) => {
    pointerOverControlsRef.current = hovered;
  }, []);
  const handleMiniSeek = useCallback(
    (seconds: number) => {
      void seek(seconds).catch(() => undefined);
    },
    [seek],
  );
  const handleMiniSeekRelative = useCallback(
    (delta: number) => {
      void seekRelative(delta).catch(() => undefined);
    },
    [seekRelative],
  );

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
    !activeSkipAction &&
    !idleOverlayVisible &&
    playbackIntact &&
    !panelsOwnSurface;
  const selectorEpisode = useMemo(
    () =>
      findEpisodeByCoordinates(details?.episodes, selectorAbsoluteSeason, selectorAbsoluteEpisode),
    [details?.episodes, selectorAbsoluteSeason, selectorAbsoluteEpisode],
  );
  // Held a beat past the flag so the loading card dissolves out.
  const loadingOverlay = useDelayedUnmount((isLoading || isResolving) && !error, 180);
  const loadingBackdrop = useDelayedUnmount(isLoading, 500);
  // Same dissolve for the stall spinner.
  const bufferingOverlay = useDelayedUnmount(
    isBuffering && playbackIntact && !hasEnded && !panelsOwnSurface && !loadingOverlay.mounted,
    150,
  );
  const centerStatusVisible = loadingOverlay.mounted || bufferingOverlay.mounted || !!error;
  // `PlayerStreamSelector` is memoized — the target must hold a stable identity.
  const selectorTarget = useMemo<StreamSelectorTarget>(
    () => ({
      type: effectiveResolveMediaType,
      // The render gate below refuses to mount without a truthy id.
      id: id ?? '',
      streamId: selectorStreamLookupId,
      season: selectorStreamSeason,
      episode: selectorStreamEpisode,
      absoluteSeason: selectorAbsoluteSeason,
      absoluteEpisode: selectorAbsoluteEpisode,
      title: details?.title || resolveTitle,
      episodeTitle: selectorEpisode?.title,
      overview: selectorEpisode?.overview || details?.description,
      poster,
      backdrop,
      logo,
      episodes: details?.episodes,
      from,
      originFrom,
    }),
    [
      effectiveResolveMediaType,
      id,
      selectorStreamLookupId,
      selectorStreamSeason,
      selectorStreamEpisode,
      selectorAbsoluteSeason,
      selectorAbsoluteEpisode,
      details?.title,
      resolveTitle,
      selectorEpisode,
      details?.description,
      details?.episodes,
      poster,
      backdrop,
      logo,
      from,
      originFrom,
    ],
  );

  // The selector portals over either surface; `mounted` (not `open`) gates the tree so the exit animation plays.
  const streamSelectorNode =
    streamSelectorState.mounted && type && id ? (
      <PlayerStreamSelector
        clock={clock}
        open={showStreamSelector}
        onClose={closeStreamSelector}
        onBeforePlayerNavigation={prepareForPlayerNavigation}
        target={selectorTarget}
        isCurrentEpisode={isSelectorForCurrentEpisode}
        routeStartTime={startTime}
        targetStartTime={selectedEpisodeStreamTarget?.startTime ?? 0}
        currentStreamKey={activeStreamKey}
      />
    ) : null;

  // Docked EOF gate: expanded-only panels can't cover the mini, but a resolve or the selector must not leave strips clickable beneath.
  const miniEofOpen = hasEnded && playbackIntact && !showStreamSelector;
  const nextEpisodeThumbnail = nextEpisode?.thumbnail ?? backdrop ?? poster ?? undefined;
  // Memoized for MiniPlayer.
  const miniPlayerUpNext = useMemo(
    () =>
      miniEofOpen && nextEpisode
        ? {
            label: formatEpisodeHeading(nextEpisode.season, nextEpisode.episode, nextEpisode.title),
          }
        : undefined,
    [miniEofOpen, nextEpisode],
  );

  // FLIP source for the dock entrance, memoized once per dock: the last expanded mpv rect.
  const miniDockOrigin = useMemo(
    () => (isExpanded ? null : getExpandedVideoRect()),
    [isExpanded, getExpandedVideoRect],
  );

  const miniPlayerNode = (exiting: boolean) => (
    <MiniPlayer
      exiting={exiting}
      title={title}
      episodeLabel={currentEpisodeLabel || undefined}
      backdrop={backdrop ?? poster}
      isPlaying={isPlaying}
      isWorking={isLoading || isResolving || isBuffering}
      statusText={playerLoadingCopy.headline}
      error={showErrorOverlay ? error : null}
      clock={clock}
      duration={duration}
      canGoNext={!!nextEpisode}
      hasVideo={mpvSurfaceReady && !!activeStreamUrl && !isLoading && !showErrorOverlay}
      isMuted={isMuted}
      volume={volume}
      upNext={miniPlayerUpNext}
      endOfMedia={miniEofOpen && !nextEpisode}
      skipAction={activeSkipAction}
      onReplay={replayFromStart}
      onBackToTitle={backToTitle}
      initialPosition={miniPositionRef.current}
      // FLIP source rect — null until a margin was sent (e.g. mount straight into mini → plain entrance).
      dockOrigin={miniDockOrigin}
      // Focus claims only on the dock transition — a docked session remount must not yank browse focus.
      claimFocusOnMount={wasExpandedRef.current && !isExpanded}
      onVideoRectChange={handleMiniVideoRectChange}
      onPositionChange={handleMiniPositionChange}
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
          headline={playerLoadingCopy.headline}
          detail={playerLoadingCopy.detail}
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
              'absolute inset-x-0 top-0 h-32 bg-linear-to-b from-black/65 via-black/25 to-transparent transition-opacity duration-150 motion-reduce:transition-none',
              chromeVisible ? 'opacity-100' : 'opacity-0',
            )}
          />
          <div
            aria-hidden='true'
            className={cn(
              'absolute inset-x-0 bottom-0 h-36 bg-linear-to-t from-black/70 via-black/25 to-transparent transition-opacity duration-150 motion-reduce:transition-none',
              chromeVisible ? 'opacity-100' : 'opacity-0',
            )}
          />
          <div
            className={cn(
              'transition-opacity duration-150 motion-reduce:transition-none has-[:focus-visible]:opacity-100',
              chromeVisible ? 'pointer-events-auto' : 'pointer-events-none',
              chromeVisible ? 'opacity-100' : 'opacity-0',
            )}
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
            onPointerEnter={() => {
              pointerOverControlsRef.current = true;
            }}
            onPointerLeave={() => {
              pointerOverControlsRef.current = false;
            }}
          >
            {/* Seek previews include a segment badge; keep the action lane above their full height. */}
            <div className='pointer-events-none absolute bottom-full right-0 flex max-w-full items-end justify-end pb-12'>
              {activeSkipAction && !idleOverlayVisible && (
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
                  autoPlaySecondsLeft={autoPlayNextIn}
                  autoPlayDurationSeconds={appUiPreferences.nextEpisodeCountdownSecs}
                  onCancelAutoPlay={cancelAutoPlayNext}
                  onPlayNext={playNextEpisode}
                />
              )}
              {showEndCard && (
                <PlayerEndCard
                  title={currentEpisodeHeading || title || ''}
                  thumbnail={currentEpisode?.thumbnail ?? backdrop ?? poster ?? undefined}
                  onReplay={replayFromStart}
                  onBackToTitle={backToTitle}
                />
              )}
            </div>
            <div
              className={cn(
                'transition-opacity duration-150 motion-reduce:transition-none has-[:focus-visible]:opacity-100',
                chromeVisible ? 'pointer-events-auto' : 'pointer-events-none',
                chromeVisible ? 'opacity-100' : 'opacity-0',
              )}
            >
              <PlayerProgressBar
                active={chromeVisible}
                duration={duration}
                clock={clock}
                bufferedClock={bufferedClock}
                skipSegments={skipSegments}
                resetKey={activeStreamUrl}
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
                canGoPrevious={!!previousEpisode}
                onPreviousEpisode={playPreviousEpisode}
                previousEpisodeLabel={previousEpisodeLabel}
                canGoNext={!!nextEpisode}
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
                addonSubtitlesError={addonSubtitlesError}
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
          onEpisodeSelect={playEpisode}
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
          resetKey={activeStreamUrl}
          status={
            isResolving
              ? resolveStatus || 'Finding stream…'
              : isLoading
                ? 'Starting playback…'
                : isBuffering
                  ? 'Buffering…'
                  : undefined
          }
          error={error}
          ended={hasEnded && !isResolving}
          autoPlaySecondsLeft={autoPlayNextIn}
          canGoNext={!!nextEpisode}
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
          'pointer-events-none absolute inset-0 z-90 bg-black/80 transition-opacity duration-150 motion-reduce:transition-none',
          isViewportTransitioning ? 'opacity-100' : 'opacity-0',
        )}
      />
      {/* Expand handoff: the mini chrome lingers one beat and dissolves out. */}
      {miniExiting && miniPlayerNode(true)}
    </div>
  );
}
