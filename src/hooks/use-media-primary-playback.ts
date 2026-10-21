import { useQueryClient } from '@tanstack/react-query';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { useMountedRef } from '@/hooks/use-mounted-ref';
import { type HistoryPlaybackPlanReason, type MediaItem, type WatchProgress } from '@/lib/api';
import { prefetchDetailsRouteData } from '@/lib/details-prefetch';
import { expandedSessionState, usePlayerSession, warmPlayerChunk } from '@/lib/player-session';
import { openHistoryPlaybackPlan } from '@/lib/history-playback';
import { resolvePlayerStream } from '@/lib/resolve-player-stream';
import {
  buildDetailsRoute,
  claimPlaybackLaunch,
  isCurrentPlaybackLaunch,
  launchResolvedStream,
  type PlayerRouteMediaType,
  resolvePlayerRouteMediaType,
} from '@/lib/player-navigation';
import { formatSeasonEpisode, isSeriesLikeMediaType } from '@/lib/utils';

type PrimaryPlaybackSurface = 'card' | 'details';
type EpisodeSelectionReason = 'no-history' | HistoryPlaybackPlanReason;

interface UseMediaPrimaryPlaybackOptions {
  from: string;
  historyEntry?: WatchProgress | null;
  item?: MediaItem | null;
  /** Keep a card's launch alive when only its hover overlay unmounts. */
  launchOwnerMountedRef?: RefObject<boolean>;
  onPlayMovieWithoutHistory?: (() => void | Promise<void>) | null;
  onSelectEpisode?: ((reason: EpisodeSelectionReason) => void | Promise<void>) | null;
  surface: PrimaryPlaybackSurface;
}

function getPrimaryPlaybackLabel(
  surface: PrimaryPlaybackSurface,
  isResolving: boolean,
  mediaType?: PlayerRouteMediaType,
  hasResumePath?: boolean,
  resumeDetail?: string,
): string {
  if (isResolving) {
    return 'Opening…';
  }

  if (!mediaType) {
    return 'Play';
  }

  if (surface === 'details') {
    if (mediaType === 'movie') {
      return hasResumePath ? 'Continue' : 'Start Watching';
    }

    // Episode resumes name their target — "Continue S2:E4" beats a bare "Continue".
    return hasResumePath ? `Continue${resumeDetail ? ` ${resumeDetail}` : ''}` : 'Start Watching';
  }

  if (hasResumePath) {
    return 'Resume';
  }

  return mediaType === 'movie' ? 'Play' : 'View & Play';
}

function getHistoryPlaybackErrorTitle(
  surface: PrimaryPlaybackSurface,
  mediaType?: PlayerRouteMediaType,
): string {
  if (surface !== 'details' || !mediaType) {
    return 'Failed to resume playback';
  }

  return mediaType === 'movie' ? 'Failed to continue movie' : 'Failed to continue series';
}

