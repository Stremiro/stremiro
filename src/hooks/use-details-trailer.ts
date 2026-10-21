import { useState } from 'react';

import type { MediaDetails } from '@/lib/api';
import { buildYouTubeEmbedUrl } from '@/lib/trailer-utils';

// Trailer dialog state for the details hero. The URL is derived, not staged:
// `DialogContent` only mounts while open, so autoplay can't run hidden.
export function useDetailsTrailer(item: MediaDetails | undefined) {
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [selectedId, selectTrailer] = useState<string | undefined>();
  const trailers = item?.trailers ?? [];
  const selectedTrailer = trailers.find((trailer) => trailer.id === selectedId) ?? trailers[0];
  const selectedTrailerId = selectedTrailer?.id;
  const trailerUrl = selectedTrailerId
    ? buildYouTubeEmbedUrl(selectedTrailerId, { autoplay: true })
    : null;

  const openTrailer = () => {
    if (trailerUrl) setTrailerOpen(true);
  };

  return {
    trailerOpen,
    trailerUrl,
    trailers,
    selectedTrailerId,
    selectTrailer,
    openTrailer,
    onTrailerOpenChange: setTrailerOpen,
  };
}
