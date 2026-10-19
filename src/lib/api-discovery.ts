import { queryOptions } from '@tanstack/react-query';
import type {
  BrowseGenres,
  CalendarRange,
  CalendarSchedule,
  DetailsPrefetchBundle,
  Episode,
  EpisodeNavigation,
  EpisodeNavigationRequest,
  MediaDetails,
  MediaItem,
  SearchCatalogPage,
  SearchCatalogQuery,
  UnairedEpisodesRequest,
} from '@/lib/api';
import type { InvokeApi } from '@/lib/api-core';
import {
  detailsCardQueryKey,
  detailsQueryKey,
  DETAILS_GC_TIME_MS,
  DETAILS_STALE_TIME_MS,
  trendingRowQueryKey,
} from '@/lib/query-invalidation';

interface DiscoveryApiContext {
  safeInvoke: InvokeApi;
}

export function similarTitlesQueryKey({ id, title, type, year, genres, description }: MediaItem) {
  return trendingRowQueryKey(
    'similar',
    type,
    id,
    title,
    description ?? '',
    year ?? '',
    ...(genres ?? []),
  );
}

export function createDiscoveryApi({ safeInvoke }: DiscoveryApiContext) {
  // Rust owns normalization/caching/fetch overlap; React Query owns view payloads and invalidation.
  const querySearchCatalogPage = (request: SearchCatalogQuery) =>
    safeInvoke<SearchCatalogPage>('query_search_catalog', { request });

  const getMediaDetails = (type: string, id: string) =>
    safeInvoke<MediaDetails>('get_media_details', {
      mediaType: type,
      id,
      includeEpisodes: true,
    });

  const getEpisodeNavigation = (request: EpisodeNavigationRequest) =>
    safeInvoke<EpisodeNavigation>('get_episode_navigation', { request });

  const getUnairedEpisodeIndices = (request: UnairedEpisodesRequest) =>
    safeInvoke<number[]>('get_unaired_episode_indices', { request });

  const searchEpisodes = (episodes: Episode[], query: string) =>
    safeInvoke<number[]>('search_episodes', {
      query,
      episodes: episodes.map(({ season, episode, title, overview }) => ({
        season,
        episode,
        title,
        overview,
      })),
    });

  const searchTitles = (titles: string[], query: string) =>
    safeInvoke<number[]>('search_titles', { titles, query });

  const getMediaCardDetails = (type: string, id: string) =>
    safeInvoke<MediaDetails>('get_media_details', {
      mediaType: type,
      id,
      includeEpisodes: false,
    });

  const detailsQueryOptions = (type: string, id: string | undefined, missingIdMessage?: string) =>
    queryOptions({
      queryKey: detailsQueryKey(type, id),
      queryFn: () =>
        missingIdMessage && !id
          ? Promise.reject(new Error(missingIdMessage))
          : getMediaDetails(type, id!),
      staleTime: DETAILS_STALE_TIME_MS,
      gcTime: DETAILS_GC_TIME_MS,
    });

  const cardDetailsQueryOptions = (
    type: string,
    id: string | undefined,
    missingIdMessage?: string,
  ) =>
    queryOptions({
      queryKey: detailsCardQueryKey(type, id),
      queryFn: () =>
        missingIdMessage && !id
          ? Promise.reject(new Error(missingIdMessage))
          : getMediaCardDetails(type, id!),
      staleTime: DETAILS_STALE_TIME_MS,
      gcTime: DETAILS_GC_TIME_MS,
    });

  // One IPC for the details-route prefetch: card details + resume snapshot.
  const getDetailsPrefetchBundle = (type: string, id: string) =>
    safeInvoke<DetailsPrefetchBundle>('get_details_prefetch_bundle', {
      mediaType: type,
      id,
    });

  const getCalendarEvents = (range: CalendarRange) =>
    safeInvoke<CalendarSchedule>('get_calendar_events', { range });

  const getBrowseGenres = () => safeInvoke<BrowseGenres>('get_browse_genres');

  const getRecentWatchSeed = () => safeInvoke<MediaItem | null>('get_recent_watch_seed');

  // Rust picks the browse catalog and seed genres from the source's genres.
  const querySimilarTitles = (source: MediaItem) =>
    safeInvoke<MediaItem[]>('query_similar_titles', {
      source: {
        id: source.id,
        title: source.title,
        type: source.type,
        year: source.year,
        genres: source.genres,
        description: source.description,
      },
    });

  return {
    querySearchCatalogPage,
    getMediaDetails,
    detailsQueryOptions,
    cardDetailsQueryOptions,
    getEpisodeNavigation,
    getUnairedEpisodeIndices,
    searchEpisodes,
    searchTitles,
    getMediaCardDetails,
    getDetailsPrefetchBundle,
    getCalendarEvents,
    getBrowseGenres,
    getRecentWatchSeed,
    querySimilarTitles,
  };
}
