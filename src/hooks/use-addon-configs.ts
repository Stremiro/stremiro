import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import {
  ADDON_CONFIGS_QUERY_KEY,
  ADDON_CONFIGS_STALE_TIME_MS,
  BROWSE_GENRES_QUERY_KEY,
} from '@/lib/query-invalidation';

/// One owner for the addon-config registry read — the stream-selector source
/// filter and settings share the same key, stale time, and queryFn so a
/// `select`-free duplicate can't fork the entry.
export function useAddonConfigs(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ADDON_CONFIGS_QUERY_KEY,
    queryFn: api.getAddonConfigs,
    enabled: options?.enabled ?? true,
    staleTime: ADDON_CONFIGS_STALE_TIME_MS,
  });
}

/// Manifest-driven genre menus for home and search, computed in Rust from
/// the enabled addons. Same stale time as the registry they derive from.
export function useBrowseGenres(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: BROWSE_GENRES_QUERY_KEY,
    queryFn: api.getBrowseGenres,
    enabled: options?.enabled ?? true,
    staleTime: ADDON_CONFIGS_STALE_TIME_MS,
  });
}
