import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { useMountedRef } from '@/hooks/use-mounted-ref';
import {
  api,
  type HistoryPlaybackPlan,
  type HistoryPlaybackPlanReason,
  type MediaItem,
  type WatchProgress,
} from '@/lib/api';
import { prefetchDetailsRouteData, prefetchFullDetailsData } from '@/lib/details-prefetch';
import { warmPlayerChunk } from '@/lib/player-session';
import { applyHistoryPlaybackPlan, watchProgressCoordinates } from '@/lib/history-playback';
import { resolvePlayerStream } from '@/lib/resolve-player-stream';
import {
  launchResolvedStream,
  type PlayerRouteMediaType,
  resolvePlayerRouteMediaType,
} from '@/lib/player-navigation';
import { formatSeasonEpisode } from '@/lib/utils';

type PrimaryPlaybackSurface = 'card' | 'details';
type EpisodeSelectionReason = 'no-history' | HistoryPlaybackPlanReason;

interface UseMediaPrimaryPlaybackOptions {
  from: string;
  historyEntry?: WatchProgress | null;
  item?: MediaItem | null;
  onPlayMovieWithoutHistory?: (() => void | Promise<void>) | null;
  onSelectEpisode?: ((reason: EpisodeSelectionReason) => void | Promise<void>) | null;
  surface: PrimaryPlaybackSurface;
}

function getPrimaryPlaybackLabel(
  surface: PrimaryPlaybackSurface,
  isResolving: boolean,
  item?: MediaItem | null,
  hasResumePath?: boolean,
  resumeDetail?: string,
): string {
  if (isResolving) {
    return 'Resolving…';
  }

  if (!item) {
    return 'Play';
  }

  if (surface === 'details') {
    if (item.type === 'movie') {
      return hasResumePath ? 'Continue' : 'Play';
    }

    // Episode resumes name their target — "Continue S2:E4" beats a bare
    // "Continue" that says nothing about where playback lands.
    return hasResumePath ? `Continue${resumeDetail ? ` ${resumeDetail}` : ''}` : 'Start Watching';
  }

  if (hasResumePath) {
    return 'Resume';
  }

  return item.type === 'movie' ? 'Play' : 'View & Play';
}

function getHistoryPlaybackErrorTitle(
  surface: PrimaryPlaybackSurface,
  item?: MediaItem | null,
): string {
  if (surface !== 'details' || !item) {
    return 'Failed to resume playback';
  }

  return item.type === 'movie' ? 'Failed to continue movie' : 'Failed to continue series';
}

