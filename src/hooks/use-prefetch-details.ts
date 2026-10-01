import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { prefetchDetailsRouteData } from '@/lib/details-prefetch';

// Hover/focus intent for the details route: binds a stable prefetch
// callback so memoized cards and rows don't churn on every render.
export function usePrefetchDetails(mediaId: string, mediaType?: string | null) {
  const queryClient = useQueryClient();
  return useCallback(() => {
    prefetchDetailsRouteData(queryClient, { mediaId, mediaType });
  }, [queryClient, mediaId, mediaType]);
}
