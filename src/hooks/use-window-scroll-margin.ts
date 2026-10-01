import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Distance from the document top to the container's top edge, in window
 * coordinates. `useWindowVirtualizer` positions rows relative to the window,
 * so lists below the fold render misplaced without this margin. Measured on
 * layout and resize; sub-pixel deltas are suppressed so observer feedback
 * never loops. Inert while `shouldVirtualize` is false.
 */
export function useWindowScrollMargin(
  containerRef: RefObject<HTMLDivElement | null>,
  shouldVirtualize: boolean,
): number {
  const [scrollMargin, setScrollMargin] = useState(0);

  const updateScrollMargin = useCallback(() => {
    if (!shouldVirtualize || !containerRef.current) {
      return;
    }

    const nextScrollMargin = containerRef.current.getBoundingClientRect().top + window.scrollY;
    setScrollMargin((currentScrollMargin) =>
      Math.abs(currentScrollMargin - nextScrollMargin) < 1 ? currentScrollMargin : nextScrollMargin,
    );
  }, [containerRef, shouldVirtualize]);

  useLayoutEffect(() => {
    updateScrollMargin();
  }, [updateScrollMargin]);

  useEffect(() => {
    if (!shouldVirtualize) {
      return;
    }

    const handleResize = () => {
      updateScrollMargin();
    };

    window.addEventListener('resize', handleResize, { passive: true });

    const resizeObserver =
      typeof ResizeObserver === 'undefined' || !containerRef.current
        ? null
        : new ResizeObserver(() => {
            updateScrollMargin();
          });

    if (resizeObserver && containerRef.current) {
      resizeObserver.observe(containerRef.current);
      // Content above the container (hero media settling, banners) moves the
      // margin without resizing the container itself — watch the body so
      // those shifts still re-measure.
      resizeObserver.observe(document.body);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver?.disconnect();
    };
  }, [containerRef, shouldVirtualize, updateScrollMargin]);

  return scrollMargin;
}
