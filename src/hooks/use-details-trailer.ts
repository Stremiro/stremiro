import { useCallback, useState } from 'react';

import type { MediaDetails } from '@/lib/api';
import { buildYouTubeEmbedUrl } from '@/lib/trailer-utils';

// Trailer dialog state + opener for the details hero. The backend ships only
// validated YouTube ids, so the first trailer always embeds in-app. The URL
// is derived rather than staged: `DialogContent` only mounts while open, so
// autoplay can't run against a hidden iframe.
export function useDetailsTrailer(item: MediaDetails | undefined) {
  const [trailerOpen, setTrailerOpen] = useState(false);
  const trailerId = item?.trailers?.[0]?.id;
  const trailerUrl = trailerId ? buildYouTubeEmbedUrl(trailerId, { autoplay: true }) : null;

  const openTrailer = useCallback(() => {
    if (trailerUrl) setTrailerOpen(true);
  }, [trailerUrl]);

  return { trailerOpen, trailerUrl, openTrailer, onTrailerOpenChange: setTrailerOpen };
}
