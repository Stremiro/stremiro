import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useScrollEdgeIndicators } from '@/hooks/use-scroll-edge-indicators';
import { useSlidingIndicator } from '@/hooks/use-sliding-indicator';
import type { SeasonEpisodeState } from '@/lib/details-episode-state';
import { clamp, cn, pluralize, scrollBehavior } from '@/lib/utils';

interface SeasonSwitcherProps {
  seasons: { number: number; episodeCount: number }[];
  activeSeason: number | null;
  watchedCounts: ReadonlyMap<number, number>;
  onSelectSeason: (season: number) => void;
}

const RAIL_SEGMENT_CLASS: Record<SeasonEpisodeState, string> = {
  watched: 'bg-(--accent-prog)',
  started: 'bg-[rgb(var(--accent-prog-rgb)/0.45)]',
  next: 'bg-white/75',
  unwatched: 'bg-white/[0.14]',
  unaired: 'bg-white/[0.06]',
};
// Beyond this, segments get thinner than their gaps.
const RAIL_SEGMENT_LIMIT = 30;

export function SeasonProgressRail({
  segments,
  watchedCount,
}: {
  segments: { key: string; state: SeasonEpisodeState }[];
  watchedCount: number;
}) {
  const total = segments.length;
  const complete = watchedCount === total;
  return (
    <div className='flex items-center gap-2.5 animate-in fade-in duration-200 motion-reduce:animate-none'>
      {total <= RAIL_SEGMENT_LIMIT ? (
        <div aria-hidden='true' className='flex h-1 w-28 gap-[3px] sm:w-40'>
          {segments.map(({ key, state }) => (
            <span
              key={key}
              className={cn(
                'min-w-0 flex-1 rounded-full transition-colors duration-300 motion-reduce:transition-none',
                RAIL_SEGMENT_CLASS[state],
              )}
            />
          ))}
        </div>
      ) : (
        <div
          aria-hidden='true'
          className='h-1 w-28 overflow-hidden rounded-full bg-white/[0.14] sm:w-40'
        >
          <div
            className='h-full origin-left rounded-full bg-(--accent-prog) transition-transform duration-300 motion-reduce:transition-none'
            style={{ transform: `scaleX(${watchedCount / total})` }}
          />
        </div>
      )}
      <span
        className={cn(
          'text-[12px] font-medium tabular-nums',
          complete ? 'text-(--accent-prog)' : 'text-zinc-400',
        )}
      >
        {complete ? 'Season watched' : `${watchedCount} of ${total} watched`}
      </span>
    </div>
  );
}

const SCROLL_BUTTON_CLASS =
  'not-aria-disabled:pointer-events-auto flex h-9 w-9 items-center justify-center rounded-md border border-white/10 bg-black/50 text-white/70 backdrop-blur-xs transition-colors duration-150 not-aria-disabled:hover:bg-black/70 not-aria-disabled:hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 aria-disabled:cursor-default aria-disabled:opacity-40';

