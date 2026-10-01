import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type Key, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { useScrollEdgeIndicators } from '@/hooks/use-scroll-edge-indicators';
import { cn, prefersReducedMotion } from '@/lib/utils';
import { MediaCardSkeleton, MEDIA_CARD_SLOT_CLASS_NAME } from './media-card';

export const HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS =
  'pr-6 pl-[84px] md:px-12 md:pl-24 lg:px-14 lg:pl-28';

const SCROLL_BUTTON_CLASS_NAME =
  'h-7 w-7 rounded-full bg-transparent border border-white/[0.08] text-zinc-500 hover:bg-white/[0.08] hover:text-white transition-colors duration-150 backdrop-blur-xs';
const DEFAULT_ITEM_CLASS_NAME = `flex-none ${MEDIA_CARD_SLOT_CLASS_NAME} snap-start`;
const DEFAULT_SCROLLER_CLASS_NAME =
  'flex overflow-x-auto gap-4 pb-8 scrollbar-hide snap-x snap-proximity';
// Bounded scroll memory survives route changes.
const RAIL_SCROLL_MEMORY_MAX = 64;
const railScrollPositions = new Map<string, number>();

function rememberRailScrollPosition(railId: string, position: number): void {
  // Re-set refreshes recency; evict the oldest key at capacity.
  railScrollPositions.delete(railId);
  railScrollPositions.set(railId, position);
  if (railScrollPositions.size > RAIL_SCROLL_MEMORY_MAX) {
    const oldest = railScrollPositions.keys().next().value;
    if (oldest !== undefined) railScrollPositions.delete(oldest);
  }
}

// Cap mounted cards; full catalogs remain available through search.
const RAIL_MAX_ITEMS = 48;

interface HorizontalMediaRailProps<T> {
  /** Concatenated, never `cn()`-merged — column classes may pair `lg:pl-*`
      with `lg:px-*`, which tailwind-merge would collapse. */
  contentInsetsClassName?: string;
  getItemKey: (item: T, index: number) => Key;
  headerContent?: ReactNode;
  isLoading: boolean;
  items: readonly T[];
  /** Stable identity for cross-remount scroll memory (e.g. 'continue-watching'). */
  railId?: string;
  renderItem: (item: T, index: number) => ReactNode;
  scrollerClassName?: string;
  sectionClassName?: string;
  skeletonCount?: number;
  title: ReactNode;
  viewportClassName?: string;
}

