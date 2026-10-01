import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { ADDON_CONFIGS_QUERY_KEY, ADDON_CONFIGS_STALE_TIME_MS } from '@/lib/query-invalidation';

/// One owner for the addon-config manifest read — home/search genre menus,
/// the stream-selector source filter, and settings all share the same key,
/// stale time, and queryFn so a `select`-free duplicate can't fork the entry.
export function useAddonConfigs(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ADDON_CONFIGS_QUERY_KEY,
    queryFn: api.getAddonConfigs,
    enabled: options?.enabled ?? true,
    staleTime: ADDON_CONFIGS_STALE_TIME_MS,
  });
}
