import { defaultRangeExtractor, type Range, useWindowVirtualizer } from '@tanstack/react-virtual';
import { Fragment, type ReactNode, useCallback, useRef, useState } from 'react';

import { useWindowScrollMargin } from '@/hooks/use-window-scroll-margin';

const DEFAULT_STACK_GAP_PX = 6;
const DEFAULT_VIRTUALIZATION_THRESHOLD = 40;
const OVERSCAN_ROWS = 6;

export function focusedRowRange(range: Range, focusedIndex: number): number[] {
  const indices = defaultRangeExtractor(range);
  if (focusedIndex >= 0 && focusedIndex < range.count && !indices.includes(focusedIndex)) {
    indices.push(focusedIndex);
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const shouldVirtualize = items.length >= DEFAULT_VIRTUALIZATION_THRESHOLD;
  const scrollMargin = useWindowScrollMargin(containerRef, shouldVirtualize);
  const rangeExtractor = useCallback(
    (range: Range) => focusedRowRange(range, focusedIndex),
    [focusedIndex],
  );

  const rowVirtualizer = useWindowVirtualizer({
    count: items.length,
    enabled: shouldVirtualize,
    estimateSize,
    gap: DEFAULT_STACK_GAP_PX,
    overscan: OVERSCAN_ROWS,
    scrollMargin,
    getItemKey: (index) => getItemKey(items[index] as T, index),
    rangeExtractor,
  });

  if (!shouldVirtualize) {
    return (
      <div ref={containerRef} style={{ display: 'grid', gap: `${DEFAULT_STACK_GAP_PX}px` }}>
        {items.map((item, index) => (
          <Fragment key={getItemKey(item, index)}>{renderItem(item, index)}</Fragment>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className='relative w-full'
      style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
    >
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        const item = items[virtualRow.index];
        if (!item) {
          return null;
        }

        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={rowVirtualizer.measureElement}
            onFocusCapture={() => setFocusedIndex(virtualRow.index)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setFocusedIndex(-1);
            }}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
            }}
          >
            {renderItem(item, virtualRow.index)}
          </div>
        );
      })}
    </div>
  );
}
