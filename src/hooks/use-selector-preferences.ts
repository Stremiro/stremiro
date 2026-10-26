import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { useDebounce } from '@/hooks/use-debounce';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import {
  api,
  type StreamSelectorPreferences,
  type StreamSelectorPreferencesPatch,
  type StreamSelectorPreferencesState,
} from '@/lib/api';
import { registerPendingAppWriteFlusher, trackPendingAppWrite } from '@/lib/pending-app-writes';
import { STREAM_SELECTOR_PREFERENCES_QUERY_KEY } from '@/lib/query-invalidation';
import { DEFAULT_FILTERS } from '@/lib/stream-selector-utils';
import { createSerialTaskQueue } from '@/lib/utils';

const STREAM_SELECTOR_PREFERENCE_SAVE_DELAY_MS = 200;
const STREAM_SELECTOR_PREFERENCE_ERROR_TOAST_ID = 'stream-selector-preference-error';
const streamSelectorPreferencesSaveQueue = createSerialTaskQueue();

interface UseSelectorPreferencesStateArgs {
  episode?: number;
  isSeriesLike: boolean;
  open: boolean;
  season?: number;
  selectorSessionKey: string;
}

// Key derives from the single field list so a new pref field can't compare stale or miss merge diffs.
const STREAM_SELECTOR_PREFERENCE_FIELDS = [
  'quality',
  'source',
  'addon',
  'sort',
  'batch',
] as const satisfies readonly (keyof StreamSelectorPreferences)[];

function buildStreamSelectorPreferencesKey(filters: StreamSelectorPreferences): string {
  return STREAM_SELECTOR_PREFERENCE_FIELDS.map((field) => filters[field]).join('|');
}

function areStreamSelectorPreferencesEqual(
  left: StreamSelectorPreferences,
  right: StreamSelectorPreferences,
): boolean {
  return STREAM_SELECTOR_PREFERENCE_FIELDS.every((field) => left[field] === right[field]);
}

