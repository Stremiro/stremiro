import { useQueryClient } from '@tanstack/react-query';
import { type MouseEvent, useCallback, useRef, useState } from 'react';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import type { WatchProgress } from '@/lib/api';
import { openHistoryPlaybackPlan } from '@/lib/history-playback';
import { boundNavigate, currentPathWithSearch } from '@/lib/navigation';
import { claimPlaybackLaunch } from '@/lib/player-navigation';

// Resume-from-history click: resolves the Rust playback plan before navigating. Ref guard blocks double-fires; late completion is dropped after unmount.
export function useHistoryPlayback(item: WatchProgress, errorTitle: string) {
  const queryClient = useQueryClient();
  const isMountedRef = useMountedRef();
  const [isPending, setIsPending] = useState(false);
  const pendingRef = useRef(false);

  const play = useCallback(
    async (event: MouseEvent) => {
      event.preventDefault();
      if (pendingRef.current) return;
      const launchGeneration = claimPlaybackLaunch();
      pendingRef.current = true;
      setIsPending(true);
      try {
        await openHistoryPlaybackPlan(
          boundNavigate,
          item,
          currentPathWithSearch(),
          errorTitle,
          queryClient,
          { launchGeneration, isCancelled: () => !isMountedRef.current },
        );
      } finally {
        pendingRef.current = false;
        if (isMountedRef.current) {
          setIsPending(false);
        }
      }
    },
    [item, errorTitle, queryClient, isMountedRef],
  );

  return { play, isPending };
}
