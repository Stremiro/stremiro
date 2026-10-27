import { openUrl } from '@tauri-apps/plugin-opener';
import { Trigger as DialogTrigger } from '@radix-ui/react-dialog';
import { Clapperboard, ExternalLink, Loader2, RotateCw, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { preconnect, preload } from 'react-dom';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { MediaDetails } from '@/lib/api';
import { notifyAction } from '@/lib/notify';
import {
  buildYouTubeEmbedUrl,
  isYouTubePlayerOrigin,
  isYouTubeReadyEvent,
  parseYouTubeMessage,
  postYouTubeCommand,
  postYouTubeListening,
  YOUTUBE_EMBED_ORIGIN,
  youTubeThumbnailUrl,
} from '@/lib/youtube-player';
import { cn, scrollBehavior } from '@/lib/utils';

const TRAILER_ICON_BUTTON_CLASS =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors duration-150 hover:bg-white/[0.08] hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-none';
const TRAILER_START_VOLUME = 25;
const PLAYER_HANDSHAKE_RETRY_MS = 250;
const PLAYER_HANDSHAKE_BUDGET_MS = 4_000;

interface DetailsTrailerProps {
  trailers: NonNullable<MediaDetails['trailers']>;
  title: string;
  triggerClassName: string;
}

// Addon names often repeat the title for every entry; number them unless each name stands apart.
function trailerLabels(trailers: DetailsTrailerProps['trailers'], title: string) {
  const names = trailers.map((trailer) => trailer.name?.trim() ?? '');
  const keys = names.map((name) => name.toLowerCase());
  const distinct =
    new Set(keys).size === keys.length &&
    keys.every((key) => key && key !== title.trim().toLowerCase());
  if (distinct) return names;
  return trailers.length > 1 ? names.map((_, index) => `Trailer ${index + 1}`) : ['Trailer'];
}

function revealTrailer(button: HTMLButtonElement) {
  const strip = button.parentElement;
  if (!strip) return;
  const bounds = strip.getBoundingClientRect();
  const card = button.getBoundingClientRect();
  const offset =
    card.left < bounds.left + 4
      ? card.left - bounds.left - 4
      : Math.max(0, card.right - bounds.right + 4);
  if (offset !== 0) strip.scrollBy({ left: offset, behavior: scrollBehavior() });
}

// Embeds start at YouTube's remembered (often full) volume; lower it once the player is ready.
function useTrailerStartVolume(frame: HTMLIFrameElement | null) {
  useEffect(() => {
    if (!frame) return;
    // The player ignores the listening handshake until its script boots.
    const retry = window.setInterval(() => postYouTubeListening(frame), PLAYER_HANDSHAKE_RETRY_MS);
    const stop = window.setTimeout(() => window.clearInterval(retry), PLAYER_HANDSHAKE_BUDGET_MS);
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || !isYouTubePlayerOrigin(event.origin)) return;
      if (!isYouTubeReadyEvent(parseYouTubeMessage(event.data))) return;
      window.clearInterval(retry);
      postYouTubeCommand(frame, 'setVolume', [TRAILER_START_VOLUME]);
    };
    window.addEventListener('message', handleMessage);
    postYouTubeListening(frame);
    return () => {
      window.clearInterval(retry);
      window.clearTimeout(stop);
      window.removeEventListener('message', handleMessage);
    };
  }, [frame]);
}