export function SeasonSwitcher({
  seasons,
  activeSeason,
  watchedCounts,
  onSelectSeason,
}: SeasonSwitcherProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const {
    bind: bindScrollRef,
    syncScrollState,
    hasOverflow,
    canScrollLeft,
    canScrollRight,
  } = useScrollEdgeIndicators(scrollRef);
  const activeIndex = seasons.findIndex((season) => season.number === activeSeason);
  const indicator = useSlidingIndicator(
    activeSeason !== null ? String(activeSeason) : undefined,
    scrollRef,
    itemRefs,
  );

  // ResizeObserver only watches the container box — a changed season count
  // changes scrollWidth without it.
  useEffect(() => {
    syncScrollState();
  }, [seasons.length, syncScrollState]);

  useEffect(() => {
    if (activeSeason === null) return;

    const timer = window.setTimeout(() => {
      const strip = scrollRef.current;
      const tab = itemRefs.current.get(String(activeSeason));
      if (!strip || !tab) return;
      const stripBounds = strip.getBoundingClientRect();
      const tabBounds = tab.getBoundingClientRect();
      const inset = hasOverflow ? 48 : strip.clientLeft;
      const visibleLeft = stripBounds.left + inset;
      const visibleRight = stripBounds.right - inset;
      const offset =
        tabBounds.left < visibleLeft
          ? tabBounds.left - visibleLeft
          : tabBounds.right > visibleRight
            ? tabBounds.right - visibleRight
            : 0;
      // Keep visible tabs still; only reveal labels hidden by the overflow controls.
      if (offset !== 0) strip.scrollBy({ left: offset, behavior: scrollBehavior() });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [activeSeason, hasOverflow]);

  const goToSeasonIndex = (index: number) => {
    const target = seasons[clamp(index, 0, seasons.length - 1)];
    if (!target) return;
    if (target.number !== activeSeason) onSelectSeason(target.number);
    itemRefs.current.get(String(target.number))?.focus({ preventScroll: true });
  };

  const scroll = (direction: 'left' | 'right') => {
    scrollRef.current?.scrollBy({
      left: direction === 'left' ? -320 : 320,
      behavior: scrollBehavior(),
    });
  };

  return (
    <div className='relative'>
      {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- APG
          tablists aren't focusable; arrows bubble up from the focused tab. */}
      <div
        ref={bindScrollRef}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          )
            return;
          if (activeIndex < 0) return;
          let nextIndex: number;
          if (event.key === 'ArrowLeft') nextIndex = activeIndex - 1;
          else if (event.key === 'ArrowRight') nextIndex = activeIndex + 1;
          else if (event.key === 'Home') nextIndex = 0;
          else if (event.key === 'End') nextIndex = seasons.length - 1;
          else return;
          event.preventDefault();
          goToSeasonIndex(nextIndex);
        }}
        className='relative flex items-center gap-1 overflow-x-auto py-1 scrollbar-hide'
        role='tablist'
        aria-label='Seasons'
      >
        {indicator && (
          <span
            aria-hidden='true'
            className='nav-sliding-pill pointer-events-none absolute left-0 top-0 rounded-md border border-white/15 bg-white/[0.1]'
            style={{
              width: indicator.width,
              height: indicator.height,
              transform: `translate3d(${indicator.left}px, ${indicator.top}px, 0)`,
            }}
          />
        )}
        {seasons.map((season) => {
          const isActive = activeSeason === season.number;
          const label = season.number === 0 ? 'Specials' : `Season ${season.number}`;
          const watched = watchedCounts.get(season.number) ?? 0;

          return (
            <button
              key={season.number}
              ref={(node) => {
                if (node) itemRefs.current.set(String(season.number), node);
                else itemRefs.current.delete(String(season.number));
              }}
              type='button'
              role='tab'
              id={`season-tab-${season.number}`}
              aria-controls='details-episodes-panel'
              aria-selected={isActive}
              aria-label={`${label}, ${pluralize(season.episodeCount, 'episode')}${watched > 0 ? `, ${watched} watched` : ''}`}
              tabIndex={isActive ? 0 : -1}
              className={cn(
                'relative z-1 flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 text-[13px] font-medium leading-none transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40 motion-reduce:transition-none',
                isActive ? 'text-white' : 'text-zinc-300 hover:bg-white/[0.04] hover:text-white',
              )}
              onClick={() => {
                if (!isActive) onSelectSeason(season.number);
              }}
            >
              {label}
              {season.episodeCount > 0 && (
                <span
                  className={cn(
                    'text-[11px] font-medium tabular-nums',
                    isActive ? 'text-zinc-200' : 'text-zinc-400',
                  )}
                >
                  {season.episodeCount}
                </span>
              )}
              {watched > 0 && season.episodeCount > 0 && (
                <span
                  aria-hidden='true'
                  className='absolute inset-x-3 bottom-0.5 h-[2px] overflow-hidden rounded-full bg-white/10'
                >
                  <span
                    className='block h-full origin-left rounded-full bg-(--accent-prog) transition-transform duration-300 motion-reduce:transition-none'
                    style={{ transform: `scaleX(${Math.min(watched / season.episodeCount, 1)})` }}
                  />
                </span>
              )}
            </button>
          );
        })}
      </div>

      {hasOverflow &&
        (
          [
            {
              side: 'left',
              canScroll: canScrollLeft,
              Icon: ChevronLeft,
              edgeClass: 'left-0 bg-linear-to-r',
              buttonClass: 'ml-1',
            },
            {
              side: 'right',
              canScroll: canScrollRight,
              Icon: ChevronRight,
              edgeClass: 'right-0 justify-end bg-linear-to-l',
              buttonClass: 'mr-1',
            },
          ] as const
        ).map(({ side, canScroll, Icon, edgeClass, buttonClass }) => (
          <div
            key={side}
            className={cn(
              'pointer-events-none absolute inset-y-0 z-10 flex w-12 items-center from-background via-background/80 to-transparent focus-within:opacity-100',
              edgeClass,
              !canScroll && 'opacity-0',
            )}
          >
            <button
              type='button'
              onClick={() => {
                if (canScroll) scroll(side);
              }}
              className={`${SCROLL_BUTTON_CLASS} ${buttonClass}`}
              aria-label={`Scroll seasons ${side}`}
              aria-disabled={!canScroll || undefined}
            >
              <Icon className='h-4 w-4' />
            </button>
          </div>
        ))}
    </div>
  );
}
