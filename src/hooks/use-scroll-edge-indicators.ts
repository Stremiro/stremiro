import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { clamp, prefersReducedMotion } from '@/lib/utils';

// Below this px of phantom scroll room (sub-pixel/rounded layouts) the edge counts as reached.
const SCROLL_BOUNDARY_EPSILON = 4;
const DRAG_THRESHOLD_PX = 4;
const GLIDE_MAX_IDLE_MS = 64;
const GLIDE_MIN_VELOCITY = 0.25;
const GLIDE_MAX_VELOCITY = 3.5;
const GLIDE_FRICTION_PER_FRAME = 0.92;
const GLIDE_STOP_PX = 0.4;

export const DRAG_SCROLL_CLASS =
  'cursor-grab select-none active:cursor-grabbing data-[dragging]:cursor-grabbing data-[dragging]:**:cursor-grabbing!';

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
    const scrollLeft = el.scrollLeft;
    if (positionRef) positionRef.current = scrollLeft;
    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    const hasOverflow = maxScrollLeft > SCROLL_BOUNDARY_EPSILON;
    const next: ScrollEdgeState = {
      hasOverflow,
      canScrollLeft: hasOverflow && scrollLeft > SCROLL_BOUNDARY_EPSILON,
      canScrollRight: hasOverflow && scrollLeft < maxScrollLeft - SCROLL_BOUNDARY_EPSILON,
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
      if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame);
      node.removeEventListener('scroll', handleScroll);
      resizeObserver.disconnect();
    };
  }, [node, positionRef, syncScrollState]);

  return { bind, syncScrollState, ...edges };
}

/** Fade mask for a horizontal scroller: transparent only where the scroll continues. */
export function scrollEdgeMask(scrollState: ScrollEdgeState) {
  return scrollState.hasOverflow
    ? `linear-gradient(to right, ${scrollState.canScrollLeft ? 'transparent 0px, black 28px' : 'black 0px'}, ${scrollState.canScrollRight ? 'black calc(100% - 28px), transparent 100%' : 'black 100%'})`
    : undefined;
}

interface DragScrollSession {
  pointerId: number;
  startX: number;
  startLeft: number;
  lastX: number;
  lastTime: number;
  velocity: number;
  moved: boolean;
}

function scheduleAnimationFrame(callback: FrameRequestCallback) {
  return typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(callback)
    : setTimeout(() => callback(performance.now()), 16);
}

function cancelScheduledFrame(frameRef: RefObject<number | null>) {
  if (frameRef.current === null) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current);
  else clearTimeout(frameRef.current);
  frameRef.current = null;
}

