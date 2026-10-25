import { useMemo, useState } from 'react';

import { EPISODE_SEARCH_MIN_COUNT, useEpisodeSearch } from '@/hooks/use-episode-search';
import { type Episode, type MediaDetails } from '@/lib/api';
import { boundedMapSet, clamp } from '@/lib/utils';

const EPISODE_DISPLAY_PAGE_SIZE = 9;
const EMPTY_EPISODES: Episode[] = [];
const EMPTY_SEASONS: NonNullable<MediaDetails['seasons']> = [];

// Per-season page memory across remounts: details remounts on player return and
// would reset to page 0. Bounded FIFO so the map can't grow per title×season.
const EPISODE_PAGE_MEMORY_MAX = 256;
const episodePageMemory = new Map<string, number>();

interface EpisodePaneState {
  key: string;
  season: number | null;
  search: string;
  page: { key: string; page: number } | null;
}

const episodePaneMemory = new Map<string, EpisodePaneState>();

function episodesInSeason(item: MediaDetails | undefined, season: number) {
  return (item?.episodes ?? EMPTY_EPISODES).filter((episode) => episode.season === season);
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
}

export function useDetailsEpisodePane({
  item,
  effectiveRouteId,
  locationKey,
  locationSeason,
  locationEpisode,
  resumeSeason,
  resumeEpisode,
}: UseDetailsEpisodePaneArgs) {
  // Restore Back/Forward landings without leaking picks into a fresh navigation.
  const paneKey = JSON.stringify([effectiveRouteId, locationKey]);
  const [paneState, setPaneState] = useState<EpisodePaneState | null>(null);
  const pane = paneState?.key === paneKey ? paneState : episodePaneMemory.get(paneKey);
  const userSelectedSeason = pane?.season ?? null;
  const episodeSearch = pane?.search ?? '';
  const episodePageOverride = pane?.page;
  const updatePane = (update: (previous: EpisodePaneState) => EpisodePaneState) => {
    const current = episodePaneMemory.get(paneKey) ??
      pane ?? { key: paneKey, season: null, search: '', page: null };
    const next = update(current);
    if (next === current) return;
    boundedMapSet(episodePaneMemory, paneKey, next, EPISODE_PAGE_MEMORY_MAX);
    setPaneState(next);
  };
  const selectedSeasonHint =
    userSelectedSeason ??
    locationSeason ??
    (typeof resumeSeason === 'number' ? resumeSeason : null);

  // `item.seasons` is the backend summary of sorted `episodes`; numbers ascend.
  const seasons = item?.seasons ?? EMPTY_SEASONS;
  const selectedSeason =
    selectedSeasonHint !== null && seasons.some((season) => season.number === selectedSeasonHint)
      ? selectedSeasonHint
      : ((seasons.find((season) => season.number > 0) ?? seasons[0])?.number ?? null);

  const setEpisodeSearch = (value: React.SetStateAction<string>) =>
    updatePane((previous) => {
      const search = typeof value === 'function' ? value(previous.search) : value;
      return search === previous.search
        ? previous
        : {
            ...previous,
            season: locationSeason === null ? selectedSeason : previous.season,
            search,
          };
    });

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
  const episodeSeasonKey = (season: number | 'none') =>
    `${effectiveRouteId || 'unknown'}:${season}`;
  const currentEpisodeSeasonKey = episodeSeasonKey(selectedSeason ?? 'none');
  const seasonEpisodes = useMemo(
    () => (selectedSeason === null ? EMPTY_EPISODES : episodesInSeason(item, selectedSeason)),
    [item, selectedSeason],
  );
  const shouldShowEpisodeSearch = seasonEpisodes.length > EPISODE_SEARCH_MIN_COUNT;
  const {
    effectiveEpisodeSearch,
    filteredEpisodes: searchFilteredEpisodes,
    searchError: episodeSearchError,
    isSearchFetching: isEpisodeSearchFetching,
    isSearchPending: isEpisodeSearchPending,
    retrySearch: retryEpisodeSearch,
  } = useEpisodeSearch(seasonEpisodes, episodeSearch, shouldShowEpisodeSearch);
  const hasEpisodeSearch = effectiveEpisodeSearch.length > 0;
  const episodePageKey = JSON.stringify([
    locationKey,
    currentEpisodeSeasonKey,
    effectiveEpisodeSearch,
  ]);
  const defaultEpisodeIndex =
    defaultEpisode == null
      ? -1
      : seasonEpisodes.findIndex((episode) => episode.episode === defaultEpisode);
  const resumeEpisodeIndex =
    item?.type === 'series' && resumeSeason !== undefined && resumeEpisode !== undefined
      ? (resumeSeason === selectedSeason
          ? seasonEpisodes
          : episodesInSeason(item, resumeSeason)
        ).findIndex((episode) => episode.episode === resumeEpisode)
      : -1;
  const resumeEpisodePageIndex =
    resumeEpisodeIndex >= 0 ? Math.floor(resumeEpisodeIndex / EPISODE_DISPLAY_PAGE_SIZE) : null;
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

  const retainEpisodePosition = () =>
    updatePane((previous) => ({
      ...previous,
      season: selectedSeason,
      page: { key: episodePageKey, page: activeEpisodePageIndex },
    }));

  const changeEpisodePage = (direction: 'previous' | 'next') => {
    const delta = direction === 'previous' ? -1 : 1;
    const nextPage = clamp(activeEpisodePageIndex + delta, 0, totalEpisodePages - 1);
    if (nextPage === activeEpisodePageIndex) return;

    if (!hasEpisodeSearch)
      boundedMapSet(episodePageMemory, currentEpisodeSeasonKey, nextPage, EPISODE_PAGE_MEMORY_MAX);
    updatePane((previous) => ({
      ...previous,
      season: selectedSeason,
      page: { key: episodePageKey, page: nextPage },
    }));
  };

  const pageStart = activeEpisodePageIndex * EPISODE_DISPLAY_PAGE_SIZE;
  const visibleEpisodes = searchFilteredEpisodes.slice(
    pageStart,
    pageStart + EPISODE_DISPLAY_PAGE_SIZE,
  );

  const hasPreviousEpisodes = activeEpisodePageIndex > 0;
  const hasMoreEpisodes = activeEpisodePageIndex < totalEpisodePages - 1;
  const visibleEpisodeStart = totalEpisodeCount === 0 ? 0 : pageStart + 1;
  const visibleEpisodeEnd =
    totalEpisodeCount === 0
      ? 0
      : Math.min(totalEpisodeCount, visibleEpisodeStart + visibleEpisodes.length - 1);
  const episodeRangeLabel =
    visibleEpisodeStart > 0 ? `Episodes ${visibleEpisodeStart}-${visibleEpisodeEnd}` : 'Episodes';

  const selectSeason = (seasonNumber: number) => {
    updatePane((previous) =>
      previous.season === seasonNumber && !previous.search
        ? previous
        : { ...previous, season: seasonNumber, search: '' },
    );
  };

  const jumpToEpisode = (seasonNumber: number, episodeNumber: number) => {
    const index = episodesInSeason(item, seasonNumber).findIndex(
      (episode) => episode.episode === episodeNumber,
    );
    if (index < 0) return;
    const page = Math.floor(index / EPISODE_DISPLAY_PAGE_SIZE);
    const seasonKey = episodeSeasonKey(seasonNumber);
    boundedMapSet(episodePageMemory, seasonKey, page, EPISODE_PAGE_MEMORY_MAX);
    updatePane((previous) => ({
      ...previous,
      season: seasonNumber,
      search: '',
      page: { key: JSON.stringify([locationKey, seasonKey, '']), page },
    }));
  };

  return {
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
  };
}
