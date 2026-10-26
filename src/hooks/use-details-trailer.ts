import { useState } from 'react';
import { preconnect, preload } from 'react-dom';

import type { MediaDetails } from '@/lib/api';
import {
  buildYouTubeEmbedUrl,
  YOUTUBE_EMBED_ORIGIN,
  youTubeThumbnailUrl,
} from '@/lib/youtube-player';

// Trailer dialog state for the details hero. The URL is derived, not staged:
// `DialogContent` only mounts while open, so autoplay can't run hidden.
export function useDetailsTrailer(item: MediaDetails | undefined) {
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [selectedId, selectTrailer] = useState<string | undefined>();
  const trailers = item?.trailers ?? [];
  const selectedTrailer = trailers.find((trailer) => trailer.id === selectedId) ?? trailers[0];
  const selectedTrailerId = selectedTrailer?.id;
  const trailerUrl = selectedTrailerId
    ? buildYouTubeEmbedUrl(selectedTrailerId, {
        autoplay: true,
        jsApi: true,
        origin: window.location.origin,
      })
    : null;

  // Hover/focus intent opens the embed connection and fetches the poster frame before the click.
  const warmTrailer = () => {
    if (!selectedTrailerId) return;
    preconnect(YOUTUBE_EMBED_ORIGIN);
    preload(youTubeThumbnailUrl(selectedTrailerId), { as: 'image', fetchPriority: 'low' });
  };

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
    warmTrailer,
    onTrailerOpenChange: setTrailerOpen,
  };
}
