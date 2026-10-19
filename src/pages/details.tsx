import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Star,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigationType, useParams } from 'react-router';
import { EpisodeCard, isEpisodeSpoiler } from '@/components/details-episode-card';
import { SeasonSwitcher } from '@/components/details-season-switcher';
import { DetailsSimilarTitles } from '@/components/details-similar-titles';
import { DetailsTrailerDialog } from '@/components/details-trailer-dialog';
import { CreateListDialog } from '@/components/list/list-editor-dialog';
import { SaveToCollectionPanel } from '@/components/list/save-to-collection';
import { RemoteImage } from '@/components/remote-image';
import { RetryBanner } from '@/components/retry-banner';
import { StreamSelector } from '@/components/stream-selector';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SearchInput } from '@/components/ui/search-input';
import { Skeleton } from '@/components/ui/skeleton';
import { useAppUiPreferences } from '@/hooks/use-app-ui-preferences';
import { useDetailsEpisodePane } from '@/hooks/use-details-episode-pane';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useFailedSrc } from '@/hooks/use-failed-src';
import { useLocalDay } from '@/hooks/use-local-day';
import { useDetailsStreamSelector } from '@/hooks/use-details-stream-selector';
import { useDetailsTrailer } from '@/hooks/use-details-trailer';
import { useDetailsWatchStatus } from '@/hooks/use-details-watch-status';
import {
  useMarkSeasonWatched,
  useListSummaries,
  useMediaCollectionActions,
  useTitleWatchProgress,
  useToggleEpisodeWatched,
} from '@/hooks/use-media-library';
import { useMediaPrimaryPlayback } from '@/hooks/use-media-primary-playback';
import {
  api,
  type Episode,
  type MediaDetails,
  WATCH_STATUS_COLORS,
  WATCH_STATUS_LABELS,
  type WatchStatus,
} from '@/lib/api';
import { episodeMatchesCoordinates } from '@/lib/episode-stream-target';
import {
  episodeProgressKey,
  formatWatchRemaining,
  getWatchProgressPercent,
} from '@/lib/history-playback';
import { currentPathWithSearch } from '@/lib/navigation';
import {
  detailsCardQueryKey,
  detailsQueryKey,
  DETAILS_GC_TIME_MS,
  WATCH_HISTORY_VIEW_STALE_TIME_MS,
} from '@/lib/query-invalidation';
import { searchGenrePath } from '@/lib/search-page-state';
import {
  cn,
  GENRE_LINK_CLASS,
  isSeriesLikeMediaType,
  mediaTypeLabel,
  queryNeedsRetry,
  scrollBehavior,
  SIDEBAR_PAGE_COLUMN_INSETS,
} from '@/lib/utils';

const EPISODE_SKELETON_TILES = [1, 2, 3, 4, 5, 6, 7, 8].map((index) => (
  <div
    key={`episode-skeleton-${index}`}
    className='aspect-video w-full rounded-lg border border-white/[0.06] bg-zinc-900/60 animate-pulse'
  />
));

const ICON_ACTION_CLASS =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/[0.12] bg-white/[0.06] text-white/70 transition-colors duration-150 hover:border-white/[0.2] hover:bg-white/[0.1] hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/50 aria-disabled:cursor-wait';

const EPISODE_PAGE_BUTTON_CLASS =
  'flex h-9 w-9 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03] text-zinc-300 transition-colors duration-150 not-aria-disabled:hover:bg-white/[0.08] not-aria-disabled:hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 aria-disabled:cursor-default aria-disabled:opacity-35';

const DETAILS_COLUMN_CLASS = `mx-auto w-full max-w-6xl ${SIDEBAR_PAGE_COLUMN_INSETS}`;
const DETAILS_HERO_CLASS =
  'relative -mt-8 flex min-h-[70vh] w-full items-end pb-12 pt-24 lg:pb-16 lg:pt-28';
const DETAILS_STATUS_STRIP_CLASS =
  'inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-1 scrollbar-hide';

const WATCH_STATUS_ORDER: WatchStatus[] = ['plan_to_watch', 'watching', 'watched', 'dropped'];

const EMPTY_CREDIT_NAMES: string[] = [];

