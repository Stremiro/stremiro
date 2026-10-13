import { useCallback, useState } from 'react';

import type { MediaDetails } from '@/lib/api';
import { buildYouTubeEmbedUrl } from '@/lib/trailer-utils';

// Trailer dialog state for the details hero. The URL is derived, not staged:
// `DialogContent` only mounts while open, so autoplay can't run hidden.
export function useDetailsTrailer(item: MediaDetails | undefined) {
  const [trailerOpen, setTrailerOpen] = useState(false);
  const trailerId = item?.trailers?.[0]?.id;
  const trailerUrl = trailerId ? buildYouTubeEmbedUrl(trailerId, { autoplay: true }) : null;

  const openTrailer = useCallback(() => {
    if (trailerUrl) setTrailerOpen(true);
  }, [trailerUrl]);

  return { trailerOpen, trailerUrl, openTrailer, onTrailerOpenChange: setTrailerOpen };
}
