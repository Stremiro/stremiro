import { Channel } from '@tauri-apps/api/core';
import { replaceEqualDeep, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAddonConfigs } from '@/hooks/use-addon-configs';
import { useDebounce } from '@/hooks/use-debounce';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { useTitleWatchProgress } from '@/hooks/use-media-library';
import { useSelectorPreferencesState } from '@/hooks/use-selector-preferences';
import { useSelectorResolution } from '@/hooks/use-selector-resolution';
import {
  api,
  type AddonStream,
  type StreamSelectorData,
  type StreamSelectorStats,
  type StreamSelectorPreferences,
  type StreamSourceSummary,
} from '@/lib/api';
import { episodeProgressKey } from '@/lib/history-playback';
import { streamSelectorQueryKey } from '@/lib/query-invalidation';
import { playerStreamRankingOptions } from '@/lib/resolve-player-stream';
import { buildStreamRankingCacheKey } from '@/lib/stream-ranking';
import type { StreamSelectorTarget } from '@/lib/stream-selector-target';
import { createObjectIdentity, isSeriesLikeMediaType } from '@/lib/utils';

const STREAM_SELECTOR_GC_TIME_MS = 1000 * 60 * 2;
const EMPTY_SELECTOR_STREAMS: AddonStream[] = [];
const getSelectorPoolId = createObjectIdentity();

// Stable fallback so `?? []` never changes memo identity across renders.
const EMPTY_SOURCE_SUMMARIES: StreamSourceSummary[] = [];
const EMPTY_STREAM_STATS: StreamSelectorStats = {
  resCounts: { '4k': 0, '1080p': 0, '720p': 0, sd: 0 },
  playableCount: 0,
  p2pCount: 0,
  cachedCount: 0,
  batchCount: 0,
  episodeLikeCount: 0,
  sourceHealth: { degraded: 0, offline: 0, pending: 0 },
};

function shareStreamSelectorData(previousData: unknown, nextData: unknown): StreamSelectorData {
  const previous = previousData as StreamSelectorData | undefined;
  const next = nextData as StreamSelectorData;
  if (!previous) return next;

  const { streams: previousStreams, ...previousFields } = previous;
  const { streams: nextStreams, ...nextFields } = next;
  // Ranking inserts/moves rows, so index-based sharing would rebuild unchanged streams.
  const previousByKey = new Map(previousStreams.map((stream) => [stream.streamKey, stream]));
  const streams = nextStreams.map((stream) =>
    replaceEqualDeep(previousByKey.get(stream.streamKey), stream),
  );
  const fields = replaceEqualDeep(previousFields, nextFields);
  const sameStreams =
    streams.length === previousStreams.length &&
    streams.every((stream, index) => stream === previousStreams[index]);
  if (sameStreams && fields === previousFields) return previous;
  return { ...fields, streams: sameStreams ? previousStreams : streams };
}

interface UseStreamSelectorControllerArgs {
  open: boolean;
  onClose: () => void;
  onBeforePlayerNavigation?: () => void | Promise<void>;
  getStartTime?: () => number | undefined;
  target: StreamSelectorTarget;
}

