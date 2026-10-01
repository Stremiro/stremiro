import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import type { MediaDetails } from '@/lib/api';
import { resolveTrailerEmbedUrl } from '@/lib/trailer-utils';

// Trailer dialog state + opener for the details hero. The backend only
// emits strict YouTube watch URLs, so every trailer embeds in-app — a URL
// that fails to resolve is a data bug, not a different opening strategy.
export function useDetailsTrailer(item: MediaDetails | undefined) {
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [trailerUrl, setTrailerUrl] = useState<string | null>(null);
  const trailers = item?.trailers;

  const openTrailer = useCallback(() => {
    // First candidate that embeds wins — a dead first URL shouldn't mask the
    // rest of the trailer list.
    for (const trailer of trailers ?? []) {
      const embedUrl = resolveTrailerEmbedUrl(trailer.url?.trim(), { autoplay: true });
      if (embedUrl) {
        setTrailerUrl(embedUrl);
        setTrailerOpen(true);
        return;
      }
    }
    toast.error('Trailer unavailable');
  }, [trailers]);

  const onTrailerOpenChange = useCallback((open: boolean) => {
    setTrailerOpen(open);
    // Keep trailerUrl through the close: clearing it here unmounts the
    // iframe while Radix is still animating out, collapsing the dialog
    // mid-transition. The content unmounts with the dialog anyway, and the
    // next open writes a fresh URL.
  }, []);

  return { trailerOpen, trailerUrl, openTrailer, onTrailerOpenChange };
}
