import type {
  BrowseGenres,
  CalendarRange,
  CalendarSchedule,
  MediaDetails,
  MediaItem,
  SearchCatalogPage,
  SearchCatalogQuery,
} from '@/lib/api';
import type { InvokeApi } from '@/lib/api-core';

interface DiscoveryApiContext {
  safeInvoke: InvokeApi;
}

export function createDiscoveryApi({ safeInvoke }: DiscoveryApiContext) {
  // Rust owns request normalization, resource caching and overlapping fetches;
  // React Query owns view payloads and their invalidation.
  const querySearchCatalogPage = (request: SearchCatalogQuery) =>
    safeInvoke<SearchCatalogPage>('query_search_catalog', { request });

  const getMediaDetails = (type: string, id: string) =>
    safeInvoke<MediaDetails>('get_media_details', {
      mediaType: type,
      id,
      includeEpisodes: true,
    });

  const getMediaCardDetails = (type: string, id: string) =>
    safeInvoke<MediaDetails>('get_media_details', {
      mediaType: type,
      id,
      includeEpisodes: false,
    });

  const getCalendarEvents = (range: CalendarRange) =>
    safeInvoke<CalendarSchedule>('get_calendar_events', { range });

  const getBrowseGenres = () => safeInvoke<BrowseGenres>('get_browse_genres');

  // Rust picks the browse catalog and seed genres from the source's genres.
  const querySimilarTitles = (source: MediaItem) =>
    safeInvoke<MediaItem[]>('query_similar_titles', {
      source: {
        id: source.id,
        title: source.title,
        type: source.type,
        year: source.year,
        genres: source.genres,
      },
    });

  return {
    querySearchCatalogPage,
    getMediaDetails,
    getMediaCardDetails,
    getCalendarEvents,
    getBrowseGenres,
    querySimilarTitles,
  };
}
