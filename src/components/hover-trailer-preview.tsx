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
} from '@/lib/youtube-player';
import { cn } from '@/lib/utils';

interface HoverTrailerPreviewProps {
  videoId: string;
  /** Embedding disabled, removed or private — the caller may try another trailer. */
  onUnavailable: () => void;
  onRevealChange: (revealed: boolean) => void;
}

const LISTENING_RETRY_MS = 250;
const LISTENING_RETRY_BUDGET_MS = 4_000;
// The embed's title bar and pause glyph auto-hide 3.5–4.1 s after PLAYING; no player command hides them sooner.
const REVEAL_SETTLE_MS = 4_200;

export function HoverTrailerPreview({
  videoId,
  onUnavailable,
  onRevealChange,
}: HoverTrailerPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hasPlayedRef = useRef(false);
  const connectedRef = useRef(false);
  // Prevent PAUSED events from undoing a visibility pause.
  const visibilityPausedRef = useRef(true);
  const offscreenRef = useRef(true);
  // 'settling' runs from PLAYING until YouTube's chrome has hidden.
  const [phase, setPhase] = useState<'hidden' | 'settling' | 'revealed'>('hidden');
  const phaseRef = useRef(phase);
  const revealTimerRef = useRef<number | null>(null);
  const revealed = phase === 'revealed';

  const reveal = useCallback((next: boolean) => {
    if (next && phaseRef.current !== 'hidden') return;
    if (revealTimerRef.current !== null) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    phaseRef.current = next ? 'settling' : 'hidden';
    setPhase(phaseRef.current);
    if (!next) return;
    revealTimerRef.current = window.setTimeout(() => {
      revealTimerRef.current = null;
      phaseRef.current = 'revealed';
      setPhase('revealed');
    }, REVEAL_SETTLE_MS);
  }, []);

  const embedUrl = buildYouTubeEmbedUrl(videoId, {
    autoplay: true,
    controls: false,
    mute: true,
    jsApi: true,
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
    postYouTubeCommand(iframe, 'addEventListener', ['onError']);
    postYouTubeCommand(iframe, 'mute');
    visibilityPausedRef.current = document.hidden || !document.hasFocus() || offscreenRef.current;
    postYouTubeCommand(iframe, visibilityPausedRef.current ? 'pauseVideo' : 'playVideo');
  }, []);

  useEffect(() => {
    hasPlayedRef.current = false;
    connectedRef.current = false;
    visibilityPausedRef.current = true;
    offscreenRef.current = true;
    reveal(false);
    return () => reveal(false);
  }, [reveal, videoId]);

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
      if (payload?.event === 'onError') {
        onUnavailable();
        return;
      }

      const playerState = parseYouTubePlayerState(payload);
      if (playerState === null) {
        return;
      }

      connectedRef.current = true;

      // Autoplay can start after the visibility event already ran.
      if (document.hidden || !document.hasFocus() || offscreenRef.current) {
        visibilityPausedRef.current = true;
        reveal(false);
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
        reveal(true);
        return;
      }

      if (playerState === YOUTUBE_PLAYER_STATE.BUFFERING && hasPlayedRef.current) {
        reveal(true);
        return;
      }

      reveal(false);

      if (playerState === YOUTUBE_PLAYER_STATE.ENDED) {
        postYouTubeCommand(iframe, 'seekTo', [0, true]);
        postYouTubeCommand(iframe, 'playVideo');
        return;
      }

      if (
        playerState === YOUTUBE_PLAYER_STATE.PAUSED &&
        hasPlayedRef.current &&
        !visibilityPausedRef.current
      ) {
        postYouTubeCommand(iframe, 'playVideo');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [handshake, onUnavailable, reveal, videoId]);

  useEffect(() => onRevealChange(revealed), [onRevealChange, revealed]);

  // Pause while hidden, unfocused or offscreen; late autoplay is handled above.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const syncVisibility = () => {
      const shouldPause = document.hidden || !document.hasFocus() || offscreenRef.current;
      const wasPaused = visibilityPausedRef.current;
      visibilityPausedRef.current = shouldPause;
      if (shouldPause) reveal(false);
      if (connectedRef.current && (shouldPause || wasPaused)) {
        postYouTubeCommand(iframe, shouldPause ? 'pauseVideo' : 'playVideo');
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      offscreenRef.current = !entry.isIntersecting;
      syncVisibility();
    });
    observer.observe(iframe);
    document.addEventListener('visibilitychange', syncVisibility);
    window.addEventListener('blur', syncVisibility);
    window.addEventListener('focus', syncVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', syncVisibility);
      window.removeEventListener('blur', syncVisibility);
      window.removeEventListener('focus', syncVisibility);
    };
  }, [reveal, videoId]);

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
    <>
      {phase !== 'hidden' && (
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 origin-left bg-(--accent-prog) shadow-[0_0_8px_rgb(var(--accent-prog-rgb)/0.6)] transition-opacity duration-300',
            revealed && 'opacity-0',
          )}
          style={{ animation: `watch-progress-entrance ${REVEAL_SETTLE_MS}ms linear both` }}
        />
      )}
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
    </>
  );
  /* eslint-enable react/iframe-missing-sandbox */
}
