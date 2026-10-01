import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { type Episode, type MediaDetails } from '@/lib/api';
import { buildEpisodeStreamTarget, findEpisodeByCoordinates } from '@/lib/episode-stream-target';
import {
  type DetailsHistoryRouteState,
  getHistoryPlaybackFallbackNotice,
  MIN_RESUME_POSITION_SECS,
} from '@/lib/history-playback';
import { currentPathWithSearch, navigateApp, takeDetailsReturnState } from '@/lib/navigation';
import type { StreamSelectorTarget } from '@/lib/stream-selector-target';

interface DetailsStreamSelectorTarget extends StreamSelectorTarget {
  /** Resume position for the picked stream — surfaced via `getStartTime`. */
  startTime?: number;
}

// Stream-selector state machine for the details page: open/close, the params
// the dialog renders from, and the open paths. The player's Back hands over a
// "reopen selector" payload — inline on a replace, or via the path-keyed stash
// on a POP (which can't write history state). The effect consumes it once.
export function useDetailsStreamSelector({
  item,
  isPlaceholderData,
  baseRouteType,
  locationState,
}: {
  item: MediaDetails | undefined;
  /** Card placeholder carries no episodes — the handoff waits for the full payload. */
  isPlaceholderData: boolean;
  baseRouteType: string;
  locationState: unknown;
}) {
  const [streamSelectorOpen, setStreamSelectorOpen] = useState(false);
  const [streamTarget, setStreamTarget] = useState<DetailsStreamSelectorTarget | null>(null);
  // One-shot latch, not render state: it's only read inside the effect, so a
  // state flag would pay a render per consume.
  const reopenSelectorConsumedRef = useRef(false);
  // Mirrors `streamTarget` so `getStreamTargetStartTime` can stay referentially
  // stable — the selector calls it lazily at pick time, not per render.
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

  // The details page's own origin — forwarded into the player route so
  // Back→details→Back reaches the real origin (search, calendar) instead of
  // dead-ending on the details route itself.
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
      episodeInput: Pick<
        Episode,
        'season' | 'episode' | 'title' | 'streamLookupId' | 'streamSeason' | 'streamEpisode'
      >,
      options?: {
        overview?: string;
        startTime?: number;
      },
    ): boolean => {
      if (!itemId || !preferredStreamId) return false;

      const target = buildEpisodeStreamTarget(preferredStreamId, episodeInput);

      setTarget({
        ...buildBaseTarget(),
        streamId: target.streamLookupId,
        season: target.streamSeason,
        episode: target.streamEpisode,
        absoluteSeason: target.absoluteSeason,
        absoluteEpisode: target.absoluteEpisode,
        // Bare title: the header owns the S/E label itself, and the same
        // string rides into the player route where chrome adds it again.
        title: itemTitle ?? '',
        episodeTitle: episodeInput.title,
        overview: options?.overview,
        startTime: options?.startTime,
      });
      setStreamSelectorOpen(true);
      return true;
    },
    [itemId, itemTitle, preferredStreamId, buildBaseTarget, setTarget],
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

      const targetEpisode = findEpisodeByCoordinates(item.episodes, reopenSeason, reopenEpisode);

      return openEpisodeStreamSelector(
        {
          season: reopenSeason,
          episode: reopenEpisode,
          title: targetEpisode?.title,
          streamLookupId: targetEpisode?.streamLookupId,
          streamSeason: targetEpisode?.streamSeason,
          streamEpisode: targetEpisode?.streamEpisode,
        },
        {
          overview: targetEpisode?.overview || item.description,
          startTime,
        },
      );
    },
    [handleWatchMovie, item, openEpisodeStreamSelector, preferredStreamId],
  );

  useEffect(() => {
    if (reopenSelectorConsumedRef.current || !item || isPlaceholderData || !preferredStreamId) {
      return;
    }

    const navState = locationState as DetailsHistoryRouteState | undefined;
    // POP returns can't carry state — the player stashes the same handoff
    // path-keyed instead.
    const handoff = navState?.reopenStreamSelector
      ? navState
      : (takeDetailsReturnState(currentPathWithSearch()) as DetailsHistoryRouteState | undefined);

    if (!handoff?.reopenStreamSelector) return;

    // Surface a dropped handoff: the player asked for the selector but the
    // episode metadata can't honor it — a silent no-op reads as a broken Back.
    reopenSelectorConsumedRef.current = true;
    // History state outlives the mount — strip the one-shot fields so a later
    // remount of this entry can't re-fire the selector, and fold the season
    // hint in so the episode pane lands on the returned-from coordinates.
    navigateApp(currentPathWithSearch(), {
      replace: true,
      state: {
        ...(navState?.from !== undefined ? { from: navState.from } : {}),
        season: handoff.season ?? navState?.season,
      },
    });
    // The strip above still runs when the selector is already open — a stale
    // handoff must not hijack it, but it must not outlive this mount either.
    if (streamTarget || streamSelectorOpen) return;
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

  return {
    streamSelectorOpen,
    streamTarget,
    handleWatchMovie,
    openEpisodeStreamSelector,
    handleSelectorClose,
    getStreamTargetStartTime,
  };
}
