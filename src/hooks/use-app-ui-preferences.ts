import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';

import { type AppUiPreferences, type AppUiPreferencesPatch, api } from '@/lib/api';
import {
  claimOptimisticQueryWrite,
  runOptimisticQueryMutation,
  settleOptimisticQueryWrites,
} from '@/lib/optimistic-query';
import { registerPendingAppWriteFlusher } from '@/lib/pending-app-writes';
import { APP_UI_PREFERENCES_QUERY_KEY } from '@/lib/query-invalidation';

// A fixed window persists held gestures without waiting for their release.
const APP_UI_PREFERENCE_FLUSH_MS = 350;
const preferenceFlushers = new Set<() => void>();
let pendingPatch: AppUiPreferencesPatch | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushPendingPreferences: (() => Promise<void>) | null = null;

export function registerAppUiPreferenceFlusher(flush: () => void): () => void {
  preferenceFlushers.add(flush);
  return () => {
    preferenceFlushers.delete(flush);
  };
}

async function flushAppUiPreferenceWrites(): Promise<void> {
  // Drain player buffers into one shared IPC batch before the app write barrier.
  for (const flush of preferenceFlushers) flush();
  // A patch landing mid-drain (a debounce timer or unmount flush racing the
  // barrier) re-arms `flushPendingPreferences` — keep draining until no
  // pending flush survives a full settle, or close/export strands it on a
  // timer that never runs.
  for (;;) {
    const pending = flushPendingPreferences;
    if (!pending) break;
    // Sequential on purpose: the settle must observe the tail the drain
    // just registered — `Promise.all` would race it.
    // eslint-disable-next-line no-await-in-loop
    await pending();
    // eslint-disable-next-line no-await-in-loop
    await settleOptimisticQueryWrites([APP_UI_PREFERENCES_QUERY_KEY]);
  }
}
registerPendingAppWriteFlusher(flushAppUiPreferenceWrites);

const DEFAULT_APP_UI_PREFERENCES: AppUiPreferences = {
  playerVolume: 75,
  playerSpeed: 1,
  spoilerProtection: false,
  subtitleDelay: 0,
  subtitlePos: 100,
  subtitleScale: 1.0,
  autoPlayNext: false,
  trailerPreviews: true,
  autoSkipIntro: false,
};

// Shared query wrapper: a `select` observer sees only its slice, so surfaces
// reading one flag stop re-rendering on unrelated preference writes.
function useAppUiPreferencesQuery<T = AppUiPreferences>(
  select?: (preferences: AppUiPreferences) => T,
) {
  return useQuery({
    queryKey: APP_UI_PREFERENCES_QUERY_KEY,
    queryFn: api.getAppUiPreferences,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    placeholderData: DEFAULT_APP_UI_PREFERENCES,
    ...(select ? { select } : {}),
  });
}

/// Single-flag observer so unrelated preference writes don't re-render
/// surfaces that only gate on spoiler protection.
export function useSpoilerProtection(): boolean {
  const preferencesQuery = useAppUiPreferencesQuery((preferences) => preferences.spoilerProtection);
  return preferencesQuery.data ?? DEFAULT_APP_UI_PREFERENCES.spoilerProtection;
}

/// Single-flag observer for media cards gating the hover trailer embed.
export function useTrailerPreviews(): boolean {
  const preferencesQuery = useAppUiPreferencesQuery((preferences) => preferences.trailerPreviews);
  return preferencesQuery.data ?? DEFAULT_APP_UI_PREFERENCES.trailerPreviews;
}

export function useAppUiPreferences() {
  const queryClient = useQueryClient();
  const preferencesQuery = useAppUiPreferencesQuery();

  const currentPreferences = preferencesQuery.data ?? DEFAULT_APP_UI_PREFERENCES;

  const flushPreferences = useCallback(async () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const mergedPatch = pendingPatch;
    pendingPatch = null;
    flushPendingPreferences = null;
    if (!mergedPatch) return;
    const latest =
      queryClient.getQueryData<AppUiPreferences>(APP_UI_PREFERENCES_QUERY_KEY) ??
      DEFAULT_APP_UI_PREFERENCES;
    await runOptimisticQueryMutation({
      mutate: api.saveAppUiPreferences,
      optimisticData: { ...latest, ...mergedPatch },
      queryClient,
      queryKey: APP_UI_PREFERENCES_QUERY_KEY,
      variables: mergedPatch,
    });
  }, [queryClient]);

  // Cache data stays out of the callback dependencies so optimistic updates
  // cannot rerun cleanup and flush a gesture before its timer settles.
  const updatePreferences = useCallback(
    (patch: AppUiPreferencesPatch) => {
      claimOptimisticQueryWrite(APP_UI_PREFERENCES_QUERY_KEY);
      void queryClient.cancelQueries({ queryKey: APP_UI_PREFERENCES_QUERY_KEY, exact: true });
      // Compose on the latest cache value: two patches inside one render
      // cycle must not drop each other's optimistic fields.
      queryClient.setQueryData<AppUiPreferences>(APP_UI_PREFERENCES_QUERY_KEY, (old) => ({
        ...(old ?? DEFAULT_APP_UI_PREFERENCES),
        ...patch,
      }));

      pendingPatch = { ...pendingPatch, ...patch };
      flushPendingPreferences = flushPreferences;
      if (flushTimer !== null) return;
      flushTimer = setTimeout(() => {
        void flushPreferences().catch(() => undefined);
      }, APP_UI_PREFERENCE_FLUSH_MS);
    },
    [queryClient, flushPreferences],
  );

  // Flush a pending patch on unmount so the last gesture is not lost.
  useEffect(() => () => void flushPreferences().catch(() => undefined), [flushPreferences]);

  return {
    preferences: currentPreferences,
    // Placeholder defaults stand in until hydration lands — controls that
    // write whole fields should hold off so an early gesture can't flap.
    isHydrating: preferencesQuery.isPlaceholderData,
    updatePreferences,
  };
}
