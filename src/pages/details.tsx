import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { EpisodeCard } from '@/components/details-episode-card';
import { SeasonSwitcher } from '@/components/details-season-switcher';
import { DetailsSimilarTitles } from '@/components/details-similar-titles';
import { DetailsTrailerDialog } from '@/components/details-trailer-dialog';
import { RemoteImage } from '@/components/remote-image';
import { RetryBanner } from '@/components/retry-banner';
import { StreamSelector } from '@/components/stream-selector';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { Skeleton } from '@/components/ui/skeleton';
import { useSpoilerProtection } from '@/hooks/use-app-ui-preferences';
import { useDetailsEpisodePane } from '@/hooks/use-details-episode-pane';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useFailedSrc } from '@/hooks/use-failed-src';
import { useLocalDay } from '@/hooks/use-local-day';
import { useDetailsStreamSelector } from '@/hooks/use-details-stream-selector';
import { useDetailsTrailer } from '@/hooks/use-details-trailer';
import { useDetailsWatchStatus } from '@/hooks/use-details-watch-status';
import {
  useMarkSeasonWatched,
  useTitleWatchProgress,
  useToggleEpisodeWatched,
  useToggleLibraryItem,
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
import { episodeMatchesCoordinates, findEpisodeByCoordinates } from '@/lib/episode-stream-target';
import {
  episodeProgressKey,
  getPlayableResumeStartTime,
  getWatchProgressPercent,
  titleEpisodeProgressMap,
  watchProgressCoordinates,
} from '@/lib/history-playback';
import { currentPathWithSearch } from '@/lib/navigation';
import {
  detailsCardQueryKey,
  detailsQueryKey,
  DETAILS_GC_TIME_MS,
  DETAILS_STALE_TIME_MS,
  WATCH_HISTORY_VIEW_STALE_TIME_MS,
} from '@/lib/query-invalidation';
import { searchGenrePath } from '@/lib/search-page-state';
import {
  cn,
  isSeriesLikeMediaType,
  isAiredByLocalDay,
  mediaTypeLabel,
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

const WATCH_STATUS_ORDER: WatchStatus[] = ['plan_to_watch', 'watching', 'watched', 'dropped'];

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
  const queryClient = useQueryClient();
  // Playback preference writes must not re-render the whole page.
  const spoilerProtection = useSpoilerProtection();

  const {
    data: item,
    isLoading,
    isFetching,
    isPlaceholderData,
    error,
  } = useQuery({
    queryKey: detailsQueryKey(baseRouteType, baseRouteId),
    queryFn: () => api.getMediaDetails(baseRouteType, baseRouteId),
    enabled: !!baseRouteId,
    // Card-prefetch bridge: hover intent already fetched the metadata-only
    // payload under its own key — paint the hero immediately while the full
    // episode payload lands.
    placeholderData: () =>
      queryClient.getQueryData<MediaDetails>(detailsCardQueryKey(baseRouteType, baseRouteId)),
    staleTime: DETAILS_STALE_TIME_MS,
    gcTime: DETAILS_GC_TIME_MS,
  });

  // The OS taskbar still uses this in the frameless window.
  useDocumentTitle(item?.title);

  // The route id lets history load without waiting for addon metadata.
  const {
    data: titleProgress,
    isLoading: isLoadingWatchHistory,
    isFetching: isFetchingWatchHistory,
    isError: watchHistoryError,
    refetch: retryWatchHistory,
  } = useTitleWatchProgress(baseRouteId, { staleTime: WATCH_HISTORY_VIEW_STALE_TIME_MS });
  const watchHistory = titleProgress?.history;
  const continueWatching = titleProgress?.continueWatching;

  const episodeProgressMap = useMemo(
    () => titleEpisodeProgressMap(titleProgress?.episodeProgress),
    [titleProgress?.episodeProgress],
  );
  // Rows arrive `last_watched` DESC — the first row of each kind is its
  // latest. The backend bakes the per-episode index; these stay thin picks.
  const movieProgress = useMemo(
    () => watchHistory?.find((entry) => entry.type_ === 'movie') ?? null,
    [watchHistory],
  );
  const latestSeriesProgress = useMemo(
    () => watchHistory?.find((entry) => isSeriesLikeMediaType(entry.type_)) ?? null,
    [watchHistory],
  );
  const latestSeriesProgressCoords = useMemo(
    () => watchProgressCoordinates(latestSeriesProgress),
    [latestSeriesProgress],
  );

  const isLoadingWatchHistoryForItem = item?.type === 'series' && isLoadingWatchHistory;

  // The resumable Continue Watching row owns the "Continue S/E" action — the
  // pane must hint the same season or the action's season check can hide it.
  // The latest history row only wins when nothing is resumable: a watched
  // S2 finale shouldn't open the pane on S2 while the resume row sits in S1.
  const seriesProgress =
    item?.type === 'series'
      ? (continueWatching?.find((entry) => isSeriesLikeMediaType(entry.type_)) ?? null)
      : null;
  const seriesCanResume = getPlayableResumeStartTime(seriesProgress) !== undefined;
  const { season: seriesResumeSeason, episode: seriesResumeEpisode } =
    watchProgressCoordinates(seriesProgress);
  const resumeEpisodeCoords = useMemo(
    () =>
      seriesCanResume && seriesResumeSeason !== undefined && seriesResumeEpisode !== undefined
        ? { season: seriesResumeSeason, episode: seriesResumeEpisode }
        : null,
    [seriesCanResume, seriesResumeSeason, seriesResumeEpisode],
  );

  const {
    watchStatus: detailsWatchStatus,
    watchStatusMutation,
    isInLibrary,
  } = useDetailsWatchStatus(item);
  const toggleLibrary = useToggleLibraryItem({ item, isInLibrary });

  // Season 0 (specials) is valid: accept only real numbers — serde absent
  // keys arrive as undefined, and `Number(null)` would read a missing season
  // as "Specials".
  const rawLocationSeason = (location.state as { season?: unknown } | null)?.season;
  const locationSeason =
    typeof rawLocationSeason === 'number' && Number.isFinite(rawLocationSeason)
      ? Math.trunc(rawLocationSeason)
      : null;

  const { trailerOpen, trailerUrl, openTrailer, onTrailerOpenChange } = useDetailsTrailer(item);
  // A corrected artwork URL from a refetch must retry without a route remount.
  const backdropUrl = item?.backdrop || item?.poster;
  const logoUrl = item?.logo;
  const [backdropSrc, onBackdropError] = useFailedSrc(backdropUrl);
  const [logoSrc, onLogoError] = useFailedSrc(logoUrl);
  const [loadedBackdrop, setLoadedBackdrop] = useState<string | null>(null);
  const [loadedLogo, setLoadedLogo] = useState<string | null>(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [descriptionClamped, setDescriptionClamped] = useState(false);
  const [castExpanded, setCastExpanded] = useState(false);
  const localDayMs = useLocalDay().getTime();
  const descriptionRef = useRef<HTMLParagraphElement | null>(null);

  const {
    seasonCount,
    selectedSeason,
    localSeasonEntries,
    seasonEpisodes,
    visibleEpisodes,
    episodeSearch,
    setEpisodeSearch,
    selectSeason,
    shouldShowEpisodeSearch,
    episodeRangeLabel,
    totalEpisodeCount,
    totalEpisodePages,
    activeEpisodePageIndex,
    visibleEpisodeStart,
    hasPreviousEpisodes,
    hasMoreEpisodes,
    changeEpisodePage,
    shouldShowEpisodeProgressSkeleton,
  } = useDetailsEpisodePane({
    item,
    effectiveRouteId: baseRouteId,
    locationKey: location.key,
    locationSeason,
    resumeSeason: resumeEpisodeCoords?.season ?? latestSeriesProgressCoords.season,
    resumeEpisode: resumeEpisodeCoords?.episode ?? latestSeriesProgressCoords.episode,
    isLoadingWatchHistory: isLoadingWatchHistoryForItem,
  });

  const hasEpisodesSection = item?.type === 'series' && (item?.episodes?.length ?? 0) > 0;

  // "Read more" only exists when the clamp actually bites — short blurbs
  // never see a dead toggle. Re-measures on resize and description change;
  // while expanded the last clamped verdict is kept so "Show less" stays.
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
      const storedRow = episodeProgressMap.get(
        episodeProgressKey(baseRouteId, ep.season, ep.episode),
      );
      if (optimisticEpisodeWatched(ep) ?? !!storedRow?.is_watched) {
        watched += 1;
        continue;
      }
      if (isAiredByLocalDay(ep.releaseDate, localDayMs)) targets.push(ep);
    }
    return { seasonWatchedCount: watched, seasonWatchTargets: targets };
  }, [seasonEpisodes, episodeProgressMap, localDayMs, baseRouteId, optimisticEpisodeWatched]);

  const resumeEpisodeRef = useRef<HTMLButtonElement | null>(null);
  const {
    streamSelectorOpen,
    streamTarget,
    handleWatchMovie,
    openEpisodeStreamSelector,
    handleSelectorClose,
    getStreamTargetStartTime,
  } = useDetailsStreamSelector({
    item,
    isPlaceholderData,
    baseRouteType,
    locationState: location.state,
  });

  // Spoiler protection: episodes past the furthest watched one get blurred
  // thumbnails and hidden descriptions. The backend folds the ceiling into
  // the payload (canonical coords, started rows plus the latest-row seed).
  const maxWatchedEpisodeInSeason =
    spoilerProtection && selectedSeason !== null
      ? (titleProgress?.watchedEpisodeCeiling[selectedSeason] ?? null)
      : null;

  const handleWatchEpisode = useCallback(
    (ep: Episode) => {
      if (!item) return;

      const startTime = getPlayableResumeStartTime(
        episodeProgressMap.get(episodeProgressKey(baseRouteId, ep.season, ep.episode)),
      );
      openEpisodeStreamSelector(ep, {
        overview: ep.overview || item.description,
        startTime,
      });
    },
    [episodeProgressMap, item, baseRouteId, openEpisodeStreamSelector],
  );

  // Destructured `mutate` keeps `handleToggleEpisodeWatched` referentially
  // stable — the mutation object itself is re-allocated per render and would
  // defeat `EpisodeCard`'s memo.
  const handleToggleEpisodeWatched = useCallback(
    (ep: Episode) => {
      if (!item || episodeWatchedPending || markSeasonWatched.isPending) return;
      const epProgress = episodeProgressMap.get(
        episodeProgressKey(baseRouteId, ep.season, ep.episode),
      );
      mutateEpisodeWatched({
        episodes: [ep],
        watched: !epProgress?.is_watched,
      });
    },
    [
      episodeProgressMap,
      item,
      baseRouteId,
      mutateEpisodeWatched,
      episodeWatchedPending,
      markSeasonWatched.isPending,
    ],
  );

  const progress = item?.type === 'movie' ? movieProgress : null;

  const movieCanResume = getPlayableResumeStartTime(progress) !== undefined;
  const primaryPlaybackHistoryEntry =
    item?.type === 'movie'
      ? progress && movieCanResume
        ? progress
        : null
      : seriesProgress && seriesCanResume
        ? seriesProgress
        : null;

  const scrollToEpisodes = useCallback(() => {
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

  // The play button's resume branch needs the title-progress read — a click
  // inside its (short) load window would fall back to "no history" behavior.
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

  // "Start over" replays the resume target from the beginning. The explicit
  // `startTime: 1` rides the existing player contract: a positive value
  // suppresses the progress-fetch resume, and anything under
  // MIN_RESUME_POSITION_SECS means "from the beginning" — no seek at all.
  const handleStartOver = useCallback(() => {
    if (!item || !primaryPlaybackHistoryEntry) return;
    const startTime = 1;

    if (item.type === 'movie') {
      handleWatchMovie(startTime);
      return;
    }

    const { season, episode } = watchProgressCoordinates(primaryPlaybackHistoryEntry);
    if (season === undefined || episode === undefined) return;
    const targetEpisode = findEpisodeByCoordinates(item.episodes, season, episode);
    openEpisodeStreamSelector(
      {
        season,
        episode,
        title: targetEpisode?.title,
        streamLookupId: targetEpisode?.streamLookupId,
        streamSeason: targetEpisode?.streamSeason,
        streamEpisode: targetEpisode?.streamEpisode,
      },
      {
        overview: targetEpisode?.overview || item.description,
        startTime,
      },
    );
  }, [handleWatchMovie, item, openEpisodeStreamSelector, primaryPlaybackHistoryEntry]);

  const handleRetryDetails = () => {
    if (!baseRouteId || isFetching) return;
    void queryClient.invalidateQueries({ queryKey: detailsQueryKey(baseRouteType, baseRouteId) });
  };

  // Center the resume episode once per landing on its season. Filtering or
  // paging re-creates `visibleEpisodes`, and re-centering on each of those
  // would yank the page away from wherever the user scrolled while typing.
  const centeredResumeLandingRef = useRef<string | null>(null);
  useEffect(() => {
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

    const timer = window.setTimeout(() => {
      // Latched only once the scroll runs: a timer cancelled by a dep change
      // inside the delay must still get its landing.
      centeredResumeLandingRef.current = landingKey;
      resumeEpisodeRef.current?.scrollIntoView({
        block: 'center',
        behavior: scrollBehavior(),
      });
    }, 80);

    return () => window.clearTimeout(timer);
  }, [
    visibleEpisodes,
    resumeEpisodeCoords,
    selectedSeason,
    isPlaceholderData,
    episodeSearch,
    baseRouteId,
  ]);

  if (isLoading) return <DetailsSkeleton />;

  if (error && !item) {
    return (
      <div
        role='alert'
        className={`${DETAILS_COLUMN_CLASS} min-h-[75vh] flex flex-col items-center justify-center gap-3 text-center`}
      >
        <Clapperboard className='w-10 h-10 text-zinc-600 opacity-40' />
        <p className='text-lg font-semibold text-white'>Couldn&apos;t load this title</p>
        <p className='text-sm text-zinc-500 max-w-sm leading-relaxed'>
          The details request failed — check your connection, then try again.
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
      <div className='relative flex min-h-[70vh] w-full items-end pb-24 pt-32 -mt-8'>
        {backdropSrc && (
          <div className='absolute inset-0 z-0'>
            <div className='absolute inset-0 bg-linear-to-t from-background via-background/70 to-background/10 z-10' />
            <div className='absolute inset-0 bg-linear-to-r from-background/80 via-background/20 to-transparent z-10' />
            <RemoteImage
              key={backdropSrc}
              src={backdropSrc}
              alt=''
              className={cn(
                'w-full h-full object-cover transition-opacity duration-700 ease-out',
                loadedBackdrop === backdropSrc ? 'opacity-100' : 'opacity-0',
              )}
              loading='eager'
              fetchPriority='high'
              onLoad={() => setLoadedBackdrop(backdropSrc)}
              onError={onBackdropError}
              style={{ objectPosition: 'center 20%' }}
            />
          </div>
        )}

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
                {logoSrc ? (
                  <>
                    <h1 className='sr-only'>{item.title}</h1>
                    <RemoteImage
                      key={logoSrc}
                      src={logoSrc}
                      alt=''
                      className={cn(
                        'h-24 max-w-full md:h-32 object-contain object-left mb-6 drop-shadow-2xl transition-opacity duration-500 ease-out',
                        loadedLogo === logoSrc ? 'opacity-100' : 'opacity-0',
                      )}
                      onLoad={() => setLoadedLogo(logoSrc)}
                      onError={onLogoError}
                    />
                  </>
                ) : (
                  <h1 className='mb-5 wrap-break-word text-[32px] font-semibold leading-[1.1] tracking-[-0.035em] text-white drop-shadow-lg sm:text-5xl lg:text-6xl'>
                    {item.title}
                  </h1>
                )}

                <div className='flex flex-wrap items-center gap-x-3 gap-y-2 text-sm font-medium text-white/85'>
                  {item.displayYear && (
                    <>
                      <span className='tabular-nums'>{item.displayYear}</span>
                      <span aria-hidden='true' className='text-white/25'>
                        ·
                      </span>
                    </>
                  )}
                  <span>
                    {isSeriesLikeMediaType(item.type) && hasEpisodesSection && seasonCount > 0
                      ? `${seasonCount} Season${seasonCount === 1 ? '' : 's'}`
                      : mediaTypeLabel(item.type)}
                  </span>

                  {item.genres && item.genres.length > 0 && (
                    <>
                      <span aria-hidden='true' className='text-white/25'>
                        ·
                      </span>
                      <div className='flex flex-wrap items-center gap-1.5'>
                        {item.genres.slice(0, 3).map((genre) => (
                          <Link
                            key={genre}
                            to={searchGenrePath(baseRouteType, genre)}
                            title={`Browse ${genre}`}
                            className='rounded-md border border-white/10 bg-white/[0.05] px-2.5 py-1.5 text-[12px] font-medium leading-none text-white/75 transition-colors duration-150 hover:border-white/25 hover:bg-white/[0.1] hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40'
                          >
                            {genre}
                          </Link>
                        ))}
                      </div>
                    </>
                  )}

                  {item.rating && (
                    <>
                      <span aria-hidden='true' className='text-white/25'>
                        ·
                      </span>
                      <div className='flex items-baseline gap-1.5'>
                        <Star className='rating-star h-4 w-4 translate-y-[2px] fill-amber-400 text-amber-400' />
                        <span className='text-[15px] font-semibold tabular-nums text-white'>
                          {item.rating}
                        </span>
                        <span className='text-xs font-medium tabular-nums text-white/35'>/10</span>
                      </div>
                    </>
                  )}
                </div>
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

                <div className='flex gap-2.5'>
                  <button
                    type='button'
                    aria-label={isInLibrary ? 'Remove from library' : 'Add to library'}
                    aria-pressed={isInLibrary}
                    aria-busy={toggleLibrary.isPending || undefined}
                    title={isInLibrary ? 'In library' : 'Add to library'}
                    className={cn(
                      ICON_ACTION_CLASS,
                      isInLibrary &&
                        'border-white/30 bg-white/15 text-white hover:border-white/40 hover:bg-white/20',
                    )}
                    aria-disabled={toggleLibrary.isPending || undefined}
                    onClick={() => {
                      if (!toggleLibrary.isPending) toggleLibrary.mutate();
                    }}
                  >
                    {toggleLibrary.isPending ? (
                      <Loader2 className='w-5 h-5 animate-spin' />
                    ) : isInLibrary ? (
                      <Check className='w-5 h-5' />
                    ) : (
                      <Plus className='w-5 h-5' />
                    )}
                  </button>

                  {item.trailers && item.trailers.length > 0 && (
                    <button
                      type='button'
                      aria-label='Watch trailer'
                      title='Trailer'
                      className={ICON_ACTION_CLASS}
                      onClick={openTrailer}
                    >
                      <Clapperboard className='w-5 h-5' />
                    </button>
                  )}

                  {/* History resolves over IPC after first paint — the
                      trailing slot keeps its late arrival from pushing the
                      library/trailer buttons sideways. */}
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
              </div>

              <div className='flex flex-wrap items-center gap-x-3.5 gap-y-2 pt-5'>
                <span
                  id='details-watch-status-label'
                  className='text-[12px] font-medium text-white/65'
                >
                  My status
                </span>
                <div
                  className='inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-1 scrollbar-hide'
                  role='group'
                  aria-labelledby='details-watch-status-label'
                >
                  {WATCH_STATUS_ORDER.map((status) => {
                    const isActive = detailsWatchStatus === status;
                    const colors = WATCH_STATUS_COLORS[status];
                    return (
                      <button
                        key={status}
                        type='button'
                        // aria-disabled, not disabled: a disabled button drops
                        // keyboard focus to <body> mid-mutation.
                        aria-disabled={watchStatusMutation.isPending || undefined}
                        aria-pressed={isActive}
                        title={isActive ? 'Clear status' : undefined}
                        onClick={() => {
                          if (!watchStatusMutation.isPending) {
                            watchStatusMutation.mutate(isActive ? null : status);
                          }
                        }}
                        className={cn(
                          'flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-md border px-3 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/30',
                          isActive
                            ? cn(colors.bg, colors.text, colors.border)
                            : 'border-transparent text-white/70 hover:bg-white/[0.08] hover:text-white',
                          watchStatusMutation.isPending && 'cursor-wait',
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

              {item.cast && item.cast.length > 0 && (
                <div className='pt-6 max-w-3xl'>
                  <div className='flex flex-wrap items-center gap-x-2 gap-y-2 text-[13px] md:text-[14px]'>
                    <span className='font-semibold text-white/50 mr-1'>Starring:</span>
                    {(castExpanded ? item.cast : item.cast.slice(0, 5)).map((actor, i, cast) => (
                      <span key={actor} className='flex items-center'>
                        <span className='text-zinc-300'>{actor}</span>
                        {i < cast.length - 1 && <span className='text-white/20 mx-2'>,</span>}
                      </span>
                    ))}
                    {item.cast.length > 5 && (
                      <button
                        type='button'
                        onClick={() => setCastExpanded((v) => !v)}
                        aria-expanded={castExpanded}
                        className='ml-1 inline-flex min-h-8 items-center rounded-md px-1 text-white/65 transition-colors duration-150 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40'
                      >
                        {castExpanded ? 'Show less' : `+${item.cast.length - 5} more`}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {hasEpisodesSection && (
        <div id='episodes-section' className={`${DETAILS_COLUMN_CLASS} py-8`}>
          <div className='w-full flex flex-col gap-4 animate-in fade-in duration-300'>
            <h2 className='text-[17px] font-semibold tracking-[-0.02em] text-white'>Episodes</h2>
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
              {shouldShowEpisodeSearch && (
                <SearchInput
                  placeholder='Search episodes…'
                  aria-label='Search episodes'
                  value={episodeSearch}
                  onValueChange={setEpisodeSearch}
                  clearLabel='Clear episode search'
                  className='h-9 bg-white/[0.04] border-white/10 text-sm text-white placeholder:text-zinc-500 focus-visible:ring-white/20 focus-visible:border-white/20 rounded-lg'
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
                  {!shouldShowEpisodeProgressSkeleton &&
                    (seasonWatchTargets.length > 1 || markSeasonWatched.isPending) && (
                      <button
                        type='button'
                        aria-disabled={
                          markSeasonWatched.isPending || episodeWatchedPending || undefined
                        }
                        onClick={() => {
                          if (!markSeasonWatched.isPending && !episodeWatchedPending) {
                            markSeasonWatched.mutate({
                              episodes: seasonWatchTargets,
                              watched: true,
                            });
                          }
                        }}
                        className='flex h-8 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-zinc-400 transition-colors duration-150 hover:bg-white/[0.06] hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/30 aria-disabled:cursor-wait'
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
                      // aria-disabled, not disabled: paging to the edge
                      // disables the focused button and drops focus to
                      // <body>, ending keyboard navigation mid-row.
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

              <div className='grid grid-cols-1 gap-3 pb-2 sm:grid-cols-2 xl:grid-cols-4'>
                {shouldShowEpisodeProgressSkeleton ? (
                  EPISODE_SKELETON_TILES
                ) : visibleEpisodes.length === 0 && episodeSearch.trim() ? (
                  <p className='col-span-full py-14 text-center text-sm text-zinc-400'>
                    No episodes match &ldquo;
                    {episodeSearch}&rdquo;
                  </p>
                ) : (
                  visibleEpisodes.map((ep) => {
                    const epProgress = episodeProgressMap.get(
                      episodeProgressKey(baseRouteId, ep.season, ep.episode),
                    );
                    const optimisticWatched = optimisticEpisodeWatched(ep);
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
                      seriesCanResume &&
                      episodeMatchesCoordinates(ep, seriesResumeSeason, seriesResumeEpisode);

                    return (
                      <EpisodeCard
                        key={ep.id}
                        episode={ep}
                        isResume={isResumeEp}
                        isSpoiler={
                          maxWatchedEpisodeInSeason !== null &&
                          !epProgress?.has_started_watching &&
                          ep.episode > maxWatchedEpisodeInSeason
                        }
                        isWatched={optimisticWatched ?? !!epProgress?.is_watched}
                        isWatchedPending={episodeWatchedPending || markSeasonWatched.isPending}
                        progressPercent={progressPercent}
                        resumeRef={isResumeEp ? resumeEpisodeRef : undefined}
                        onPlay={handleWatchEpisode}
                        onToggleWatched={handleToggleEpisodeWatched}
                      />
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Card placeholder paints the hero before the episode payload lands —
          shimmer the episode grid so the section doesn't pop in cold. */}
      {!hasEpisodesSection && isPlaceholderData && item.type === 'series' && (
        <div className={`${DETAILS_COLUMN_CLASS} py-8`}>
          <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4'>
            {EPISODE_SKELETON_TILES}
          </div>
        </div>
      )}

      <DetailsSimilarTitles item={item} contentInsetsClassName={DETAILS_COLUMN_CLASS} />

      {/* Target stays mounted after close so Radix can play the exit
          animation; `open` alone drives the dialog state. */}
      {streamTarget && (
        <StreamSelector
          open={streamSelectorOpen}
          onClose={handleSelectorClose}
          target={streamTarget}
          getStartTime={getStreamTargetStartTime}
        />
      )}

      <DetailsTrailerDialog
        open={trailerOpen}
        onOpenChange={onTrailerOpenChange}
        trailerUrl={trailerUrl}
        title={item.title}
      />
    </div>
  );
}

function DetailsSkeleton() {
  return (
    <div className='min-h-screen bg-background'>
      <div className='relative h-[70vh] w-full -mt-8 overflow-hidden'>
        <div className='absolute inset-0 bg-zinc-950' />
        <div className='absolute inset-0 bg-linear-to-t from-background via-background/60 to-transparent' />
        <div className='absolute bottom-0 left-0 right-0 h-64 bg-linear-to-t from-background to-transparent' />
      </div>

      <div className={`${DETAILS_COLUMN_CLASS} -mt-56 relative z-10`}>
        <div className='flex flex-col gap-6 w-full max-w-4xl animate-pulse'>
          <Skeleton className='h-10 w-72 max-w-full bg-zinc-800/60' />
          <div className='flex gap-3'>
            <Skeleton className='h-5 w-14 bg-zinc-800/50' />
            <Skeleton className='h-5 w-20 bg-zinc-800/50' />
            <Skeleton className='h-5 w-16 bg-zinc-800/50' />
          </div>
          <div className='space-y-2.5'>
            <Skeleton className='h-4 w-full max-w-lg bg-zinc-800/40' />
            <Skeleton className='h-4 w-4/5 max-w-md bg-zinc-800/40' />
          </div>
          <div className='flex gap-3 pt-3'>
            <Skeleton className='h-11 w-36 rounded-lg bg-zinc-800/50' />
            <Skeleton className='h-11 w-11 rounded-lg bg-zinc-800/40' />
          </div>
        </div>
      </div>
    </div>
  );
}