export function useStreamSelectorController({
  open,
  onClose,
  onBeforePlayerNavigation,
  getStartTime,
  target,
}: UseStreamSelectorControllerArgs) {
  const { type, id, streamId, season, episode, absoluteSeason, absoluteEpisode, title, overview } =
    target;
  const queryClient = useQueryClient();
  const isOnline = useOnlineStatus();
  const isSeriesLike = isSeriesLikeMediaType(type);

  const lookupId = streamId || id;
  // Type+id join the key so titles sharing a lookup id (kitsu/tt aliases) can't collide.
  const selectorSessionKey = JSON.stringify([
    type,
    id,
    lookupId,
    season ?? null,
    episode ?? null,
    absoluteSeason ?? null,
    absoluteEpisode ?? null,
  ]);
  const {
    batchFilter,
    filters,
    hasActiveFilter: hasPreferenceFilter,
    qualityFilter,
    resetFilters: resetPreferenceFilters,
    setFilters,
    showBatchFilter,
    sortMode,
    sourceFilter,
  } = useSelectorPreferencesState({
    episode,
    isSeriesLike,
    open,
    season,
    selectorSessionKey,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const normalizedSearchQuery = searchQuery.trim();
  const debouncedSearchQuery = useDebounce(normalizedSearchQuery, 180);
  const requestedSearchQuery = normalizedSearchQuery ? debouncedSearchQuery : '';
  useEffect(() => {
    setSearchQuery('');
  }, [open, selectorSessionKey]);
  const resetFilters = useCallback(() => {
    setSearchQuery('');
    resetPreferenceFilters();
  }, [resetPreferenceFilters]);
  const hasActiveFilter = hasPreferenceFilter || searchQuery.trim().length > 0;
  const compactOverview = useMemo(() => {
    if (!overview) return '';
    const normalized = overview.replace(/\s+/g, ' ').trim();
    const maxChars = 200;
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars).trimEnd()}…`;
  }, [overview]);
  const {
    activeResolveFeedback,
    activeResolveKey,
    cancelResolve,
    handleRequestClose,
    handleSelectStream,
    isAnyResolving,
  } = useSelectorResolution({
    getStartTime,
    lookupId,
    onBeforePlayerNavigation,
    onClose,
    open,
    selectorSessionKey,
    target,
  });

  const rankingOptions = useMemo(
    () =>
      playerStreamRankingOptions({
        mediaId: id,
        mediaType: type,
        streamSeason: season,
        streamEpisode: episode,
        absoluteSeason,
        absoluteEpisode,
        title,
      }),
    [absoluteEpisode, absoluteSeason, episode, id, season, title, type],
  );

  const {
    data: addonConfigs = [],
    refetch: refetchAddonConfigs,
    isLoading: isLoadingAddonConfigs,
    error: addonConfigsError,
  } = useAddonConfigs({ enabled: open && isOnline });

  const hasEnabledAddons = addonConfigs.some((addon) => addon.enabled);

  // Ranking inputs are part of the key so titles/episodes never share pages.
  const selectorQueryKey = streamSelectorQueryKey(
    type,
    lookupId,
    season,
    episode,
    absoluteEpisode,
    buildStreamRankingCacheKey(rankingOptions),
  );
  // Channels can't be cancelled — an abandoned invoke keeps emitting; a per-fetch generation drops stale snapshots.
  const selectorFetchGenerationRef = useRef(0);
  const selectorOpenRef = useRef(open);
  useEffect(() => {
    selectorOpenRef.current = open;
    return () => {
      selectorOpenRef.current = false;
    };
  }, [open]);
  const {
    data: streamSelectorData,
    error: streamSelectorDataError,
    isFetching: isFetchingStreamSelectorData,
    refetch: refetchStreamSelectorData,
  } = useQuery({
    queryKey: selectorQueryKey,
    // Do not consume signal: TanStack would cancel and revert this fetch on unmount.
    queryFn: () => {
      // The backend emits a merged+ranked snapshot per addon — cache each so rows appear progressively.
      const generation = ++selectorFetchGenerationRef.current;
      const onProgress = new Channel<StreamSelectorData>();
      // Channel is not an EventTarget — onmessage is its only surface.
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      onProgress.onmessage = (snapshot) => {
        if (selectorOpenRef.current && generation === selectorFetchGenerationRef.current) {
          queryClient.setQueryData<StreamSelectorData>(selectorQueryKey, (previous) =>
            previous?.streams.length && snapshot.streams.length === 0 ? previous : snapshot,
          );
        }
      };
      return api.getStreamSelectorData(
        type,
        lookupId,
        season,
        episode,
        absoluteEpisode,
        rankingOptions,
        onProgress,
      );
    },
    structuralSharing: shareStreamSelectorData,
    enabled: open && !!lookupId?.trim() && isOnline,
    staleTime: 1000 * 60 * 3,
    gcTime: STREAM_SELECTOR_GC_TIME_MS,
    retry: 0,
  });
  const streams = useMemo(() => streamSelectorData?.streams ?? [], [streamSelectorData?.streams]);
  const streamStats = streamSelectorData?.stats ?? EMPTY_STREAM_STATS;

  const addonHealthMetrics = streamSelectorData?.sourceSummaries ?? EMPTY_SOURCE_SUMMARIES;

  // sourceSummaries covers exactly the queried addons so count and filter can't drift.
  const { streamSourceAddonIds, streamSourceCount } = useMemo(() => {
    const ids = new Set<string>();
    for (const summary of addonHealthMetrics) ids.add(summary.id);
    return { streamSourceAddonIds: ids, streamSourceCount: ids.size };
  }, [addonHealthMetrics]);

  const effectiveAddonFilter = useMemo(() => {
    const raw = filters.addon.trim();
    return streamSourceAddonIds.has(raw) ? raw : 'all';
  }, [streamSourceAddonIds, filters.addon]);

  const effectiveFilters = useMemo<StreamSelectorPreferences>(() => {
    const addonUnchanged = effectiveAddonFilter === filters.addon;
    const batchUnchanged = showBatchFilter || filters.batch === 'all';
    if (addonUnchanged && batchUnchanged) {
      return filters;
    }

    return {
      ...filters,
      addon: effectiveAddonFilter,
      batch: showBatchFilter ? filters.batch : 'all',
    };
  }, [effectiveAddonFilter, filters, showBatchFilter]);

  // Badge the row the title last played so a reopening user can re-pick what worked.
  const { data: titleProgress } = useTitleWatchProgress(id, {
    enabled: open && isOnline && Boolean(id),
  });
  // Exact episode targets read the per-episode map; anything else takes the newest same-kind head.
  const lastStreamEntry = useMemo(() => {
    const targetSeason = absoluteSeason ?? season;
    const targetEpisode = absoluteEpisode ?? episode;
    const exact =
      isSeriesLike && id && targetSeason !== undefined && targetEpisode !== undefined
        ? titleProgress?.episodeProgress?.[episodeProgressKey(id, targetSeason, targetEpisode)]
        : undefined;
    return (
      exact ?? (isSeriesLike ? titleProgress?.latestSeriesEntry : titleProgress?.latestMovieEntry)
    );
  }, [absoluteEpisode, absoluteSeason, episode, id, isSeriesLike, season, titleProgress]);
  const lastStreamKey = lastStreamEntry?.last_stream_key || undefined;
  const lastStreamFamily = lastStreamEntry?.stream_family || undefined;
  // Per-episode watch rows — the pack picker reads resume points from the same snapshot as the badge.
  const episodeProgress = titleProgress?.episodeProgress;
  const {
    data: selectorView,
    error: selectorViewError,
    isFetching: isFetchingSelectorView,
    refetch: refetchSelectorView,
  } = useQuery({
    queryKey: [
      'stream-selector-view',
      selectorSessionKey,
      getSelectorPoolId(streams),
      effectiveFilters,
      requestedSearchQuery,
    ],
    queryFn: async () => {
      const indices = await api.getStreamSelectorIndices(
        streams,
        effectiveFilters,
        requestedSearchQuery,
      );
      return {
        streams: indices.map((index) => streams[index]),
        searchQuery: requestedSearchQuery,
      };
    },
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === selectorSessionKey ? previousData : undefined,
    enabled: open && streams.length > 0,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    structuralSharing: false,
  });
  const sortedStreams = selectorView?.streams ?? EMPTY_SELECTOR_STREAMS;
  const effectiveSearchQuery = selectorView?.searchQuery ?? '';
  const isSearchPending = normalizedSearchQuery !== requestedSearchQuery || isFetchingSelectorView;

  const [retryState, setRetryState] = useState<{
    sessionKey: string;
    error: unknown;
  } | null>(null);
  const isRetrying = retryState?.sessionKey === selectorSessionKey;

  // A failed addon-config read must not masquerade as "no addons" — surface it as a retryable error once loading settles.
  const fatalAddonError =
    selectorViewError ??
    (streams.length === 0
      ? (streamSelectorData?.fatalErrorMessage ??
        streamSelectorDataError ??
        (isFetchingStreamSelectorData || isLoadingAddonConfigs ? null : addonConfigsError) ??
        (isRetrying ? retryState?.error : null) ??
        null)
      : null);

  // Snapshots don't end the fetch; fetch state settles on error/cancel even with an incomplete last snapshot.
  const isLoading =
    !fatalAddonError &&
    !isRetrying &&
    ((streams.length === 0 && (isLoadingAddonConfigs || isFetchingStreamSelectorData)) ||
      (streams.length > 0 && !selectorView && isFetchingSelectorView));

  const refetchStreams = useCallback(() => {
    if (isRetrying) return;
    const retry = { sessionKey: selectorSessionKey, error: fatalAddonError };
    setRetryState(retry);
    const requests = selectorViewError
      ? [refetchSelectorView()]
      : [refetchAddonConfigs(), refetchStreamSelectorData()];
    void Promise.allSettled(requests).then(() => {
      setRetryState((current) => (current === retry ? null : current));
    });
  }, [
    fatalAddonError,
    isRetrying,
    refetchAddonConfigs,
    refetchSelectorView,
    refetchStreamSelectorData,
    selectorViewError,
    selectorSessionKey,
  ]);

  const sourcesStillLoading = !fatalAddonError && isFetchingStreamSelectorData;

  const handleDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        handleRequestClose();
      }
    },
    [handleRequestClose],
  );
  return {
    activeResolveFeedback,
    activeResolveKey,
    addonHealthMetrics,
    batchFilter,
    cancelResolve,
    compactOverview,
    effectiveAddonFilter,
    effectiveSearchQuery,
    hasEnabledAddons,
    episodeProgress,
    watchedEpisodeCeiling: titleProgress?.watchedEpisodeCeiling,
    fatalAddonError,
    lastStreamKey,
    lastStreamFamily,
    lookupId,
    streamSourceCount,
    handleDialogOpenChange,
    handleRequestClose,
    handleSelectStream,
    hasActiveFilter,
    healthSummary: streamStats.sourceHealth,
    isAnyResolving,
    isLoading,
    isLoadingAddonConfigs,
    isOnline,
    isRetrying,
    isSearchPending,
    qualityFilter,
    rankingOptions,
    refetchStreams,
    resetFilters,
    selectorSessionKey,
    searchQuery,
    setSearchQuery,
    setFilters,
    showBatchFilter,
    sortMode,
    sortedStreams,
    sourceFilter,
    sourcesStillLoading,
    streamStats,
    streams,
  };
}