function DetailsCredits({
  cast = EMPTY_CREDIT_NAMES,
  directors = EMPTY_CREDIT_NAMES,
}: Pick<MediaDetails, 'cast' | 'directors'>) {
  if (!cast.length && !directors.length) return null;

  return (
    <dl className='mt-4 grid max-w-2xl grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 text-[13px] leading-5'>
      {cast.length > 0 && (
        <>
          <dt className='text-[11px] font-semibold uppercase tracking-[0.08em] text-white/40'>
            Starring
          </dt>
          <dd className='flex min-w-0 items-baseline gap-2 text-white/80'>
            <span className='min-w-0 truncate' title={cast.join(' · ')}>
              {cast.slice(0, 4).join(' · ')}
            </span>
            {cast.length > 4 && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type='button'
                    aria-label='Full cast'
                    className='inline-flex min-h-6 shrink-0 items-center rounded-md border border-white/10 bg-white/[0.05] px-2 py-1 text-[11px] font-medium leading-none text-white/75 transition-colors duration-150 hover:border-white/25 hover:bg-white/[0.1] hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40'
                  >
                    +{cast.length - 4}
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align='start'
                  sideOffset={8}
                  tabIndex={0}
                  aria-labelledby='details-full-cast-heading'
                  className='max-h-64 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-lg border-white/10 p-4 shadow-xl focus-visible:ring-2 focus-visible:ring-white/40'
                >
                  <h2
                    id='details-full-cast-heading'
                    className='mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-white/40'
                  >
                    Full cast
                  </h2>
                  <ul
                    aria-labelledby='details-full-cast-heading'
                    className='grid grid-cols-2 gap-x-4 gap-y-2'
                  >
                    {cast.map((name) => (
                      <li
                        key={name}
                        className='min-w-0 wrap-break-word text-[13px] leading-5 text-white/80'
                      >
                        {name}
                      </li>
                    ))}
                  </ul>
                </PopoverContent>
              </Popover>
            )}
          </dd>
        </>
      )}
      {directors.length > 0 && (
        <>
          <dt className='text-[11px] font-semibold uppercase tracking-[0.08em] text-white/40'>
            {directors.length === 1 ? 'Director' : 'Directors'}
          </dt>
          <dd className='min-w-0 truncate text-white/80' title={directors.join(' · ')}>
            {directors.join(' · ')}
          </dd>
        </>
      )}
    </dl>
  );
}

