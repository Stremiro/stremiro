import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useDebounce } from '@/hooks/use-debounce';
import {
  api,
  type StreamSelectorPreferences,
  type StreamSelectorPreferencesState,
} from '@/lib/api';
import { registerPendingAppWriteFlusher, trackPendingAppWrite } from '@/lib/pending-app-writes';
import { STREAM_SELECTOR_PREFERENCES_QUERY_KEY } from '@/lib/query-invalidation';
import { DEFAULT_FILTERS } from '@/lib/stream-selector-utils';

const STREAM_SELECTOR_PREFERENCE_SAVE_DELAY_MS = 200;
let streamSelectorPreferencesSaveQueue = Promise.resolve<void>(undefined);

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
  return buildStreamSelectorPreferencesKey(left) === buildStreamSelectorPreferencesKey(right);
}

export function useSelectorPreferencesState({
  episode,
  isSeriesLike,
  open,
  season,
  selectorSessionKey,
}: UseSelectorPreferencesStateArgs) {
  const queryClient = useQueryClient();
  const openSessionKeyRef = useRef<string | null>(null);
  const hasHydratedFiltersRef = useRef(false);
  const lastRequestedPreferenceKeyRef = useRef<string | null>(null);
  // This instance's last hydrated/adopted snapshot — merge base for whole-snapshot saves shared across selector instances.
  const persistedBaselineRef = useRef<StreamSelectorPreferences | null>(null);

  const showBatchFilter = isSeriesLike && season !== undefined && episode !== undefined;
  const defaultFilters = useMemo<StreamSelectorPreferences>(() => {
    return {
      ...DEFAULT_FILTERS,
      batch: showBatchFilter ? 'episodes' : 'all',
    };
  }, [showBatchFilter]);

  const [filters, setFiltersState] = useState<StreamSelectorPreferences>(defaultFilters);
  // Marks user edits so hydration never clobbers a change made mid-flight.
  const userEditedFiltersRef = useRef(false);
  const setFilters = useCallback((next: SetStateAction<StreamSelectorPreferences>) => {
    userEditedFiltersRef.current = true;
    setFiltersState(next);
  }, []);
  const latestFiltersRef = useRef(filters);
  // Raw save op — the queue only stores the recovered tail, so lifecycle flushes observe failures here.
  const lastPersistOperationRef = useRef<Promise<void> | null>(null);
  const debouncedFilters = useDebounce(filters, STREAM_SELECTOR_PREFERENCE_SAVE_DELAY_MS);

  useEffect(() => {
    latestFiltersRef.current = filters;
  }, [filters]);

  const streamSelectorPreferencesQuery = useQuery({
    queryKey: STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
    queryFn: api.getStreamSelectorPreferences,
    enabled: open,
    staleTime: Infinity,
    gcTime: Infinity,
  });

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
      const operation = streamSelectorPreferencesSaveQueue.then(async () => {
        // The command replaces the whole shared snapshot — merge this instance's
        // changed fields over the freshest persisted one so a parallel edit isn't clobbered.
        const freshest = queryClient.getQueryData<StreamSelectorPreferencesState>(
          STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
        )?.preferences;
        // A pre-hydration edit has no baseline — the freshest shared snapshot is the only correct merge base.
        const baseline = persistedBaselineRef.current ?? freshest;
        const changedFields: Partial<StreamSelectorPreferences> = {};
        if (freshest && baseline) {
          for (const field of STREAM_SELECTOR_PREFERENCE_FIELDS) {
            if (nextFilters[field] !== baseline[field]) {
              changedFields[field] = nextFilters[field] as never;
            }
          }
        }
        const merged: StreamSelectorPreferences =
          freshest && baseline ? { ...freshest, ...changedFields } : nextFilters;
        const savedPreferences = await api.saveStreamSelectorPreferences(merged);
        persistedBaselineRef.current = savedPreferences;
        if (lastRequestedPreferenceKeyRef.current === nextPreferenceKey) {
          lastRequestedPreferenceKeyRef.current =
            buildStreamSelectorPreferencesKey(savedPreferences);
        }
        // The server canonicalizes — adopt its value unless the user already moved past this request.
        if (
          areStreamSelectorPreferencesEqual(latestFiltersRef.current, nextFilters) &&
          !areStreamSelectorPreferencesEqual(savedPreferences, nextFilters)
        ) {
          setFiltersState(savedPreferences);
        }
        queryClient.setQueryData<StreamSelectorPreferencesState>(
          STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
          {
            preferences: savedPreferences,
            initialized: true,
          },
        );
      });
      lastPersistOperationRef.current = operation;
      // The queue keeps the recovered tail so later edits serialize; the raw op is what barriers await.
      streamSelectorPreferencesSaveQueue = operation.catch(() => {
        if (lastRequestedPreferenceKeyRef.current === nextPreferenceKey) {
          lastRequestedPreferenceKeyRef.current = null;
        }
      });
      return trackPendingAppWrite(operation);
    },
  );

  // Hydration-safe flusher shared by selector close and app-write barriers.
  const flushPendingSelectorPreferences = useEffectEvent(async (): Promise<void> => {
    if (userEditedFiltersRef.current) {
      // Hydrate before composing the write — never persist over unread stored state.
      const stored = await queryClient.ensureQueryData({
        queryKey: STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
        queryFn: api.getStreamSelectorPreferences,
      });
      let nextFilters = latestFiltersRef.current;
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
        setFiltersState(nextFilters);
      }
      await persistStreamSelectorPreferences(latestFiltersRef.current);
    }
    // No pending edit: tracked raw operations already cover in-flight work.
  });

  useEffect(() => registerPendingAppWriteFlusher(flushPendingSelectorPreferences), []);

  const syncFiltersFromPersistedState = useEffectEvent((nextFilters: StreamSelectorPreferences) => {
    // Raw setter: a hydration sync is not a user edit.
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

    if (openSessionKeyRef.current === selectorSessionKey && hasHydratedFiltersRef.current) {
      return;
    }

    openSessionKeyRef.current = selectorSessionKey;
    hasHydratedFiltersRef.current = true;
    lastRequestedPreferenceKeyRef.current = buildStreamSelectorPreferencesKey(
      normalizedPersistedFilters,
    );
    persistedBaselineRef.current = normalizedPersistedFilters;
    // An in-flight edit is user intent — the debounced save persists it; syncing would clobber it.
    if (!userEditedFiltersRef.current) {
      syncFiltersFromPersistedState(normalizedPersistedFilters);
    }
  }, [
    normalizedPersistedFilters,
    open,
    selectorSessionKey,
    streamSelectorPreferencesQuery.isSuccess,
  ]);

  const flushOnClose = useEffectEvent(() => {
    const latestFilters = latestFiltersRef.current;
    if (
      userEditedFiltersRef.current &&
      (!hasHydratedFiltersRef.current ||
        !areStreamSelectorPreferencesEqual(latestFilters, normalizedPersistedFilters))
    ) {
      void trackPendingAppWrite(flushPendingSelectorPreferences()).catch(() => undefined);
    }

    openSessionKeyRef.current = null;
    hasHydratedFiltersRef.current = false;
    userEditedFiltersRef.current = false;
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
      !hasHydratedFiltersRef.current ||
      !userEditedFiltersRef.current ||
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
    batchFilter: filters.batch,
    filters,
    hasActiveFilter: hasVisibleFilter,
    qualityFilter: filters.quality,
    resetFilters,
    setFilters,
    showBatchFilter,
    sortMode: filters.sort,
    sourceFilter: filters.source,
  };
}
