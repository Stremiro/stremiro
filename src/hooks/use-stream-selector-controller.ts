import { Channel } from '@tauri-apps/api/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAddonConfigs } from '@/hooks/use-addon-configs';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { useTitleWatchProgress } from '@/hooks/use-media-library';
import { useSelectorPreferencesState } from '@/hooks/use-selector-preferences';
import { useSelectorResolution } from '@/hooks/use-selector-resolution';
import {
  api,
  type StreamSelectorData,
  type StreamSelectorStats,
  type StreamSelectorPreferences,
  type StreamSourceSummary,
} from '@/lib/api';
import { episodeProgressKey } from '@/lib/history-playback';
import { streamSelectorQueryKey } from '@/lib/query-invalidation';
import { playerStreamRankingOptions } from '@/lib/resolve-player-stream';
import { buildStreamRankingCacheKey } from '@/lib/stream-ranking';
import { filterSelectorStreams } from '@/lib/stream-selector-utils';
import type { StreamSelectorTarget } from '@/lib/stream-selector-target';
import { isSeriesLikeMediaType } from '@/lib/utils';

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

  const hasEnabledAddons = addonConfigs.some(
    (addon) => addon.enabled && addon.url.trim().length > 0,
  );

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
  const {
    data: streamSelectorData,
    error: streamSelectorDataError,
    isFetching: isFetchingStreamSelectorData,
    refetch: refetchStreamSelectorData,
  } = useQuery({
    queryKey: selectorQueryKey,
    queryFn: ({ signal }) => {
      // The backend emits a merged+ranked snapshot per addon — cache each so rows appear progressively.
      const generation = ++selectorFetchGenerationRef.current;
      const onProgress = new Channel<StreamSelectorData>();
      // Channel is not an EventTarget — onmessage is its only surface.
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      onProgress.onmessage = (snapshot) => {
        if (!signal.aborted && generation === selectorFetchGenerationRef.current) {
          queryClient.setQueryData(selectorQueryKey, snapshot);
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
    enabled: open && !!lookupId?.trim() && isOnline,
    staleTime: 1000 * 60 * 3,
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
  // Synchronous filter/sort so clicks feel instant; Rust stays the `smart` ranking authority.
  const sortedStreams = useMemo(
    () => filterSelectorStreams(streams, effectiveFilters, searchQuery),
    [streams, effectiveFilters, searchQuery],
  );

  // A failed addon-config read must not masquerade as "no addons" — surface it as a retryable error once loading settles.
  const fatalAddonError =
    streams.length === 0
      ? (streamSelectorData?.fatalErrorMessage ??
        streamSelectorDataError ??
        (isFetchingStreamSelectorData || isLoadingAddonConfigs ? null : addonConfigsError) ??
        null)
      : null;

  // Snapshots don't end the fetch; fetch state settles on error/cancel even with an incomplete last snapshot.
  const isLoading =
    streams.length === 0 &&
    !fatalAddonError &&
    (isLoadingAddonConfigs || isFetchingStreamSelectorData);

  const refetchStreams = useCallback(() => {
    void refetchAddonConfigs();
    void refetchStreamSelectorData();
  }, [refetchAddonConfigs, refetchStreamSelectorData]);

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
    qualityFilter,
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
