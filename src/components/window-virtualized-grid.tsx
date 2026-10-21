import { type Range, useWindowVirtualizer } from '@tanstack/react-virtual';
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { focusedRowRange } from '@/components/window-virtualized-stack';
import { useWindowScrollMargin } from '@/hooks/use-window-scroll-margin';

const DEFAULT_GRID_GAP_PX = 16;
const DEFAULT_FALLBACK_ITEM_WIDTH_PX = 160;
const DEFAULT_OVERSCAN_ROWS = 2;
const DEFAULT_VIRTUALIZATION_THRESHOLD = 24;
const getRowKey = (index: number) => `row-${index}`;

function getDefaultWindowGridColumnCount(viewportWidth: number) {
  if (viewportWidth >= 1280) {
    return 6;
  }
  if (viewportWidth >= 1024) {
    return 5;
  }
  if (viewportWidth >= 768) {
    return 4;
  }
  if (viewportWidth >= 640) {
    return 3;
  }

  return 2;
}

interface WindowVirtualizedGridProps<T> {
  items: readonly T[];
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  estimateItemHeight: (itemWidth: number) => number;
  getColumnCount?: (viewportWidth: number, containerWidth: number) => number;
  gap?: number;
  rowGap?: number;
}

export function WindowVirtualizedGrid<T>({
  items,
  getItemKey,
  renderItem,
  estimateItemHeight,
  getColumnCount = getDefaultWindowGridColumnCount,
  gap = DEFAULT_GRID_GAP_PX,
  rowGap = gap,
}: WindowVirtualizedGridProps<T>) {
  // See WindowVirtualizedStack: compiler memoization would freeze virtual rows.
  'use no memo';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [metrics, setMetrics] = useState(() => ({
    columnCount: getColumnCount(typeof window === 'undefined' ? 1280 : window.innerWidth, 0),
    containerWidth: 0,
  }));
  const shouldVirtualize = items.length >= DEFAULT_VIRTUALIZATION_THRESHOLD;
  // Metrics feed both plain and virtualized rendering, so the grid owns the resize wiring; the virtualized-only scroll margin comes from the hook.
  const scrollMargin = useWindowScrollMargin(containerRef, shouldVirtualize);

  const updateMetrics = useCallback(() => {
    const nextContainerWidth = containerRef.current?.clientWidth ?? 0;
    const nextColumnCount = Math.max(1, getColumnCount(window.innerWidth, nextContainerWidth));

    setMetrics((currentMetrics) =>
      currentMetrics.columnCount === nextColumnCount &&
      currentMetrics.containerWidth === nextContainerWidth
        ? currentMetrics
        : {
            columnCount: nextColumnCount,
            containerWidth: nextContainerWidth,
          },
    );
  }, [getColumnCount]);

  useLayoutEffect(() => {
    updateMetrics();
  }, [updateMetrics]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    // Viewport-fluid — any metric-changing resize also resizes the container, so the observer owns every resync.
    const resizeObserver = new ResizeObserver(updateMetrics);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [updateMetrics]);

  const columnCount = metrics.columnCount;
  const rowCount = Math.ceil(items.length / columnCount);
  const estimatedItemWidth =
    metrics.containerWidth > 0
      ? (metrics.containerWidth - gap * (columnCount - 1)) / columnCount
      : DEFAULT_FALLBACK_ITEM_WIDTH_PX;
  const estimatedRowHeight = estimateItemHeight(estimatedItemWidth) + rowGap;
  const rangeExtractor = useCallback(
    (range: Range) => focusedRowRange(range, focusedIndex),
    [focusedIndex],
  );

  const rowVirtualizer = useWindowVirtualizer({
    count: rowCount,
    enabled: shouldVirtualize,
    estimateSize: () => estimatedRowHeight,
    overscan: DEFAULT_OVERSCAN_ROWS,
    scrollMargin,
    getItemKey: getRowKey,
    rangeExtractor,
  });

  const gridTemplateColumns = `repeat(${columnCount}, minmax(0, 1fr))`;
  const rows = shouldVirtualize
    ? rowVirtualizer.getVirtualItems()
    : Array.from({ length: rowCount }, (_, index) => ({ index, key: getRowKey(index), start: 0 }));

  return (
    <div
      ref={containerRef}
      className='relative w-full'
      style={shouldVirtualize ? { height: `${rowVirtualizer.getTotalSize()}px` } : undefined}
    >
      {rows.map((virtualRow) => {
        const rowStartIndex = virtualRow.index * columnCount;
        const rowItems = items.slice(rowStartIndex, rowStartIndex + columnCount);

        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={shouldVirtualize ? rowVirtualizer.measureElement : undefined}
            onFocusCapture={() => setFocusedIndex(virtualRow.index)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setFocusedIndex(-1);
            }}
            style={{
              position: shouldVirtualize ? 'absolute' : undefined,
              top: shouldVirtualize ? `${virtualRow.start - scrollMargin}px` : undefined,
              left: shouldVirtualize ? 0 : undefined,
              width: '100%',
              display: 'grid',
              gap: `${gap}px`,
              gridTemplateColumns,
              paddingBottom:
                shouldVirtualize || virtualRow.index < rowCount - 1 ? `${rowGap}px` : undefined,
            }}
          >
            {rowItems.map((item, itemOffset) => {
              const itemIndex = rowStartIndex + itemOffset;
              return (
                <Fragment key={getItemKey(item, itemIndex)}>{renderItem(item, itemIndex)}</Fragment>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
