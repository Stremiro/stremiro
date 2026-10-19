import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { ADDON_CONFIGS_STALE_TIME_MS, BROWSE_GENRES_QUERY_KEY } from '@/lib/query-invalidation';

/// Single addon-config registry read shared by stream-selector filter and settings — one key/queryFn so no forked cache entry.
export function useAddonConfigs(options?: { enabled?: boolean }) {
  return useQuery({
    ...api.addonConfigsQueryOptions(),
    enabled: options?.enabled ?? true,
  });
}

/// Genre menus for home/search, computed in Rust from enabled addons; same stale time as the registry.
export function useBrowseGenres(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: BROWSE_GENRES_QUERY_KEY,
    queryFn: api.getBrowseGenres,
    enabled: options?.enabled ?? true,
    staleTime: ADDON_CONFIGS_STALE_TIME_MS,
  });
}
