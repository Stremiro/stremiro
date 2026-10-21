import { type RefObject, useCallback, useEffect, useState } from 'react';

// Below this px of phantom scroll room (sub-pixel/rounded layouts) the edge counts as reached.
const SCROLL_BOUNDARY_EPSILON = 4;

interface ScrollEdgeState {
  canScrollLeft: boolean;
  canScrollRight: boolean;
  hasOverflow: boolean;
}

const INITIAL_SCROLL_EDGE_STATE: ScrollEdgeState = {
  canScrollLeft: false,
  canScrollRight: false,
  hasOverflow: false,
};

/** Horizontal-scroll edge tracker: rAF scroll listener + container ResizeObserver; `bind` subscribes
    late scrollers, `syncScrollState` re-reads after content changes (RO watches the box, not scrollWidth). */
export function useScrollEdgeIndicators<T extends HTMLElement>(
  scrollRef: RefObject<T | null>,
  positionRef?: RefObject<number>,
) {
  const [node, setNode] = useState<T | null>(null);
  const [edges, setEdges] = useState(INITIAL_SCROLL_EDGE_STATE);

  const bind = useCallback(
    (el: T | null) => {
      scrollRef.current = el;
      setNode(el);
    },
    [scrollRef],
  );

  const syncScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      setEdges((prev) =>
        prev.hasOverflow || prev.canScrollLeft || prev.canScrollRight
          ? INITIAL_SCROLL_EDGE_STATE
          : prev,
      );
      return;
    }

    // positionRef mirrors scrollLeft so an unmount cleanup can persist it after React detaches the ref.
    if (positionRef) positionRef.current = el.scrollLeft;
    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    const hasOverflow = maxScrollLeft > SCROLL_BOUNDARY_EPSILON;
    const next: ScrollEdgeState = {
      hasOverflow,
      canScrollLeft: hasOverflow && el.scrollLeft > SCROLL_BOUNDARY_EPSILON,
      canScrollRight: hasOverflow && el.scrollLeft < maxScrollLeft - SCROLL_BOUNDARY_EPSILON,
    };
    setEdges((prev) =>
      prev.hasOverflow === next.hasOverflow &&
      prev.canScrollLeft === next.canScrollLeft &&
      prev.canScrollRight === next.canScrollRight
        ? prev
        : next,
    );
  }, [scrollRef, positionRef]);

  useEffect(() => {
    if (!node) return;

    const initialSyncFrame = window.requestAnimationFrame(syncScrollState);
    // Scroll events outpace frames — one state read per frame.
    let scrollFrame: number | null = null;
    const handleScroll = () => {
      if (positionRef) positionRef.current = node.scrollLeft;
      if (scrollFrame !== null) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = null;
        syncScrollState();
      });
    };
    const resizeObserver = new ResizeObserver(syncScrollState);

    node.addEventListener('scroll', handleScroll, { passive: true });
    resizeObserver.observe(node);

    return () => {
      window.cancelAnimationFrame(initialSyncFrame);
      if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame);
      node.removeEventListener('scroll', handleScroll);
      resizeObserver.disconnect();
    };
  }, [node, positionRef, syncScrollState]);

  return { bind, syncScrollState, ...edges };
}
