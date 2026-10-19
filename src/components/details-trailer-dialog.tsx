import { openUrl } from '@tauri-apps/plugin-opener';
import { ExternalLink, Film, Loader2, RotateCw, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { MediaDetails } from '@/lib/api';
import { notifyAction } from '@/lib/notify';
import { cn, scrollBehavior } from '@/lib/utils';

const TRAILER_ACTION_BUTTON_CLASS =
  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-none';

interface DetailsTrailerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trailerUrl: string | null;
  trailers: NonNullable<MediaDetails['trailers']>;
  selectedTrailerId: string | undefined;
  onSelectTrailer: (id: string) => void;
  title: string;
}

export function DetailsTrailerDialog({
  open,
  onOpenChange,
  trailerUrl,
  trailers,
  selectedTrailerId,
  onSelectTrailer,
  title,
}: DetailsTrailerDialogProps) {
  const selectedIndex = trailers.findIndex((trailer) => trailer.id === selectedTrailerId);
  const activeIndex = Math.max(0, selectedIndex);
  const selectedEntry = trailers[activeIndex];
  const selectedKey = selectedEntry?.id;
  const trailerLabel = selectedEntry?.name ?? `${title} trailer`;
  const hasPicker = trailers.length > 1;
  const tabId = useId();
  const panelId = `${tabId}-panel`;
  const trailerButtons = useRef(new Map<string, HTMLButtonElement>());
  const [focusedTrailerId, setFocusedTrailerId] = useState(selectedKey);
  const [reloadAttempt, setReloadAttempt] = useState(0);
  const frameKey = `${trailerUrl}:${reloadAttempt}`;
  const [loadedFrameKey, setLoadedFrameKey] = useState<string | null>(null);
  const [delayedFrameKey, setDelayedFrameKey] = useState<string | null>(null);
  const isLoadingTrailer = !!trailerUrl && loadedFrameKey !== frameKey;

  useEffect(() => {
    setFocusedTrailerId(selectedKey);
    setLoadedFrameKey(null);
    setDelayedFrameKey(null);
    if (open && selectedKey) {
      trailerButtons.current.get(selectedKey)?.scrollIntoView({
        behavior: scrollBehavior(),
        block: 'nearest',
        inline: 'center',
      });
    }
  }, [open, selectedKey]);

  useEffect(() => {
    if (!open || !isLoadingTrailer) return;
    const timer = window.setTimeout(() => setDelayedFrameKey(frameKey), 8000);
    return () => window.clearTimeout(timer);
  }, [open, isLoadingTrailer, frameKey]);

  const openSelectedTrailer = () => {
    if (!selectedTrailerId) return;
    void openUrl(`https://www.youtube.com/watch?v=${encodeURIComponent(selectedTrailerId)}`).catch(
      () => notifyAction("Couldn't open YouTube", { tone: 'error' }),
    );
  };

  const reloadTrailer = () => {
    setLoadedFrameKey(null);
    setDelayedFrameKey(null);
    setReloadAttempt((attempt) => attempt + 1);
  };

  const handleTrailerKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
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
    trailerButtons.current.get(trailer.id)?.focus();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideCloseButton
        className={cn(
          'max-w-none gap-0 overflow-hidden rounded-2xl border border-white/[0.1] bg-zinc-950 p-0 text-white shadow-[0_28px_90px_rgba(0,0,0,0.85)] sm:max-w-5xl sm:rounded-2xl',
          hasPicker
            ? 'w-[min(60rem,calc(100vw-2rem),calc((100dvh-10rem)*16/9))]'
            : 'w-[min(60rem,calc(100vw-2rem),calc((100dvh-7rem)*16/9))]',
        )}
      >
        <div className='flex items-center justify-between gap-3 border-b border-white/[0.07] px-3 py-2 sm:px-4'>
          <div className='flex min-w-0 items-center gap-2.5'>
            <Film aria-hidden='true' className='hidden h-4 w-4 shrink-0 text-zinc-500 sm:block' />
            <div className='min-w-0'>
              <DialogTitle className='truncate text-[13.5px] font-semibold tracking-tight text-white'>
                {trailerLabel}
              </DialogTitle>
              {(hasPicker || trailerLabel !== title) && (
                <span className='mt-1 hidden truncate text-[11px] text-zinc-500 sm:block'>
                  {title}
                </span>
              )}
            </div>
          </div>
          <div className='flex shrink-0 items-center gap-0.5'>
            {hasPicker && (
              <span className='mr-2 whitespace-nowrap font-mono text-[11px] text-zinc-500 tabular-nums'>
                {activeIndex + 1} / {trailers.length}
              </span>
            )}
            {trailerUrl && (
              <button
                type='button'
                aria-label='Reload trailer'
                title='Reload trailer'
                onClick={reloadTrailer}
                className={TRAILER_ACTION_BUTTON_CLASS}
              >
                <RotateCw aria-hidden='true' className='h-4 w-4' />
              </button>
            )}
            {selectedTrailerId && (
              <button
                type='button'
                aria-label='Watch on YouTube'
                title='Watch on YouTube'
                onClick={openSelectedTrailer}
                className={cn(
                  TRAILER_ACTION_BUTTON_CLASS,
                  'gap-1.5 text-xs font-medium sm:w-auto sm:px-2.5',
                )}
              >
                <ExternalLink aria-hidden='true' className='h-4 w-4' />
                <span className='hidden sm:inline'>YouTube</span>
              </button>
            )}
            <DialogClose asChild>
              <button
                type='button'
                aria-label='Close trailer'
                aria-keyshortcuts='Escape'
                title='Close (Esc)'
                className={TRAILER_ACTION_BUTTON_CLASS}
              >
                <X aria-hidden='true' className='h-4 w-4' />
              </button>
            </DialogClose>
          </div>
        </div>
        <DialogDescription className='sr-only'>Trailer video for {title}.</DialogDescription>
        <div
          id={panelId}
          role={hasPicker ? 'tabpanel' : undefined}
          aria-labelledby={hasPicker ? `${tabId}-${activeIndex}` : undefined}
          tabIndex={hasPicker ? 0 : undefined}
          className='relative aspect-video w-full bg-black focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40'
        >
          {isLoadingTrailer && (
            <div
              role='status'
              className='pointer-events-none absolute inset-0 z-10 grid place-items-center'
            >
              <div className='flex flex-col items-center gap-3 rounded-xl bg-black/80 p-4 text-center'>
                <Loader2
                  aria-hidden='true'
                  className='h-6 w-6 animate-spin text-zinc-300 motion-reduce:animate-none'
                />
                {delayedFrameKey === frameKey ? (
                  <>
                    <p className='text-sm text-zinc-300'>Taking longer than expected</p>
                    <p className='max-w-56 text-xs leading-relaxed text-zinc-400'>
                      Try the reload or YouTube controls above.
                    </p>
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
              className='relative block h-full w-full border-0'
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
          <div className='border-t border-white/[0.07] px-2 py-1.5'>
            <div
              role='tablist'
              aria-label='Trailers'
              className='flex items-center gap-1 overflow-x-auto p-1 scrollbar-hide'
            >
              {trailers.map((trailer, index) => {
                const isActive = trailer.id === selectedKey;
                const label = trailer.name ?? `Trailer ${index + 1}`;
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
                      'nav-switch-item flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-md border px-2.5 text-xs font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40',
                      isActive
                        ? 'border-white/[0.1] bg-white/[0.08] text-white'
                        : 'border-transparent text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200',
                    )}
                    onFocus={() => setFocusedTrailerId(trailer.id)}
                    onClick={() => onSelectTrailer(trailer.id)}
                    onKeyDown={(event) => handleTrailerKeyDown(event, index)}
                  >
                    <span
                      aria-hidden='true'
                      className={cn(
                        'font-mono text-[10px] tabular-nums',
                        isActive ? 'text-zinc-300' : 'text-zinc-500',
                      )}
                    >
                      {index + 1}
                    </span>
                    <span className='max-w-[16rem] truncate'>{label}</span>
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
