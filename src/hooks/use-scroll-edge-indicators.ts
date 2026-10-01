import { type RefObject, useCallback, useEffect, useState } from 'react';

// Sub-pixel/rounded layouts can report a few px of phantom scroll room —
// below this the edge counts as reached.
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

/**
 * Edge-state tracker for a horizontally scrolling container — owns the
 * rAF-coalesced scroll listener, window-resize resync, and a ResizeObserver
 * on the container box. Attach via the returned `bind` callback ref so a
 * scroller that mounts late still subscribes. Call `syncScrollState` after
 * content changes — ResizeObserver watches the container's box, not its
 * scrollWidth. `positionRef` mirrors the last scrollLeft so an unmount
 * cleanup can persist it after React detaches the DOM ref.
 */
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
    // Scroll events outpace frames — coalesce to one state read per frame.
    let scrollFrame: number | null = null;
    const handleScroll = () => {
      if (scrollFrame !== null) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = null;
        syncScrollState();
      });
    };
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncScrollState);

    node.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', syncScrollState);
    resizeObserver?.observe(node);

    return () => {
      window.cancelAnimationFrame(initialSyncFrame);
      if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame);
      node.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', syncScrollState);
      resizeObserver?.disconnect();
    };
  }, [node, syncScrollState]);

  return { bind, syncScrollState, ...edges };
}
