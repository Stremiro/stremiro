import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { WindowVirtualizedStack } from '@/components/window-virtualized-stack';

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
  const [metrics, setMetrics] = useState(() => ({
    columnCount: getColumnCount(typeof window === 'undefined' ? 1280 : window.innerWidth, 0),
    containerWidth: 0,
  }));

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
    if (!container) return;

    // Viewport-fluid — any metric-changing resize also resizes the container, so the observer owns every resync.
    const resizeObserver = new ResizeObserver(updateMetrics);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [updateMetrics]);

  const columnCount = metrics.columnCount;
  const rowCount = Math.ceil(items.length / columnCount);
  const rows = useMemo(() => Array.from({ length: rowCount }, (_, index) => index), [rowCount]);
  const estimatedItemWidth =
    metrics.containerWidth > 0
      ? (metrics.containerWidth - gap * (columnCount - 1)) / columnCount
      : DEFAULT_FALLBACK_ITEM_WIDTH_PX;
  const estimatedRowHeight = estimateItemHeight(estimatedItemWidth) + rowGap;
  const gridTemplateColumns = `repeat(${columnCount}, minmax(0, 1fr))`;

  return (
    <WindowVirtualizedStack
      containerRef={containerRef}
      items={rows}
      getItemKey={getRowKey}
      estimateSize={() => estimatedRowHeight}
      virtualize={items.length >= DEFAULT_VIRTUALIZATION_THRESHOLD}
      overscan={DEFAULT_OVERSCAN_ROWS}
      gap={0}
      getRowStyle={(index, offset) => ({
        top: offset === undefined ? undefined : `${offset}px`,
        transform: undefined,
        width: '100%',
        display: 'grid',
        gap: `${gap}px`,
        gridTemplateColumns,
        paddingBottom: offset !== undefined || index < rowCount - 1 ? `${rowGap}px` : undefined,
      })}
      renderItem={(rowIndex) => {
        const rowStartIndex = rowIndex * columnCount;
        return items.slice(rowStartIndex, rowStartIndex + columnCount).map((item, itemOffset) => {
          const itemIndex = rowStartIndex + itemOffset;
          return (
            <Fragment key={getItemKey(item, itemIndex)}>{renderItem(item, itemIndex)}</Fragment>
          );
        });
      }}
    />
  );
}
