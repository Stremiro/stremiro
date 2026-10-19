import { defaultRangeExtractor, type Range, useWindowVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useCallback, useRef, useState } from 'react';

import { useWindowScrollMargin } from '@/hooks/use-window-scroll-margin';

const DEFAULT_STACK_GAP_PX = 6;
const DEFAULT_VIRTUALIZATION_THRESHOLD = 40;
const OVERSCAN_ROWS = 6;

export function focusedRowRange(range: Range, focusedIndex: number): number[] {
  const indices = defaultRangeExtractor(range);
  if (focusedIndex >= 0 && focusedIndex < range.count) {
    const first = Math.max(0, focusedIndex - 1);
    const last = Math.min(range.count - 1, focusedIndex + 1);
    if (first >= indices[0] && last <= indices[indices.length - 1]) return indices;
    for (let index = first; index <= last; index += 1) {
      if (!indices.includes(index)) indices.push(index);
    }
    indices.sort((left, right) => left - right);
  }
  return indices;
}

interface WindowVirtualizedStackProps<T> {
  items: readonly T[];
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  estimateSize: (index: number) => number;
}

export function WindowVirtualizedStack<T>({
  items,
  getItemKey,
  renderItem,
  estimateSize,
}: WindowVirtualizedStackProps<T>) {
  // The compiler caches getVirtualItems() on the stable virtualizer instance, freezing rows on scroll.
  'use no memo';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const shouldVirtualize = items.length >= DEFAULT_VIRTUALIZATION_THRESHOLD;
  const scrollMargin = useWindowScrollMargin(containerRef, shouldVirtualize);
  const rangeExtractor = useCallback(
    (range: Range) => focusedRowRange(range, focusedIndex),
    [focusedIndex],
  );
  const getRowKey = useCallback(
    (index: number) => getItemKey(items[index] as T, index),
    [getItemKey, items],
  );

  const rowVirtualizer = useWindowVirtualizer({
    count: items.length,
    enabled: shouldVirtualize,
    estimateSize,
    gap: DEFAULT_STACK_GAP_PX,
    overscan: OVERSCAN_ROWS,
    scrollMargin,
    getItemKey: getRowKey,
    rangeExtractor,
  });

  const rows = shouldVirtualize
    ? rowVirtualizer.getVirtualItems()
    : items.map((item, index) => ({ index, key: getItemKey(item, index), start: 0 }));

  return (
    <div
      ref={containerRef}
      className='relative w-full'
      style={
        shouldVirtualize
          ? { height: `${rowVirtualizer.getTotalSize()}px` }
          : { display: 'grid', gap: `${DEFAULT_STACK_GAP_PX}px` }
      }
    >
      {rows.map((virtualRow) => {
        const item = items[virtualRow.index];
        if (!item) {
          return null;
        }

        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={shouldVirtualize ? rowVirtualizer.measureElement : undefined}
            onFocusCapture={() => setFocusedIndex(virtualRow.index)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setFocusedIndex(-1);
            }}
            style={
              shouldVirtualize
                ? {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                  }
                : undefined
            }
          >
            {renderItem(item, virtualRow.index)}
          </div>
        );
      })}
    </div>
  );
}
