import { defaultRangeExtractor, type Range, useWindowVirtualizer } from '@tanstack/react-virtual';
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from 'react';

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
  containerRef?: RefObject<HTMLDivElement | null>;
  virtualize?: boolean;
  overscan?: number;
  gap?: number;
  getRowStyle?: (index: number, offset?: number) => CSSProperties;
}

export function WindowVirtualizedStack<T>({
  items,
  getItemKey,
  renderItem,
  estimateSize,
  containerRef: suppliedRef,
  virtualize = items.length >= DEFAULT_VIRTUALIZATION_THRESHOLD,
  overscan = OVERSCAN_ROWS,
  gap = DEFAULT_STACK_GAP_PX,
  getRowStyle,
}: WindowVirtualizedStackProps<T>) {
  // The compiler caches getVirtualItems() on the stable virtualizer instance, freezing rows on scroll.
  'use no memo';
  const ownRef = useRef<HTMLDivElement | null>(null);
  const containerRef = suppliedRef ?? ownRef;
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const scrollMargin = useWindowScrollMargin(containerRef, virtualize);
  const rangeExtractor = useCallback(
    (range: Range) => focusedRowRange(range, focusedIndex),
    [focusedIndex],
  );
  const getRowKey = useCallback(
    (index: number) => getItemKey(items[index], index),
    [getItemKey, items],
  );

  const rowVirtualizer = useWindowVirtualizer({
    count: items.length,
    enabled: virtualize,
    estimateSize,
    gap,
    overscan,
    scrollMargin,
    getItemKey: getRowKey,
    rangeExtractor,
  });

  const rows = virtualize
    ? rowVirtualizer.getVirtualItems()
    : items.map((item, index) => ({ index, key: getItemKey(item, index), start: 0 }));

  return (
    <div
      ref={containerRef}
      className='relative w-full'
      style={
        virtualize
          ? { height: `${rowVirtualizer.getTotalSize()}px` }
          : gap
            ? { display: 'grid', gap: `${gap}px` }
            : undefined
      }
    >
      {rows.map((virtualRow) => {
        const item = items[virtualRow.index];
        if (item === undefined) {
          return null;
        }

        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={virtualize ? rowVirtualizer.measureElement : undefined}
            onFocusCapture={() => setFocusedIndex(virtualRow.index)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setFocusedIndex(-1);
            }}
            style={{
              ...(virtualize
                ? {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                  }
                : undefined),
              ...getRowStyle?.(
                virtualRow.index,
                virtualize ? virtualRow.start - scrollMargin : undefined,
              ),
            }}
          >
            {renderItem(item, virtualRow.index)}
          </div>
        );
      })}
    </div>
  );
}