export function Details() {
  const { type, id } = useParams<{ type: string; id: string }>();

  return (
    <div className='min-h-screen page-enter bg-background'>
      <DetailsContent key={`${type}-${id}`} />
    </div>
  );
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
    placeholderData: () =>
      queryClient.getQueryData<MediaDetails>(detailsCardQueryKey(baseRouteType, baseRouteId)),
  });
  // Keep the first offline notice mounted through manual and reconnect retries.
  const [hasPausedDetails, setHasPausedDetails] = useState(false);
  if (isPaused && dataUpdatedAt === 0 && !hasPausedDetails) setHasPausedDetails(true);

  // The OS taskbar still uses this in the frameless window.
  useDocumentTitle(item?.title);

  // The route id lets history load without waiting for addon metadata.
  const titleProgressQuery = useTitleWatchProgress(baseRouteId, {
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

  const isLoadingWatchHistoryForItem =
    item?.type === 'series' && isLoadingWatchHistory && !watchHistoryError;

  // The resumable row owns "Continue S/E" — the pane must hint the same season.
  // The latest history row only wins when nothing is resumable; Rust only
  // lists rows with a playable resume point here.
  const seriesProgress =
    item?.type === 'series' ? (titleProgress?.seriesResumeEntry ?? null) : null;
  const seriesCanResume = seriesProgress !== null;
  const seriesResumeSeason = seriesProgress?.absolute_season;
  const seriesResumeEpisode = seriesProgress?.absolute_episode;
  const resumeEpisodeCoords = useMemo(
    () =>
      seriesCanResume && seriesResumeSeason != null && seriesResumeEpisode != null
        ? { season: seriesResumeSeason, episode: seriesResumeEpisode }
        : null,
    [seriesCanResume, seriesResumeSeason, seriesResumeEpisode],
  );

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
  const libraryStatusBusy = toggleLibrary.isPending || watchStatusMutation.isPending;
  const collectionItemId = item?.id ?? baseRouteId;
  const listSummariesQuery = useListSummaries(collectionItemId, {
    enabled: Boolean(collectionItemId),
  });
  const { data: listSummaries } = listSummariesQuery;
  const isSaved = isInLibrary || (listSummaries?.some((list) => list.contains_item) ?? false);
  const isSaveReady = isWatchStateReady && listSummariesQuery.isSuccess;
  const collectionStateError = watchStateError || queryNeedsRetry(listSummariesQuery);
  const [saveOpen, setSaveOpen] = useState(false);
  const [createListOpen, setCreateListOpen] = useState(false);
  const saveTriggerRef = useRef<HTMLButtonElement>(null);

  // Season 0 (specials) is valid; only accept real numbers — `Number(null)`
  // would read a missing season as Specials.
  const rawLocationSeason = (location.state as { season?: unknown } | null)?.season;
  const locationSeason =
    typeof rawLocationSeason === 'number' && Number.isFinite(rawLocationSeason)
      ? Math.trunc(rawLocationSeason)
      : null;
  const rawLocationEpisode = (location.state as { episode?: unknown } | null)?.episode;
  const locationEpisode =
    typeof rawLocationEpisode === 'number' && Number.isFinite(rawLocationEpisode)
      ? Math.trunc(rawLocationEpisode)
      : null;

  const {
    trailerOpen,
    trailerUrl,
    trailers,
    selectedTrailerId,
    selectTrailer,
    openTrailer,
    onTrailerOpenChange,
  } = useDetailsTrailer(item);
  // A corrected artwork URL from a refetch must retry without a route remount.
  const logoUrl = item?.logo;
  const heroBackdropSrc = item?.backdrop || item?.poster;
  const [logoSrc, onLogoError] = useFailedSrc(logoUrl);
  const [loadedBackdrop, setLoadedBackdrop] = useState<string | null>(null);
  const [loadedLogo, setLoadedLogo] = useState<string | null>(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [descriptionClamped, setDescriptionClamped] = useState(false);
  const localToday = format(useLocalDay(), 'yyyy-MM-dd');
  const descriptionRef = useRef<HTMLParagraphElement | null>(null);

  const {
    seasonCount,
    selectedSeason,
    localSeasonEntries,
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

  const hasEpisodesSection = item?.type === 'series' && (item?.episodes?.length ?? 0) > 0;

  // Rust owns the aired-by-local-day rule. Unknown or stale air states never
  // label episodes unaired and never enable bulk completion.
  const unairedScopeKey = [...detailsQueryKey(baseRouteType, baseRouteId), 'unaired-episodes'];
  const unairedEpisodesQuery = useQuery({
    queryKey: [...unairedScopeKey, localToday, dataUpdatedAt],
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

  // "Read more" only exists when the clamp actually bites; while expanded the
  // last verdict is kept so "Show less" stays.
  useEffect(() => {
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
  const pendingWatchedMutation = episodeWatchedPending
    ? episodeWatchedVariables
    : markSeasonWatched.isPending
      ? markSeasonWatched.variables
      : undefined;
  const pendingEpisodeKeys = useMemo(
    () =>
      new Set(
        pendingWatchedMutation?.episodes.map((ep) =>
          episodeProgressKey(baseRouteId, ep.season, ep.episode),
        ),
      ),
    [baseRouteId, pendingWatchedMutation],
  );
  const optimisticEpisodeWatched = useCallback(
    (ep: Episode) =>
      pendingEpisodeKeys.has(episodeProgressKey(baseRouteId, ep.season, ep.episode))
        ? pendingWatchedMutation?.watched
        : undefined,
    [baseRouteId, pendingEpisodeKeys, pendingWatchedMutation?.watched],
  );

  const { seasonWatchedCount, seasonWatchTargets } = useMemo(() => {
    const targets: Episode[] = [];
    let watched = 0;
    for (const ep of seasonEpisodes) {
      const key = episodeProgressKey(baseRouteId, ep.season, ep.episode);
      if (optimisticEpisodeWatched(ep) ?? !!episodeProgress?.[key]?.is_watched) {
        watched += 1;
        continue;
      }
      if (unairedEpisodeKeys && !unairedEpisodeKeys.has(key)) targets.push(ep);
    }
    return { seasonWatchedCount: watched, seasonWatchTargets: targets };
  }, [seasonEpisodes, episodeProgress, unairedEpisodeKeys, baseRouteId, optimisticEpisodeWatched]);

  const resumeEpisodeRef = useRef<HTMLButtonElement | null>(null);
  const episodeSearchInputRef = useRef<HTMLInputElement>(null);
  const episodeActionFocusRef = useRef<{
    button: HTMLButtonElement;
    target: 'resume' | 'heading' | 'search';
  } | null>(null);
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
    openEpisodeSelectorForCoordinates,
    handleSelectorClose,
    handleSelectorClosed,
    getStreamTargetStartTime,
  } = useDetailsStreamSelector({
    item,
    isPlaceholderData,
    baseRouteType,
    baseRouteId,
    locationState: location.state,
    spoilerProtection,
    titleProgress,
  });

  const handleWatchEpisode = useCallback(
    (ep: Episode) => {
      if (!item) return;

      const epProgress = episodeProgress?.[episodeProgressKey(baseRouteId, ep.season, ep.episode)];
      openEpisodeStreamSelector(ep, {
        startTime: epProgress?.resume_start_time,
      });
    },
    [episodeProgress, item, baseRouteId, openEpisodeStreamSelector],
  );

  // Destructured `mutate` keeps this stable — the mutation object is
  // re-allocated per render and would defeat `EpisodeCard`'s memo.
  const handleToggleEpisodeWatched = useCallback(
    (ep: Episode) => {
      if (!item || !hasWatchProgress || episodeWatchedPending || markSeasonWatched.isPending)
        return;
      const epProgress = episodeProgress?.[episodeProgressKey(baseRouteId, ep.season, ep.episode)];
      mutateEpisodeWatched({
        episodes: [ep],
        watched: !epProgress?.is_watched,
      });
    },
    [
      episodeProgress,
      hasWatchProgress,
      item,
      baseRouteId,
      mutateEpisodeWatched,
      episodeWatchedPending,
      markSeasonWatched.isPending,
    ],
  );

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

  const scrollToEpisodes = useCallback(() => {
    document.getElementById('details-episodes-heading')?.focus({ preventScroll: true });
    document.getElementById('episodes-section')?.scrollIntoView({ behavior: scrollBehavior() });
  }, []);

  const primaryPlayback = useMediaPrimaryPlayback({
    from: currentPathWithSearch(),
    historyEntry: primaryPlaybackHistoryEntry,
    item,
    onPlayMovieWithoutHistory: item?.type === 'movie' ? handleWatchMovie : undefined,
    onSelectEpisode: item?.type === 'series' ? scrollToEpisodes : undefined,
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
    item?.type === 'series' &&
    isPlaceholderData;
  const primaryActionPending =
    primaryPlayback.isResolvingPrimaryAction || historyPending || episodeActionPending;

  // "Start over" replays the resume target from the beginning: `startTime: 1`
  // rides the player contract — under MIN_RESUME_POSITION_SECS means no seek.
  const handleStartOver = useCallback(() => {
    if (!item || !primaryPlaybackHistoryEntry) return;
    const startTime = 1;

    if (item.type === 'movie') {
      handleWatchMovie(startTime);
      return;
    }

    const { absolute_season: season, absolute_episode: episode } = primaryPlaybackHistoryEntry;
    if (season == null || episode == null) return;
    openEpisodeSelectorForCoordinates(season, episode, startTime);
  }, [handleWatchMovie, item, openEpisodeSelectorForCoordinates, primaryPlaybackHistoryEntry]);

  const handleRetryDetails = async () => {
    if (!baseRouteId || isFetching) return;
    const filters = { queryKey: detailsQueryKey(baseRouteType, baseRouteId) };
    await queryClient.cancelQueries(filters, { revert: true });
    await queryClient.invalidateQueries(filters);
  };

  // Center the resume episode once per landing — re-centering on each
  // `visibleEpisodes` re-creation would yank the page mid-typing.
  const centeredResumeLandingRef = useRef<string | null>(null);
  const autoCenterNavigationRef = useRef({ key: location.key, type: navigationType });
  useEffect(() => {
    const landing = autoCenterNavigationRef.current;
    if (landing.key !== location.key) {
      // The player's POP handoff clears route state with a same-page REPLACE.
      if (navigationType !== 'REPLACE') {
        landing.type = navigationType;
        centeredResumeLandingRef.current = null;
      }
      landing.key = location.key;
    }
    if (landing.type === 'POP' && (locationSeason === null || locationEpisode === null)) return;
    if (!resumeEpisodeCoords || selectedSeason !== resumeEpisodeCoords.season) {
      centeredResumeLandingRef.current = null;
      return;
    }
    if (isPlaceholderData || episodeSearch.trim()) return;
    if (!visibleEpisodes.some((ep) => ep.episode === resumeEpisodeCoords.episode)) return;
    const landingKey = episodeProgressKey(
      baseRouteId,
      resumeEpisodeCoords.season,
      resumeEpisodeCoords.episode,
    );
    if (centeredResumeLandingRef.current === landingKey) return;

    const intentListeners = new AbortController();
    const timer = window.setTimeout(() => {
      intentListeners.abort();
      centeredResumeLandingRef.current = landingKey;
      resumeEpisodeRef.current?.scrollIntoView({
        block: 'center',
        behavior: scrollBehavior(),
      });
    }, 80);
    const cancelCentering = () => {
      centeredResumeLandingRef.current = landingKey;
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
    resumeEpisodeCoords,
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
            : 'The details request failed — check your connection, then try again.'}
        </p>
        <Button
          variant='outline'
          onClick={handleRetryDetails}
          aria-disabled={isFetching || undefined}
          aria-busy={isFetching}
          className='mt-1 h-9 rounded-md px-4 aria-disabled:cursor-wait aria-disabled:opacity-50'
        >
          <RotateCcw
            className={cn('h-4 w-4', isFetching && 'animate-spin motion-reduce:animate-none')}
          />
          Retry
        </Button>
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
    <div className='relative pb-20'>
      <div className={DETAILS_HERO_CLASS}>
        <div
          className='absolute inset-0 z-0'
          aria-hidden='true'
          style={{
            background:
              'radial-gradient(80% 90% at 65% 20%, rgb(var(--accent-art-rgb) / 0.14), transparent 75%)',
          }}
        >
          <div className='absolute inset-0 bg-linear-to-t from-background via-background/70 to-background/10 z-10' />
          <div className='absolute inset-0 bg-linear-to-r from-background/80 via-background/20 to-transparent z-10' />
          {heroBackdropSrc && (
            <RemoteImage
              key={heroBackdropSrc}
              src={heroBackdropSrc}
              fallbackSrc={item.poster}
              alt=''
              className={cn(
                'w-full h-full object-cover transition-opacity duration-700 ease-out',
                loadedBackdrop === heroBackdropSrc ? 'opacity-100' : 'opacity-0',
              )}
              loading='eager'
              fetchPriority='high'
              onLoad={() => setLoadedBackdrop(heroBackdropSrc)}
              style={{ objectPosition: 'center 20%' }}
            />
          )}
        </div>

        <div className={`${DETAILS_COLUMN_CLASS} relative z-20 flex flex-col`}>
          <div className='flex flex-col gap-6 w-full max-w-4xl'>
            {error && (
              <RetryBanner
                message="Couldn't refresh this title. Showing the saved details."
                onRetry={handleRetryDetails}
                isRetrying={isFetching}
              />
            )}
            <div className='space-y-6 w-full'>
              <div>
                <div
                  className={cn(
                    'relative mb-5 flex items-center',
                    logoUrl && 'min-h-24 md:min-h-32',
                  )}
                >
                  <h1
                    className={cn(
                      'w-full wrap-break-word text-[32px] font-semibold leading-[1.1] tracking-[-0.035em] text-white drop-shadow-lg transition-opacity duration-500 ease-out sm:text-5xl lg:text-6xl',
                      logoSrc && loadedLogo === logoSrc ? 'opacity-0' : 'opacity-100',
                    )}
                  >
                    {item.title}
                  </h1>
                  {logoSrc && (
                    <RemoteImage
                      key={logoSrc}
                      src={logoSrc}
                      alt=''
                      className={cn(
                        'absolute inset-0 h-full max-h-24 w-full object-contain object-left drop-shadow-2xl transition-opacity duration-500 ease-out md:max-h-32',
                        loadedLogo === logoSrc ? 'opacity-100' : 'opacity-0',
                      )}
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
                    {isSeriesLikeMediaType(item.type) && hasEpisodesSection && seasonCount > 0
                      ? `${seasonCount} Season${seasonCount === 1 ? '' : 's'}`
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
                </div>
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
                    'text-[14px] md:text-[15px] text-white/75 max-w-2xl leading-relaxed font-normal',
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
                <DetailsCredits cast={item.cast} directors={item.directors} />
              </div>

              <div className='flex flex-wrap items-center gap-2.5 pt-2'>
                <button
                  type='button'
                  className='group rounded-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black aria-disabled:cursor-wait'
                  aria-disabled={primaryActionPending || undefined}
                  aria-busy={primaryActionPending || undefined}
                  onClick={() => {
                    if (primaryActionPending) return;
                    if (historyUnavailable) void retryWatchHistory();
                    else void primaryPlayback.handlePrimaryAction();
                  }}
                >
                  <span className='flex h-11 items-center justify-center gap-2 rounded-lg bg-white px-5 text-black transition-colors duration-150 group-hover:bg-zinc-200 group-aria-disabled:opacity-80'>
                    {historyPending ||
                    episodeActionPending ||
                    primaryPlayback.showResolvingFeedback ? (
                      <Loader2 className='w-5 h-5 animate-spin' />
                    ) : (
                      <Play className='w-5 h-5 fill-current' />
                    )}
                    <span className='text-sm font-semibold tracking-tight'>
                      {historyPending
                        ? 'Loading progress…'
                        : episodeActionPending
                          ? 'Loading episodes…'
                          : historyUnavailable
                            ? 'Retry watch progress'
                            : primaryPlayback.primaryActionLabel}
                    </span>
                  </span>
                </button>

                <div className='flex flex-wrap gap-2.5'>
                  <Popover
                    open={saveOpen}
                    onOpenChange={(open) => {
                      if (!open || isSaveReady) setSaveOpen(open);
                    }}
                  >
                    <PopoverTrigger asChild>
                      <button
                        ref={saveTriggerRef}
                        type='button'
                        aria-label={
                          !isSaveReady
                            ? collectionStateError
                              ? 'Saved state unavailable'
                              : 'Loading saved state'
                            : isSaved
                              ? 'Saved — manage library and lists'
                              : 'Save to library or list'
                        }
                        aria-disabled={!isSaveReady || undefined}
                        aria-busy={
                          libraryStatusBusy || (!isSaveReady && !collectionStateError) || undefined
                        }
                        title={
                          !isSaveReady ? 'Saved state unavailable' : isSaved ? 'Saved' : 'Save'
                        }
                        className={cn(
                          ICON_ACTION_CLASS,
                          'w-auto min-w-24 gap-2 px-3',
                          !isSaveReady && 'opacity-45',
                          isSaveReady &&
                            isSaved &&
                            'border-white/30 bg-white/15 text-white hover:border-white/40 hover:bg-white/20',
                        )}
                      >
                        {libraryStatusBusy || (!isSaveReady && !collectionStateError) ? (
                          <Loader2 className='w-5 h-5 animate-spin' />
                        ) : isSaveReady && isSaved ? (
                          <Check className='w-5 h-5' />
                        ) : (
                          <Plus className='w-5 h-5' />
                        )}
                        <span className='text-[13px] font-medium'>
                          {isSaveReady && isSaved ? 'Saved' : 'Save'}
                        </span>
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      align='start'
                      sideOffset={8}
                      aria-label='Save to'
                      className='w-72 rounded-xl border-white/10 bg-zinc-950/95 p-1.5 shadow-2xl backdrop-blur-xl'
                    >
                      <h2 className='px-2.5 pb-1.5 pt-2 text-sm font-semibold text-white'>
                        Save to
                      </h2>
                      <SaveToCollectionPanel
                        item={item}
                        isInLibrary={isInLibrary}
                        showLibrary
                        libraryBusy={libraryStatusBusy || !isWatchStateReady}
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
                    <button
                      type='button'
                      aria-label='Watch trailer'
                      title='Trailer'
                      className={cn(ICON_ACTION_CLASS, 'w-auto gap-2 px-3')}
                      onClick={openTrailer}
                    >
                      <Clapperboard className='w-5 h-5' />
                      <span className='text-[13px] font-medium'>Trailer</span>
                    </button>
                  )}

                  {/* History resolves over IPC after first paint — the trailing
                      slot keeps its late arrival from shoving the other buttons. */}
                  {primaryPlaybackHistoryEntry && (
                    <button
                      type='button'
                      aria-label='Start over from the beginning'
                      aria-disabled={primaryActionPending || undefined}
                      title='Start over'
                      className={cn(ICON_ACTION_CLASS, 'animate-in fade-in duration-200')}
                      onClick={() => {
                        if (!primaryActionPending) handleStartOver();
                      }}
                    >
                      <RotateCcw className='w-5 h-5' />
                    </button>
                  )}
                </div>

                {resumeRemaining && (
                  <div className='flex basis-full items-center gap-2.5 pt-1 animate-in fade-in duration-200'>
                    <div className='h-[3px] w-32 overflow-hidden rounded-full bg-white/15'>
                      <div
                        className='h-full rounded-full bg-(--accent-prog)'
                        style={{ width: `${resumePercent}%` }}
                      />
                    </div>
                    <span className='text-[12px] font-medium tabular-nums text-white/60'>
                      {resumeRemaining}
                    </span>
                  </div>
                )}
              </div>

              {collectionStateError && (
                <RetryBanner
                  className='max-w-xl px-3 py-2'
                  message="Couldn't load library, lists or status."
                  isRetrying={isFetchingWatchState || listSummariesQuery.isFetching}
                  onRetry={() =>
                    void Promise.all([retryWatchState(), listSummariesQuery.refetch()])
                  }
                />
              )}
              <div className='flex flex-wrap items-center gap-x-3.5 gap-y-2 pt-5'>
                <span
                  id='details-watch-status-label'
                  className='text-[12px] font-medium text-white/65'
                >
                  My status
                </span>
                <div
                  className={cn(
                    DETAILS_STATUS_STRIP_CLASS,
                    !isWatchStateReady && !watchStatusMutation.isPending && 'opacity-45',
                  )}
                  role='group'
                  aria-labelledby='details-watch-status-label'
                  aria-busy={
                    libraryStatusBusy || (!isWatchStateReady && !watchStateError) || undefined
                  }
                >
                  {WATCH_STATUS_ORDER.map((status) => {
                    const isActive = detailsWatchStatus === status;
                    const colors = WATCH_STATUS_COLORS[status];
                    return (
                      <button
                        key={status}
                        type='button'
                        // aria-disabled, not disabled: disabled drops keyboard focus to <body> mid-mutation.
                        aria-disabled={libraryStatusBusy || !isWatchStateReady || undefined}
                        aria-pressed={
                          isWatchStateReady || watchStatusMutation.isPending ? isActive : undefined
                        }
                        title={isActive ? 'Clear status' : undefined}
                        onClick={() => {
                          if (!libraryStatusBusy && isWatchStateReady) {
                            watchStatusMutation.mutate(isActive ? null : status);
                          }
                        }}
                        className={cn(
                          'flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-md border px-3 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/30',
                          isActive
                            ? cn(colors.bg, colors.text, colors.border, 'hover:brightness-125')
                            : 'border-transparent text-white/70 hover:bg-white/[0.08] hover:text-white',
                          (libraryStatusBusy || !isWatchStateReady) && 'cursor-wait',
                        )}
                      >
                        <span
                          aria-hidden='true'
                          className={cn(
                            'h-1.5 w-1.5 rounded-full bg-current transition-opacity',
                            !isActive && 'opacity-50',
                          )}
                        />
                        {WATCH_STATUS_LABELS[status]}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {hasEpisodesSection && (
        <div id='episodes-section' className={`${DETAILS_COLUMN_CLASS} pt-5 pb-8`}>
          <div className='w-full flex flex-col gap-4 animate-in fade-in duration-300'>
            <h2
              id='details-episodes-heading'
              tabIndex={-1}
              className='text-[17px] font-semibold tracking-[-0.02em] text-white focus:outline-hidden'
            >
              Episodes
            </h2>
            {localSeasonEntries.length > 1 && (
              <div className='w-full'>
                <SeasonSwitcher
                  localSeasons={localSeasonEntries}
                  activeSeason={selectedSeason}
                  onLocalSeason={selectSeason}
                />
              </div>
            )}
            <div
              id='details-episodes-panel'
              className='min-w-0 space-y-3'
              // Panel semantics only exist while the season tablist renders.
              role={localSeasonEntries.length > 1 ? 'tabpanel' : undefined}
              aria-labelledby={
                localSeasonEntries.length > 1 && selectedSeason !== null
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
              <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-2'>
                <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2'>
                  <p
                    aria-live='polite'
                    className='text-[12px] font-medium tabular-nums text-zinc-400'
                  >
                    {episodeRangeLabel}
                    {visibleEpisodeStart > 0 && (
                      <span className='text-zinc-500'>{` of ${totalEpisodeCount}`}</span>
                    )}
                    {seasonWatchedCount > 0 && (
                      <span className='text-zinc-500'>{` · ${seasonWatchedCount} watched`}</span>
                    )}
                  </p>
                  {resumeEpisodeCoords &&
                    (selectedSeason !== resumeEpisodeCoords.season ||
                      (resumeEpisodePageIndex !== null &&
                        activeEpisodePageIndex !== resumeEpisodePageIndex) ||
                      episodeSearch.trim().length > 0) && (
                      <button
                        type='button'
                        onClick={(event) => {
                          episodeActionFocusRef.current =
                            document.activeElement === event.currentTarget
                              ? { button: event.currentTarget, target: 'resume' }
                              : null;
                          jumpToEpisode(resumeEpisodeCoords.season, resumeEpisodeCoords.episode);
                        }}
                        className='accent-lattice-soft flex h-8 items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium transition-colors duration-150 hover:brightness-125 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/30'
                      >
                        <RotateCcw aria-hidden='true' className='h-3.5 w-3.5' />
                        Jump to S{resumeEpisodeCoords.season}E{resumeEpisodeCoords.episode}
                      </button>
                    )}
                  {!isLoadingWatchHistoryForItem &&
                    (seasonWatchTargets.length > 1 || markSeasonWatched.isPending) && (
                      <button
                        type='button'
                        aria-disabled={
                          !hasWatchProgress ||
                          !airStatesReady ||
                          markSeasonWatched.isPending ||
                          episodeWatchedPending ||
                          undefined
                        }
                        onClick={(event) => {
                          if (
                            hasWatchProgress &&
                            airStatesReady &&
                            !markSeasonWatched.isPending &&
                            !episodeWatchedPending
                          ) {
                            episodeActionFocusRef.current =
                              document.activeElement === event.currentTarget
                                ? { button: event.currentTarget, target: 'heading' }
                                : null;
                            markSeasonWatched.mutate({
                              episodes: seasonWatchTargets,
                              watched: true,
                            });
                          }
                        }}
                        className='flex h-8 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-zinc-400 transition-colors duration-150 not-aria-disabled:hover:bg-white/[0.06] not-aria-disabled:hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/30 aria-disabled:cursor-default aria-disabled:opacity-60'
                      >
                        {markSeasonWatched.isPending ? (
                          <Loader2 className='h-3.5 w-3.5 animate-spin' />
                        ) : (
                          <Check className='h-3.5 w-3.5' strokeWidth={2.5} />
                        )}
                        Mark season watched
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
                aria-busy={
                  isLoadingWatchHistoryForItem || (!episodeSearchError && isEpisodeSearchPending)
                }
                className='grid grid-cols-1 gap-3 pb-2 sm:grid-cols-2 xl:grid-cols-4'
              >
                {!episodeSearchError && visibleEpisodes.length === 0 && isEpisodeSearchPending ? (
                  <div
                    role='status'
                    className='col-span-full flex flex-col items-center gap-3 py-14 text-center'
                  >
                    <p className='text-sm text-zinc-400'>Searching episodes…</p>
                  </div>
                ) : !episodeSearchError && visibleEpisodes.length === 0 && episodeSearch.trim() ? (
                  <div className='col-span-full flex flex-col items-center gap-3 py-14 text-center'>
                    <p className='text-sm text-zinc-400'>
                      No episodes match &ldquo;
                      {episodeSearch}&rdquo;
                    </p>
                    <button
                      type='button'
                      onClick={(event) => {
                        episodeActionFocusRef.current =
                          document.activeElement === event.currentTarget
                            ? { button: event.currentTarget, target: 'search' }
                            : null;
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
                    const epProgress = hasWatchProgress ? episodeProgress?.[episodeKey] : undefined;
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
                    const isResumeEp =
                      hasWatchProgress &&
                      seriesCanResume &&
                      episodeMatchesCoordinates(ep, seriesResumeSeason, seriesResumeEpisode);
                    const isWatched = optimisticWatched ?? !!epProgress?.is_watched;
                    const remainingText =
                      epProgress && !isWatched && epProgress.has_started_watching
                        ? formatWatchRemaining(epProgress.position, epProgress.duration)
                        : null;

                    return (
                      <EpisodeCard
                        key={`${ep.id}:${ep.season}:${ep.episode}`}
                        episode={ep}
                        isResume={isResumeEp}
                        isSpoiler={isEpisodeSpoiler(
                          ep,
                          isHydratingSpoilerProtection || spoilerProtection,
                          titleProgress?.watchedEpisodeCeiling,
                          epProgress,
                        )}
                        isWatched={isWatched}
                        isAired={!unairedEpisodeKeys?.has(episodeKey)}
                        isWatchedDisabled={episodeWatchedPending || markSeasonWatched.isPending}
                        isWatchedPending={pendingEpisodeKeys.has(episodeKey)}
                        progressPercent={progressPercent}
                        remainingText={remainingText}
                        resumeRef={isResumeEp ? resumeEpisodeRef : undefined}
                        onPlay={handleWatchEpisode}
                        onToggleWatched={hasWatchProgress ? handleToggleEpisodeWatched : undefined}
                      />
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {!hasEpisodesSection && !isPlaceholderData && item.type === 'series' && (
        <div id='episodes-section' className={`${DETAILS_COLUMN_CLASS} py-8`}>
          <section
            id='details-episodes-heading'
            tabIndex={-1}
            aria-label='Episode information unavailable'
            className='rounded-xl focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/30'
          >
            <RetryBanner
              message='Episode information unavailable.'
              isRetrying={isFetching}
              onRetry={() => {
                const button = document.activeElement;
                episodeActionFocusRef.current =
                  button instanceof HTMLButtonElement ? { button, target: 'heading' } : null;
                void handleRetryDetails();
              }}
            />
          </section>
        </div>
      )}

      {/* Shimmer the episode grid while the card placeholder's hero is up. */}
      {!hasEpisodesSection && isPlaceholderData && item.type === 'series' && (
        <div className={`${DETAILS_COLUMN_CLASS} py-8`}>
          <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4'>
            {EPISODE_SKELETON_TILES}
          </div>
        </div>
      )}

      <DetailsSimilarTitles item={item} contentInsetsClassName={DETAILS_COLUMN_CLASS} />

      {streamTarget && (
        <StreamSelector
          open={streamSelectorOpen}
          onClose={handleSelectorClose}
          onClosed={handleSelectorClosed}
          target={streamTarget}
          getStartTime={getStreamTargetStartTime}
        />
      )}

      <DetailsTrailerDialog
        open={trailerOpen}
        onOpenChange={onTrailerOpenChange}
        trailerUrl={trailerUrl}
        trailers={trailers}
        selectedTrailerId={selectedTrailerId}
        onSelectTrailer={selectTrailer}
        title={item.title}
      />
    </div>
  );
}

function DetailsSkeleton() {
  return (
    <div className='relative min-h-screen bg-background pb-20' aria-busy='true'>
      <span role='status' className='sr-only'>
        Loading…
      </span>
      <div className={DETAILS_HERO_CLASS} aria-hidden='true'>
        <div className='absolute inset-0 bg-zinc-950' />
        <div className='absolute inset-0 bg-linear-to-t from-background via-background/60 to-transparent' />
        <div className={`${DETAILS_COLUMN_CLASS} relative z-20 flex flex-col`}>
          <div className='flex w-full max-w-4xl flex-col gap-6'>
            <div className='w-full space-y-6'>
              <div>
                <div className='mb-5 flex min-h-24 items-center md:min-h-32'>
                  <Skeleton className='h-16 w-80 max-w-full bg-zinc-800/60 md:h-20' />
                </div>
                <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
                  <Skeleton className='h-5 w-14 bg-zinc-800/50' />
                  <Skeleton className='h-5 w-20 bg-zinc-800/50' />
                  <Skeleton className='h-5 w-16 bg-zinc-800/50' />
                </div>
                <div className='mt-3 flex flex-wrap items-center gap-1.5'>
                  <Skeleton className='h-7 w-20 rounded-md bg-zinc-800/50' />
                  <Skeleton className='h-7 w-16 rounded-md bg-zinc-800/50' />
                  <Skeleton className='h-7 w-20 rounded-md bg-zinc-800/50' />
                </div>
              </div>
              <div className='max-w-2xl space-y-2.5'>
                <Skeleton className='h-4 w-full bg-zinc-800/40' />
                <Skeleton className='h-4 w-full bg-zinc-800/40' />
                <Skeleton className='h-4 w-4/5 bg-zinc-800/40' />
              </div>
              <div className='flex flex-wrap items-center gap-2.5 pt-2'>
                <Skeleton className='h-11 w-36 max-w-full rounded-lg bg-zinc-800/50' />
                <div className='flex flex-wrap gap-2.5'>
                  <Skeleton className='h-11 w-24 rounded-lg bg-zinc-800/40' />
                  <Skeleton className='h-11 w-26 rounded-lg bg-zinc-800/40' />
                </div>
              </div>
              <div className='flex flex-wrap items-center gap-x-3.5 gap-y-2 pt-5'>
                <Skeleton className='h-4 w-16 bg-zinc-800/40' />
                <div className={DETAILS_STATUS_STRIP_CLASS}>
                  {WATCH_STATUS_ORDER.map((status) => (
                    <Skeleton
                      key={status}
                      className='flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-transparent bg-zinc-800/40 px-3 text-[13px] font-medium text-transparent'
                    >
                      <span className='h-1.5 w-1.5' />
                      {WATCH_STATUS_LABELS[status]}
                    </Skeleton>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