export function useSelectorPreferencesState({
  episode,
  isSeriesLike,
  open,
  season,
  selectorSessionKey,
}: UseSelectorPreferencesStateArgs) {
  const queryClient = useQueryClient();
  const mountedRef = useMountedRef();
  const hydratedSessionKeyRef = useRef<string | null>(null);
  const lastRequestedPreferenceKeyRef = useRef<string | null>(null);
  // This instance's last hydrated/adopted snapshot is the dequeue-time diff base.
  const persistedBaselineRef = useRef<StreamSelectorPreferences | null>(null);

  const showBatchFilter = isSeriesLike && season !== undefined && episode !== undefined;
  const streamSelectorPreferencesQuery = useQuery({
    queryKey: STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
    queryFn: api.getStreamSelectorPreferences,
    enabled: open,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const defaultFilters = streamSelectorPreferencesQuery.data
    ? showBatchFilter
      ? streamSelectorPreferencesQuery.data.episodeDefaultPreferences
      : streamSelectorPreferencesQuery.data.defaultPreferences
    : DEFAULT_FILTERS;

  const [filters, setFiltersState] = useState<StreamSelectorPreferences>(defaultFilters);
  const latestFiltersRef = useRef(filters);
  // Only explicitly edited fields may override preferences that arrive mid-flight.
  const userEditedFilterFieldsRef = useRef(new Set<keyof StreamSelectorPreferences>());
  const setFilters = useCallback((next: SetStateAction<StreamSelectorPreferences>) => {
    const current = latestFiltersRef.current;
    const nextFilters = typeof next === 'function' ? next(current) : next;
    for (const field of STREAM_SELECTOR_PREFERENCE_FIELDS) {
      if (nextFilters[field] !== current[field]) {
        userEditedFilterFieldsRef.current.add(field);
      }
    }
    latestFiltersRef.current = nextFilters;
    setFiltersState(nextFilters);
  }, []);
  // Raw save op — the queue only stores the recovered tail, so lifecycle flushes observe failures here.
  const lastPersistOperationRef = useRef<Promise<void> | null>(null);
  const retryPendingSaveRef = useRef<(() => Promise<void>) | null>(null);
  const debouncedFilters = useDebounce(filters, STREAM_SELECTOR_PREFERENCE_SAVE_DELAY_MS);
  const showPreferenceSaveError = () => {
    toast.error("Couldn't save stream filters", {
      id: STREAM_SELECTOR_PREFERENCE_ERROR_TOAST_ID,
      action: {
        label: 'Retry',
        onClick: () => {
          const retry = retryPendingSaveRef.current;
          if (retry) void trackPendingAppWrite(retry()).catch(() => undefined);
        },
      },
    });
  };

  // Rust sanitizes on read/save so the snapshot is used as-is; the stored batch survives
  // movie sessions (no batch control) so it can't overwrite a series `episodes` pref.
  const normalizedPersistedFilters =
    streamSelectorPreferencesQuery.isSuccess && streamSelectorPreferencesQuery.data.initialized
      ? streamSelectorPreferencesQuery.data.preferences
      : defaultFilters;

  const persistStreamSelectorPreferences = useEffectEvent(
    (nextFilters: StreamSelectorPreferences): Promise<void> => {
      const nextPreferenceKey = buildStreamSelectorPreferencesKey(nextFilters);
      if (lastRequestedPreferenceKeyRef.current === nextPreferenceKey) {
        return lastPersistOperationRef.current ?? Promise.resolve();
      }

      lastRequestedPreferenceKeyRef.current = nextPreferenceKey;
      const operation = streamSelectorPreferencesSaveQueue.enqueue(async () => {
        const baseline = persistedBaselineRef.current;
        const patch: StreamSelectorPreferencesPatch = { episodeContext: showBatchFilter };
        for (const field of STREAM_SELECTOR_PREFERENCE_FIELDS) {
          if (!baseline || nextFilters[field] !== baseline[field]) {
            patch[field] = nextFilters[field] as never;
          }
        }
        const saved = await api.patchStreamSelectorPreferences(patch);
        const savedPreferences = saved.preferences;
        persistedBaselineRef.current = savedPreferences;
        if (lastRequestedPreferenceKeyRef.current === nextPreferenceKey) {
          lastRequestedPreferenceKeyRef.current =
            buildStreamSelectorPreferencesKey(savedPreferences);
          if (areStreamSelectorPreferencesEqual(latestFiltersRef.current, nextFilters)) {
            userEditedFilterFieldsRef.current.clear();
            toast.dismiss(STREAM_SELECTOR_PREFERENCE_ERROR_TOAST_ID);
            // Adopt canonical values only while this is still the latest edit.
            latestFiltersRef.current = savedPreferences;
            if (
              mountedRef.current &&
              !areStreamSelectorPreferencesEqual(savedPreferences, nextFilters)
            ) {
              setFiltersState(savedPreferences);
            }
          }
        }
        queryClient.setQueryData<StreamSelectorPreferencesState>(
          STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
          saved,
        );
      });
      lastPersistOperationRef.current = operation;
      void operation.catch(() => {
        if (lastRequestedPreferenceKeyRef.current === nextPreferenceKey) {
          lastRequestedPreferenceKeyRef.current = null;
          if (areStreamSelectorPreferencesEqual(latestFiltersRef.current, nextFilters)) {
            showPreferenceSaveError();
          }
        }
      });
      return trackPendingAppWrite(operation);
    },
  );

  // Hydration-safe flusher shared by selector close and app-write barriers.
  const flushPendingSelectorPreferences = useEffectEvent(async (): Promise<void> => {
    if (userEditedFilterFieldsRef.current.size > 0) {
      const needsHydration = hydratedSessionKeyRef.current === null;
      // Hydrate before composing the write — never persist over unread stored state.
      const stored = await queryClient
        .ensureQueryData({
          queryKey: STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
          queryFn: api.getStreamSelectorPreferences,
        })
        .catch((error: unknown) => {
          showPreferenceSaveError();
          throw error;
        });
      let nextFilters = latestFiltersRef.current;
      if (needsHydration) {
        const storedFilters = stored.initialized
          ? stored.preferences
          : showBatchFilter
            ? stored.episodeDefaultPreferences
            : stored.defaultPreferences;
        nextFilters = { ...storedFilters };
        for (const field of userEditedFilterFieldsRef.current) {
          nextFilters[field] = latestFiltersRef.current[field] as never;
        }
        persistedBaselineRef.current = storedFilters;
      }
      if (!showBatchFilter && stored.initialized) {
        // Batch control hidden for movies — carry the stored batch, same as reset/hydration.
        nextFilters = {
          ...nextFilters,
          batch: stored.preferences.batch,
        };
      }
      if (!areStreamSelectorPreferencesEqual(nextFilters, latestFiltersRef.current)) {
        // Commit synchronously so a stale debounced value can't overwrite it.
        latestFiltersRef.current = nextFilters;
        if (mountedRef.current) {
          setFiltersState(nextFilters);
        }
      }
      await persistStreamSelectorPreferences(latestFiltersRef.current);
    }
    // No pending edit: tracked raw operations already cover in-flight work.
  });

  useEffect(() => {
    retryPendingSaveRef.current = flushPendingSelectorPreferences;
    return registerPendingAppWriteFlusher(flushPendingSelectorPreferences);
  }, []);

  const syncFiltersFromPersistedState = useEffectEvent((nextFilters: StreamSelectorPreferences) => {
    // Raw setter: a hydration sync is not a user edit.
    latestFiltersRef.current = nextFilters;
    setFiltersState((currentFilters) =>
      areStreamSelectorPreferencesEqual(currentFilters, nextFilters) ? currentFilters : nextFilters,
    );
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    if (!streamSelectorPreferencesQuery.isSuccess) {
      return;
    }

    if (hydratedSessionKeyRef.current === selectorSessionKey) {
      return;
    }

    hydratedSessionKeyRef.current = selectorSessionKey;
    lastRequestedPreferenceKeyRef.current = buildStreamSelectorPreferencesKey(
      normalizedPersistedFilters,
    );
    persistedBaselineRef.current = normalizedPersistedFilters;
    const nextFilters = { ...normalizedPersistedFilters };
    for (const field of userEditedFilterFieldsRef.current) {
      nextFilters[field] = latestFiltersRef.current[field] as never;
    }
    syncFiltersFromPersistedState(nextFilters);
  }, [
    normalizedPersistedFilters,
    open,
    selectorSessionKey,
    streamSelectorPreferencesQuery.isSuccess,
  ]);

  const flushOnClose = useEffectEvent(() => {
    if (userEditedFilterFieldsRef.current.size > 0) {
      void trackPendingAppWrite(flushPendingSelectorPreferences()).catch(() => undefined);
    }

    hydratedSessionKeyRef.current = null;
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    return flushOnClose;
  }, [open]);

  useEffect(() => {
    // Re-runs can beat the debounce — only persist the current, settled user edit.
    if (
      !open ||
      !streamSelectorPreferencesQuery.isSuccess ||
      hydratedSessionKeyRef.current === null ||
      userEditedFilterFieldsRef.current.size === 0 ||
      !areStreamSelectorPreferencesEqual(debouncedFilters, latestFiltersRef.current)
    ) {
      return;
    }

    if (areStreamSelectorPreferencesEqual(debouncedFilters, normalizedPersistedFilters)) {
      return;
    }

    void persistStreamSelectorPreferences(debouncedFilters);
  }, [
    debouncedFilters,
    normalizedPersistedFilters,
    open,
    streamSelectorPreferencesQuery.isSuccess,
  ]);

  const resetFilters = useCallback(() => {
    // Reset explicitly edits every visible field, even one still showing its default.
    for (const field of STREAM_SELECTOR_PREFERENCE_FIELDS) {
      if (field !== 'batch' || showBatchFilter) userEditedFilterFieldsRef.current.add(field);
    }
    setFilters((current) => {
      const next = showBatchFilter ? defaultFilters : { ...defaultFilters, batch: current.batch };
      return areStreamSelectorPreferencesEqual(current, next) ? current : next;
    });
  }, [defaultFilters, setFilters, showBatchFilter]);

  // Masking `batch` keeps the hidden movie control's value out of the comparison.
  const hasVisibleFilter = !areStreamSelectorPreferencesEqual(
    showBatchFilter ? filters : { ...filters, batch: defaultFilters.batch },
    defaultFilters,
  );

  return {
    filters,
    hasActiveFilter: hasVisibleFilter,
    resetFilters,
    setFilters,
    showBatchFilter,
  };
}
