import { useQueryClient } from '@tanstack/react-query';
import { type MouseEvent, useCallback, useRef, useState } from 'react';
import type { NavigateFunction, NavigateOptions, To } from 'react-router';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import type { WatchProgress } from '@/lib/api';
import { openHistoryPlaybackPlan } from '@/lib/history-playback';
import { currentPathWithSearch, navigateApp } from '@/lib/navigation';

// Root-bound navigate: useNavigate() would re-subscribe every history card to location changes.
const boundNavigate: NavigateFunction = (to: To | number, options?: NavigateOptions) => {
  navigateApp(to, options);
};

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
      pendingRef.current = true;
      setIsPending(true);
      try {
        await openHistoryPlaybackPlan(
          boundNavigate,
          item,
          currentPathWithSearch(),
          errorTitle,
          queryClient,
          { isCancelled: () => !isMountedRef.current },
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
