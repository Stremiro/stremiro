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

// The persisted-state key is the single field list — equality delegates to
// it so a new preference field can't compare stale.
function buildStreamSelectorPreferencesKey(filters: StreamSelectorPreferences): string {
  return [filters.quality, filters.source, filters.addon, filters.sort, filters.batch].join('|');
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

  const showBatchFilter = isSeriesLike && season !== undefined && episode !== undefined;
  const defaultFilters = useMemo<StreamSelectorPreferences>(() => {
    return {
      ...DEFAULT_FILTERS,
      batch: showBatchFilter ? 'episodes' : 'all',
    };
  }, [showBatchFilter]);

  const [filters, setFiltersState] = useState<StreamSelectorPreferences>(defaultFilters);
  // Marks user-driven edits so hydration never clobbers a change that landed
  // while the preferences query was in flight.
  const userEditedFiltersRef = useRef(false);
  const setFilters = useCallback((next: SetStateAction<StreamSelectorPreferences>) => {
    userEditedFiltersRef.current = true;
    setFiltersState(next);
  }, []);
  const latestFiltersRef = useRef(filters);
  // Raw (unswallowed) save operation: the module queue only stores the
  // recovered tail, so lifecycle flushes observe failures through this.
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

  // Rust sanitizes stored preferences on read and save, so the snapshot is
  // used as-is. The stored batch survives sessions that hide the control
  // (movies) so it never overwrites a series `episodes` preference.
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
      const operation = streamSelectorPreferencesSaveQueue
        .catch(() => undefined)
        .then(async () => {
          const savedPreferences = await api.saveStreamSelectorPreferences(nextFilters);
          if (lastRequestedPreferenceKeyRef.current === nextPreferenceKey) {
            lastRequestedPreferenceKeyRef.current =
              buildStreamSelectorPreferencesKey(savedPreferences);
          }
          // The server canonicalizes (trim, 'all' fold, truncation): adopt
          // its value so `filters` can't diverge from persisted state —
          // unless the user already moved past this request.
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
      // The queue keeps the recovered tail so later edits still serialize;
      // the raw operation is what lifecycle barriers await.
      streamSelectorPreferencesSaveQueue = operation.catch(() => {
        if (lastRequestedPreferenceKeyRef.current === nextPreferenceKey) {
          lastRequestedPreferenceKeyRef.current = null;
        }
      });
      return trackPendingAppWrite(operation);
    },
  );

  // Instance flusher for the app write barrier: a close landing inside the
  // 200ms debounce would otherwise drop the latest edit.
  const flushPendingSelectorPreferences = useEffectEvent(async (): Promise<void> => {
    if (userEditedFiltersRef.current) {
      // Hydrate before composing the write — never persist over stored
      // state this instance has not read yet.
      const stored = await queryClient.ensureQueryData({
        queryKey: STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
        queryFn: api.getStreamSelectorPreferences,
      });
      let nextFilters = latestFiltersRef.current;
      if (!showBatchFilter && stored.initialized) {
        // The batch control is hidden for movies, so the flush must carry
        // the stored batch — same policy reset/hydration apply.
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
    // An edit made while the query was in flight is user intent: the
    // debounced save below persists it — syncing would clobber it.
    if (!userEditedFiltersRef.current) {
      syncFiltersFromPersistedState(normalizedPersistedFilters);
    }
  }, [
    normalizedPersistedFilters,
    open,
    selectorSessionKey,
    streamSelectorPreferencesQuery.isSuccess,
  ]);

  // Latest-render binding lets the close cleanup compare against the
  // freshest persisted snapshot without a shadow ref.
  const flushOnClose = useEffectEvent(() => {
    if (!hasHydratedFiltersRef.current) {
      return;
    }

    const latestFilters = latestFiltersRef.current;
    if (
      userEditedFiltersRef.current &&
      !areStreamSelectorPreferencesEqual(latestFilters, normalizedPersistedFilters)
    ) {
      void persistStreamSelectorPreferences(latestFilters);
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
    // Hydration and queued-save completions can rerun this effect before the
    // debounce catches up. Only persist the current, settled user edit.
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

  // Equality is the single field list — masking `batch` keeps the hidden
  // movie control's value out of the comparison without hand-listing fields.
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
