import { useCallback, useEffect, useRef } from 'react';

import { registerAppUiPreferenceFlusher } from '@/hooks/use-app-ui-preferences';
import type { AppUiPreferencesPatch } from '@/lib/api';

const PREFS_PERSIST_DEBOUNCE_MS = 400;

/** Merge rapid preference changes, draining on unmount and app write barriers. */
export function useDebouncedPrefsPersist(
  updatePreferences: (patch: AppUiPreferencesPatch) => void,
): (patch: AppUiPreferencesPatch) => void {
  const pendingPatchRef = useRef<AppUiPreferencesPatch | null>(null);
  const persistTimerRef = useRef<number | null>(null);

  const flushPreferences = useCallback(() => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    const patch = pendingPatchRef.current;
    pendingPatchRef.current = null;
    if (patch) updatePreferences(patch);
  }, [updatePreferences]);

  const schedulePrefsPersist = useCallback(
    (patch: AppUiPreferencesPatch) => {
      pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }
      persistTimerRef.current = window.setTimeout(flushPreferences, PREFS_PERSIST_DEBOUNCE_MS);
    },
    [flushPreferences],
  );

  useEffect(() => {
    const unregister = registerAppUiPreferenceFlusher(flushPreferences);
    return () => {
      unregister();
      flushPreferences();
    };
  }, [flushPreferences]);

  return schedulePrefsPersist;
}
