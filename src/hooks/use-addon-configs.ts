import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { ADDON_CONFIGS_STALE_TIME_MS, BROWSE_GENRES_QUERY_KEY } from '@/lib/query-invalidation';

/// One addon-config registry query shared by Home and Settings.
export function useAddonConfigs() {
  return useQuery(api.addonConfigsQueryOptions());
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
