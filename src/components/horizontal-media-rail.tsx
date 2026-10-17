import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type Key, type ReactNode, useLayoutEffect, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
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

// Cap mounted cards; full catalogs remain available through search.
const RAIL_MAX_ITEMS = 48;

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
  const hasNotice = notice !== undefined;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastScrollLeftRef = useRef(0);
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
          <h2 className='text-[17px] font-semibold tracking-[-0.02em] text-white'>{title}</h2>

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
      )}
    </section>
  );
}