/** Mouse drag-to-scroll with 4px dead-zone, click suppression, snap suspend, and damped flick coast. */
export function useHorizontalDragScroll<T extends HTMLElement>() {
  const dragRef = useRef<DragScrollSession | null>(null);
  const suppressClickRef = useRef(false);
  const suppressFrameRef = useRef<number | null>(null);
  const glideFrameRef = useRef<number | null>(null);
  const glideTargetRef = useRef<T | null>(null);

  const stopGlide = useCallback(() => {
    cancelScheduledFrame(glideFrameRef);
    if (glideTargetRef.current) {
      glideTargetRef.current.style.scrollSnapType = '';
      glideTargetRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      stopGlide();
      cancelScheduledFrame(suppressFrameRef);
    },
    [stopGlide],
  );

  const finishDrag = (event: ReactPointerEvent<T>, allowCoast: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const el = event.currentTarget;
    delete el.dataset.dragging;
    if (el.hasPointerCapture(event.pointerId)) {
      el.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved) return;

    if (allowCoast) {
      suppressClickRef.current = true;
      cancelScheduledFrame(suppressFrameRef);
      suppressFrameRef.current = scheduleAnimationFrame(() => {
        suppressFrameRef.current = null;
        suppressClickRef.current = false;
      });
    }

    const idleMs = performance.now() - drag.lastTime;
    if (
      allowCoast &&
      idleMs < GLIDE_MAX_IDLE_MS &&
      !prefersReducedMotion() &&
      Math.abs(drag.velocity) >= GLIDE_MIN_VELOCITY
    ) {
      let prevTime = performance.now();
      let velocity = clamp(drag.velocity, -GLIDE_MAX_VELOCITY, GLIDE_MAX_VELOCITY);
      glideTargetRef.current = el;
      const step = (now: number) => {
        const dt = Math.min(32, Math.max(1, now - prevTime));
        prevTime = now;
        velocity *= Math.pow(GLIDE_FRICTION_PER_FRAME, dt / 16.6667);
        const delta = velocity * dt;
        const maxLeft = el.scrollWidth - el.clientWidth;
        if (Math.abs(delta) < GLIDE_STOP_PX || maxLeft <= 0) {
          stopGlide();
          return;
        }
        const before = el.scrollLeft;
        el.scrollLeft = clamp(before + delta, 0, maxLeft);
        if (Math.abs(el.scrollLeft - before) < 0.5 && (before <= 0 || before >= maxLeft)) {
          stopGlide();
          return;
        }
        glideFrameRef.current = scheduleAnimationFrame(step);
      };
      glideFrameRef.current = scheduleAnimationFrame(step);
      return;
    }

    el.style.scrollSnapType = '';
  };

  return {
    onPointerDown: (event: ReactPointerEvent<T>) => {
      stopGlide();
      suppressClickRef.current = false;
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      const el = event.currentTarget;
      if (el.scrollWidth <= el.clientWidth) return;
      if (
        (event.target as { closest?: (selector: string) => unknown } | null)?.closest?.(
          'input, textarea, select, [contenteditable="true"], [data-selectable="true"]',
        )
      ) {
        return;
      }
      const now = performance.now();
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startLeft: el.scrollLeft,
        lastX: event.clientX,
        lastTime: now,
        velocity: 0,
        moved: false,
      };
    },
    onPointerMove: (event: ReactPointerEvent<T>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) {
        finishDrag(event, false);
        return;
      }
      const el = event.currentTarget;
      if (!drag.moved) {
        if (Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        // Snap points fight a hand-held position; they resume once the drag/coast settles.
        el.style.scrollSnapType = 'none';
        el.dataset.dragging = '';
        el.setPointerCapture(event.pointerId);
      }
      const now = performance.now();
      const dt = now - drag.lastTime;
      if (dt > 0) {
        const instant = (drag.lastX - event.clientX) / dt;
        drag.velocity = dt > GLIDE_MAX_IDLE_MS ? instant : drag.velocity * 0.35 + instant * 0.65;
        drag.lastX = event.clientX;
        drag.lastTime = now;
      }
      el.scrollLeft = drag.startLeft - (event.clientX - drag.startX);
    },
    onPointerUp: (event: ReactPointerEvent<T>) => finishDrag(event, true),
    onPointerCancel: (event: ReactPointerEvent<T>) => finishDrag(event, false),
    onWheel: stopGlide,
    onClickCapture: (event: ReactMouseEvent<T>) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

/** True once `sentinelRef` scrolls under the 32px frameless titlebar. Focus inside the
    compact copy moves to `focusRef` when it hides, so it never lands in an inert region. */
export function useScrolledPastTitlebar(
  sentinelRef: RefObject<HTMLElement | null>,
  compactRef: RefObject<HTMLElement | null>,
  focusRef: RefObject<HTMLElement | null>,
) {
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        const next =
          !entry.isIntersecting && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 32);
        if (!next && compactRef.current?.contains(document.activeElement)) {
          focusRef.current?.focus({ preventScroll: true });
        }
        setPassed(next);
      },
      { rootMargin: '-32px 0px 0px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinelRef, compactRef, focusRef]);
  return passed;
}