export function useMediaPrimaryPlayback({
  from,
  historyEntry,
  item,
  launchOwnerMountedRef,
  onPlayMovieWithoutHistory,
  onSelectEpisode,
  surface,
}: UseMediaPrimaryPlaybackOptions) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session, presentation } = usePlayerSession();
  const playbackType: PlayerRouteMediaType = resolvePlayerRouteMediaType(item?.type);
  const itemId = item?.id;
  const itemType = item?.type;
  const historyId = historyEntry?.id;
  const historyType = historyEntry?.type_;
  const sessionId = session?.id;
  const sessionType = session?.type;
  const resumeEntry =
    historyId === itemId &&
    (historyType === playbackType ||
      (isSeriesLikeMediaType(historyType) && isSeriesLikeMediaType(playbackType)))
      ? historyEntry
      : null;
  const activeSession =
    presentation === 'mini' &&
    sessionId === itemId &&
    (sessionType === playbackType ||
      (isSeriesLikeMediaType(sessionType) && isSeriesLikeMediaType(playbackType)))
      ? session
      : null;
  const [isResolvingPrimaryAction, setIsResolvingPrimaryAction] = useState(false);
  // Delay only the rising edge; completion clears feedback immediately.
  const [showResolvingFeedback, setShowResolvingFeedback] = useState(false);
  useEffect(() => {
    if (!isResolvingPrimaryAction) {
      setShowResolvingFeedback(false);
      return;
    }
    const timer = window.setTimeout(() => setShowResolvingFeedback(true), 180);
    return () => window.clearTimeout(timer);
  }, [isResolvingPrimaryAction]);
  const isMountedRef = useMountedRef();
  const primaryActionInFlightRef = useRef(false);
  const primaryActionGenerationRef = useRef(0);
  useLayoutEffect(() => {
    // A title change frees the button; only a newer Play supersedes an explicit click.
    primaryActionInFlightRef.current = false;
    setIsResolvingPrimaryAction(false);
    setShowResolvingFeedback(false);
  }, [itemId, itemType]);

  const navigateToDetails = () => {
    if (!itemId || !itemType) {
      return;
    }

    prefetchDetailsRouteData(queryClient, {
      mediaId: itemId,
      mediaType: itemType,
    });
    navigate(buildDetailsRoute(playbackType, itemId), { state: { from } });
  };

  const handlePrimaryAction = async () => {
    if (!item || primaryActionInFlightRef.current) {
      return;
    }
    const launchGeneration = claimPlaybackLaunch();
    if (activeSession) {
      navigate(activeSession.playerPath, { state: expandedSessionState(activeSession, from) });
      return;
    }

    primaryActionInFlightRef.current = true;
    const generation = ++primaryActionGenerationRef.current;
    const isCurrentAction = () =>
      (launchOwnerMountedRef ?? isMountedRef).current &&
      generation === primaryActionGenerationRef.current &&
      isCurrentPlaybackLaunch(launchGeneration);
    const runPrimaryAction = async () => {
      if (resumeEntry) {
        setIsResolvingPrimaryAction(true);
        await openHistoryPlaybackPlan(
          navigate,
          resumeEntry,
          from,
          getHistoryPlaybackErrorTitle(surface, playbackType),
          queryClient,
          { onSelectEpisode, launchGeneration, isCancelled: () => !isCurrentAction() },
        );
        return;
      }

      warmPlayerChunk();

      if (playbackType !== 'movie') {
        if (onSelectEpisode) {
          await onSelectEpisode('no-history');
          return;
        }

        navigateToDetails();
        return;
      }

      if (onPlayMovieWithoutHistory) {
        setIsResolvingPrimaryAction(true);
        try {
          await onPlayMovieWithoutHistory();
        } catch (error) {
          if (!isCurrentAction()) return;
          toast.error('Failed to start playback', {
            description: error instanceof Error ? error.message : 'Please try again.',
          });
        }
        return;
      }

      setIsResolvingPrimaryAction(true);
      const toastId = toast.loading('Finding the best stream…', { description: item.title });

      try {
        // Same resolve as the player path; ranking context lets title affinity and language prefs score.
        const request = {
          mediaType: playbackType,
          mediaId: item.id,
          // Pin the prime-key id — the player's replay prefers `details.imdbId` and misses primed entries on aliased titles (kitsu/tt).
          streamLookupId: item.id,
          title: item.title,
        };
        const resolved = await resolvePlayerStream(request);

        toast.dismiss(toastId);
        if (!isCurrentAction()) return;

        if (!resolved.url) {
          toast.error('No streams found', { description: item.title });
          navigateToDetails();
          return;
        }
        launchResolvedStream(navigate, request, resolved, {
          backdrop: item.backdrop,
          from,
          poster: item.poster,
        });
      } catch {
        toast.dismiss(toastId);
        if (!isCurrentAction()) return;
        toast.error('Could not resolve stream', {
          description: 'Opening details page instead…',
        });
        navigateToDetails();
      }
    };
    await runPrimaryAction().finally(() => {
      if (isMountedRef.current && generation === primaryActionGenerationRef.current) {
        primaryActionInFlightRef.current = false;
        setIsResolvingPrimaryAction(false);
      }
    });
  };

  const resumeSeason = activeSession
    ? activeSession.season === undefined
      ? undefined
      : Number(activeSession.season)
    : (resumeEntry?.absolute_season ?? undefined);
  const resumeEpisode = activeSession
    ? activeSession.episode === undefined
      ? undefined
      : Number(activeSession.episode)
    : (resumeEntry?.absolute_episode ?? undefined);
  const resumeDetail = formatSeasonEpisode(resumeSeason, resumeEpisode) || undefined;
  const primaryActionLabel = getPrimaryPlaybackLabel(
    surface,
    showResolvingFeedback,
    item ? playbackType : undefined,
    Boolean(activeSession || resumeEntry),
    resumeDetail,
  );

  return {
    handlePrimaryAction,
    isResolvingPrimaryAction,
    showResolvingFeedback,
    canReturnToActivePlayer: Boolean(activeSession),
    primaryActionLabel,
  };
}
