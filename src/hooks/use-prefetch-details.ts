import { useQueryClient } from '@tanstack/react-query';
import { prefetchDetailsRouteData } from '@/lib/details-prefetch';

export function usePrefetchDetails(mediaId: string, mediaType?: string | null) {
  const queryClient = useQueryClient();
  return () => {
    prefetchDetailsRouteData(queryClient, { mediaId, mediaType });
  };
}
