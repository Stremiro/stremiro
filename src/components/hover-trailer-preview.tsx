import { useCallback, useEffect, useRef, useState } from 'react';
import {
  YOUTUBE_PLAYER_STATE,
  buildYouTubeEmbedUrl,
  isYouTubePlayerOrigin,
  isYouTubeReadyEvent,
  parseYouTubeMessage,
  parseYouTubePlayerState,
  postYouTubeCommand,
  postYouTubeListening,
} from '@/lib/trailer-utils';
import { cn } from '@/lib/utils';

interface HoverTrailerPreviewProps {
  videoId: string;
}

const LISTENING_RETRY_MS = 250;
const LISTENING_RETRY_BUDGET_MS = 4_000;

export function HoverTrailerPreview({ videoId }: HoverTrailerPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hasPlayedRef = useRef(false);
  const connectedRef = useRef(false);
  // Prevent PAUSED events from undoing a visibility pause.
  const hiddenPausedRef = useRef(false);
  const [revealed, setRevealed] = useState(false);

  const embedUrl = buildYouTubeEmbedUrl(videoId, {
    autoplay: true,
    controls: false,
    mute: true,
    playsInline: true,
    rel: false,
    chromeless: true,
    origin: window.location.origin,
  });

  const handshake = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) {
      return;
    }

    postYouTubeListening(iframe);
    postYouTubeCommand(iframe, 'addEventListener', ['onStateChange']);
    postYouTubeCommand(iframe, 'mute');
    hiddenPausedRef.current = document.hidden;
    postYouTubeCommand(iframe, document.hidden ? 'pauseVideo' : 'playVideo');
  }, []);

  useEffect(() => {
    hasPlayedRef.current = false;
    connectedRef.current = false;
    hiddenPausedRef.current = false;
    setRevealed(false);
  }, [videoId]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) {
        return;
      }

      if (!isYouTubePlayerOrigin(event.origin)) {
        return;
      }

      const payload = parseYouTubeMessage(event.data);
      if (isYouTubeReadyEvent(payload)) {
        connectedRef.current = true;
        handshake();
        return;
      }

      const playerState = parseYouTubePlayerState(payload);
      if (playerState === null) {
        return;
      }

      connectedRef.current = true;

      // Autoplay can start after the visibility event already ran.
      if (document.hidden) {
        hiddenPausedRef.current = true;
        setRevealed(false);
        if (
          playerState === YOUTUBE_PLAYER_STATE.PLAYING ||
          playerState === YOUTUBE_PLAYER_STATE.BUFFERING
        ) {
          postYouTubeCommand(iframe, 'pauseVideo');
        }
        return;
      }

      if (playerState === YOUTUBE_PLAYER_STATE.PLAYING) {
        hasPlayedRef.current = true;
        setRevealed(true);
        return;
      }

      if (playerState === YOUTUBE_PLAYER_STATE.BUFFERING && hasPlayedRef.current) {
        setRevealed(true);
        return;
      }

      setRevealed(false);

      if (playerState === YOUTUBE_PLAYER_STATE.ENDED) {
        postYouTubeCommand(iframe, 'seekTo', [0, true]);
        postYouTubeCommand(iframe, 'playVideo');
        return;
      }

      if (
        playerState === YOUTUBE_PLAYER_STATE.PAUSED &&
        hasPlayedRef.current &&
        !hiddenPausedRef.current
      ) {
        postYouTubeCommand(iframe, 'playVideo');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [handshake, videoId]);

  // Pause on hide; hidden autoplay completions are handled above.
  useEffect(() => {
    const handleVisibility = () => {
      const iframe = iframeRef.current;
      if (!iframe || !connectedRef.current) return;
      if (document.hidden) {
        hiddenPausedRef.current = true;
        postYouTubeCommand(iframe, 'pauseVideo');
      } else if (hiddenPausedRef.current) {
        hiddenPausedRef.current = false;
        postYouTubeCommand(iframe, 'playVideo');
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  useEffect(() => {
    const startedAt = Date.now();
    const retryId = window.setInterval(() => {
      if (
        hasPlayedRef.current ||
        connectedRef.current ||
        Date.now() - startedAt >= LISTENING_RETRY_BUDGET_MS
      ) {
        window.clearInterval(retryId);
        return;
      }

      handshake();
    }, LISTENING_RETRY_MS);

    return () => {
      window.clearInterval(retryId);
    };
  }, [handshake, videoId]);

  // YouTube embeds require scripts+same-origin; the sandbox still bounds
  // top-level navigation, forms, and downloads.
  /* eslint-disable react/iframe-missing-sandbox */
  return (
    <iframe
      ref={iframeRef}
      key={embedUrl}
      src={embedUrl}
      onLoad={handshake}
      className={cn(
        // Crop YouTube's edge chrome outside the preview.
        'absolute inset-0 h-full w-full scale-[1.3] border-0 pointer-events-none ease-out',
        revealed
          ? 'opacity-100 transition-opacity duration-300'
          : 'opacity-0 transition-opacity duration-75',
      )}
      sandbox='allow-scripts allow-same-origin allow-presentation allow-popups'
      allow='accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture'
      referrerPolicy='strict-origin-when-cross-origin'
      title='Trailer preview'
      tabIndex={-1}
      aria-hidden
    />
  );
  /* eslint-enable react/iframe-missing-sandbox */
}
