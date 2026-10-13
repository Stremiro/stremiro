import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/** Container top in window coords — `useWindowVirtualizer` needs it for below-the-fold lists.
    Sub-pixel deltas suppressed so observer feedback never loops. Inert while `shouldVirtualize` is false. */
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

    // Burst body resizes (image decode, infinite-scroll appends) coalesce to one measure per frame.
    let measureFrame: number | null = null;
    const scheduleMeasure = () => {
      if (measureFrame !== null) return;
      measureFrame = window.requestAnimationFrame(() => {
        measureFrame = null;
        updateScrollMargin();
      });
    };

    const resizeObserver =
      typeof ResizeObserver === 'undefined' || !containerRef.current
        ? null
        : new ResizeObserver(scheduleMeasure);

    if (resizeObserver && containerRef.current) {
      resizeObserver.observe(containerRef.current);
      // Content above (hero media, banners) shifts the margin without resizing the container — watch the body too.
      resizeObserver.observe(document.body);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      if (measureFrame !== null) window.cancelAnimationFrame(measureFrame);
      resizeObserver?.disconnect();
    };
  }, [containerRef, shouldVirtualize, updateScrollMargin]);

  return scrollMargin;
}
