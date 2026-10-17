import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { isEpisodeSpoiler } from '@/components/details-episode-card';
import { type Episode, type MediaDetails, type TitleWatchProgress } from '@/lib/api';
import { buildEpisodeStreamTarget, findEpisodeByCoordinates } from '@/lib/episode-stream-target';
import {
  type DetailsHistoryRouteState,
  episodeProgressKey,
  getHistoryPlaybackFallbackNotice,
  MIN_RESUME_POSITION_SECS,
} from '@/lib/history-playback';
import { currentPathWithSearch, navigateApp, takeDetailsReturnState } from '@/lib/navigation';
import type { StreamSelectorTarget } from '@/lib/stream-selector-target';
import { getEpisodeTitle } from '@/lib/utils';

interface DetailsStreamSelectorTarget extends StreamSelectorTarget {
  /** Resume position for the picked stream — surfaced via `getStartTime`. */
  startTime?: number;
}

// Stream-selector state for the details page. The player's Back hands over a
// "reopen selector" payload — inline on a replace, or via the path-keyed stash
// on a POP (which can't write history state). The effect consumes it once.
export function useDetailsStreamSelector({
  item,
  isPlaceholderData,
  baseRouteType,
  baseRouteId,
  locationState,
  spoilerProtection,
  titleProgress,
}: {
  item: MediaDetails | undefined;
  /** Card placeholder carries no episodes — the handoff waits for the full payload. */
  isPlaceholderData: boolean;
  baseRouteType: string;
  baseRouteId: string;
  locationState: unknown;
  spoilerProtection: boolean;
  titleProgress: TitleWatchProgress | undefined;
}) {
  const [streamSelectorOpen, setStreamSelectorOpen] = useState(false);
  const [streamTarget, setStreamTarget] = useState<DetailsStreamSelectorTarget | null>(null);
  // One-shot latch, not render state — it's only read inside the effect.
  const reopenSelectorConsumedRef = useRef(false);
  // Mirrors `streamTarget` so `getStreamTargetStartTime` stays stable — the
  // selector calls it lazily at pick time.
  const streamTargetRef = useRef<DetailsStreamSelectorTarget | null>(null);
  const setTarget = useCallback((target: DetailsStreamSelectorTarget) => {
    streamTargetRef.current = target;
    setStreamTarget(target);
  }, []);
  const getStreamTargetStartTime = useCallback(() => streamTargetRef.current?.startTime, []);

  const preferredStreamId = item?.imdbId || item?.id;
  const itemId = item?.id;
  const itemTitle = item?.title;
  const itemDescription = item?.description;
  const itemPoster = item?.poster;
  const itemBackdrop = item?.backdrop;
  const itemLogo = item?.logo;
  const itemEpisodes = item?.episodes;

  // Forwarded into the player route so Back→details→Back reaches the real
  // origin instead of dead-ending on the details route.
  const rawDetailsFrom = (locationState as DetailsHistoryRouteState | undefined)?.from;
  const detailsOriginFrom = typeof rawDetailsFrom === 'string' ? rawDetailsFrom : undefined;

  const streamSelectorType: 'movie' | 'series' | 'anime' =
    item?.type === 'movie' ? 'movie' : baseRouteType === 'anime' ? 'anime' : 'series';

  // One builder for the fields every details-launched target shares.
  const buildBaseTarget = useCallback(
    (): DetailsStreamSelectorTarget => ({
      type: streamSelectorType,
      id: itemId ?? '',
      originFrom: detailsOriginFrom,
      poster: itemPoster,
      backdrop: itemBackdrop,
      logo: itemLogo,
      episodes: itemEpisodes,
      from: currentPathWithSearch(),
      title: '',
    }),
    [
      streamSelectorType,
      itemId,
      detailsOriginFrom,
      itemPoster,
      itemBackdrop,
      itemLogo,
      itemEpisodes,
    ],
  );

  const handleWatchMovie = useCallback(
    (startTime?: number) => {
      if (!itemId || !preferredStreamId) return;
      setTarget({
        ...buildBaseTarget(),
        streamId: preferredStreamId,
        title: itemTitle ?? '',
        overview: itemDescription,
        startTime,
      });
      setStreamSelectorOpen(true);
    },
    [itemId, itemTitle, itemDescription, preferredStreamId, buildBaseTarget, setTarget],
  );

  const openEpisodeStreamSelector = useCallback(
    (
      episodeInput: Episode,
      options?: {
        startTime?: number;
      },
    ): boolean => {
      if (!itemId || !preferredStreamId) return false;

      const target = buildEpisodeStreamTarget(preferredStreamId, episodeInput);
      const epProgress =
        titleProgress?.episodeProgress[
          episodeProgressKey(baseRouteId, episodeInput.season, episodeInput.episode)
        ];
      const hideSpoiler = isEpisodeSpoiler(
        episodeInput,
        spoilerProtection,
        titleProgress?.watchedEpisodeCeiling,
        epProgress,
      );

      setTarget({
        ...buildBaseTarget(),
        streamId: target.streamLookupId,
        season: target.streamSeason,
        episode: target.streamEpisode,
        absoluteSeason: target.absoluteSeason,
        absoluteEpisode: target.absoluteEpisode,
        // Bare title — the header owns the S/E label and player chrome re-adds it.
        title: itemTitle ?? '',
        episodeTitle: getEpisodeTitle(
          hideSpoiler ? undefined : episodeInput.title,
          episodeInput.episode,
        ),
        overview: hideSpoiler ? itemDescription : episodeInput.overview || itemDescription,
        startTime: options?.startTime,
      });
      setStreamSelectorOpen(true);
      return true;
    },
    [
      itemId,
      itemTitle,
      itemDescription,
      preferredStreamId,
      buildBaseTarget,
      setTarget,
      titleProgress,
      baseRouteId,
      spoilerProtection,
    ],
  );

  // One owner for "open the selector at S/E": episode lookup plus the target payload.
  const openEpisodeSelectorForCoordinates = useCallback(
    (season: number, episode: number, startTime?: number): boolean => {
      const targetEpisode = findEpisodeByCoordinates(itemEpisodes, season, episode);
      return openEpisodeStreamSelector(targetEpisode ?? { id: '', season, episode }, { startTime });
    },
    [itemEpisodes, openEpisodeStreamSelector],
  );

  const openDetailsReopenSelector = useCallback(
    (
      state?: Pick<
        DetailsHistoryRouteState,
        'reopenStreamSelector' | 'reopenStreamSeason' | 'reopenStreamEpisode' | 'reopenStartTime'
      >,
    ): boolean => {
      if (!state?.reopenStreamSelector || !item || !preferredStreamId) {
        return false;
      }

      const startTime =
        typeof state.reopenStartTime === 'number' &&
        state.reopenStartTime >= MIN_RESUME_POSITION_SECS
          ? state.reopenStartTime
          : undefined;

      if (item.type === 'movie') {
        handleWatchMovie(startTime);
        return true;
      }

      const reopenSeason =
        typeof state.reopenStreamSeason === 'number' ? state.reopenStreamSeason : undefined;
      const reopenEpisode =
        typeof state.reopenStreamEpisode === 'number' ? state.reopenStreamEpisode : undefined;

      if (reopenSeason === undefined || reopenEpisode === undefined) {
        return false;
      }

      return openEpisodeSelectorForCoordinates(reopenSeason, reopenEpisode, startTime);
    },
    [handleWatchMovie, item, openEpisodeSelectorForCoordinates, preferredStreamId],
  );

  useEffect(() => {
    if (reopenSelectorConsumedRef.current || !item || isPlaceholderData || !preferredStreamId) {
      return;
    }

    const navState = locationState as DetailsHistoryRouteState | undefined;
    // POP returns can't carry state — the player stashes the handoff path-keyed.
    const handoff = navState?.reopenStreamSelector
      ? navState
      : (takeDetailsReturnState(currentPathWithSearch()) as DetailsHistoryRouteState | undefined);

    if (!handoff) return;

    reopenSelectorConsumedRef.current = true;
    // Clean POP exits also carry the season; only reopening is conditional.
    const from = handoff.from ?? navState?.from;
    navigateApp(currentPathWithSearch(), {
      replace: true,
      state: {
        ...(from !== undefined ? { from } : {}),
        season: handoff.season ?? navState?.season,
      },
    });
    if (!handoff.reopenStreamSelector || streamTarget || streamSelectorOpen) return;
    if (!openDetailsReopenSelector(handoff)) {
      const notice = getHistoryPlaybackFallbackNotice('select-episode');
      toast.error(notice.title, { description: notice.description });
    }
  }, [
    item,
    isPlaceholderData,
    locationState,
    openDetailsReopenSelector,
    preferredStreamId,
    streamTarget,
    streamSelectorOpen,
  ]);

  const handleSelectorClose = useCallback(() => {
    setStreamSelectorOpen(false);
    reopenSelectorConsumedRef.current = true;
  }, []);

  const handleSelectorClosed = useCallback(() => {
    streamTargetRef.current = null;
    setStreamTarget(null);
  }, []);

  return {
    streamSelectorOpen,
    streamTarget,
    handleWatchMovie,
    openEpisodeStreamSelector,
    openEpisodeSelectorForCoordinates,
    handleSelectorClose,
    handleSelectorClosed,
    getStreamTargetStartTime,
  };
}
