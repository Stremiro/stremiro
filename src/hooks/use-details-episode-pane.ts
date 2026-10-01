import { useCallback, useMemo, useState } from 'react';

import type { LocalSeasonEntry } from '@/components/details-season-switcher';
import { useDebounce } from '@/hooks/use-debounce';
import { type Episode, type MediaDetails } from '@/lib/api';
import {
  EPISODE_SEARCH_DEBOUNCE_MS,
  EPISODE_SEARCH_MIN_COUNT,
  filterEpisodesBySearchQuery,
} from '@/lib/episode-search';

const EPISODE_DISPLAY_PAGE_SIZE = 8;
const EMPTY_EPISODES: Episode[] = [];

// Per-season page memory across remounts: leaving for an episode/player and
// coming back remounts details, resetting component state to page 0 — the map
// lands the user on the page they left. Bounded FIFO so the session map can't
// accumulate an entry per title×season visited.
const EPISODE_PAGE_MEMORY_MAX = 256;
const episodePageMemory = new Map<string, number>();

function rememberEpisodePage(key: string, page: number): void {
  // Re-set refreshes recency; evict the oldest key at capacity.
  episodePageMemory.delete(key);
  episodePageMemory.set(key, page);
  if (episodePageMemory.size > EPISODE_PAGE_MEMORY_MAX) {
    const oldest = episodePageMemory.keys().next().value;
    if (oldest !== undefined) episodePageMemory.delete(oldest);
  }
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
  const [episodeSearch, setEpisodeSearch] = useState('');
  // Render trigger only — `episodePageMemory` owns persistence; the override
  // exists so a page change re-renders before the map read below. Keyed so a
  // stale override can't leak onto a different title/season.
  const [episodePageOverride, setEpisodePageOverride] = useState<{
    key: string;
    page: number;
  } | null>(null);

  const debouncedEpisodeSearch = useDebounce(episodeSearch.trim(), EPISODE_SEARCH_DEBOUNCE_MS);
  // A cleared field must take effect immediately — otherwise the stale
  // debounced query keeps filtering the freshly selected season's rows for
  // up to a debounce window (a blank grid with no empty-state message).
  const effectiveEpisodeSearch = episodeSearch.trim() ? debouncedEpisodeSearch : '';
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
  const defaultEpisodePageIndex =
    resumeEpisodeForSelectedSeason !== null && resumeEpisodeForSelectedSeason > 0
      ? Math.floor((resumeEpisodeForSelectedSeason - 1) / EPISODE_DISPLAY_PAGE_SIZE)
      : 0;
  const requestedEpisodePageIndex = hasEpisodeSearch
    ? 0
    : ((episodePageOverride?.key === currentEpisodeSeasonKey
        ? episodePageOverride.page
        : undefined) ??
      episodePageMemory.get(currentEpisodeSeasonKey) ??
      defaultEpisodePageIndex);

  const seasonEpisodes =
    selectedSeason === null
      ? EMPTY_EPISODES
      : (episodesBySeason.get(selectedSeason) ?? EMPTY_EPISODES);

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
      const nextPage = Math.max(0, Math.min(activeEpisodePageIndex + delta, totalEpisodePages - 1));
      if (nextPage === activeEpisodePageIndex) return;

      rememberEpisodePage(currentEpisodeSeasonKey, nextPage);
      setEpisodePageOverride({ key: currentEpisodeSeasonKey, page: nextPage });
    },
    [activeEpisodePageIndex, currentEpisodeSeasonKey, totalEpisodePages],
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
    [locationKey],
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
