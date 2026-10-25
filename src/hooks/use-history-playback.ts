import { useQueryClient } from '@tanstack/react-query';
import { type MouseEvent, useLayoutEffect, useRef, useState } from 'react';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import type { WatchProgress } from '@/lib/api';
import { isSameMediaKind, openHistoryPlaybackPlan } from '@/lib/history-playback';
import { boundNavigate, currentPathWithSearch } from '@/lib/navigation';
import { claimPlaybackLaunch } from '@/lib/player-navigation';
import { expandedSessionState, usePlayerSession } from '@/lib/player-session';

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

  const play = async (event: MouseEvent) => {
    event.preventDefault();
    if (pendingRef.current) return;
    const launchGeneration = claimPlaybackLaunch();
    const from = currentPathWithSearch();
    const { session, presentation } = sessionRef.current;
    if (
      presentation === 'mini' &&
      session?.id === item.id &&
      isSameMediaKind(session.type, item.type_) &&
      (item.type_ === 'movie' ||
        (session.season === String(item.absolute_season ?? item.season) &&
          session.episode === String(item.absolute_episode ?? item.episode)))
    ) {
      boundNavigate(session.playerPath, { state: expandedSessionState(session, from) });
      return;
    }
    pendingRef.current = true;
    setIsPending(true);
    await openHistoryPlaybackPlan(boundNavigate, item, from, errorTitle, queryClient, {
      launchGeneration,
      isCancelled: () => !isMountedRef.current,
    }).finally(() => {
      pendingRef.current = false;
      if (isMountedRef.current) {
        setIsPending(false);
      }
    });
  };

  return { play, isPending };
}
