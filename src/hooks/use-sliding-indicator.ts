import { type RefObject, useLayoutEffect, useState } from 'react';

interface IndicatorBounds {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function useSlidingIndicator<Key extends string, Item extends HTMLElement>(
  activeKey: Key | undefined,
  containerRef: RefObject<HTMLElement | null>,
  itemRefs: RefObject<Map<Key, Item>>,
) {
  const [indicator, setIndicator] = useState<IndicatorBounds | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const item = activeKey ? itemRefs.current.get(activeKey) : undefined;
      if (!item) return;
      const next = {
        top: item.offsetTop,
        left: item.offsetLeft,
        width: item.offsetWidth,
        height: item.offsetHeight,
      };
      if (!next.width || !next.height) return;
      setIndicator((current) =>
        current?.top === next.top &&
        current.left === next.left &&
        current.width === next.width &&
        current.height === next.height
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const item of itemRefs.current.values()) observer.observe(item);
    return () => observer.disconnect();
  }, [activeKey, containerRef, itemRefs]);

  // Mount an indicator only after measuring so its first placement never slides from zero.
  return indicator;
}
