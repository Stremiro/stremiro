import { Channel } from '@tauri-apps/api/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';
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
import { getLastUsedStreamIdentity, indexTitleWatchProgress } from '@/lib/history-playback';
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
  // Media type and id join the session key so titles sharing a lookup id
  // (kitsu/tt aliases) can't collide as one session.
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
    hasActiveFilter,
    qualityFilter,
    resetFilters,
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

  const enabledAddons = useMemo(
    () => addonConfigs.filter((addon) => addon.enabled && addon.url.trim().length > 0),
    [addonConfigs],
  );

  // Ranking inputs are part of the key so titles/episodes never share pages.
  const streamSelectorQueryKey = [
    'streams',
    'selector',
    type,
    lookupId,
    season,
    episode,
    absoluteEpisode,
    buildStreamRankingCacheKey(rankingOptions),
  ] as const;
  // Channels can't be cancelled — an abandoned invoke keeps emitting
  // snapshots into the same query key. A per-fetch generation drops them.
  const selectorFetchGenerationRef = useRef(0);
  const {
    data: streamSelectorData,
    error: streamSelectorDataError,
    isFetching: isFetchingStreamSelectorData,
    refetch: refetchStreamSelectorData,
  } = useQuery({
    queryKey: streamSelectorQueryKey,
    queryFn: ({ signal }) => {
      // The backend emits a merged+ranked snapshot per addon — write each
      // into the cache so rows appear progressively. The invoke result stays
      // the authoritative final payload.
      const generation = ++selectorFetchGenerationRef.current;
      const onProgress = new Channel<StreamSelectorData>();
      // Channel is not an EventTarget — onmessage is its only surface.
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      onProgress.onmessage = (snapshot) => {
        if (!signal.aborted && generation === selectorFetchGenerationRef.current) {
          queryClient.setQueryData(streamSelectorQueryKey, snapshot);
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

  // Only stream-declaring addons are real "sources": `sourceSummaries` covers
  // exactly the addons queried, so the count and the filter can't drift.
  // Preferences saved before the id-keyed filter may hold the display name —
  // the name→id map translates once here.
  const { streamSourceAddonIds, addonIdByName, streamSourceCount } = useMemo(() => {
    const ids = new Set<string>();
    const byName = new Map<string, string>();
    for (const summary of addonHealthMetrics) {
      ids.add(summary.id);
      const key = summary.name.trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, summary.id);
    }
    return { streamSourceAddonIds: ids, addonIdByName: byName, streamSourceCount: ids.size };
  }, [addonHealthMetrics]);

  const effectiveAddonFilter = useMemo(() => {
    const raw = filters.addon.trim();
    if (raw === 'all' || raw.length === 0) return 'all';
    if (streamSourceAddonIds.has(raw)) return raw;
    return addonIdByName.get(raw.toLowerCase()) ?? 'all';
  }, [addonIdByName, streamSourceAddonIds, filters.addon]);

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

  // Last-used stream identity — badge the row the title last played so a
  // reopening user can re-pick what worked.
  const { data: titleProgress } = useTitleWatchProgress(id, {
    enabled: open && isOnline && Boolean(id),
  });
  const { lastStreamKey, lastStreamFamily } = useMemo(
    () =>
      getLastUsedStreamIdentity(
        titleProgress?.history,
        type,
        absoluteSeason ?? season,
        absoluteEpisode ?? episode,
      ),
    [absoluteEpisode, absoluteSeason, episode, season, titleProgress, type],
  );
  // Per-episode watch rows — the pack picker reads resume points and
  // progress from the same snapshot as the badge.
  const { episodeProgressMap } = useMemo(
    () => indexTitleWatchProgress(titleProgress?.history),
    [titleProgress?.history],
  );
  // Filter/sort run synchronously so clicks feel instant; Rust stays the
  // ranking authority for `smart` order.
  const sortedStreams = useMemo(
    () => filterSelectorStreams(streams, effectiveFilters),
    [streams, effectiveFilters],
  );

  // A failed addon-config read must not masquerade as "no addons enabled" —
  // surface it as the retryable error it is once nothing is still loading.
  const fatalAddonError =
    streams.length === 0
      ? (streamSelectorData?.fatalErrorMessage ??
        streamSelectorDataError ??
        (isFetchingStreamSelectorData || isLoadingAddonConfigs ? null : addonConfigsError) ??
        null)
      : null;

  // Cache snapshots do not end the query's fetch. Its fetch state also
  // settles on error/cancel, even when the last snapshot is incomplete.
  const isLoading =
    streams.length === 0 &&
    !fatalAddonError &&
    (isLoadingAddonConfigs || isFetchingStreamSelectorData);

  const refetchStreams = useCallback(() => {
    void refetchAddonConfigs();
    void refetchStreamSelectorData();
  }, [refetchAddonConfigs, refetchStreamSelectorData]);

  const healthSummary = useMemo(() => {
    let degraded = 0;
    let offline = 0;
    let pending = 0;

    for (const metric of addonHealthMetrics) {
      if (metric.status === 'degraded') degraded += 1;
      else if (metric.status === 'offline') offline += 1;
      else if (metric.status === 'pending') pending += 1;
    }

    return { degraded, offline, pending };
  }, [addonHealthMetrics]);

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
    enabledAddons,
    episodeProgressMap,
    fatalAddonError,
    lastStreamKey,
    lastStreamFamily,
    lookupId,
    streamSourceCount,
    handleDialogOpenChange,
    handleRequestClose,
    handleSelectStream,
    hasActiveFilter,
    healthSummary,
    isAnyResolving,
    isLoading,
    isLoadingAddonConfigs,
    isOnline,
    qualityFilter,
    refetchStreams,
    resetFilters,
    selectorSessionKey,
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
