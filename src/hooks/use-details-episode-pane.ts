import { useCallback, useMemo, useState } from 'react';

import type { LocalSeasonEntry } from '@/components/details-season-switcher';
import { type Episode, type MediaDetails } from '@/lib/api';
import {
  EPISODE_SEARCH_MIN_COUNT,
  filterEpisodesBySearchQuery,
  useEffectiveEpisodeSearch,
} from '@/lib/episode-search';
import { boundedMapSet, clamp } from '@/lib/utils';

const EPISODE_DISPLAY_PAGE_SIZE = 8;
const EMPTY_EPISODES: Episode[] = [];

// Per-season page memory across remounts: leaving for an episode/player and
// coming back remounts details, resetting component state to page 0 — the map
// lands the user on the page they left. Bounded FIFO so the session map can't
// accumulate an entry per title×season visited.
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
  /// `location.key` — identifies this navigation, so a user season pick
  /// can't leak onto a fresh navigation to the same title.
  locationKey: string;
  locationSeason: number | null;
  resumeSeason?: number;
  resumeEpisode?: number;
  isLoadingWatchHistory: boolean;
}

interface UseDetailsEpisodePaneResult {
  seasonCount: number;
  selectedSeason: number | null;
  localSeasonEntries: LocalSeasonEntry[];
  /** All episodes in the selected season — the page's watched-count fold
      iterates this instead of re-filtering `item.episodes`. */
  seasonEpisodes: Episode[];
  visibleEpisodes: Episode[];
  episodeSearch: string;
  setEpisodeSearch: React.Dispatch<React.SetStateAction<string>>;
  selectSeason: (seasonNumber: number) => void;
  shouldShowEpisodeSearch: boolean;
  episodeRangeLabel: string;
  totalEpisodeCount: number;
  totalEpisodePages: number;
  activeEpisodePageIndex: number;
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
  resumeSeason,
  resumeEpisode,
  isLoadingWatchHistory,
}: UseDetailsEpisodePaneArgs): UseDetailsEpisodePaneResult {
  // Keyed by navigation like `episodePageOverride` is keyed by title+season:
  // the parent only keys on `${type}-${id}`, so a fresh navigation to the same
  // title must not inherit a stale season pick.
  const [userSeasonSelection, setUserSeasonSelection] = useState<{
    key: string;
    season: number;
  } | null>(null);
  const userSelectedSeason =
    userSeasonSelection?.key === locationKey ? userSeasonSelection.season : null;
  // Keyed like the season pick above: a fresh navigation to the same title
  // must not inherit the previous visit's search text.
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
  // Render trigger only — `episodePageMemory` owns persistence; the override
  // exists so a page change re-renders before the map read below. Keyed so a
  // stale override can't leak onto a different title/season.
  const [episodePageOverride, setEpisodePageOverride] = useState<{
    key: string;
    page: number;
  } | null>(null);

  const effectiveEpisodeSearch = useEffectiveEpisodeSearch(episodeSearch);
  const selectedSeasonHint =
    userSelectedSeason ??
    locationSeason ??
    (typeof resumeSeason === 'number' ? resumeSeason : null);
  const hasEpisodeSearch = effectiveEpisodeSearch.length > 0;

  // Episodes arrive (season, episode)-sorted from the backend — grouping
  // preserves that order and season keys insert already ascending.
  const { seasons, episodesBySeason } = useMemo(() => {
    const grouped = new Map<number, Episode[]>();
    for (const episode of item?.episodes ?? []) {
      const seasonEpisodes = grouped.get(episode.season);
      if (seasonEpisodes) {
        seasonEpisodes.push(episode);
      } else {
        grouped.set(episode.season, [episode]);
      }
    }
    return {
      seasons: Array.from(grouped.keys()),
      episodesBySeason: grouped,
    };
  }, [item?.episodes]);

  const selectedSeason = useMemo(() => {
    if (selectedSeasonHint !== null && seasons.includes(selectedSeasonHint)) {
      return selectedSeasonHint;
    }
    if (seasons.length === 0) return null;
    return seasons.includes(1) ? 1 : seasons[0];
  }, [selectedSeasonHint, seasons]);

  const localSeasonEntries = useMemo(() => {
    return seasons.map((seasonNumber) => ({
      number: seasonNumber,
      shortLabel: formatSeasonShortLabel(seasonNumber),
      episodeCount: episodesBySeason.get(seasonNumber)?.length ?? 0,
    }));
  }, [episodesBySeason, seasons]);

  const resumeEpisodeForSelectedSeason =
    item?.type === 'series' &&
    typeof resumeEpisode === 'number' &&
    (selectedSeason === null || resumeSeason === selectedSeason)
      ? resumeEpisode
      : null;

  // Key on the route id, not `item.id`: it's stable from mount (no mid-load
  // key flip when metadata lands) and matches the identity the progress
  // reads/writes use.
  const currentEpisodeSeasonKey = `${effectiveRouteId || 'unknown'}:${selectedSeason ?? 'none'}`;
  const episodePageKey = hasEpisodeSearch
    ? JSON.stringify([currentEpisodeSeasonKey, effectiveEpisodeSearch])
    : currentEpisodeSeasonKey;
  const seasonEpisodes =
    selectedSeason === null
      ? EMPTY_EPISODES
      : (episodesBySeason.get(selectedSeason) ?? EMPTY_EPISODES);
  const resumeEpisodeIndex = seasonEpisodes.findIndex(
    (episode) => episode.episode === resumeEpisodeForSelectedSeason,
  );
  const defaultEpisodePageIndex =
    resumeEpisodeIndex >= 0 ? Math.floor(resumeEpisodeIndex / EPISODE_DISPLAY_PAGE_SIZE) : 0;
  const requestedEpisodePageIndex =
    (episodePageOverride?.key === episodePageKey ? episodePageOverride.page : undefined) ??
    (hasEpisodeSearch
      ? 0
      : (episodePageMemory.get(currentEpisodeSeasonKey) ?? defaultEpisodePageIndex));

  const searchFilteredEpisodes = useMemo(
    () => filterEpisodesBySearchQuery(seasonEpisodes, effectiveEpisodeSearch),
    [effectiveEpisodeSearch, seasonEpisodes],
  );

  const totalEpisodeCount = hasEpisodeSearch
    ? searchFilteredEpisodes.length
    : seasonEpisodes.length;
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
    if (selectedSeason === null) return [];

    const start = activeEpisodePageIndex * EPISODE_DISPLAY_PAGE_SIZE;
    return searchFilteredEpisodes.slice(start, start + EPISODE_DISPLAY_PAGE_SIZE);
  }, [activeEpisodePageIndex, searchFilteredEpisodes, selectedSeason]);

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

  return {
    seasonCount: seasons.length,
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
  };
}