export function HorizontalMediaRail<T>({
  contentInsetsClassName = HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS,
  getItemKey,
  headerContent,
  isLoading,
  items,
  railId,
  renderItem,
  scrollerClassName,
  sectionClassName,
  skeletonCount = 8,
  title,
  viewportClassName,
}: HorizontalMediaRailProps<T>) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastScrollLeftRef = useRef(0);
  const {
    bind: bindScrollContainer,
    syncScrollState,
    ...scrollState
  } = useScrollEdgeIndicators(scrollContainerRef, lastScrollLeftRef);

  // ResizeObserver only watches the container box — a new item set changes
  // scrollWidth without resizing it, so content swaps resync explicitly.
  useEffect(() => {
    const frame = window.requestAnimationFrame(syncScrollState);
    return () => window.cancelAnimationFrame(frame);
  }, [isLoading, items.length, syncScrollState]);

  const itemKeys = useMemo(() => {
    if (isLoading) return new Set<string>();
    return new Set(items.map((item, index) => String(getItemKey(item, index))));
  }, [getItemKey, isLoading, items]);
  const previousKeysRef = useRef<ReadonlySet<string> | null>(null);

  useLayoutEffect(() => {
    // Loading/empty phases must not re-arm the initial scroll restoration.
    if (itemKeys.size === 0) return;
    const previousKeys = previousKeysRef.current;
    previousKeysRef.current = itemKeys;
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;
    if (!previousKeys) {
      if (railId) {
        const remembered = railScrollPositions.get(railId);
        if (remembered !== undefined && remembered > 0) {
          scrollContainer.scrollLeft = remembered;
          syncScrollState();
        }
      }
      return;
    }
    // Reorders and pure insertions/removals preserve the user's position.
    let sharedKeys = 0;
    for (const key of itemKeys) {
      if (previousKeys.has(key)) sharedKeys += 1;
    }
    const insertOrRemoveOnly = sharedKeys === previousKeys.size || sharedKeys === itemKeys.size;
    if (!insertOrRemoveOnly) {
      scrollContainer.scrollLeft = 0;
      syncScrollState();
    }
  }, [itemKeys, railId, syncScrollState]);

  useEffect(() => {
    if (!railId) return;
    const position = lastScrollLeftRef;
    return () => {
      rememberRailScrollPosition(railId, position.current);
    };
  }, [railId]);

  const scroll = (direction: 'left' | 'right') => {
    if (!scrollContainerRef.current) {
      return;
    }

    const { current } = scrollContainerRef;
    const delta = direction === 'left' ? -current.offsetWidth * 0.8 : current.offsetWidth * 0.8;
    current.scrollBy({ left: delta, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  const edgeMask = scrollState.hasOverflow
    ? `linear-gradient(to right, ${scrollState.canScrollLeft ? 'transparent 0px, black 28px' : 'black 0px'}, ${scrollState.canScrollRight ? 'black calc(100% - 28px), transparent 100%' : 'black 100%'})`
    : undefined;

  return (
    <section className={cn('py-4 relative group/section', sectionClassName)}>
      <div className={`${contentInsetsClassName} mb-3`}>
        <div className='flex items-center justify-between mb-3'>
          <h2 className='text-[17px] font-semibold tracking-[-0.02em] text-white'>{title}</h2>

          {scrollState.hasOverflow && (
            <div className='flex items-center gap-1.5 opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100 focus-within:opacity-100 transition-opacity duration-300'>
              <Button
                aria-label='Scroll rail left'
                size='icon'
                variant='ghost'
                className={cn(
                  SCROLL_BUTTON_CLASS_NAME,
                  !scrollState.canScrollLeft && 'cursor-default opacity-40',
                )}
                // Keep keyboard focus when reaching an edge.
                aria-disabled={!scrollState.canScrollLeft || undefined}
                onClick={() => {
                  if (scrollState.canScrollLeft) scroll('left');
                }}
              >
                <ChevronLeft className='h-4 w-4' />
              </Button>
              <Button
                aria-label='Scroll rail right'
                size='icon'
                variant='ghost'
                className={cn(
                  SCROLL_BUTTON_CLASS_NAME,
                  !scrollState.canScrollRight && 'cursor-default opacity-40',
                )}
                aria-disabled={!scrollState.canScrollRight || undefined}
                onClick={() => {
                  if (scrollState.canScrollRight) scroll('right');
                }}
              >
                <ChevronRight className='h-4 w-4' />
              </Button>
            </div>
          )}
        </div>

        {headerContent}
      </div>

      <div className={`${contentInsetsClassName} ${cn('overflow-hidden', viewportClassName)}`}>
        <div
          ref={bindScrollContainer}
          data-media-scroller
          className={cn(DEFAULT_SCROLLER_CLASS_NAME, scrollerClassName)}
          style={edgeMask ? { maskImage: edgeMask, WebkitMaskImage: edgeMask } : undefined}
        >
          {isLoading
            ? Array.from({ length: skeletonCount }, (_, index) => (
                <div key={`rail-skeleton-${index + 1}`} className={DEFAULT_ITEM_CLASS_NAME}>
                  <MediaCardSkeleton />
                </div>
              ))
            : items.slice(0, RAIL_MAX_ITEMS).map((item, index) => (
                <div key={getItemKey(item, index)} className={DEFAULT_ITEM_CLASS_NAME}>
                  {renderItem(item, index)}
                </div>
              ))}
        </div>
      </div>
    </section>
  );
}
