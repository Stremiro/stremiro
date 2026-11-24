import type { Query, QueryClient } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import { APP_UPDATE_STATE_QUERY_KEY } from '@/lib/app-updater';
import { pruneExpiredStreamCache } from '@/lib/api-cache';
import {
  APP_UI_PREFERENCES_QUERY_KEY,
  DEFAULT_PLAYER_KEYBINDINGS_QUERY_KEY,
  PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
  PROFILE_PREFERENCES_QUERY_KEY,
  STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
  SUPPORTED_LANGUAGES_QUERY_KEY,
} from '@/lib/query-invalidation';

const PRESERVED_QUERY_PREFIXES = new Set<string>([
  APP_UPDATE_STATE_QUERY_KEY[0],
  PROFILE_PREFERENCES_QUERY_KEY[0],
  APP_UI_PREFERENCES_QUERY_KEY[0],
  STREAM_SELECTOR_PREFERENCES_QUERY_KEY[0],
  PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY[0],
  DEFAULT_PLAYER_KEYBINDINGS_QUERY_KEY[0],
  SUPPORTED_LANGUAGES_QUERY_KEY[0],
]);

function isPreservedQueryKey(queryKey: readonly unknown[]): boolean {
  const head = queryKey[0];
  return typeof head === 'string' && PRESERVED_QUERY_PREFIXES.has(head);
}

type StaleTimeOption =
  | number
  | 'static'
  | ((query: Query<unknown, Error, unknown>) => number | 'static')
  | undefined;

function resolveEffectiveStaleTime(
  queryClient: QueryClient,
  query: Query<unknown, Error, unknown>,
): number | 'static' {
  const options = query.options as { staleTime?: StaleTimeOption };
  const raw: StaleTimeOption =
    options.staleTime ??
    (queryClient.getQueryDefaults(query.queryKey).staleTime as StaleTimeOption) ??
    queryClient.getDefaultOptions().queries?.staleTime ??
    0;
  return typeof raw === 'function' ? raw(query) : raw;
}

/**
 * Drops expired stream cache entries and stale, truly unobserved React Query
 * entries during hidden/minimized background maintenance. Mounted observers
 * (even disabled ones), in-flight fetches, staged launches, update state,
 * caller-configured static/infinite queries, and user preferences stay untouched.
 */
export function trimFrontendMemory(queryClient: QueryClient): number {
  pruneExpiredStreamCache();

  let removed = 0;
  queryClient.removeQueries({
    type: 'inactive',
    predicate: (query) => {
      if (query.getObserversCount() > 0) return false;
      if (query.state.fetchStatus !== 'idle') return false;
      if (isPreservedQueryKey(query.queryKey)) return false;

      const staleTime = resolveEffectiveStaleTime(queryClient, query);
      if (staleTime === 'static' || !Number.isFinite(staleTime)) return false;
      if (!query.isStaleByTime(staleTime)) return false;

      removed += 1;
      return true;
    },
  });

  return removed;
}

export function registerMemoryTrimListener(queryClient: QueryClient): Promise<() => void> {
  return listen('app://memory-trim', () => {
    // Drop late background trim events if the window is already visible again.
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
    trimFrontendMemory(queryClient);
  });
}
