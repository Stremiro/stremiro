import { openUrl } from '@tauri-apps/plugin-opener';
import { ChevronLeft, ChevronRight, ExternalLink, Film, Loader2, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { MediaDetails } from '@/lib/api';
import { cn, scrollBehavior } from '@/lib/utils';

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

  useEffect(() => {
    if (open && selectedKey) {
      trailerButtons.current.get(selectedKey)?.scrollIntoView({
        behavior: scrollBehavior(),
        block: 'nearest',
        inline: 'center',
      });
    }
  }, [open, selectedKey]);

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
    onSelectTrailer(trailer.id);
    trailerButtons.current.get(trailer.id)?.focus({ preventScroll: true });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideCloseButton
        className={cn(
          'max-w-none gap-0 overflow-hidden rounded-2xl border border-white/[0.1] bg-zinc-950 p-0 text-white shadow-[0_28px_90px_rgba(0,0,0,0.85)] sm:max-w-5xl sm:rounded-2xl',
          hasPicker
            ? 'w-[min(64rem,calc(100vw-2rem),calc((100dvh-10rem)*16/9))]'
            : 'w-[min(64rem,calc(100vw-2rem),calc((100dvh-7rem)*16/9))]',
        )}
      >
        <div className='flex items-center justify-between gap-3 border-b border-white/[0.07] bg-zinc-950/95 px-4 py-2.5'>
          <div className='flex min-w-0 items-center gap-2.5'>
            <span className='flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-zinc-400'>
              <Film aria-hidden='true' className='h-3.5 w-3.5' />
            </span>
            <div className='min-w-0'>
              <DialogTitle className='truncate text-[13.5px] font-semibold tracking-tight text-white'>
                {trailerLabel}
              </DialogTitle>
              {(hasPicker || trailerLabel !== title) && (
                <span className='mt-0.5 hidden truncate text-xs text-zinc-400 sm:block'>
                  {title}
                </span>
              )}
            </div>
          </div>
          <div className='flex shrink-0 items-center gap-1.5'>
            {hasPicker && (
              <>
                <span className='rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] font-medium text-zinc-300 tabular-nums'>
                  {activeIndex + 1} / {trailers.length}
                </span>
                <button
                  type='button'
                  aria-label='Previous trailer'
                  title='Previous trailer'
                  aria-disabled={activeIndex === 0 || undefined}
                  onClick={() => {
                    if (activeIndex === 0) return;
                    const previous = trailers[activeIndex - 1];
                    if (previous) onSelectTrailer(previous.id);
                  }}
                  className='inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-zinc-300 transition-colors not-aria-disabled:hover:border-white/[0.16] not-aria-disabled:hover:bg-white/[0.09] not-aria-disabled:hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 aria-disabled:cursor-default aria-disabled:opacity-35 motion-reduce:transition-none'
                >
                  <ChevronLeft aria-hidden='true' className='h-4 w-4' />
                </button>
                <button
                  type='button'
                  aria-label='Next trailer'
                  title='Next trailer'
                  aria-disabled={activeIndex === trailers.length - 1 || undefined}
                  onClick={() => {
                    if (activeIndex === trailers.length - 1) return;
                    const next = trailers[activeIndex + 1];
                    if (next) onSelectTrailer(next.id);
                  }}
                  className='inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-zinc-300 transition-colors not-aria-disabled:hover:border-white/[0.16] not-aria-disabled:hover:bg-white/[0.09] not-aria-disabled:hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 aria-disabled:cursor-default aria-disabled:opacity-35 motion-reduce:transition-none'
                >
                  <ChevronRight aria-hidden='true' className='h-4 w-4' />
                </button>
              </>
            )}
            {selectedTrailerId && (
              <button
                type='button'
                aria-label='Watch on YouTube'
                title='Watch on YouTube'
                onClick={() =>
                  void openUrl(
                    `https://www.youtube.com/watch?v=${encodeURIComponent(selectedTrailerId)}`,
                  ).catch(() => undefined)
                }
                className='inline-flex h-9 w-9 items-center justify-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2 text-xs font-medium text-zinc-300 transition-colors hover:border-white/[0.16] hover:bg-white/[0.09] hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-none sm:w-auto'
              >
                <ExternalLink aria-hidden='true' className='h-4 w-4' />
                <span className='hidden sm:inline'>Watch on YouTube</span>
              </button>
            )}
            {(hasPicker || selectedTrailerId) && (
              <span aria-hidden='true' className='mx-1 h-5 w-px bg-white/[0.12]' />
            )}
            <DialogClose asChild>
              <Button
                type='button'
                variant='ghost'
                size='icon'
                aria-label='Close trailer'
                aria-keyshortcuts='Escape'
                title='Close (Esc)'
                className='shrink-0 rounded-lg border border-white/[0.2] bg-white/[0.12] text-white shadow-sm hover:border-white/[0.3] hover:bg-white/[0.2] hover:text-white focus-visible:bg-white/[0.2] focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-none'
              >
                <X aria-hidden='true' className='h-4 w-4' strokeWidth={2.25} />
              </Button>
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
          {/* Sits under the iframe until the embed paints over it. */}
          <Loader2
            aria-hidden='true'
            className='absolute inset-0 m-auto h-6 w-6 animate-spin text-zinc-600 motion-reduce:animate-none'
          />
          {/* eslint-disable react/iframe-missing-sandbox -- the embed needs
                scripts+same-origin to function; the sandbox still bounds
                top-level navigation, forms, and downloads. */}
          {trailerUrl && (
            <iframe
              key={selectedTrailerId}
              className='relative block h-full w-full border-0'
              src={trailerUrl}
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
          <div className='border-t border-white/[0.07] bg-zinc-950/95 px-3 py-2.5'>
            <div
              role='tablist'
              aria-label='Trailers'
              className='flex items-center gap-1.5 overflow-x-auto p-1 scrollbar-hide'
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
                    tabIndex={isActive ? 0 : -1}
                    title={label}
                    className={cn(
                      'nav-switch-item flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border px-3 text-[13px] font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40',
                      isActive
                        ? 'border-white/[0.3] bg-white/[0.16] text-white shadow-sm'
                        : 'border-white/[0.06] bg-white/[0.03] text-zinc-400 hover:border-white/[0.14] hover:bg-white/[0.06] hover:text-zinc-200',
                    )}
                    onClick={() => onSelectTrailer(trailer.id)}
                    onKeyDown={(event) => handleTrailerKeyDown(event, index)}
                  >
                    <span
                      aria-hidden='true'
                      className={cn(
                        'flex h-5 min-w-5 items-center justify-center rounded-md px-1 font-mono text-[10px] tabular-nums',
                        isActive ? 'bg-white/[0.16] text-white' : 'bg-white/[0.05] text-zinc-500',
                      )}
                    >
                      {index + 1}
                    </span>
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
