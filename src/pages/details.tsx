import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toLocalDate } from '@/lib/schedule-dates';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  ListVideo,
  Loader2,
  Play,
  RotateCcw,
  Star,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavigationType, useLocation, useNavigationType, useParams } from 'react-router';
import {
  EpisodeCard,
  type EpisodeEmphasis,
  isEpisodeSpoiler,
} from '@/components/details-episode-card';
import { DetailsCredits } from '@/components/details-credits';
import {
  creditsMediaType,
  DetailsSections,
  NextAiringChip,
  type DetailsSection,
} from '@/components/details-sections';
import {
  type SeasonEpisodeState,
  SeasonProgressRail,
  SeasonSwitcher,
} from '@/components/details-season-switcher';
import { DetailsSimilarTitles } from '@/components/details-similar-titles';
import { DetailsTrailer } from '@/components/details-trailer-dialog';
import { CreateListDialog } from '@/components/list/list-editor-dialog';
import { SaveToCollectionPanel } from '@/components/list/save-to-collection';
import { RemoteImage } from '@/components/remote-image';
import { RetryBanner } from '@/components/retry-banner';
import { ScrollToTop } from '@/components/scroll-to-top';
import { StreamSelector } from '@/components/stream-selector';
import { Button, CopyButton, SaveIndicator } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SearchInput } from '@/components/ui/search-input';
import { DetailsSkeleton, Skeleton } from '@/components/ui/skeleton';
import { WatchStatusIcon } from '@/components/watch-status-icon';
import { useAppUiPreferences } from '@/hooks/use-app-ui-preferences';
import { useDetailsEpisodePane } from '@/hooks/use-details-episode-pane';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useFailedSrc } from '@/hooks/use-failed-src';
import { useLocalDay } from '@/hooks/use-local-day';
import { useNearViewport } from '@/hooks/use-near-viewport';
import { useDetailsStreamSelector } from '@/hooks/use-details-stream-selector';
import { useDetailsWatchStatus } from '@/hooks/use-details-watch-status';
import {
  useMarkSeasonWatched,
  useMediaCollectionActions,
  useTitleWatchProgress,
  useToggleEpisodeWatched,
} from '@/hooks/use-media-library';
import { useMediaPrimaryPlayback } from '@/hooks/use-media-primary-playback';
import {
  api,
  type Episode,
  getErrorMessage,
  isNoCapableAddonError,
  WATCH_STATUSES,
  WATCH_STATUS_COLORS,
  WATCH_STATUS_LABELS,
} from '@/lib/api';
import { buildEpisodeShareLink, buildTitleShareLink } from '@/lib/app-links';
import { PLAYER_RESTART_START_TIME } from '@/lib/player-navigation';
import { episodeMatchesCoordinates } from '@/lib/episode-stream-target';
import { claimDetailsHero } from '@/lib/navigation';
import { copyText } from '@/lib/notify';
import {
  episodeProgressKey,
  formatWatchRemaining,
  getWatchProgressPercent,
} from '@/lib/history-playback';
import {
  detailsQueryKey,
  DETAILS_GC_TIME_MS,
  WATCH_HISTORY_VIEW_STALE_TIME_MS,
} from '@/lib/query-invalidation';
import { searchGenrePath } from '@/lib/search-page-state';
import {
  cn,
  createObjectIdentity,
  formatSeasonEpisode,
  GENRE_LINK_CLASS,
  isSeriesLikeMediaType,
  mediaTypeLabel,
  pluralize,
  queryNeedsRetry,
  scrollBehavior,
  SIDEBAR_PAGE_COLUMN_INSETS,
} from '@/lib/utils';

const EPISODE_SKELETON_TILES = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => (
  <div
    key={`episode-skeleton-${index}`}
    className='aspect-video w-full rounded-lg border border-white/[0.06] bg-zinc-900/60 animate-pulse motion-reduce:animate-none'
  />
));

const ICON_ACTION_CLASS =
  'group/action flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/[0.1] bg-white/[0.06] text-white/75 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] transition-[background-color,border-color,color] duration-150 ease-out hover:border-white/[0.18] hover:bg-white/[0.1] hover:text-white not-aria-disabled:active:bg-white/[0.14] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/50 aria-disabled:cursor-default motion-reduce:transition-none';

const EPISODE_PAGE_BUTTON_CLASS =
  'flex h-9 w-9 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03] text-zinc-300 transition-colors duration-150 not-aria-disabled:hover:bg-white/[0.08] not-aria-disabled:hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 aria-disabled:cursor-default aria-disabled:opacity-35';

const DETAILS_COLUMN_CLASS = `mx-auto w-full max-w-6xl ${SIDEBAR_PAGE_COLUMN_INSETS}`;
const DETAILS_HERO_CLASS =
  'relative -mt-8 flex min-h-[70vh] w-full items-end pb-12 pt-24 lg:pb-16 lg:pt-28';
const DETAILS_STATUS_STRIP_CLASS =
  'inline-grid max-w-full grid-cols-2 gap-1 rounded-xl border border-white/[0.08] bg-white/[0.02] p-1 sm:inline-flex sm:flex-wrap';

