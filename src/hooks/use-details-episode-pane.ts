import { useCallback, useMemo, useState } from 'react';

import type { LocalSeasonEntry } from '@/components/details-season-switcher';
import { EPISODE_SEARCH_MIN_COUNT, useEpisodeSearch } from '@/hooks/use-episode-search';
import { type Episode, type MediaDetails } from '@/lib/api';
import { boundedMapSet, clamp } from '@/lib/utils';

const EPISODE_DISPLAY_PAGE_SIZE = 8;
const EMPTY_EPISODES: Episode[] = [];

// Per-season page memory across remounts: details remounts on player return and
// would reset to page 0. Bounded FIFO so the map can't grow per title×season.
const EPISODE_PAGE_MEMORY_MAX = 256;
const episodePageMemory = new Map<string, number>();

function rememberEpisodePage(key: string, page: number): void {
  boundedMapSet(episodePageMemory, key, page, EPISODE_PAGE_MEMORY_MAX);
}

function formatSeasonShortLabel(seasonNumber: number): string {
  return seasonNumber === 0 ? 'Specials' : `S${seasonNumber}`;
}

interface UseDetailsEpisodePaneArgs {
  item?: MediaDetails;
  effectiveRouteId: string;
  /// `location.key` — identifies this navigation, so a season pick can't leak onto a fresh navigation to the same title.
  locationKey: string;
  locationSeason: number | null;
  locationEpisode?: number | null;
  resumeSeason?: number;
  resumeEpisode?: number;
  isLoadingWatchHistory: boolean;
}

interface UseDetailsEpisodePaneResult {
  seasonCount: number;
  selectedSeason: number | null;
  localSeasonEntries: LocalSeasonEntry[];
  /** All episodes in the selected season (the watched-count fold iterates this). */
  seasonEpisodes: Episode[];
  visibleEpisodes: Episode[];
  episodeSearch: string;
  episodeSearchError: boolean;
  isEpisodeSearchFetching: boolean;
  isEpisodeSearchPending: boolean;
  retryEpisodeSearch: () => void;
  setEpisodeSearch: React.Dispatch<React.SetStateAction<string>>;
  selectSeason: (seasonNumber: number) => void;
  jumpToEpisode: (seasonNumber: number, episodeNumber: number) => void;
  shouldShowEpisodeSearch: boolean;
  episodeRangeLabel: string;
  totalEpisodeCount: number;
  totalEpisodePages: number;
  activeEpisodePageIndex: number;
  resumeEpisodePageIndex: number | null;
  visibleEpisodeStart: number;
  hasPreviousEpisodes: boolean;
  hasMoreEpisodes: boolean;
  changeEpisodePage: (direction: 'previous' | 'next') => void;
  shouldShowEpisodeProgressSkeleton: boolean;
}

