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
  type StreamSelectorBatch,
  type StreamSelectorPreferences,
  type StreamSelectorPreferencesState,
  type StreamSelectorQuality,
  type StreamSelectorSort,
  type StreamSelectorSource,
} from '@/lib/api';
import { registerPendingAppWriteFlusher, trackPendingAppWrite } from '@/lib/pending-app-writes';
import { STREAM_SELECTOR_PREFERENCES_QUERY_KEY } from '@/lib/query-invalidation';
import { DEFAULT_FILTERS } from '@/lib/stream-selector-utils';

const QUALITY_FILTER_VALUES: ReadonlySet<StreamSelectorQuality> = new Set([
  'all',
  '4k',
  '1080p',
  '720p',
  'sd',
]);
const SOURCE_FILTER_VALUES: ReadonlySet<StreamSelectorSource> = new Set(['all', 'cached']);
const SORT_MODE_VALUES: ReadonlySet<StreamSelectorSort> = new Set(['smart', 'quality', 'seeds']);
const BATCH_FILTER_VALUES: ReadonlySet<StreamSelectorBatch> = new Set(['all', 'episodes', 'packs']);
const STREAM_SELECTOR_PREFERENCE_SAVE_DELAY_MS = 200;
let streamSelectorPreferencesSaveQueue = Promise.resolve<void>(undefined);

export function flushPendingStreamSelectorPreferences(): Promise<void> {
  return streamSelectorPreferencesSaveQueue;
}
registerPendingAppWriteFlusher(flushPendingStreamSelectorPreferences);

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

function normalizeStoredFilters(
  candidate: unknown,
  defaults: StreamSelectorPreferences,
): StreamSelectorPreferences {
  if (!candidate || typeof candidate !== 'object') {
    return defaults;
  }

  const stored = candidate as Partial<Record<keyof StreamSelectorPreferences, unknown>>;
  const quality = QUALITY_FILTER_VALUES.has(stored.quality as StreamSelectorQuality)
    ? (stored.quality as StreamSelectorQuality)
    : defaults.quality;
  const source = SOURCE_FILTER_VALUES.has(stored.source as StreamSelectorSource)
    ? (stored.source as StreamSelectorSource)
    : defaults.source;
  const sort = SORT_MODE_VALUES.has(stored.sort as StreamSelectorSort)
    ? (stored.sort as StreamSelectorSort)
    : defaults.sort;
  const storedBatch = BATCH_FILTER_VALUES.has(stored.batch as StreamSelectorBatch)
    ? (stored.batch as StreamSelectorBatch)
    : defaults.batch;
  // Keep the stored batch even when this session hides the control (movies);
  // forcing `all` would persist over a series `episodes` preference.
  const addon =
    typeof stored.addon === 'string' && stored.addon.trim().length > 0
      ? stored.addon.trim()
      : defaults.addon;

  return {
    quality,
    source,
    addon,
    sort,
    batch: storedBatch,
  };
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
  const persistedFiltersRef = useRef(filters);
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

  const persistedStreamSelectorPreferences =
    streamSelectorPreferencesQuery.isSuccess && streamSelectorPreferencesQuery.data.initialized
      ? streamSelectorPreferencesQuery.data.preferences
      : defaultFilters;
  const normalizedPersistedFilters = useMemo(
    () => normalizeStoredFilters(persistedStreamSelectorPreferences, defaultFilters),
    [defaultFilters, persistedStreamSelectorPreferences],
  );

  useEffect(() => {
    persistedFiltersRef.current = normalizedPersistedFilters;
  }, [normalizedPersistedFilters]);

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
          batch: normalizeStoredFilters(stored.preferences, defaultFilters).batch,
        };
      }
      if (!areStreamSelectorPreferencesEqual(nextFilters, latestFiltersRef.current)) {
        // Commit synchronously so a stale debounced value can't overwrite it.
        latestFiltersRef.current = nextFilters;
        setFiltersState(nextFilters);
      }
      await persistStreamSelectorPreferences(latestFiltersRef.current);
      return;
    }
    // No pending edit — the recovered queue tail covers in-flight work, and
    // tracked raw operations still surface a failure through the barrier.
    await streamSelectorPreferencesSaveQueue;
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

  useEffect(() => {
    if (!open) {
      return;
    }

    return () => {
      if (!hasHydratedFiltersRef.current) {
        return;
      }

      const latestFilters = latestFiltersRef.current;
      if (
        userEditedFiltersRef.current &&
        !areStreamSelectorPreferencesEqual(latestFilters, persistedFiltersRef.current)
      ) {
        void persistStreamSelectorPreferences(latestFilters);
      }

      openSessionKeyRef.current = null;
      hasHydratedFiltersRef.current = false;
      userEditedFiltersRef.current = false;
    };
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

  const hasVisibleFilter = showBatchFilter
    ? !areStreamSelectorPreferencesEqual(filters, defaultFilters)
    : filters.quality !== defaultFilters.quality ||
      filters.source !== defaultFilters.source ||
      filters.addon !== defaultFilters.addon ||
      filters.sort !== defaultFilters.sort;

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
