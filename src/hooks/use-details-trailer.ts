import { useCallback, useState } from 'react';

import type { MediaDetails } from '@/lib/api';
import { buildYouTubeEmbedUrl } from '@/lib/trailer-utils';

// Trailer dialog state + opener for the details hero. The backend ships only
// validated YouTube ids, so the first trailer always embeds in-app.
export function useDetailsTrailer(item: MediaDetails | undefined) {
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [trailerUrl, setTrailerUrl] = useState<string | null>(null);
  const trailerId = item?.trailers?.[0]?.id;

  const openTrailer = useCallback(() => {
    if (!trailerId) return;
    setTrailerUrl(buildYouTubeEmbedUrl(trailerId, { autoplay: true }));
    setTrailerOpen(true);
  }, [trailerId]);

  const onTrailerOpenChange = useCallback((open: boolean) => {
    setTrailerOpen(open);
    // Keep trailerUrl through the close: clearing it here unmounts the
    // iframe while Radix is still animating out, collapsing the dialog
    // mid-transition. The content unmounts with the dialog anyway, and the
    // next open writes a fresh URL.
  }, []);

  return { trailerOpen, trailerUrl, openTrailer, onTrailerOpenChange };
}
