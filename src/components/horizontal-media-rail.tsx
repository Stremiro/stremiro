import { type Range, useVirtualizer } from '@tanstack/react-virtual';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  type Key,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
import { focusedRowRange } from '@/components/window-virtualized-stack';
import { useScrollEdgeIndicators } from '@/hooks/use-scroll-edge-indicators';
import { boundedMapSet, cn, scrollBehavior } from '@/lib/utils';
import { MediaCardSkeleton, MEDIA_CARD_SLOT_CLASS_NAME } from './media-card';

export const HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS =
  'pr-6 pl-[84px] md:px-12 md:pl-24 lg:px-14 lg:pl-28';

const SCROLL_BUTTON_CLASS_NAME =
  'h-9 w-9 rounded-md bg-transparent border border-white/[0.08] text-zinc-400 hover:bg-white/[0.08] hover:text-white transition-colors duration-150 aria-disabled:cursor-default aria-disabled:opacity-40';
const DEFAULT_ITEM_CLASS_NAME = `flex-none ${MEDIA_CARD_SLOT_CLASS_NAME} snap-start`;
const DEFAULT_SCROLLER_CLASS_NAME =
  'flex overflow-x-auto gap-4 pb-8 scrollbar-hide snap-x snap-proximity';
// Bounded scroll memory survives route changes.
const RAIL_SCROLL_MEMORY_MAX = 64;
const railScrollPositions = new Map<string, number>();

function rememberRailScrollPosition(railId: string, position: number): void {
  boundedMapSet(railScrollPositions, railId, position, RAIL_SCROLL_MEMORY_MAX);
}

const RAIL_VIRTUALIZATION_THRESHOLD = 48;

