import { useQueryClient } from '@tanstack/react-query';
import { type MouseEvent, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { api, getErrorMessage, type WatchProgress } from '@/lib/api';
import { isSameMediaKind, openHistoryPlaybackPlan } from '@/lib/history-playback';
import { boundNavigate, currentPathWithSearch } from '@/lib/navigation';
import { claimPlaybackLaunch, isCurrentPlaybackLaunch } from '@/lib/player-navigation';
import { expandedSessionState, usePlayerSession } from '@/lib/player-session';
import { toLocalDate } from '@/lib/schedule-dates';

// Resume-from-history click: resolves the Rust playback plan before navigating. Ref guard blocks double-fires; late completion is dropped after unmount.
export function useHistoryPlayback(item: WatchProgress, errorTitle: string) {
  const queryClient = useQueryClient();
  const playerSession = usePlayerSession();
  // Read at click time so session changes keep `play` stable for memoized cards.
  const sessionRef = useRef(playerSession);
  useLayoutEffect(() => {
    sessionRef.current = playerSession;
  });
  const isMountedRef = useMountedRef();
  const [isPending, setIsPending] = useState(false);
  const pendingRef = useRef(false);

  const launch = async (
    resolveRow: (isCancelled: () => boolean) => Promise<WatchProgress | null>,
  ) => {
    if (pendingRef.current) return;
    const launchGeneration = claimPlaybackLaunch();
    const from = currentPathWithSearch();
    const isCancelled = () => !isMountedRef.current || !isCurrentPlaybackLaunch(launchGeneration);
    pendingRef.current = true;
    setIsPending(true);
    return (async () => {
      const row = await resolveRow(isCancelled);
      if (!row || isCancelled()) return;
      const { session, presentation } = sessionRef.current;
      if (
        presentation === 'mini' &&
        session?.id === row.id &&
        isSameMediaKind(session.type, row.type_) &&
        (row.type_ === 'movie' ||
          (session.season === String(row.absolute_season ?? row.season) &&
            session.episode === String(row.absolute_episode ?? row.episode)))
      ) {
        void boundNavigate(session.playerPath, { state: expandedSessionState(session, from) });
        return;
      }
      await openHistoryPlaybackPlan(boundNavigate, row, from, errorTitle, queryClient, {
        launchGeneration,
        isCancelled,
      });
    })().finally(() => {
      pendingRef.current = false;
      if (isMountedRef.current) setIsPending(false);
    });
  };

  const play = async (event: MouseEvent) => {
    event.preventDefault();
    await launch(async () => item);
  };

  const playNext = async () => {
    await launch(async (isCancelled) => {
      try {
        const next = await api.getNextEpisodeRow(item, toLocalDate(new Date()).toString());
        if (isCancelled()) return null;
        if (!next) toast.info('No next episode has aired yet');
        return next;
      } catch (error) {
        if (isCancelled()) return null;
        toast.error('Failed to find the next episode', {
          description: getErrorMessage(error),
        });
        return null;
      }
    });
  };

  return { play, playNext, isPending };
}