export function DetailsTrailer({ trailers, title, triggerClassName }: DetailsTrailerProps) {
  const [open, onOpenChange] = useState(false);
  const [selectedId, onSelectTrailer] = useState<string>();
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  const activeIndex = Math.max(
    0,
    trailers.findIndex((trailer) => trailer.id === selectedId),
  );
  const selectedEntry = trailers[activeIndex];
  const selectedKey = selectedEntry?.id;
  const trailerUrl = selectedKey
    ? buildYouTubeEmbedUrl(selectedKey, {
        autoplay: true,
        jsApi: true,
        origin: window.location.origin,
      })
    : null;
  const labels = trailerLabels(trailers, title);
  const trailerLabel = labels[activeIndex] ?? 'Trailer';
  const hasPicker = trailers.length > 1;
  const tabId = useId();
  const panelId = `${tabId}-panel`;
  const trailerButtons = useRef(new Map<string, HTMLButtonElement>());
  const [focusedTrailerId, setFocusedTrailerId] = useState(selectedKey);
  const [reloadAttempt, setReloadAttempt] = useState(0);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const frameKey = `${trailerUrl}:${reloadAttempt}`;
  const [loadedFrameKey, setLoadedFrameKey] = useState<string | null>(null);
  const [delayedFrameKey, setDelayedFrameKey] = useState<string | null>(null);
  const isLoadingTrailer = !!trailerUrl && loadedFrameKey !== frameKey;
  useTrailerStartVolume(frame);

  const warmTrailer = () => {
    if (!selectedKey) return;
    preconnect(YOUTUBE_EMBED_ORIGIN);
    preload(youTubeThumbnailUrl(selectedKey), { as: 'image', fetchPriority: 'low' });
  };

  useEffect(() => {
    setFocusedTrailerId(selectedKey);
    setLoadedFrameKey(null);
    setDelayedFrameKey(null);
    if (open && selectedKey) {
      const button = trailerButtons.current.get(selectedKey);
      if (button) revealTrailer(button);
    }
  }, [open, selectedKey]);

  useEffect(() => {
    if (!open || !isLoadingTrailer) return;
    const timer = window.setTimeout(() => setDelayedFrameKey(frameKey), 8000);
    return () => window.clearTimeout(timer);
  }, [open, isLoadingTrailer, frameKey]);

  const openSelectedTrailer = () => {
    if (!selectedKey) return;
    void openUrl(`https://www.youtube.com/watch?v=${encodeURIComponent(selectedKey)}`).catch(() =>
      notifyAction("Couldn't open YouTube", { tone: 'error' }),
    );
  };

  const handleTrailerKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowLeft':
        nextIndex = (index - 1 + trailers.length) % trailers.length;
        break;
      case 'ArrowRight':
        nextIndex = (index + 1) % trailers.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = trailers.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const trailer = trailers[nextIndex];
    if (!trailer) return;
    trailerButtons.current.get(trailer.id)?.focus({ preventScroll: true });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button
          ref={returnFocusRef}
          type='button'
          aria-label='Watch trailer'
          title='Trailer'
          className={cn(triggerClassName, 'w-auto gap-2 px-3')}
          onPointerEnter={warmTrailer}
          onFocus={warmTrailer}
        >
          <Clapperboard
            aria-hidden='true'
            className='w-5 h-5 origin-bottom-left transition-transform duration-200 ease-out group-hover/action:-rotate-12 motion-reduce:transition-none'
          />
          <span className='text-[13px] font-medium'>Trailer</span>
        </button>
      </DialogTrigger>
      <DialogContent
        hideCloseButton
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef.current?.isConnected) return;
          event.preventDefault();
          returnFocusRef.current.focus({ preventScroll: true });
        }}
        className={cn(
          'max-w-none gap-0 overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-950 p-0 text-white shadow-[0_24px_80px_rgba(0,0,0,0.8)] motion-reduce:animate-none motion-reduce:transition-none sm:max-w-5xl sm:rounded-xl',
          hasPicker
            ? 'w-[min(60rem,calc(100vw-2rem),calc((100dvh-11rem)*16/9))]'
            : 'w-[min(60rem,calc(100vw-2rem),calc((100dvh-8rem)*16/9))]',
        )}
      >
        <div className='flex h-12 items-center gap-1 pl-4 pr-2'>
          <DialogTitle className='mr-2 min-w-0 flex-1 truncate text-sm font-medium leading-5 text-white'>
            {title}
            <span className='font-normal text-zinc-500'> · {trailerLabel}</span>
          </DialogTitle>
          {selectedKey && (
            <button
              type='button'
              aria-label='Watch on YouTube'
              title='Watch on YouTube'
              onClick={openSelectedTrailer}
              className={TRAILER_ICON_BUTTON_CLASS}
            >
              <ExternalLink aria-hidden='true' className='h-4 w-4' />
            </button>
          )}
          <DialogClose asChild>
            <button
              type='button'
              aria-label='Close trailer'
              aria-keyshortcuts='Escape'
              title='Close (Esc)'
              className={TRAILER_ICON_BUTTON_CLASS}
            >
              <X aria-hidden='true' className='h-4 w-4' />
            </button>
          </DialogClose>
        </div>
        <DialogDescription className='sr-only'>Trailer video for {title}.</DialogDescription>
        <div
          id={panelId}
          role={hasPicker ? 'tabpanel' : undefined}
          aria-labelledby={hasPicker ? `${tabId}-${activeIndex}` : undefined}
          tabIndex={hasPicker ? 0 : undefined}
          className='relative aspect-video w-full bg-black focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40'
        >
          {selectedKey && (
            <img
              key={selectedKey}
              src={youTubeThumbnailUrl(selectedKey)}
              alt=''
              aria-hidden='true'
              decoding='async'
              className='absolute inset-0 h-full w-full object-cover opacity-40 animate-in fade-in-0 duration-300 motion-reduce:animate-none'
            />
          )}
          {isLoadingTrailer && (
            <div
              role='status'
              className='pointer-events-none absolute inset-0 z-10 grid place-items-center'
            >
              <div className='delayed-fade-in flex flex-col items-center gap-3 text-center motion-reduce:animate-none'>
                <Loader2
                  aria-hidden='true'
                  className='h-6 w-6 animate-spin text-zinc-400 motion-reduce:animate-none'
                />
                {delayedFrameKey === frameKey ? (
                  <>
                    <p className='text-sm text-zinc-300'>Taking longer than expected</p>
                    <button
                      type='button'
                      onClick={() => setReloadAttempt((attempt) => attempt + 1)}
                      className='pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-md bg-white/[0.08] px-3 text-xs font-medium text-zinc-200 transition-colors duration-150 hover:bg-white/[0.14] hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-none'
                    >
                      <RotateCw aria-hidden='true' className='h-3.5 w-3.5' />
                      Reload
                    </button>
                  </>
                ) : (
                  <span className='sr-only'>Loading trailer...</span>
                )}
              </div>
            </div>
          )}
          {/* eslint-disable react/iframe-missing-sandbox -- the embed needs
                scripts+same-origin to function; the sandbox still bounds
                top-level navigation, forms, and downloads. */}
          {trailerUrl && (
            <iframe
              key={frameKey}
              ref={setFrame}
              className={cn(
                'absolute inset-0 h-full w-full border-0 transition-opacity duration-300 ease-out motion-reduce:transition-none',
                isLoadingTrailer && 'opacity-0',
              )}
              src={trailerUrl}
              onLoad={() => setLoadedFrameKey(frameKey)}
              title={`${title} — ${trailerLabel}`}
              sandbox='allow-scripts allow-same-origin allow-presentation allow-popups'
              allow='accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture'
              referrerPolicy='strict-origin-when-cross-origin'
              allowFullScreen
            />
          )}
          {/* eslint-enable react/iframe-missing-sandbox */}
        </div>
        {hasPicker && (
          <div className='min-w-0 px-2 py-2'>
            <span id={`${tabId}-help`} className='sr-only'>
              Use arrow keys, Home or End to browse trailers. Press Enter or Space to play.
            </span>
            <div
              role='tablist'
              aria-label='Trailers'
              aria-describedby={`${tabId}-help`}
              aria-orientation='horizontal'
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  setFocusedTrailerId(selectedKey);
              }}
              className='flex items-center gap-1 overflow-x-auto overscroll-x-contain scrollbar-hide'
            >
              {trailers.map((trailer, index) => {
                const isActive = trailer.id === selectedKey;
                const label = labels[index];
                return (
                  <button
                    key={trailer.id}
                    ref={(node) => {
                      if (node) trailerButtons.current.set(trailer.id, node);
                      else trailerButtons.current.delete(trailer.id);
                    }}
                    id={`${tabId}-${index}`}
                    type='button'
                    role='tab'
                    aria-selected={isActive}
                    aria-controls={panelId}
                    tabIndex={trailer.id === (focusedTrailerId ?? selectedKey) ? 0 : -1}
                    title={label}
                    className={cn(
                      'nav-switch-item h-8 max-w-56 shrink-0 truncate rounded-md px-3 text-xs font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--accent-nav)/70 motion-reduce:transition-none',
                      isActive
                        ? 'accent-active'
                        : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100',
                    )}
                    onFocus={(event) => {
                      setFocusedTrailerId(trailer.id);
                      if (event.currentTarget.matches(':focus-visible'))
                        revealTrailer(event.currentTarget);
                    }}
                    onClick={() => onSelectTrailer(trailer.id)}
                    onKeyDown={(event) => handleTrailerKeyDown(event, index)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
