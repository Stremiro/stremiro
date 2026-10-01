import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Fragment, type ReactNode, useRef } from 'react';

import { useWindowScrollMargin } from '@/hooks/use-window-scroll-margin';

const DEFAULT_STACK_GAP_PX = 6;
const DEFAULT_VIRTUALIZATION_THRESHOLD = 40;

interface WindowVirtualizedStackProps<T> {
  items: readonly T[];
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  estimateSize: (index: number) => number;
  overscan?: number;
  gap?: number;
  virtualizationThreshold?: number;
}

export function WindowVirtualizedStack<T>({
  items,
  getItemKey,
  renderItem,
  estimateSize,
  overscan = 6,
  gap = DEFAULT_STACK_GAP_PX,
  virtualizationThreshold = DEFAULT_VIRTUALIZATION_THRESHOLD,
}: WindowVirtualizedStackProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = items.length >= virtualizationThreshold;
  const scrollMargin = useWindowScrollMargin(containerRef, shouldVirtualize);

  const rowVirtualizer = useWindowVirtualizer({
    count: items.length,
    enabled: shouldVirtualize,
    estimateSize,
    gap,
    overscan,
    scrollMargin,
    getItemKey: (index) => getItemKey(items[index] as T, index),
  });

  if (!shouldVirtualize) {
    return (
      <div ref={containerRef} style={{ display: 'grid', gap: `${gap}px` }}>
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