export function useMediaPrimaryPlayback({
  from,
  historyEntry,
  item,
  onPlayMovieWithoutHistory,
  onSelectEpisode,
  surface,
}: UseMediaPrimaryPlaybackOptions) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isResolvingPrimaryAction, setIsResolvingPrimaryAction] = useState(false);
  const isMountedRef = useMountedRef();
  const primaryActionInFlightRef = useRef(false);
  const playbackType: PlayerRouteMediaType = resolvePlayerRouteMediaType(item?.type);
  const itemId = item?.id;
  const itemType = item?.type;

  const navigateToDetails = useCallback(() => {
    if (!itemId || !itemType) {
      return;
    }

    prefetchDetailsRouteData(queryClient, {
      mediaId: itemId,
      mediaType: itemType,
    });
    navigate(`/details/${playbackType}/${itemId}`, { state: { from } });
  }, [from, itemId, itemType, navigate, playbackType, queryClient]);

  const runActionWithFeedback = useCallback(
    async (action: () => void | Promise<void>, errorTitle: string) => {
      setIsResolvingPrimaryAction(true);

      try {
        await action();
        return true;
      } catch (error) {
        toast.error(errorTitle, {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
        return false;
      } finally {
        if (isMountedRef.current) {
          setIsResolvingPrimaryAction(false);
        }
      }
    },
    [isMountedRef],
  );

  const handleHistoryPlaybackPlan = useCallback(
    (plan: HistoryPlaybackPlan) =>
      applyHistoryPlaybackPlan(navigate, plan, {
        onSelectEpisode,
        isCancelled: () => !isMountedRef.current,
      }),
    [isMountedRef, navigate, onSelectEpisode],
  );

  const handlePrimaryAction = useCallback(async () => {
    if (!item || primaryActionInFlightRef.current) {
      return;
    }

    // Every path below ends in a player mount — start the lazy chunk fetch
    // while history/episode resolution runs.
    warmPlayerChunk();
    primaryActionInFlightRef.current = true;
    try {
      if (historyEntry) {
        await runActionWithFeedback(
          async () => {
            // Same overlap as continue watching: the player's episode-mapping
            // gate waits on full details for series-like titles.
            prefetchFullDetailsData(queryClient, {
              mediaId: historyEntry.id,
              mediaType: historyEntry.type_,
            });
            const plan = await api.buildHistoryPlaybackPlan(historyEntry, from);
            await handleHistoryPlaybackPlan(plan);
          },
          getHistoryPlaybackErrorTitle(surface, item),
        );
        return;
      }

      if (item.type !== 'movie') {
        if (onSelectEpisode) {
          await onSelectEpisode('no-history');
          return;
        }

        navigateToDetails();
        return;
      }

      if (onPlayMovieWithoutHistory) {
        await runActionWithFeedback(onPlayMovieWithoutHistory, 'Failed to start playback');
        return;
      }

      setIsResolvingPrimaryAction(true);
      const toastId = toast.loading('Finding best stream…', { description: item.title });

      try {
        // Same command as the player path, with ranking context so title
        // affinity and language prefs score instead of falling back to zero.
        const request = {
          mediaType: playbackType,
          mediaId: item.id,
          // Pin the id the prime keys under: without it the player's replay
          // chain prefers `details.imdbId` and misses the primed entry on
          // aliased titles (kitsu/tt).
          streamLookupId: item.id,
          title: item.title,
        };
        const resolved = await resolvePlayerStream(request);

        toast.dismiss(toastId);

        if (!resolved.url) {
          toast.error('No streams found', { description: item.title });
          if (isMountedRef.current) {
            navigateToDetails();
          }
          return;
        }

        // The resolve can take seconds; if the initiating surface unmounted
        // meanwhile, navigating would yank the user away from wherever they
        // went (the selector's own path guards this with attempt ids).
        if (isMountedRef.current) {
          launchResolvedStream(navigate, request, resolved, {
            backdrop: item.backdrop,
            from,
            poster: item.poster,
          });
        }
      } catch {
        toast.dismiss(toastId);
        toast.error('Could not resolve stream', {
          description: 'Opening details page instead…',
        });
        if (isMountedRef.current) {
          navigateToDetails();
        }
      } finally {
        if (isMountedRef.current) {
          setIsResolvingPrimaryAction(false);
        }
      }
    } finally {
      primaryActionInFlightRef.current = false;
    }
  }, [
    from,
    handleHistoryPlaybackPlan,
    historyEntry,
    isMountedRef,
    item,
    navigate,
    navigateToDetails,
    onPlayMovieWithoutHistory,
    onSelectEpisode,
    playbackType,
    queryClient,
    runActionWithFeedback,
    surface,
  ]);

  const { season: resumeSeason, episode: resumeEpisode } = watchProgressCoordinates(historyEntry);
  const resumeDetail = formatSeasonEpisode(resumeSeason, resumeEpisode) || undefined;
  const primaryActionLabel = getPrimaryPlaybackLabel(
    surface,
    isResolvingPrimaryAction,
    item,
    Boolean(historyEntry),
    resumeDetail,
  );

  return {
    handlePrimaryAction,
    isResolvingPrimaryAction,
    primaryActionLabel,
  };
}