export function useDetailsEpisodePane({
  item,
  effectiveRouteId,
  locationKey,
  locationSeason,
  locationEpisode,
  resumeSeason,
  resumeEpisode,
  isLoadingWatchHistory,
}: UseDetailsEpisodePaneArgs): UseDetailsEpisodePaneResult {
  // Keyed by navigation: a fresh navigation to the same title must not inherit
  // a stale season pick.
  const [userSeasonSelection, setUserSeasonSelection] = useState<{
    key: string;
    season: number;
  } | null>(null);
  const userSelectedSeason =
    userSeasonSelection?.key === locationKey ? userSeasonSelection.season : null;
  // Keyed like the season pick above so fresh navigation doesn't inherit search text.
  const [episodeSearchState, setEpisodeSearchState] = useState<{
    key: string;
    value: string;
  } | null>(null);
  const episodeSearch = episodeSearchState?.key === locationKey ? episodeSearchState.value : '';
  const setEpisodeSearch = useCallback(
    (value: React.SetStateAction<string>) =>
      setEpisodeSearchState((previous) => {
        const current = previous?.key === locationKey ? previous.value : '';
        const next = typeof value === 'function' ? value(current) : value;
        if (current === next && (previous === null || previous.key === locationKey)) {
          return previous;
        }
        return { key: locationKey, value: next };
      }),
    [locationKey],
  );
  // Render trigger only — `episodePageMemory` owns persistence; keyed so a stale
  // override can't leak onto a different title/season.
  const [episodePageOverride, setEpisodePageOverride] = useState<{
    key: string;
    page: number;
  } | null>(null);

  const selectedSeasonHint =
    userSelectedSeason ??
    locationSeason ??
    (typeof resumeSeason === 'number' ? resumeSeason : null);

  // `item.seasons` is the backend summary of sorted `episodes`; numbers ascend.
  const seasons = useMemo(
    () => item?.seasons?.map((season) => season.number) ?? [],
    [item?.seasons],
  );

  const selectedSeason = useMemo(() => {
    if (selectedSeasonHint !== null && seasons.includes(selectedSeasonHint)) {
      return selectedSeasonHint;
    }
    if (seasons.length === 0) return null;
    return seasons.includes(1) ? 1 : seasons[0];
  }, [selectedSeasonHint, seasons]);

  const localSeasonEntries = useMemo(
    () =>
      (item?.seasons ?? []).map((season) => ({
        number: season.number,
        shortLabel: formatSeasonShortLabel(season.number),
        episodeCount: season.episodeCount,
      })),
    [item?.seasons],
  );

  const resumeEpisodeForSelectedSeason =
    item?.type === 'series' &&
    typeof resumeEpisode === 'number' &&
    (selectedSeason === null || resumeSeason === selectedSeason)
      ? resumeEpisode
      : null;
  const shouldUseLocationEpisode =
    userSelectedSeason === null &&
    locationSeason !== null &&
    selectedSeason === locationSeason &&
    typeof locationEpisode === 'number';
  const defaultEpisode = shouldUseLocationEpisode
    ? locationEpisode
    : resumeEpisodeForSelectedSeason;

  // Key on the route id, not `item.id`: stable from mount (no flip when metadata
  // lands) and matches the identity progress reads/writes use.
  const currentEpisodeSeasonKey = `${effectiveRouteId || 'unknown'}:${selectedSeason ?? 'none'}`;
  const seasonEpisodes = useMemo(
    () =>
      selectedSeason === null
        ? EMPTY_EPISODES
        : (item?.episodes ?? EMPTY_EPISODES).filter((episode) => episode.season === selectedSeason),
    [item?.episodes, selectedSeason],
  );
  const {
    effectiveEpisodeSearch,
    filteredEpisodes: searchFilteredEpisodes,
    searchError: episodeSearchError,
    isSearchFetching: isEpisodeSearchFetching,
    isSearchPending,
    retrySearch: retryEpisodeSearch,
  } = useEpisodeSearch(seasonEpisodes, episodeSearch);
  const trimmedEpisodeSearch = episodeSearch.trim();
  const isEpisodeSearchPending =
    trimmedEpisodeSearch.length > 0 &&
    (isSearchPending || trimmedEpisodeSearch !== effectiveEpisodeSearch);
  const hasEpisodeSearch = effectiveEpisodeSearch.length > 0;
  const episodePageKey = JSON.stringify([
    locationKey,
    currentEpisodeSeasonKey,
    effectiveEpisodeSearch,
  ]);
  const defaultEpisodeIndex = useMemo(
    () =>
      defaultEpisode == null
        ? -1
        : seasonEpisodes.findIndex((episode) => episode.episode === defaultEpisode),
    [defaultEpisode, seasonEpisodes],
  );
  const resumeEpisodePageIndex = useMemo(() => {
    if (item?.type !== 'series' || resumeSeason === undefined || resumeEpisode === undefined) {
      return null;
    }
    const episodes =
      resumeSeason === selectedSeason
        ? seasonEpisodes
        : (item.episodes ?? EMPTY_EPISODES).filter((episode) => episode.season === resumeSeason);
    const index = episodes.findIndex((episode) => episode.episode === resumeEpisode);
    return index >= 0 ? Math.floor(index / EPISODE_DISPLAY_PAGE_SIZE) : null;
  }, [item?.type, item?.episodes, resumeSeason, resumeEpisode, selectedSeason, seasonEpisodes]);
  const defaultEpisodePageIndex =
    defaultEpisodeIndex >= 0 ? Math.floor(defaultEpisodeIndex / EPISODE_DISPLAY_PAGE_SIZE) : 0;
  // Explicit navigation coordinates beat old page memory until the user picks a
  // season or page. Returning to a remembered title must still open the linked episode.
  const initialEpisodePageIndex =
    shouldUseLocationEpisode && defaultEpisodeIndex >= 0
      ? defaultEpisodePageIndex
      : (episodePageMemory.get(currentEpisodeSeasonKey) ?? defaultEpisodePageIndex);
  const requestedEpisodePageIndex =
    (episodePageOverride?.key === episodePageKey ? episodePageOverride.page : undefined) ??
    (hasEpisodeSearch ? 0 : initialEpisodePageIndex);

  const totalEpisodeCount = searchFilteredEpisodes.length;
  const totalEpisodePages = Math.max(1, Math.ceil(totalEpisodeCount / EPISODE_DISPLAY_PAGE_SIZE));
  const activeEpisodePageIndex = Math.min(requestedEpisodePageIndex, totalEpisodePages - 1);

  const changeEpisodePage = useCallback(
    (direction: 'previous' | 'next') => {
      const delta = direction === 'previous' ? -1 : 1;
      const nextPage = clamp(activeEpisodePageIndex + delta, 0, totalEpisodePages - 1);
      if (nextPage === activeEpisodePageIndex) return;

      if (!hasEpisodeSearch) rememberEpisodePage(currentEpisodeSeasonKey, nextPage);
      setEpisodePageOverride({ key: episodePageKey, page: nextPage });
    },
    [
      activeEpisodePageIndex,
      currentEpisodeSeasonKey,
      episodePageKey,
      hasEpisodeSearch,
      totalEpisodePages,
    ],
  );

  const visibleEpisodes = useMemo(() => {
    const start = activeEpisodePageIndex * EPISODE_DISPLAY_PAGE_SIZE;
    return searchFilteredEpisodes.slice(start, start + EPISODE_DISPLAY_PAGE_SIZE);
  }, [activeEpisodePageIndex, searchFilteredEpisodes]);

  const shouldShowEpisodeSearch = seasonEpisodes.length > EPISODE_SEARCH_MIN_COUNT;
  const hasPreviousEpisodes = activeEpisodePageIndex > 0;
  const hasMoreEpisodes = activeEpisodePageIndex < totalEpisodePages - 1;
  const visibleEpisodeStart =
    totalEpisodeCount === 0 ? 0 : activeEpisodePageIndex * EPISODE_DISPLAY_PAGE_SIZE + 1;
  const visibleEpisodeEnd =
    totalEpisodeCount === 0
      ? 0
      : Math.min(totalEpisodeCount, visibleEpisodeStart + visibleEpisodes.length - 1);
  const episodeRangeLabel =
    visibleEpisodeStart > 0 ? `Episodes ${visibleEpisodeStart}-${visibleEpisodeEnd}` : 'Episodes';
  const shouldShowEpisodeProgressSkeleton = item?.type === 'series' && isLoadingWatchHistory;

  const selectSeason = useCallback(
    (seasonNumber: number) => {
      setUserSeasonSelection((previous) =>
        previous?.key === locationKey && previous.season === seasonNumber
          ? previous
          : { key: locationKey, season: seasonNumber },
      );
      setEpisodeSearch('');
    },
    [locationKey, setEpisodeSearch],
  );

  const jumpToEpisode = useCallback(
    (seasonNumber: number, episodeNumber: number) => {
      const episodes = (item?.episodes ?? EMPTY_EPISODES).filter(
        (episode) => episode.season === seasonNumber,
      );
      const index = episodes.findIndex((episode) => episode.episode === episodeNumber);
      if (index < 0) return;
      const page = Math.floor(index / EPISODE_DISPLAY_PAGE_SIZE);
      const seasonKey = `${effectiveRouteId || 'unknown'}:${seasonNumber}`;
      selectSeason(seasonNumber);
      rememberEpisodePage(seasonKey, page);
      setEpisodePageOverride({ key: JSON.stringify([locationKey, seasonKey, '']), page });
    },
    [item?.episodes, effectiveRouteId, locationKey, selectSeason],
  );

  return {
    seasonCount: seasons.length,
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
    shouldShowEpisodeProgressSkeleton,
  };
}
