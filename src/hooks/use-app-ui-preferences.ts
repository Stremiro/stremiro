import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';

import {
  type AppUiPreferences,
  type AppUiPreferencesPatch,
  api,
  DEFAULT_APP_UI_PREFERENCES,
  getErrorMessage,
} from '@/lib/api';
import { notifyAction } from '@/lib/notify';
import { createPlayerKeymap, type PlayerKeymap } from '@/lib/player-keybindings';
import {
  claimOptimisticQueryWrite,
  runOptimisticQueryMutation,
  settleOptimisticQueryWrites,
} from '@/lib/optimistic-query';
import { registerPendingAppWriteFlusher } from '@/lib/pending-app-writes';
import {
  APP_UI_PREFERENCES_QUERY_KEY,
  DEFAULT_PLAYER_KEYBINDINGS_QUERY_KEY,
} from '@/lib/query-invalidation';

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
  // A patch landing mid-drain re-arms flushPendingPreferences — keep draining
  // until none survives a settle, or close/export strands it on a dead timer.
  for (;;) {
    const pending = flushPendingPreferences;
    if (!pending) break;
    // Sequential: the settle must observe the tail the drain just registered.
    // eslint-disable-next-line no-await-in-loop
    await pending();
    // eslint-disable-next-line no-await-in-loop
    await settleOptimisticQueryWrites([APP_UI_PREFERENCES_QUERY_KEY]);
  }
}
registerPendingAppWriteFlusher(flushAppUiPreferenceWrites);

// Shared query wrapper so `select` observers only re-render on their slice.
function useAppUiPreferencesQuery<T = AppUiPreferences>(
  select?: (preferences: AppUiPreferences) => T,
) {
  return useQuery({
    queryKey: APP_UI_PREFERENCES_QUERY_KEY,
    queryFn: async () =>
      (await api.pendingBootstrapSnapshot())?.appUiPreferences ?? api.getAppUiPreferences(),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    placeholderData: DEFAULT_APP_UI_PREFERENCES,
    ...(select ? { select } : {}),
  });
}

/// Spoiler-protection flag observer — unrelated writes don't re-render it.
export function useSpoilerProtection(): boolean {
  const preferencesQuery = useAppUiPreferencesQuery((preferences) => preferences.spoilerProtection);
  return preferencesQuery.data ?? DEFAULT_APP_UI_PREFERENCES.spoilerProtection;
}

/// Single-flag observer for media cards gating the hover trailer embed.
export function useTrailerPreviews(): boolean {
  const preferencesQuery = useAppUiPreferencesQuery((preferences) => preferences.trailerPreviews);
  return preferencesQuery.data ?? DEFAULT_APP_UI_PREFERENCES.trailerPreviews;
}

/// Resolved player keymap — re-renders only when bindings change.
export function usePlayerKeymap(): PlayerKeymap {
  const preferencesQuery = useAppUiPreferencesQuery((preferences) => ({
    bindings: preferences.effectivePlayerKeybindings,
    overrides: preferences.playerKeybindings,
  }));
  const defaultBindingsQuery = useQuery({
    queryKey: DEFAULT_PLAYER_KEYBINDINGS_QUERY_KEY,
    queryFn: api.getDefaultPlayerKeybindings,
    enabled: preferencesQuery.isError && preferencesQuery.data === undefined,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  const { bindings, overrides } = preferencesQuery.data ?? {
    bindings: defaultBindingsQuery.data ?? DEFAULT_APP_UI_PREFERENCES.effectivePlayerKeybindings,
    overrides: DEFAULT_APP_UI_PREFERENCES.playerKeybindings,
  };
  return useMemo(() => createPlayerKeymap(bindings, overrides), [bindings, overrides]);
}

export function useAppUiPreferences<T = AppUiPreferences>(
  select?: (preferences: AppUiPreferences) => T,
) {
  const queryClient = useQueryClient();
  const preferencesQuery = useAppUiPreferencesQuery(select);

  const currentPreferences =
    preferencesQuery.data ??
    (select ? select(DEFAULT_APP_UI_PREFERENCES) : (DEFAULT_APP_UI_PREFERENCES as T));

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
    try {
      await runOptimisticQueryMutation({
        mutate: async (patch: AppUiPreferencesPatch) => {
          const saved = await api.saveAppUiPreferences(patch);
          queryClient.setQueryData<AppUiPreferences>(APP_UI_PREFERENCES_QUERY_KEY, (current) => ({
            ...(current ?? saved),
            effectivePlayerKeybindings: saved.effectivePlayerKeybindings,
            defaultPlayerKeybindings: saved.defaultPlayerKeybindings,
          }));
          return saved;
        },
        optimisticData: { ...latest, ...mergedPatch },
        queryClient,
        queryKey: APP_UI_PREFERENCES_QUERY_KEY,
        variables: mergedPatch,
      });
    } catch (error) {
      notifyAction('Failed to save preferences', { detail: getErrorMessage(error), tone: 'error' });
      throw error;
    }
  }, [queryClient]);

  // Cache stays out of deps so an optimistic update can't re-run cleanup and flush a gesture early.
  const updatePreferences = useCallback(
    (patch: AppUiPreferencesPatch) => {
      claimOptimisticQueryWrite(APP_UI_PREFERENCES_QUERY_KEY);
      void queryClient.cancelQueries({ queryKey: APP_UI_PREFERENCES_QUERY_KEY, exact: true });
      // Compose on the latest cache value so two patches in one render cycle don't drop each other's fields.
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

  const savePreferences = useCallback(
    async (patch: AppUiPreferencesPatch) => {
      updatePreferences(patch);
      await flushPreferences();
    },
    [updatePreferences, flushPreferences],
  );

  // Flush a pending patch on unmount so the last gesture is not lost.
  useEffect(() => () => void flushPreferences().catch(() => undefined), [flushPreferences]);

  return {
    preferences: currentPreferences,
    isHydrating: !preferencesQuery.isSuccess || preferencesQuery.isPlaceholderData,
    preferencesQuery,
    updatePreferences,
    savePreferences,
  };
}
