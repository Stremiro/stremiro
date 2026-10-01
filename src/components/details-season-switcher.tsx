import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useScrollEdgeIndicators } from '@/hooks/use-scroll-edge-indicators';
import { clamp, cn, prefersReducedMotion } from '@/lib/utils';

export interface LocalSeasonEntry {
  number: number;
  shortLabel: string;
  episodeCount: number;
}

interface SeasonSwitcherProps {
  localSeasons: LocalSeasonEntry[];
  activeSeason: number | null;
  onLocalSeason: (season: number) => void;
}

export function SeasonSwitcher({ localSeasons, activeSeason, onLocalSeason }: SeasonSwitcherProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<number, HTMLButtonElement>());
  const {
    bind: bindScrollRef,
    syncScrollState,
    canScrollLeft: showLeft,
    canScrollRight: showRight,
  } = useScrollEdgeIndicators(scrollRef);
  const hasMultipleSeasons = localSeasons.length > 1;
  const activeIndex = localSeasons.findIndex((season) => season.number === activeSeason);

  // ResizeObserver only watches the container box — a changed season count
  // can change scrollWidth without it, so resync on set changes explicitly.
  useEffect(() => {
    syncScrollState();
  }, [localSeasons.length, syncScrollState]);

  useEffect(() => {
    if (!hasMultipleSeasons) return;
    if (activeSeason === null) return;

    const timer = window.setTimeout(() => {
      itemRefs.current.get(activeSeason)?.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'nearest',
        inline: 'center',
      });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [activeSeason, hasMultipleSeasons]);

  const goToSeasonIndex = useCallback(
    (index: number) => {
      const target = localSeasons[clamp(index, 0, localSeasons.length - 1)];
      if (!target) return;
      if (target.number !== activeSeason) {
        onLocalSeason(target.number);
      }
      itemRefs.current.get(target.number)?.focus();
    },
    [activeSeason, localSeasons, onLocalSeason],
  );

  const scroll = useCallback((direction: 'left' | 'right') => {
    scrollRef.current?.scrollBy({
      left: direction === 'left' ? -320 : 320,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, []);

  const getItemRef = useCallback(
    (seasonNumber: number) => (node: HTMLButtonElement | null) => {
      if (node) itemRefs.current.set(seasonNumber, node);
      else itemRefs.current.delete(seasonNumber);
    },
    [],
  );

  if (!hasMultipleSeasons) return null;

  return (
    <div className='relative'>
      {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- APG
          tablists aren't focusable; arrows bubble up from the focused tab. */}
      <div
        ref={bindScrollRef}
        onKeyDown={(event) => {
          if (activeIndex < 0) return;
          let nextIndex: number;
          if (event.key === 'ArrowLeft') nextIndex = activeIndex - 1;
          else if (event.key === 'ArrowRight') nextIndex = activeIndex + 1;
          else if (event.key === 'Home') nextIndex = 0;
          else if (event.key === 'End') nextIndex = localSeasons.length - 1;
          else return;
          event.preventDefault();
          goToSeasonIndex(nextIndex);
        }}
        className='flex items-center gap-1 overflow-x-auto rounded-lg border border-white/[0.08] bg-white/[0.03] p-1 scrollbar-hide'
        role='tablist'
        aria-label='Seasons'
      >
        {localSeasons.map((season) => {
          const isActive = activeSeason === season.number;

          return (
            <button
              key={season.number}
              ref={getItemRef(season.number)}
              type='button'
              role='tab'
              id={`season-tab-${season.number}`}
              aria-controls='details-episodes-panel'
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className={cn(
                'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] transition-all duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40',
                isActive
                  ? 'font-semibold text-(--on-accent-nav) shadow-xs'
                  : 'font-medium text-zinc-400 hover:bg-white/[0.06] hover:text-white',
              )}
              style={isActive ? { backgroundColor: 'var(--accent-nav)' } : undefined}
              onClick={() => onLocalSeason(season.number)}
            >
              {season.shortLabel}
              {season.episodeCount > 0 && (
                <span
                  className={cn(
                    'text-[11px] tabular-nums',
                    isActive ? 'opacity-60' : 'text-zinc-600',
                  )}
                >
                  {season.episodeCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {showLeft && (
        <div className='pointer-events-none absolute inset-y-0 left-0 z-10 flex w-12 items-center bg-linear-to-r from-background via-background/80 to-transparent'>
          <button
            type='button'
            onClick={() => scroll('left')}
            className='pointer-events-auto ml-1 flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-black/50 text-white/70 backdrop-blur-xs transition-colors hover:bg-black/70 hover:text-white focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-white/40'
            aria-label='Scroll seasons left'
          >
            <ChevronLeft className='h-3.5 w-3.5' />
          </button>
        </div>
      )}

      {showRight && (
        <div className='pointer-events-none absolute inset-y-0 right-0 z-10 flex w-12 items-center justify-end bg-linear-to-l from-background via-background/80 to-transparent'>
          <button
            type='button'
            onClick={() => scroll('right')}
            className='pointer-events-auto mr-1 flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-black/50 text-white/70 backdrop-blur-xs transition-colors hover:bg-black/70 hover:text-white focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-white/40'
            aria-label='Scroll seasons right'
          >
            <ChevronRight className='h-3.5 w-3.5' />
          </button>
        </div>
      )}
    </div>
  );
}