interface HorizontalMediaRailProps<T> {
  /** Concatenated, never `cn()`-merged — tailwind-merge would collapse `lg:pl-*`+`lg:px-*` pairs. */
  contentInsetsClassName?: string;
  getItemKey: (item: T, index: number) => Key;
  headerContent?: ReactNode;
  isLoading: boolean;
  isPlaceholderData?: boolean;
  items: readonly T[];
  notice?: ReactNode;
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
  isPlaceholderData = false,
  items,
  notice,
  railId,
  renderItem,
  scrollerClassName,
  sectionClassName,
  skeletonCount = 8,
  title,
  viewportClassName,
}: HorizontalMediaRailProps<T>) {
  // See WindowVirtualizedStack: compiler memoization would freeze virtual items.
  'use no memo';
  const hasNotice = notice !== undefined;
  const titleId = useId();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const lastScrollLeftRef = useRef(0);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [slotWidth, setSlotWidth] = useState(190);
  const shouldVirtualize = !isLoading && !hasNotice && items.length > RAIL_VIRTUALIZATION_THRESHOLD;
  const rangeExtractor = useCallback(
    (range: Range) => focusedRowRange(range, focusedIndex),
    [focusedIndex],
  );
  const getVirtualItemKey = useCallback(
    (index: number) => getItemKey(items[index], index),
    [getItemKey, items],
  );
  const virtualizer = useVirtualizer({
    horizontal: true,
    count: items.length,
    enabled: shouldVirtualize,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => slotWidth,
    gap: 16,
    overscan: 3,
    initialRect: { width: 1280, height: 0 },
    initialOffset: () => (railId ? (railScrollPositions.get(railId) ?? 0) : 0),
    getItemKey: getVirtualItemKey,
    rangeExtractor,
  });

  useLayoutEffect(() => {
    if (shouldVirtualize) virtualizer.measure();
  }, [shouldVirtualize, slotWidth, virtualizer]);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot || !shouldVirtualize) return;
    const measure = () => setSlotWidth(slot.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(slot);
    return () => observer.disconnect();
  }, [shouldVirtualize]);
  const {
    bind: bindScrollContainer,
    syncScrollState,
    ...scrollState
  } = useScrollEdgeIndicators(scrollContainerRef, lastScrollLeftRef);

  const itemKeys = useMemo(() => {
    if (isLoading) return new Set<string>();
    return new Set(items.map((item, index) => String(getItemKey(item, index))));
  }, [getItemKey, isLoading, items]);
  const previousKeysRef = useRef<ReadonlySet<string> | null>(null);
  const activeRailIdRef = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      if (activeRailIdRef.current) {
        rememberRailScrollPosition(activeRailIdRef.current, lastScrollLeftRef.current);
      }
      activeRailIdRef.current = undefined;
      previousKeysRef.current = null;
      syncScrollState();
      return;
    }
    if (isPlaceholderData || isLoading) {
      syncScrollState();
      return;
    }
    const previousRailId = activeRailIdRef.current;
    const identityChanged = previousRailId !== railId;
    if (identityChanged && previousRailId) {
      rememberRailScrollPosition(previousRailId, lastScrollLeftRef.current);
    }
    activeRailIdRef.current = railId;
    if (identityChanged) previousKeysRef.current = null;
    // Empty phases must not re-arm restoration within the same catalog.
    if (itemKeys.size === 0) {
      syncScrollState();
      return;
    }
    const previousKeys = previousKeysRef.current;
    previousKeysRef.current = itemKeys;
    if (!previousKeys) {
      if (railId) {
        const remembered = railScrollPositions.get(railId);
        scrollContainer.scrollLeft = remembered ?? 0;
      }
      syncScrollState();
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
    }
    syncScrollState();
  }, [hasNotice, isLoading, isPlaceholderData, itemKeys, railId, syncScrollState]);

  useLayoutEffect(() => {
    const scrollContainer = scrollContainerRef;
    const position = lastScrollLeftRef;
    return () => {
      const activeRailId = activeRailIdRef.current;
      if (activeRailId) {
        rememberRailScrollPosition(
          activeRailId,
          scrollContainer.current?.scrollLeft ?? position.current,
        );
      }
    };
  }, []);

  const scroll = (direction: 'left' | 'right') => {
    if (!scrollContainerRef.current) {
      return;
    }

    const { current } = scrollContainerRef;
    const delta = direction === 'left' ? -current.offsetWidth * 0.8 : current.offsetWidth * 0.8;
    current.scrollBy({ left: delta, behavior: scrollBehavior() });
  };

  const edgeMask = scrollState.hasOverflow
    ? `linear-gradient(to right, ${scrollState.canScrollLeft ? 'transparent 0px, black 28px' : 'black 0px'}, ${scrollState.canScrollRight ? 'black calc(100% - 28px), transparent 100%' : 'black 100%'})`
    : undefined;

  return (
    <section
      aria-busy={isLoading || isPlaceholderData || undefined}
      className={cn('py-4 relative group/section', sectionClassName)}
    >
      <div className={`${contentInsetsClassName} ${hasNotice ? 'mb-1' : 'mb-3'}`}>
        <div className={cn('flex items-center justify-between mb-3', !hasNotice && 'min-h-9')}>
          <h2 id={titleId} className='text-[17px] font-semibold tracking-[-0.02em] text-white'>
            {title}
          </h2>

          {!hasNotice && scrollState.hasOverflow && (
            <div className='flex shrink-0 items-center gap-1.5 opacity-60 group-hover/section:opacity-100 group-focus-within/section:opacity-100 focus-within:opacity-100 transition-opacity duration-150'>
              <Button
                aria-label='Scroll rail left'
                size='icon'
                variant='ghost'
                className={SCROLL_BUTTON_CLASS_NAME}
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
                className={SCROLL_BUTTON_CLASS_NAME}
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

      {hasNotice ? (
        <div
          className={`${contentInsetsClassName} pt-4 flex flex-wrap items-center gap-3 text-[13px] text-zinc-400`}
        >
          {notice}
        </div>
      ) : (
        <div
          className={`${contentInsetsClassName} ${cn('relative overflow-hidden', viewportClassName)}`}
        >
          {shouldVirtualize && (
            <div
              ref={slotRef}
              aria-hidden='true'
              className={`absolute invisible pointer-events-none ${MEDIA_CARD_SLOT_CLASS_NAME}`}
            />
          )}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Scroll regions handle their own navigation keys. */}
          <div
            ref={bindScrollContainer}
            data-media-scroller
            role='region'
            aria-labelledby={titleId}
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Scroll regions must be keyboard reachable.
            tabIndex={0}
            onKeyDown={(event) => {
              if (
                event.target !== event.currentTarget ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey
              )
                return;
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                scroll(event.key === 'ArrowLeft' ? 'left' : 'right');
              } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                event.currentTarget.scrollTo({
                  left: event.key === 'Home' ? 0 : event.currentTarget.scrollWidth,
                  behavior: scrollBehavior(),
                });
              }
            }}
            className={cn(
              DEFAULT_SCROLLER_CLASS_NAME,
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/25',
              scrollerClassName,
              shouldVirtualize && 'grid',
            )}
            style={{
              ...(edgeMask ? { maskImage: edgeMask, WebkitMaskImage: edgeMask } : {}),
              ...(shouldVirtualize
                ? { gridTemplateColumns: `repeat(${items.length}, ${slotWidth}px)` }
                : {}),
            }}
          >
            {isLoading
              ? Array.from({ length: skeletonCount }, (_, index) => (
                  <div key={`rail-skeleton-${index + 1}`} className={DEFAULT_ITEM_CLASS_NAME}>
                    <MediaCardSkeleton />
                  </div>
                ))
              : shouldVirtualize
                ? virtualizer.getVirtualItems().map((virtualItem) => (
                    <div
                      key={virtualItem.key}
                      className={DEFAULT_ITEM_CLASS_NAME}
                      style={{ gridColumn: virtualItem.index + 1, gridRow: 1 }}
                      onFocusCapture={() => setFocusedIndex(virtualItem.index)}
                      onBlurCapture={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedIndex(-1);
                      }}
                    >
                      {renderItem(items[virtualItem.index], virtualItem.index)}
                    </div>
                  ))
                : items.map((item, index) => (
                    <div key={getItemKey(item, index)} className={DEFAULT_ITEM_CLASS_NAME}>
                      {renderItem(item, index)}
                    </div>
                  ))}
          </div>
        </div>
      )}
    </section>
  );
}