function locationCoordinate(state: unknown, key: 'season' | 'episode'): number | null {
  const value = (state as Record<string, unknown> | null)?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

const getEpisodeListId = createObjectIdentity();

export function Details() {
  const { type, id } = useParams<{ type: string; id: string }>();

  return (
    <div className='min-h-[calc(100vh-2rem)] bg-background'>
      <DetailsContent key={`${type}-${id}`} />
    </div>
  );
}

function scrollToEpisodes() {
  document.getElementById('details-episodes-heading')?.focus({ preventScroll: true });
  document.getElementById('episodes-section')?.scrollIntoView({ behavior: scrollBehavior() });
}

function DetailsContent() {
  const { type, id } = useParams<{ type: string; id: string }>();
  const baseRouteType = type || 'series';
  const baseRouteId = id || '';
  const location = useLocation();
  const navigationType = useNavigationType();
  const queryClient = useQueryClient();
  // Playback preference writes must not re-render the whole page.
  const { preferences: spoilerProtection, isHydrating: isHydratingSpoilerProtection } =
    useAppUiPreferences((preferences) => preferences.spoilerProtection);

  // Observe late prefetch results without issuing a second metadata request.
  const { data: cardDetails } = useQuery({
    ...api.cardDetailsQueryOptions(baseRouteType, baseRouteId),
    enabled: false,
  });
  const {
    data: item,
    isFetched,
    isLoading,
    isFetching,
    isPaused,
    isPlaceholderData,
    error,
    errorUpdatedAt,
    dataUpdatedAt,
  } = useQuery({
    ...api.detailsQueryOptions(baseRouteType, baseRouteId),
    enabled: !!baseRouteId,
    // Card-prefetch bridge: paint the hero from hover intent's metadata-only
    // payload while the full episode payload lands.
    placeholderData: cardDetails,
  });
  // Keep the first offline notice mounted through manual and reconnect retries.
  const [hasPausedDetails, setHasPausedDetails] = useState(false);
  if (isPaused && dataUpdatedAt === 0 && !hasPausedDetails) setHasPausedDetails(true);

  // The OS taskbar still uses this in the frameless window.
  useDocumentTitle(item?.title);

  // The route id lets history load without waiting for addon metadata.
  const titleProgressQuery = useTitleWatchProgress(baseRouteId, {
    mediaType: baseRouteType,
    staleTime: WATCH_HISTORY_VIEW_STALE_TIME_MS,
  });
  const {
    data: titleProgress,
    isLoading: isLoadingWatchHistory,
    isFetching: isFetchingWatchHistory,
    refetch: retryWatchHistory,
  } = titleProgressQuery;
  const watchHistoryError = queryNeedsRetry(titleProgressQuery);
  const hasWatchProgress = Boolean(titleProgress);
  const episodeProgress = titleProgress?.episodeProgress;
  // `latestSeriesEntry` is the backend's first series-like row of the
  // `last_watched` DESC history list.
  const latestSeriesProgress = titleProgress?.latestSeriesEntry ?? null;

  const isSeriesLike = isSeriesLikeMediaType(item?.type);
  const isLoadingWatchHistoryForItem = isSeriesLike && isLoadingWatchHistory && !watchHistoryError;

  // The resumable row owns "Continue S/E" — the pane must hint the same season.
  // The latest history row only wins when nothing is resumable; Rust only
  // lists rows with a playable resume point here.
  const seriesProgress = isSeriesLike ? (titleProgress?.seriesResumeEntry ?? null) : null;
  const seriesCanResume = seriesProgress !== null;
  const seriesResumeSeason = seriesProgress?.absolute_season;
  const seriesResumeEpisode = seriesProgress?.absolute_episode;
  const resumeEpisodeCoords =
    seriesResumeSeason != null && seriesResumeEpisode != null
      ? { season: seriesResumeSeason, episode: seriesResumeEpisode }
      : null;

  const {
    watchStatus: detailsWatchStatus,
    watchStatusMutation,
    isInLibrary,
    isReady: isWatchStateReady,
    hasError: watchStateError,
    isFetching: isFetchingWatchState,
    refetch: retryWatchState,
  } = useDetailsWatchStatus(item, baseRouteId);
  const collectionActions = useMediaCollectionActions({ item, isInLibrary });
  const { toggleLibrary, addItemToNewList } = collectionActions;
  const savePendingLabel = watchStateError ? 'Saved state unavailable' : 'Loading saved state';
  const [saveOpen, setSaveOpen] = useState(false);
  const [createListOpen, setCreateListOpen] = useState(false);
  const saveTriggerRef = useRef<HTMLButtonElement>(null);

  // Season 0 (specials) is valid; only accept real numbers — `Number(null)`
  // would read a missing season as Specials.
  const locationSeason = locationCoordinate(location.state, 'season');
  const locationEpisode = locationCoordinate(location.state, 'episode');

  const heroBackdropSrc = item?.backdrop || item?.poster;
  // A painted logo stays put; an unpainted or failed one follows refetched metadata.
  const [loadedLogo, setLoadedLogo] = useState<string | null>(null);
  const [logoSrc, onLogoError] = useFailedSrc(loadedLogo ?? item?.logo);
  // Card placeholders often lack the logo; hold the title slot until full metadata decides.
  const titlePending = !logoSrc && isPlaceholderData && isFetching;
  const showTitleSkeleton = titlePending || (!!logoSrc && loadedLogo !== logoSrc);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [descriptionClamped, setDescriptionClamped] = useState(false);
  const [detailsSection, setDetailsSection] = useState<DetailsSection>('episodes');
  const creditsType = item ? creditsMediaType(item) : baseRouteType;
  const canEnrich = !isPlaceholderData && !!item && (isSeriesLike || creditsType === 'anime');
  const { anchorRef: creditsAnchorRef, nearViewport: creditsNearViewport } =
    useNearViewport(canEnrich);
  const { data: titleCredits } = useQuery({
    ...api.titleCreditsQueryOptions(creditsType, baseRouteId, item?.imdbId),
    enabled: canEnrich && creditsNearViewport,
  });
  const showEpisodes = () => {
    setDetailsSection('episodes');
    scrollToEpisodes();
  };
  const localToday = toLocalDate(useLocalDay()).toString();
  const descriptionRef = useRef<HTMLParagraphElement | null>(null);

  const {
    seasons,
    selectedSeason,
    seasonEpisodes,
    visibleEpisodes,
    episodeSearch,
    episodeSearchError,
    isEpisodeSearchFetching,
    isEpisodeSearchPending,
    retryEpisodeSearch,
    setEpisodeSearch,
    selectSeason,
    jumpToEpisode,
    shouldShowEpisodeSearch,
    episodeRangeLabel,
    totalEpisodeCount,
    totalEpisodePages,
    activeEpisodePageIndex,
    resumeEpisodePageIndex,
    visibleEpisodeStart,
    hasPreviousEpisodes,
    hasMoreEpisodes,
    changeEpisodePage,
    retainEpisodePosition,
  } = useDetailsEpisodePane({
    item,
    effectiveRouteId: baseRouteId,
    locationKey: location.key,
    locationSeason,
    locationEpisode,
    resumeSeason: resumeEpisodeCoords?.season ?? latestSeriesProgress?.absolute_season ?? undefined,
    resumeEpisode:
      resumeEpisodeCoords?.episode ?? latestSeriesProgress?.absolute_episode ?? undefined,
  });

  const hasEpisodesSection = isSeriesLike && (item?.episodes?.length ?? 0) > 0;

  // Rust owns the aired-by-local-day rule. Unknown or stale air states never
  // label episodes unaired and never enable bulk completion.
  const unairedScopeKey = [...detailsQueryKey(baseRouteType, baseRouteId), 'unaired-episodes'];
  const unairedEpisodesQuery = useQuery({
    queryKey: [...unairedScopeKey, localToday, item?.episodes && getEpisodeListId(item.episodes)],
    queryFn: async () => {
      const episodes = item!.episodes!;
      const indices = await api.getUnairedEpisodeIndices({
        releaseDates: episodes.map((ep) => ep.releaseDate ?? null),
        today: localToday,
      });
      return new Set(
        indices.map((index) =>
          episodeProgressKey(baseRouteId, episodes[index].season, episodes[index].episode),
        ),
      );
    },
    enabled: hasEpisodesSection && !isPlaceholderData,
    placeholderData: (previous, previousQuery) =>
      unairedScopeKey.every((part, index) => previousQuery?.queryKey[index] === part)
        ? previous
        : undefined,
    staleTime: Infinity,
    gcTime: DETAILS_GC_TIME_MS,
  });
  const { data: unairedEpisodeKeys, isPlaceholderData: isUnairedPlaceholder } =
    unairedEpisodesQuery;
  const airStatesReady = !!unairedEpisodeKeys && !isUnairedPlaceholder;

  // Home's Up Next rule: the aired successor of the furthest watched episode,
  // offered only while nothing is resumable. Rust picks both ends.
  const upNextSeason = titleProgress?.upNextSource?.absolute_season;
  const upNextEpisodeNumber = titleProgress?.upNextSource?.absolute_episode;
  const upNextQuery = useQuery({
    queryKey: [
      ...detailsQueryKey(baseRouteType, baseRouteId),
      'up-next',
      localToday,
      item?.episodes && getEpisodeListId(item.episodes),
      upNextSeason,
      upNextEpisodeNumber,
    ],
    queryFn: async () => {
      const { next } = await api.getEpisodeNavigation({
        episodes: item!.episodes!,
        season: upNextSeason!,
        episode: upNextEpisodeNumber!,
        today: localToday,
      });
      return next ?? null;
    },
    enabled:
      hasEpisodesSection &&
      !seriesCanResume &&
      !isPlaceholderData &&
      upNextSeason != null &&
      upNextEpisodeNumber != null,
    staleTime: Infinity,
    gcTime: DETAILS_GC_TIME_MS,
  });
  const upNextEpisode = upNextQuery.data ?? null;

  // "Read more" only exists when the clamp actually bites; while expanded the
  // last verdict is kept so "Show less" stays. Measured before paint so the hero never shifts.
  useLayoutEffect(() => {
    if (descriptionExpanded) return;
    const element = descriptionRef.current;
    if (!element) return;
    const measure = () => setDescriptionClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [item?.description, descriptionExpanded]);

  const markSeasonWatched = useMarkSeasonWatched({ item });
  const {
    mutate: mutateEpisodeWatched,
    isPending: episodeWatchedPending,
    variables: episodeWatchedVariables,
  } = useToggleEpisodeWatched({ item });
  const watchActionsBusy =
    toggleLibrary.isPending ||
    watchStatusMutation.isPending ||
    episodeWatchedPending ||
    markSeasonWatched.isPending;
  const pendingWatchedMutation = episodeWatchedPending
    ? episodeWatchedVariables
    : markSeasonWatched.isPending
      ? markSeasonWatched.variables
      : undefined;
  const pendingEpisodeKeys = new Set(
    pendingWatchedMutation?.episodes.map((ep) =>
      episodeProgressKey(baseRouteId, ep.season, ep.episode),
    ),
  );
  const optimisticEpisodeWatched = (ep: Episode) =>
    pendingEpisodeKeys.has(episodeProgressKey(baseRouteId, ep.season, ep.episode))
      ? pendingWatchedMutation?.watched
      : undefined;

  const isEpisodeWatched = (ep: Episode) =>
    optimisticEpisodeWatched(ep) ??
    !!episodeProgress?.[episodeProgressKey(baseRouteId, ep.season, ep.episode)]?.is_watched;
  // The resumable episode leads; otherwise Rust's aired successor of the furthest watched one.
  const nextUpEpisode = seriesCanResume ? resumeEpisodeCoords : upNextEpisode;
  const episodeEmphasis = (ep: Episode): EpisodeEmphasis =>
    nextUpEpisode && episodeMatchesCoordinates(ep, nextUpEpisode.season, nextUpEpisode.episode)
      ? seriesCanResume
        ? 'resume'
        : 'next'
      : null;

  const seasonWatchedCounts = new Map<number, number>();
  if (hasWatchProgress) {
    for (const ep of item?.episodes ?? []) {
      if (isEpisodeWatched(ep)) {
        seasonWatchedCounts.set(ep.season, (seasonWatchedCounts.get(ep.season) ?? 0) + 1);
      }
    }
  }

  const seasonWatchTargets: Episode[] = [];
  const seasonUnwatchTargets: Episode[] = [];
  const seasonRail: { key: string; state: SeasonEpisodeState }[] = [];
  let seasonWatchedCount = 0;
  let seasonHasStarted = false;
  for (const ep of seasonEpisodes) {
    const key = episodeProgressKey(baseRouteId, ep.season, ep.episode);
    if (isEpisodeWatched(ep)) {
      seasonWatchedCount += 1;
      seasonUnwatchTargets.push(ep);
      seasonRail.push({ key, state: 'watched' });
      continue;
    }
    const started = !!episodeProgress?.[key]?.has_started_watching;
    seasonHasStarted = seasonHasStarted || started;
    seasonRail.push({
      key,
      state: episodeEmphasis(ep)
        ? 'next'
        : started
          ? 'started'
          : unairedEpisodeKeys?.has(key)
            ? 'unaired'
            : 'unwatched',
    });
    if (unairedEpisodeKeys && !unairedEpisodeKeys.has(key)) seasonWatchTargets.push(ep);
  }
  // Once every aired episode is watched the season action reverses; a pending
  // mutation keeps its own direction so the label can't flip mid-write.
  const seasonActionMarksWatched = markSeasonWatched.isPending
    ? markSeasonWatched.variables.watched
    : !airStatesReady || seasonWatchTargets.length > 0;
  const seasonActionTargets = seasonActionMarksWatched ? seasonWatchTargets : seasonUnwatchTargets;

  const resumeEpisodeRef = useRef<HTMLButtonElement | null>(null);
  const episodeSearchInputRef = useRef<HTMLInputElement>(null);
  const episodeActionFocusRef = useRef<{
    button: HTMLButtonElement;
    target: 'resume' | 'heading' | 'search';
  } | null>(null);
  const holdEpisodeActionFocus = (
    button: Element | null,
    target: 'resume' | 'heading' | 'search',
  ) => {
    episodeActionFocusRef.current =
      button instanceof HTMLButtonElement && document.activeElement === button
        ? { button, target }
        : null;
  };
  useLayoutEffect(() => {
    const pending = episodeActionFocusRef.current;
    if (!pending) return;
    if (pending.button.isConnected) {
      if (document.activeElement !== pending.button) episodeActionFocusRef.current = null;
      return;
    }
    if (document.activeElement !== document.body) {
      episodeActionFocusRef.current = null;
      return;
    }
    const target =
      pending.target === 'resume'
        ? resumeEpisodeRef.current
        : pending.target === 'search'
          ? episodeSearchInputRef.current
          : document.getElementById('details-episodes-heading');
    if (!target) return;
    episodeActionFocusRef.current = null;
    target.focus({ preventScroll: true });
  });
  const {
    streamSelectorOpen,
    streamTarget,
    handleWatchMovie,
    openEpisodeStreamSelector,
    handleSelectorClose,
    handleSelectorClosed,
  } = useDetailsStreamSelector({
    item,
    isPlaceholderData,
    baseRouteType,
    baseRouteId,
    locationState: location.state,
    spoilerProtection,
    titleProgress,
  });

  const handleWatchEpisode = (ep: Episode) => {
    const epProgress = episodeProgress?.[episodeProgressKey(baseRouteId, ep.season, ep.episode)];
    openEpisodeStreamSelector(ep, epProgress?.resume_start_time);
  };

  const handlePlayEpisodeFromStart = (ep: Episode) =>
    openEpisodeStreamSelector(ep, PLAYER_RESTART_START_TIME);

  // Read through a ref so the handler stays stable for `EpisodeCard`'s memo.
  const seasonWatchTargetsRef = useRef(seasonWatchTargets);
  useLayoutEffect(() => {
    seasonWatchTargetsRef.current = seasonWatchTargets;
  });
  const firstUnwatchedEpisode = Math.min(...seasonWatchTargets.map((ep) => ep.episode));
  const { mutate: mutateSeasonWatched } = markSeasonWatched;
  const handleMarkWatchedThrough = (ep: Episode) => {
    if (watchActionsBusy) return;
    const episodes = seasonWatchTargetsRef.current.filter(
      (target) => target.season === ep.season && target.episode <= ep.episode,
    );
    if (!episodes.length) return;
    retainEpisodePosition();
    mutateSeasonWatched({
      episodes,
      watched: true,
      label: `Marked watched through E${ep.episode}`,
    });
  };

  // Destructured `mutate` keeps this stable — the mutation object is
  // re-allocated per render and would defeat `EpisodeCard`'s memo.
  const handleToggleEpisodeWatched = (ep: Episode) => {
    if (!item || !hasWatchProgress || watchActionsBusy) return;
    const epProgress = episodeProgress?.[episodeProgressKey(baseRouteId, ep.season, ep.episode)];
    retainEpisodePosition();
    mutateEpisodeWatched({
      episodes: [ep],
      watched: !epProgress?.is_watched,
    });
  };

  const primaryPlaybackHistoryEntry =
    item?.type === 'movie' ? (titleProgress?.movieResumeEntry ?? null) : seriesProgress;

  const resumePercent = primaryPlaybackHistoryEntry
    ? getWatchProgressPercent(
        primaryPlaybackHistoryEntry.position,
        primaryPlaybackHistoryEntry.duration,
      )
    : 0;
  const resumeRemaining =
    primaryPlaybackHistoryEntry && resumePercent > 0
      ? formatWatchRemaining(
          primaryPlaybackHistoryEntry.position,
          primaryPlaybackHistoryEntry.duration,
        )
      : null;

  const primaryPlayback = useMediaPrimaryPlayback({
    from: `${location.pathname}${location.search}`,
    historyEntry: primaryPlaybackHistoryEntry,
    item,
    onPlayMovieWithoutHistory: item?.type === 'movie' ? handleWatchMovie : undefined,
    onSelectEpisode: isSeriesLike
      ? upNextEpisode
        ? () => void openEpisodeStreamSelector(upNextEpisode)
        : showEpisodes
      : undefined,
    surface: 'details',
  });

  // The play button's resume branch needs the title-progress read.
  const historyUnavailable =
    !primaryPlayback.canReturnToActivePlayer && !titleProgress && watchHistoryError;
  const historyPending =
    !primaryPlayback.canReturnToActivePlayer &&
    !titleProgress &&
    (isLoadingWatchHistory || isFetchingWatchHistory);
  const episodeActionPending =
    !primaryPlayback.canReturnToActivePlayer &&
    !primaryPlaybackHistoryEntry &&
    isSeriesLike &&
    isPlaceholderData;
  const hasNoSeriesResume =
    isSeriesLike && !primaryPlaybackHistoryEntry && !primaryPlayback.canReturnToActivePlayer;
  const upNextPending =
    hasNoSeriesResume &&
    !!titleProgress?.upNextSource &&
    !upNextEpisode &&
    (isPlaceholderData || upNextQuery.isLoading);
  const primaryActionPending =
    primaryPlayback.isResolvingPrimaryAction ||
    historyPending ||
    episodeActionPending ||
    upNextPending;
  const upNextTarget = hasNoSeriesResume ? upNextEpisode : null;
  const upNextUnavailable =
    hasNoSeriesResume && !!titleProgress?.upNextSource && upNextQuery.isError && !upNextEpisode;
  const primaryActionSelectsEpisode =
    hasNoSeriesResume && !upNextTarget && !upNextPending && !historyPending;

  const handleRetryDetails = async () => {
    if (!baseRouteId || isFetching) return;
    const filters = { queryKey: detailsQueryKey(baseRouteType, baseRouteId) };
    await queryClient.cancelQueries(filters, { revert: true });
    await queryClient.invalidateQueries(filters);
  };

  // Only explicit episode links scroll the page; browsing and Back keep their position.
  const centeredEpisodeLandingRef = useRef<string | null>(null);
  const autoCenterNavigationRef = useRef({ key: location.key, type: navigationType });
  useEffect(() => {
    const landing = autoCenterNavigationRef.current;
    if (landing.key !== location.key) {
      // The player's POP handoff clears route state with a same-page REPLACE.
      if (navigationType !== NavigationType.Replace) {
        landing.type = navigationType;
        centeredEpisodeLandingRef.current = null;
      }
      landing.key = location.key;
    }
    if (landing.type === NavigationType.Pop || locationSeason === null || locationEpisode === null)
      return;
    if (selectedSeason !== locationSeason) return;
    if (isPlaceholderData || episodeSearch.trim()) return;
    const episodeButton = document.querySelector<HTMLButtonElement>(
      `#details-episodes-grid [data-episode-season="${locationSeason}"][data-episode-number="${locationEpisode}"]`,
    );
    if (!episodeButton) return;
    const landingKey = episodeProgressKey(baseRouteId, locationSeason, locationEpisode);
    if (centeredEpisodeLandingRef.current === landingKey) return;

    const intentListeners = new AbortController();
    const timer = window.setTimeout(() => {
      intentListeners.abort();
      centeredEpisodeLandingRef.current = landingKey;
      episodeButton.scrollIntoView({
        block: 'center',
        behavior: scrollBehavior(),
      });
    }, 80);
    const cancelCentering = () => {
      centeredEpisodeLandingRef.current = landingKey;
      window.clearTimeout(timer);
      intentListeners.abort();
    };
    for (const eventName of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) {
      window.addEventListener(eventName, cancelCentering, {
        capture: true,
        passive: true,
        signal: intentListeners.signal,
      });
    }

    return () => {
      window.clearTimeout(timer);
      intentListeners.abort();
    };
  }, [
    visibleEpisodes,
    selectedSeason,
    isPlaceholderData,
    episodeSearch,
    baseRouteId,
    location.key,
    locationSeason,
    locationEpisode,
    navigationType,
  ]);

  const showOfflineDetails =
    dataUpdatedAt === 0 && (isPaused || (hasPausedDetails && errorUpdatedAt === 0));

  if (isLoading && errorUpdatedAt === 0 && !showOfflineDetails) return <DetailsSkeleton />;

  if ((showOfflineDetails || error || (isFetched && isLoading)) && !item) {
    const missingAddon = !showOfflineDetails && isNoCapableAddonError(error);
    return (
      <div
        role='alert'
        className={`${DETAILS_COLUMN_CLASS} min-h-[75vh] flex flex-col items-center justify-center gap-3 text-center`}
      >
        <Clapperboard className='w-10 h-10 text-zinc-600 opacity-40' />
        <p className='text-lg font-semibold text-white'>
          {showOfflineDetails ? "You're offline" : "Couldn't load this title"}
        </p>
        <p className='text-sm text-zinc-500 max-w-sm leading-relaxed'>
          {showOfflineDetails
            ? 'Reconnect to load this title, or try again.'
            : missingAddon
              ? getErrorMessage(error)
              : 'The details request failed — check your connection, then try again.'}
        </p>
        {missingAddon ? (
          <Button variant='outline' className='mt-1 h-9 rounded-md px-4' asChild>
            <Link to='/settings?section=addons'>Manage addons</Link>
          </Button>
        ) : (
          <Button
            variant='outline'
            onClick={() => void handleRetryDetails()}
            aria-disabled={isFetching || undefined}
            aria-busy={isFetching}
            className='mt-1 h-9 rounded-md px-4 aria-disabled:cursor-wait aria-disabled:opacity-50'
          >
            <RotateCcw
              className={cn('h-4 w-4', isFetching && 'animate-spin motion-reduce:animate-none')}
            />
            Retry
          </Button>
        )}
      </div>
    );
  }

  if (!item) {
    return (
      <div
        className={`${DETAILS_COLUMN_CLASS} min-h-[75vh] flex flex-col items-center justify-center gap-3 text-center`}
      >
        <p className='text-lg font-semibold text-white'>Title not found</p>
        <p className='text-sm text-zinc-500 max-w-sm text-center'>
          This title may have been removed or the link is incomplete.
        </p>
        <Button variant='outline' className='mt-1 h-9 rounded-md px-4' asChild>
          <Link to='/'>Back to home</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className='relative pb-20 page-enter'>
      <ScrollToTop />
      <div className={DETAILS_HERO_CLASS}>
        <div
          ref={claimDetailsHero}
          className='absolute inset-0 z-0 overflow-hidden'
          aria-hidden='true'
          style={{
            background:
              'radial-gradient(80% 90% at 65% 20%, rgb(var(--accent-art-rgb) / 0.14), transparent 75%)',
          }}
        >
          <div className='absolute inset-0 bg-linear-to-t from-background via-background/70 to-background/10 z-10' />
          <div className='absolute inset-0 bg-linear-to-r from-background/80 via-background/20 to-transparent z-10' />
          <div className='details-hero-vignette absolute inset-0 z-10' />
          {heroBackdropSrc && (
            <RemoteImage
              src={heroBackdropSrc}
              fallbackSrc={item.poster}
              alt=''
              className='details-hero-drift w-full h-full object-cover'
              fadeIn
              loading='eager'
              fetchPriority='high'
              style={{ objectPosition: 'center 20%' }}
            />
          )}
        </div>

        <div className={`${DETAILS_COLUMN_CLASS} relative z-20 flex flex-col`}>
          <div className='flex flex-col gap-6 w-full max-w-4xl'>
            {(error || showOfflineDetails) && (
              <RetryBanner
                message={
                  showOfflineDetails
                    ? "You're offline. Reconnect to load the rest of this title."
                    : "Couldn't refresh this title. Showing the saved details."
                }
                onRetry={() => void handleRetryDetails()}
                isRetrying={isFetching}
              />
            )}
            <div className='space-y-6 w-full'>
              <div>
                <div className='relative mb-5 flex min-h-24 items-center md:min-h-32'>
                  <h1
                    className={
                      logoSrc || titlePending
                        ? 'sr-only'
                        : 'w-full wrap-break-word text-[32px] font-semibold leading-[1.1] tracking-[-0.035em] text-white drop-shadow-lg animate-in fade-in duration-300 motion-reduce:animate-none sm:text-5xl lg:text-6xl'
                    }
                  >
                    {item.title}
                  </h1>
                  {showTitleSkeleton && (
                    <Skeleton
                      aria-hidden='true'
                      className='h-16 w-80 max-w-full bg-zinc-800/60 md:h-20'
                    />
                  )}
                  {logoSrc && (
                    <RemoteImage
                      src={logoSrc}
                      alt=''
                      className='absolute inset-0 h-full max-h-24 w-full object-contain object-left drop-shadow-2xl md:max-h-32'
                      fadeIn
                      loading='eager'
                      fetchPriority='high'
                      onLoad={() => setLoadedLogo(logoSrc)}
                      onError={onLogoError}
                    />
                  )}
                </div>

                <div className='flex flex-wrap items-center gap-x-3 gap-y-2 text-sm font-medium text-white/85'>
                  {item.displayYear && (
                    <span className='whitespace-nowrap tabular-nums'>{item.displayYear}</span>
                  )}
                  <span className='inline-flex items-center gap-3 whitespace-nowrap'>
                    {item.displayYear && (
                      <span aria-hidden='true' className='text-white/25'>
                        ·
                      </span>
                    )}
                    {hasEpisodesSection && seasons.length > 0
                      ? pluralize(seasons.length, 'Season')
                      : mediaTypeLabel(item.type)}
                  </span>

                  {item.runtime && (
                    <span className='inline-flex items-center gap-3 whitespace-nowrap'>
                      <span aria-hidden='true' className='text-white/25'>
                        ·
                      </span>
                      <span className='tabular-nums'>{item.runtime}</span>
                    </span>
                  )}

                  {item.rating && (
                    <span className='inline-flex items-center gap-3 whitespace-nowrap'>
                      <span aria-hidden='true' className='text-white/25'>
                        ·
                      </span>
                      <span className='inline-flex items-baseline gap-1.5'>
                        <Star
                          aria-hidden='true'
                          className='h-4 w-4 translate-y-[2px] fill-amber-400 text-amber-400'
                        />
                        <span className='text-[15px] font-semibold tabular-nums text-white'>
                          {item.rating}
                        </span>
                        <span className='text-xs font-medium tabular-nums text-white/35'>/10</span>
                      </span>
                    </span>
                  )}

                  {item.country && (
                    <span className='inline-flex min-w-0 max-w-full items-center gap-3'>
                      <span aria-hidden='true' className='text-white/25'>
                        ·
                      </span>
                      <span className='min-w-0 break-words'>{item.country}</span>
                    </span>
                  )}
                  {titleCredits?.nextAiringEpisode && (
                    <NextAiringChip
                      key={titleCredits.nextAiringEpisode.airingAt}
                      episode={titleCredits.nextAiringEpisode}
                    />
                  )}
                </div>
                {item.awards && (
                  <p className='mt-2 max-w-2xl break-words text-[13px] leading-5 text-zinc-400'>
                    <span className='font-medium text-zinc-300'>Awards: </span>
                    {item.awards}
                  </p>
                )}
                {item.genres && item.genres.length > 0 && (
                  <div className='mt-3 flex flex-wrap items-center gap-1.5'>
                    {item.genres.slice(0, 3).map((genre) => (
                      <Link
                        key={genre}
                        to={searchGenrePath(baseRouteType, genre)}
                        title={`Browse ${genre}`}
                        className={GENRE_LINK_CLASS}
                      >
                        {genre}
                      </Link>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <p
                  id='details-description'
                  ref={descriptionRef}
                  className={cn(
                    'max-w-2xl text-pretty break-words text-[14px] font-normal leading-6 text-zinc-300 md:text-[15px] md:leading-[1.7]',
                    !descriptionExpanded && 'line-clamp-3 md:line-clamp-4',
                  )}
                >
                  {item.description}
                </p>
                {(descriptionClamped || descriptionExpanded) && (
                  <button
                    type='button'
                    onClick={() => setDescriptionExpanded((v) => !v)}
                    aria-expanded={descriptionExpanded}
                    aria-controls='details-description'
                    className='mt-1 inline-flex min-h-8 items-center rounded-md px-1 text-[13px] font-medium text-white/65 transition-colors duration-150 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40'
                  >
                    {descriptionExpanded ? 'Show less' : 'Read more'}
                  </button>
                )}
                <DetailsCredits
                  cast={item.cast}
                  directors={item.directors}
                  writers={item.writers}
                />
              </div>

              <div className='flex flex-wrap items-center gap-2.5 pt-2'>
                <button
                  type='button'
                  className='group rounded-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black aria-disabled:cursor-default'
                  aria-disabled={primaryActionPending || undefined}
                  aria-busy={primaryActionPending || undefined}
                  aria-controls={
                    primaryActionSelectsEpisode && !isPlaceholderData
                      ? 'episodes-section'
                      : undefined
                  }
                  onClick={() => {
                    if (primaryActionPending) return;
                    if (historyUnavailable) void retryWatchHistory();
                    else void primaryPlayback.handlePrimaryAction();
                  }}
                >
                  <span className='flex h-11 min-w-40 items-center justify-center gap-2 rounded-lg bg-white px-5 text-black shadow-[0_1px_2px_rgb(0_0_0/0.35),0_6px_18px_-10px_rgb(255_255_255/0.16),inset_0_1px_0_rgb(255_255_255/0.9),inset_0_-1px_0_rgb(0_0_0/0.08)] transition-[background-color,box-shadow,opacity] duration-200 ease-out group-hover:bg-zinc-100 group-hover:shadow-[0_1px_2px_rgb(0_0_0/0.35),0_8px_22px_-10px_rgb(255_255_255/0.22),inset_0_1px_0_rgb(255_255_255/0.9),inset_0_-1px_0_rgb(0_0_0/0.08)] group-not-aria-disabled:group-active:bg-zinc-200 group-not-aria-disabled:group-active:shadow-[0_1px_1px_rgb(0_0_0/0.3),inset_0_1px_2px_rgb(0_0_0/0.08)] group-aria-disabled:opacity-80 motion-reduce:transition-none'>
                    {primaryPlayback.showResolvingFeedback ? (
                      <Loader2
                        aria-hidden='true'
                        className='w-5 h-5 animate-spin motion-reduce:animate-none'
                      />
                    ) : historyUnavailable ? (
                      <RotateCcw aria-hidden='true' className='w-5 h-5' />
                    ) : primaryActionSelectsEpisode ? (
                      <ListVideo aria-hidden='true' className='w-5 h-5' />
                    ) : (
                      <Play
                        aria-hidden='true'
                        className='w-5 h-5 fill-current transition-transform duration-200 ease-out group-hover:translate-x-0.5 motion-reduce:transition-none'
                      />
                    )}
                    {/* Unknown history must not flash a label it is about to replace. */}
                    <span
                      className={cn(
                        'text-sm font-semibold tracking-tight',
                        historyPending && 'invisible',
                      )}
                    >
                      {historyUnavailable
                        ? 'Retry watch progress'
                        : primaryActionSelectsEpisode
                          ? 'Choose episode'
                          : upNextTarget
                            ? `Play ${formatSeasonEpisode(upNextTarget.season, upNextTarget.episode)}`
                            : upNextPending
                              ? 'Play next'
                              : primaryPlayback.primaryActionLabel}
                    </span>
                  </span>
                </button>

                <div className='flex flex-wrap gap-2.5'>
                  <Popover
                    open={saveOpen}
                    onOpenChange={(open) => {
                      if (!open || isWatchStateReady) setSaveOpen(open);
                    }}
                  >
                    <PopoverTrigger asChild>
                      <button
                        ref={saveTriggerRef}
                        type='button'
                        aria-label={
                          !isWatchStateReady
                            ? savePendingLabel
                            : isInLibrary
                              ? 'Saved — manage library and lists'
                              : 'Save to library or list'
                        }
                        aria-disabled={!isWatchStateReady || undefined}
                        aria-busy={
                          watchActionsBusy || (!isWatchStateReady && !watchStateError) || undefined
                        }
                        title={
                          !isWatchStateReady ? savePendingLabel : isInLibrary ? 'Saved' : 'Save'
                        }
                        className={cn(
                          ICON_ACTION_CLASS,
                          'w-auto min-w-24 gap-2 px-3',
                          isInLibrary &&
                            'border-white/30 bg-white/15 text-white hover:border-white/40 hover:bg-white/20',
                        )}
                      >
                        <SaveIndicator saved={isInLibrary} className='size-5' />
                        <span className='min-w-9 text-left text-[13px] font-medium'>
                          {isInLibrary ? 'Saved' : 'Save'}
                        </span>
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      align='start'
                      sideOffset={8}
                      aria-label='Save to'
                      className='w-72 rounded-xl border-white/10 bg-zinc-950/95 p-1.5 shadow-2xl'
                    >
                      <h2 className='px-2.5 pb-1.5 pt-2 text-sm font-semibold text-white'>
                        Save to
                      </h2>
                      <SaveToCollectionPanel
                        item={item}
                        isInLibrary={isInLibrary}
                        showLibrary
                        libraryBusy={watchActionsBusy || !isWatchStateReady}
                        actions={collectionActions}
                        onCreateList={() => {
                          setSaveOpen(false);
                          setCreateListOpen(true);
                        }}
                      />
                    </PopoverContent>
                  </Popover>
                  <CreateListDialog
                    open={createListOpen}
                    onOpenChange={setCreateListOpen}
                    onCreated={addItemToNewList}
                    returnFocusRef={saveTriggerRef}
                  />

                  {item.trailers && item.trailers.length > 0 && (
                    <DetailsTrailer
                      trailers={item.trailers}
                      title={item.title}
                      triggerClassName={ICON_ACTION_CLASS}
                    />
                  )}

                  <CopyButton
                    key={`${baseRouteType}:${baseRouteId}`}
                    aria-label='Copy link to this title'
                    title='Copy link'
                    className={cn(ICON_ACTION_CLASS, '[&>span]:size-5')}
                    onCopy={() =>
                      copyText(buildTitleShareLink(baseRouteType, baseRouteId), {
                        failure: 'Could not copy title link',
                      })
                    }
                  />
                </div>

                {resumeRemaining && (
                  <div className='flex basis-full items-center gap-2.5 pt-1 animate-in fade-in duration-200 motion-reduce:animate-none'>
                    <div className='h-[3px] w-32 overflow-hidden rounded-full bg-white/15'>
                      <div
                        className='h-full rounded-full bg-(--accent-prog) transition-[width] duration-500 ease-out motion-reduce:transition-none'
                        style={{ width: `${resumePercent}%` }}
                      />
                    </div>
                    <span className='text-[12px] font-medium tabular-nums text-white/60'>
                      {resumeRemaining}
                    </span>
                  </div>
                )}
              </div>

              {upNextUnavailable && (
                <RetryBanner
                  className='max-w-xl px-3 py-2'
                  message="Couldn't find the next episode. You can still choose one below."
                  isRetrying={upNextQuery.isFetching}
                  onRetry={() => void upNextQuery.refetch()}
                />
              )}
              {watchStateError && (
                <RetryBanner
                  className='max-w-xl px-3 py-2'
                  message="Couldn't load library or status."
                  isRetrying={isFetchingWatchState}
                  onRetry={() => void retryWatchState()}
                />
              )}
              <div className='flex flex-col items-start gap-2 pt-5'>
                <span
                  id='details-watch-status-label'
                  className='text-[13px] font-semibold text-zinc-200'
                >
                  My status
                  {watchStatusMutation.isPending && (
                    <span
                      role='status'
                      className='delayed-fade-in ml-2 text-[11px] font-normal text-zinc-400 motion-reduce:animate-none'
                    >
                      Saving…
                    </span>
                  )}
                </span>
                <div
                  className={DETAILS_STATUS_STRIP_CLASS}
                  role='group'
                  aria-labelledby='details-watch-status-label'
                  aria-busy={
                    watchActionsBusy || (!isWatchStateReady && !watchStateError) || undefined
                  }
                >
                  {WATCH_STATUSES.map((status) => {
                    const isActive = detailsWatchStatus === status;
                    const colors = WATCH_STATUS_COLORS[status];
                    return (
                      <button
                        key={status}
                        type='button'
                        // aria-disabled, not disabled: disabled drops keyboard focus to <body> mid-mutation.
                        aria-disabled={watchActionsBusy || !isWatchStateReady || undefined}
                        aria-pressed={
                          isWatchStateReady || watchStatusMutation.isPending ? isActive : undefined
                        }
                        title={isActive ? 'Clear status' : undefined}
                        onClick={() => {
                          if (!watchActionsBusy && isWatchStateReady) {
                            watchStatusMutation.mutate(isActive ? null : status);
                          }
                        }}
                        className={cn(
                          'group/status flex min-h-9 min-w-0 shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[12px] font-medium transition-[background-color,border-color,color,transform] duration-150 ease-out not-aria-disabled:active:scale-[0.98] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 aria-disabled:cursor-default sm:gap-2 sm:px-2.5 sm:text-[13px] motion-reduce:transition-none motion-reduce:active:scale-100',
                          isActive
                            ? cn(
                                'text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.07)]',
                                colors.bg,
                                colors.border,
                              )
                            : 'border-transparent text-zinc-300 not-aria-disabled:hover:border-white/10 not-aria-disabled:hover:bg-white/[0.06] not-aria-disabled:hover:text-white',
                        )}
                      >
                        <WatchStatusIcon
                          status={status}
                          className={cn(
                            'size-4 transition-opacity duration-150 motion-reduce:transition-none',
                            isActive || !detailsWatchStatus
                              ? 'opacity-100'
                              : 'opacity-70 group-not-aria-disabled/status:group-hover/status:opacity-100',
                          )}
                        />
                        <span className='min-w-0 whitespace-normal text-left leading-4 sm:whitespace-nowrap'>
                          {WATCH_STATUS_LABELS[status]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {(isSeriesLike || canEnrich) && (
        <div
          id='episodes-section'
          ref={creditsAnchorRef}
          className={cn(
            DETAILS_COLUMN_CLASS,
            (isSeriesLike || titleCredits?.source || item.runtime) && 'pt-5 pb-8',
          )}
        >
          <DetailsSections
            item={item}
            credits={titleCredits}
            value={detailsSection}
            onValueChange={setDetailsSection}
            hasEpisodes={isSeriesLike}
            allowExtras={!isPlaceholderData}
          >
            {hasEpisodesSection && (
              <div className='w-full flex flex-col gap-4'>
                {seasons.length > 1 && (
                  <SeasonSwitcher
                    seasons={seasons}
                    activeSeason={selectedSeason}
                    watchedCounts={seasonWatchedCounts}
                    onSelectSeason={selectSeason}
                  />
                )}
                <div
                  id='details-episodes-panel'
                  className='min-w-0 space-y-3'
                  // Panel semantics only exist while the season tablist renders.
                  role={seasons.length > 1 ? 'tabpanel' : undefined}
                  aria-labelledby={
                    seasons.length > 1 && selectedSeason !== null
                      ? `season-tab-${selectedSeason}`
                      : undefined
                  }
                >
                  {watchHistoryError && !hasWatchProgress && (
                    <RetryBanner
                      className='px-3 py-2'
                      message="Couldn't load watch history. Retry to change episode completion."
                      onRetry={() => void retryWatchHistory()}
                      isRetrying={isFetchingWatchHistory}
                    />
                  )}
                  {queryNeedsRetry(unairedEpisodesQuery) && (
                    <RetryBanner
                      className='px-3 py-2'
                      message="Couldn't check episode air dates. Retry to mark the season watched."
                      onRetry={() => void unairedEpisodesQuery.refetch()}
                      isRetrying={unairedEpisodesQuery.isFetching}
                    />
                  )}
                  {shouldShowEpisodeSearch && (
                    <SearchInput
                      inputRef={episodeSearchInputRef}
                      placeholder='Search episodes…'
                      aria-label='Search episodes'
                      value={episodeSearch}
                      onValueChange={setEpisodeSearch}
                      clearLabel='Clear episode search'
                      onSubmit={() => {
                        if (isEpisodeSearchPending || episodeSearchError || !visibleEpisodes.length)
                          return;
                        document
                          .querySelector<HTMLButtonElement>('#details-episodes-grid button')
                          ?.focus();
                      }}
                      className='h-9 bg-white/[0.04] border-white/10 text-sm text-white placeholder:text-zinc-500 focus-visible:ring-white/20 focus-visible:border-white/20 rounded-lg'
                    />
                  )}
                  {episodeSearchError && (
                    <RetryBanner
                      className='px-3 py-2'
                      message='Search failed.'
                      isRetrying={isEpisodeSearchFetching}
                      onRetry={retryEpisodeSearch}
                    />
                  )}
                  <div className='flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2'>
                    <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2'>
                      <p
                        aria-live='polite'
                        className='text-[12px] font-medium tabular-nums text-zinc-400'
                      >
                        {episodeRangeLabel}
                        {visibleEpisodeStart > 0 && (
                          <span className='text-zinc-500'>{` of ${totalEpisodeCount}`}</span>
                        )}
                      </p>
                      {hasWatchProgress && (seasonWatchedCount > 0 || seasonHasStarted) && (
                        <SeasonProgressRail
                          segments={seasonRail}
                          watchedCount={seasonWatchedCount}
                        />
                      )}
                      {resumeEpisodeCoords &&
                        (selectedSeason !== resumeEpisodeCoords.season ||
                          (resumeEpisodePageIndex !== null &&
                            activeEpisodePageIndex !== resumeEpisodePageIndex) ||
                          episodeSearch.trim().length > 0) && (
                          <button
                            type='button'
                            onClick={(event) => {
                              holdEpisodeActionFocus(event.currentTarget, 'resume');
                              jumpToEpisode(
                                resumeEpisodeCoords.season,
                                resumeEpisodeCoords.episode,
                              );
                            }}
                            className='accent-lattice-soft flex h-8 items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium transition-colors duration-150 hover:brightness-125 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/30'
                          >
                            <RotateCcw aria-hidden='true' className='h-3.5 w-3.5' />
                            Jump to{' '}
                            {formatSeasonEpisode(
                              resumeEpisodeCoords.season,
                              resumeEpisodeCoords.episode,
                            )}
                          </button>
                        )}
                      {!isLoadingWatchHistoryForItem &&
                        (seasonActionTargets.length > 0 || markSeasonWatched.isPending) && (
                          <button
                            type='button'
                            aria-disabled={
                              !hasWatchProgress || !airStatesReady || watchActionsBusy || undefined
                            }
                            aria-busy={markSeasonWatched.isPending || undefined}
                            onClick={(event) => {
                              if (hasWatchProgress && airStatesReady && !watchActionsBusy) {
                                holdEpisodeActionFocus(event.currentTarget, 'heading');
                                retainEpisodePosition();
                                markSeasonWatched.mutate({
                                  episodes: seasonActionTargets,
                                  watched: seasonActionMarksWatched,
                                });
                              }
                            }}
                            className='flex h-8 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-zinc-400 transition-colors duration-150 not-aria-disabled:hover:bg-white/[0.06] not-aria-disabled:hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/30 aria-disabled:cursor-default aria-disabled:opacity-60'
                          >
                            <Check aria-hidden='true' className='h-3.5 w-3.5' strokeWidth={2.5} />
                            {seasonActionMarksWatched
                              ? 'Mark season watched'
                              : 'Mark season unwatched'}
                          </button>
                        )}
                    </div>

                    {totalEpisodePages > 1 && (
                      <div
                        className='ml-auto flex shrink-0 items-center gap-2'
                        role='group'
                        aria-label='Episode pages'
                      >
                        <button
                          type='button'
                          // aria-disabled, not disabled: an edge page would drop the focused button to <body>.
                          aria-disabled={!hasPreviousEpisodes || undefined}
                          onClick={() => {
                            if (hasPreviousEpisodes) changeEpisodePage('previous');
                          }}
                          className={EPISODE_PAGE_BUTTON_CLASS}
                          aria-label='Show previous episodes'
                        >
                          <ChevronLeft className='h-4 w-4' />
                        </button>
                        <div className='min-w-[64px] text-center text-[12px] text-zinc-400 tabular-nums'>
                          {activeEpisodePageIndex + 1} / {totalEpisodePages}
                        </div>
                        <button
                          type='button'
                          aria-disabled={!hasMoreEpisodes || undefined}
                          onClick={() => {
                            if (hasMoreEpisodes) changeEpisodePage('next');
                          }}
                          className={EPISODE_PAGE_BUTTON_CLASS}
                          aria-label='Show next episodes'
                        >
                          <ChevronRight className='h-4 w-4' />
                        </button>
                      </div>
                    )}
                  </div>

                  {isLoadingWatchHistoryForItem && (
                    <span role='status' className='sr-only'>
                      Loading episode watch history...
                    </span>
                  )}
                  <div
                    id='details-episodes-grid'
                    aria-busy={
                      isLoadingWatchHistoryForItem ||
                      (!episodeSearchError && isEpisodeSearchPending)
                    }
                    className='grid grid-cols-1 gap-4 pb-2 sm:grid-cols-2 lg:grid-cols-3'
                  >
                    {!episodeSearchError &&
                    visibleEpisodes.length === 0 &&
                    isEpisodeSearchPending ? (
                      <div
                        role='status'
                        className='col-span-full flex flex-col items-center gap-3 py-14 text-center'
                      >
                        <p className='text-sm text-zinc-400'>Searching episodes…</p>
                      </div>
                    ) : !episodeSearchError &&
                      visibleEpisodes.length === 0 &&
                      episodeSearch.trim() ? (
                      <div className='col-span-full flex flex-col items-center gap-3 py-14 text-center'>
                        <p role='status' className='text-sm text-zinc-400'>
                          No episodes match &ldquo;
                          {episodeSearch}&rdquo;
                        </p>
                        <button
                          type='button'
                          onClick={(event) => {
                            holdEpisodeActionFocus(event.currentTarget, 'search');
                            setEpisodeSearch('');
                          }}
                          className='h-8 rounded-md border border-white/[0.08] bg-white/[0.04] px-3 text-[12.5px] font-medium text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25'
                        >
                          Clear search
                        </button>
                      </div>
                    ) : (
                      visibleEpisodes.map((ep) => {
                        const episodeKey = episodeProgressKey(baseRouteId, ep.season, ep.episode);
                        const epProgress = hasWatchProgress
                          ? episodeProgress?.[episodeKey]
                          : undefined;
                        const optimisticWatched = hasWatchProgress
                          ? optimisticEpisodeWatched(ep)
                          : undefined;
                        const progressPercent =
                          optimisticWatched !== undefined
                            ? optimisticWatched
                              ? 100
                              : 0
                            : getWatchProgressPercent(
                                epProgress?.position ?? 0,
                                epProgress?.duration ?? 0,
                              );
                        const emphasis = episodeEmphasis(ep);
                        const isWatched = optimisticWatched ?? !!epProgress?.is_watched;
                        const remainingText =
                          epProgress && !isWatched && epProgress.has_started_watching
                            ? formatWatchRemaining(epProgress.position, epProgress.duration)
                            : null;

                        return (
                          <EpisodeCard
                            key={`${ep.id}:${ep.season}:${ep.episode}`}
                            episode={ep}
                            emphasis={emphasis}
                            isSpoiler={isEpisodeSpoiler(
                              ep,
                              isHydratingSpoilerProtection || spoilerProtection,
                              titleProgress?.watchedEpisodeCeiling,
                              epProgress,
                            )}
                            isWatched={isWatched}
                            isAired={!unairedEpisodeKeys?.has(episodeKey)}
                            isWatchedDisabled={watchActionsBusy}
                            isWatchedPending={pendingEpisodeKeys.has(episodeKey)}
                            progressPercent={progressPercent}
                            remainingText={remainingText}
                            resumeRef={emphasis === 'resume' ? resumeEpisodeRef : undefined}
                            shareLink={buildEpisodeShareLink(
                              baseRouteType,
                              baseRouteId,
                              ep.season,
                              ep.episode,
                            )}
                            onPlay={handleWatchEpisode}
                            onPlayFromStart={handlePlayEpisodeFromStart}
                            onToggleWatched={
                              hasWatchProgress ? handleToggleEpisodeWatched : undefined
                            }
                            onMarkWatchedThrough={
                              hasWatchProgress &&
                              airStatesReady &&
                              firstUnwatchedEpisode < ep.episode
                                ? handleMarkWatchedThrough
                                : undefined
                            }
                          />
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            )}

            {!hasEpisodesSection && !isPlaceholderData && isSeriesLike && (
              <section
                tabIndex={-1}
                aria-label='Episode information unavailable'
                className='rounded-xl focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/30'
              >
                <RetryBanner
                  message='Episode information unavailable.'
                  isRetrying={isFetching}
                  onRetry={() => {
                    holdEpisodeActionFocus(document.activeElement, 'heading');
                    void handleRetryDetails();
                  }}
                />
              </section>
            )}

            {/* Shimmer the episode grid while the card placeholder's hero is up. */}
            {!hasEpisodesSection && isPlaceholderData && isSeriesLike && (
              <div className='flex flex-col gap-4' aria-hidden='true'>
                <Skeleton className='h-9 w-full max-w-md rounded-lg bg-zinc-800/40' />
                <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
                  {EPISODE_SKELETON_TILES}
                </div>
              </div>
            )}
          </DetailsSections>
        </div>
      )}

      <DetailsSimilarTitles item={item} contentInsetsClassName={DETAILS_COLUMN_CLASS} />

      {streamTarget && (
        <StreamSelector
          open={streamSelectorOpen}
          onClose={handleSelectorClose}
          onClosed={handleSelectorClosed}
          target={streamTarget}
          getStartTime={() => streamTarget.startTime}
        />
      )}
    </div>
  );
}
