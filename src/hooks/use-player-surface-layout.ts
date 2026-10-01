import { type RefObject, useCallback, useEffect, useRef } from 'react';
import { setVideoMarginRatio, type VideoMarginRatio } from 'tauri-plugin-libmpv-api';

// Chrome geometry shared with the mini player's drag bounds — one owner so a
// rail/titlebar resize can't desync margins from the floating frame.
export const PLAYER_SIDEBAR_WIDTH_PX = 60;
export const PLAYER_TITLEBAR_HEIGHT_PX = 32;
const MINI_MASK_TARGET_SELECTOR = '[data-mini-mask]';

function clampMarginRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0.98, value));
}

function normalizeMarginRatioPart(value?: number): number {
  return Math.round((value ?? 0) * 10000) / 10000;
}

function serializeVideoMarginRatio(ratio: VideoMarginRatio): string {
  return [
    normalizeMarginRatioPart(ratio.left),
    normalizeMarginRatioPart(ratio.right),
    normalizeMarginRatioPart(ratio.top),
    normalizeMarginRatioPart(ratio.bottom),
  ].join('|');
}

/** Fingerprint-deduped margin send: skips an identical repeat, records intent
 * up front so chase frames coalesce, and clears on failure so the next send
 * retries. Resolves true only on a verified fresh send — a dedup hit or a
 * reject is false, so callers never claim a paint that wasn't verified. */
export function sendMarginRatio(
  fingerprintRef: RefObject<string | null>,
  ratio: VideoMarginRatio,
  send: (ratio: VideoMarginRatio) => Promise<void> = setVideoMarginRatio,
): Promise<boolean> {
  const fingerprint = serializeVideoMarginRatio(ratio);
  if (fingerprintRef.current === fingerprint) return Promise.resolve(false);
  fingerprintRef.current = fingerprint;
  return send(ratio).then(
    () => true,
    () => {
      // A late reject clears the fingerprint only while it still owns the slot.
      if (fingerprintRef.current === fingerprint) {
        fingerprintRef.current = null;
      }
      return false;
    },
  );
}

function buildVideoMarginRatio(
  viewportWidth: number,
  viewportHeight: number,
  insets: {
    leftPx: number;
    rightPx: number;
    topPx: number;
    bottomPx: number;
  },
): VideoMarginRatio {
  const ratio: VideoMarginRatio = {
    left: clampMarginRatio(insets.leftPx / viewportWidth),
    right: clampMarginRatio(insets.rightPx / viewportWidth),
    top: clampMarginRatio(insets.topPx / viewportHeight),
    bottom: clampMarginRatio(insets.bottomPx / viewportHeight),
  };

  const horizontalTotal = (ratio.left ?? 0) + (ratio.right ?? 0);
  if (horizontalTotal >= 0.98) {
    const scale = 0.98 / horizontalTotal;
    ratio.left = (ratio.left ?? 0) * scale;
    ratio.right = (ratio.right ?? 0) * scale;
  }

  const verticalTotal = (ratio.top ?? 0) + (ratio.bottom ?? 0);
  if (verticalTotal >= 0.98) {
    const scale = 0.98 / verticalTotal;
    ratio.top = (ratio.top ?? 0) * scale;
    ratio.bottom = (ratio.bottom ?? 0) * scale;
  }

  return ratio;
}

interface UsePlayerSurfaceLayoutArgs {
  playerContainerRef: RefObject<HTMLDivElement | null>;
  topChromeRef: RefObject<HTMLDivElement | null>;
  bottomChromeRef: RefObject<HTMLDivElement | null>;
  activeStreamUrl?: string;
  mpvSurfaceReady: boolean;
  isFullscreen: boolean;
  isLoading: boolean;
  isResolving: boolean;
  showErrorOverlay: boolean;
  showStreamSelector: boolean;
  /** 'mini' hands margin ownership to useMiniPlayerSurface. */
  presentation: 'expanded' | 'mini';
}

export function usePlayerSurfaceLayout({
  playerContainerRef,
  topChromeRef,
  bottomChromeRef,
  activeStreamUrl,
  mpvSurfaceReady,
  isFullscreen,
  isLoading,
  isResolving,
  showErrorOverlay,
  showStreamSelector,
  presentation,
}: UsePlayerSurfaceLayoutArgs) {
  const lastAppliedMarginFingerprintRef = useRef<string | null>(null);
  // Last ratio actually sent — the mini dock FLIP's origin. Not reset on
  // presentation flip: the mini mount reads where the video visibly was.
  const lastAppliedRatioRef = useRef<VideoMarginRatio | null>(null);
  // Stale async applies must never overwrite a newer computation.
  const marginGenerationRef = useRef(0);
  const isMini = presentation === 'mini';

  useEffect(() => {
    lastAppliedMarginFingerprintRef.current = null;
  }, [activeStreamUrl, mpvSurfaceReady, presentation]);

  const applyMarginRatio = useCallback(
    async (ratio: VideoMarginRatio, generation: number): Promise<boolean> => {
      // Stale-generation calls must return before the send records intent —
      // a deduped chase frame would poison the fingerprint for a ratio never
      // sent, and a fresh apply early-returns forever.
      if (generation !== marginGenerationRef.current) return false;
      const sent = await sendMarginRatio(lastAppliedMarginFingerprintRef, ratio);
      // Recorded only after a verified send at the current generation — the
      // dock FLIP treats it as the rect the surface actually painted.
      if (!sent || generation !== marginGenerationRef.current) return false;
      lastAppliedRatioRef.current = ratio;
      return true;
    },
    [],
  );

  const applyVideoMargins = useCallback(
    async (generation: number): Promise<boolean> => {
      const containerRect = playerContainerRef.current?.getBoundingClientRect();
      if (!containerRect || containerRect.width <= 0 || containerRect.height <= 0) {
        return false;
      }

      const shouldReserveOverlayChrome = isLoading || isResolving;
      const shouldCollapseVideoSurface = showStreamSelector || showErrorOverlay;
      const topChromeRect = topChromeRef.current?.getBoundingClientRect();
      const bottomChromeRect = bottomChromeRef.current?.getBoundingClientRect();

      if (generation !== marginGenerationRef.current) return false;

      if (shouldCollapseVideoSurface) {
        return applyMarginRatio(
          buildVideoMarginRatio(containerRect.width, containerRect.height, {
            leftPx: 0,
            rightPx: Math.max(0, containerRect.width - 16),
            topPx: 0,
            bottomPx: Math.max(0, containerRect.height - 16),
          }),
          generation,
        );
      }

      const baseTopInsetPx = !isFullscreen ? PLAYER_TITLEBAR_HEIGHT_PX : 0;
      const topInsetPx =
        shouldReserveOverlayChrome && topChromeRect
          ? Math.max(baseTopInsetPx, topChromeRect.bottom - containerRect.top)
          : baseTopInsetPx;
      const bottomInsetPx =
        shouldReserveOverlayChrome && bottomChromeRect
          ? Math.max(0, containerRect.bottom - bottomChromeRect.top)
          : 0;
      const leftInsetPx = !isFullscreen ? PLAYER_SIDEBAR_WIDTH_PX : 0;

      const nextMargins = buildVideoMarginRatio(containerRect.width, containerRect.height, {
        leftPx: leftInsetPx,
        rightPx: 0,
        topPx: topInsetPx,
        bottomPx: bottomInsetPx,
      });

      return applyMarginRatio(nextMargins, generation);
    },
    [
      applyMarginRatio,
      bottomChromeRef,
      isFullscreen,
      isLoading,
      isResolving,
      playerContainerRef,
      showErrorOverlay,
      showStreamSelector,
      topChromeRef,
    ],
  );

  // Latest-render binding for imperative callers: a state token would
  // re-render the player tree per margin event. The write must precede every
  // effect that reads the ref.
  const marginRequestRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    marginRequestRef.current = () => {
      if (isMini || !mpvSurfaceReady || !activeStreamUrl) return;

      const generation = ++marginGenerationRef.current;
      // The expanded apply is the hole-release signal: until it lands the
      // deferred mask keeps the surface where the frame left it instead of
      // flashing black. A failed or deduped send leaves the mask for the
      // safety cap — it must not lift on an unverified paint.
      void applyVideoMargins(generation).then((applied) => {
        if (applied) releaseDeferredMiniMasks();
      });
    };
  });

  // Ref reads live inside the effect — `.current` is still null during render.
  useEffect(() => {
    if (isMini) return;
    if (typeof ResizeObserver === 'undefined') return;

    const observedElements = [
      playerContainerRef.current,
      topChromeRef.current,
      bottomChromeRef.current,
    ].filter(Boolean) as HTMLDivElement[];

    if (observedElements.length === 0) return;

    let animationFrameId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }

      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        // Imperative apply — no state bump, so a chrome resize never
        // re-renders the tree.
        marginRequestRef.current();
      });
    });

    observedElements.forEach((element) => {
      observer.observe(element);
    });

    return () => {
      observer.disconnect();
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
    };
  }, [bottomChromeRef, isMini, playerContainerRef, topChromeRef]);

  useEffect(() => {
    marginRequestRef.current();
  }, [activeStreamUrl, applyVideoMargins, isMini, mpvSurfaceReady]);

  // Stable handle for mpv reconfig triggers — routes through the ref so
  // callers get the latest gated apply.
  const requestMarginApply = useCallback(() => {
    marginRequestRef.current();
  }, []);

  // Where the expanded surface last painted, in viewport px — the mini player
  // reads it once at mount as the FLIP origin. Rebuilt from the live container
  // rect so a chrome offset keeps the origin honest.
  const getExpandedVideoRect = useCallback((): MiniVideoRect | null => {
    const ratio = lastAppliedRatioRef.current;
    const containerRect = playerContainerRef.current?.getBoundingClientRect();
    if (!ratio || !containerRect || containerRect.width <= 0 || containerRect.height <= 0) {
      return null;
    }
    const x = containerRect.left + (ratio.left ?? 0) * containerRect.width;
    const y = containerRect.top + (ratio.top ?? 0) * containerRect.height;
    const width =
      containerRect.width -
      (ratio.left ?? 0) * containerRect.width -
      (ratio.right ?? 0) * containerRect.width;
    const height =
      containerRect.height -
      (ratio.top ?? 0) * containerRect.height -
      (ratio.bottom ?? 0) * containerRect.height;
    return width > 0 && height > 0 ? { x, y, width, height } : null;
  }, [playerContainerRef]);

  return { requestMarginApply, getExpandedVideoRect };
}

export interface MiniVideoRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MINI_MASK_IMAGES = 'linear-gradient(#000 0 0), linear-gradient(#000 0 0)';
// The base layer deliberately overcovers the element: a 100% base would clip
// descendants painting outside the border box (mask coverage = alpha); only
// the second layer cuts the hole.
const MINI_MASK_BASE_SIZE = '12000px 12000px';
const MINI_MASK_BASE_POSITION = '-5000px -5000px';

const MINI_MASK_PROPERTIES = [
  '-webkit-mask-image',
  '-webkit-mask-size',
  '-webkit-mask-position',
  '-webkit-mask-repeat',
  '-webkit-mask-composite',
  'mask-image',
  'mask-size',
  'mask-position',
  'mask-repeat',
  'mask-composite',
] as const;

let maskHoleCache = new WeakMap<HTMLElement, string>();

function clearMiniMasks() {
  maskHoleCache = new WeakMap();
  for (const element of document.querySelectorAll<HTMLElement>(MINI_MASK_TARGET_SELECTOR)) {
    for (const property of MINI_MASK_PROPERTIES) {
      element.style.removeProperty(property);
    }
  }
}

function positionMiniMaskHoles(rect: MiniVideoRect) {
  const elements = Array.from(document.querySelectorAll<HTMLElement>(MINI_MASK_TARGET_SELECTOR));
  // All reads before any write — interleaved rect reads and style writes
  // thrash layout every frame a rect chase runs.
  const bounds = elements.map((element) => element.getBoundingClientRect());
  elements.forEach((element, index) => {
    const holeX = rect.x - bounds[index].left;
    const holeY = rect.y - bounds[index].top;
    const key = `${rect.width}x${rect.height}@${holeX},${holeY}`;
    if (maskHoleCache.get(element) === key) return;
    // Legacy -webkit- values first so the standard property wins where supported.
    element.style.setProperty('-webkit-mask-image', MINI_MASK_IMAGES);
    element.style.setProperty(
      '-webkit-mask-size',
      `${MINI_MASK_BASE_SIZE}, ${rect.width}px ${rect.height}px`,
    );
    element.style.setProperty(
      '-webkit-mask-position',
      `${MINI_MASK_BASE_POSITION}, ${holeX}px ${holeY}px`,
    );
    element.style.setProperty('-webkit-mask-repeat', 'no-repeat, no-repeat');
    element.style.setProperty('-webkit-mask-composite', 'xor');
    element.style.maskImage = MINI_MASK_IMAGES;
    element.style.maskSize = `${MINI_MASK_BASE_SIZE}, ${rect.width}px ${rect.height}px`;
    element.style.maskPosition = `${MINI_MASK_BASE_POSITION}, ${holeX}px ${holeY}px`;
    element.style.maskRepeat = 'no-repeat, no-repeat';
    element.style.maskComposite = 'exclude';
    maskHoleCache.set(element, key);
  });
}

// On expand the mpv margins still describe the corner rect for a frame or
// two — clearing the hole immediately would flash the app surface where the
// video was. The clear defers until the expanded apply lands (or a cap elapses).
const DEFERRED_MINI_MASK_CLEAR_MS = 400;
let deferredMiniMaskClearTimer: number | null = null;

function scheduleDeferredMiniMaskClear() {
  if (deferredMiniMaskClearTimer !== null) return;
  deferredMiniMaskClearTimer = window.setTimeout(() => {
    deferredMiniMaskClearTimer = null;
    clearMiniMasks();
  }, DEFERRED_MINI_MASK_CLEAR_MS);
}

function cancelDeferredMiniMaskClear() {
  if (deferredMiniMaskClearTimer === null) return;
  window.clearTimeout(deferredMiniMaskClearTimer);
  deferredMiniMaskClearTimer = null;
}

function releaseDeferredMiniMasks() {
  if (deferredMiniMaskClearTimer === null) return;
  cancelDeferredMiniMaskClear();
  clearMiniMasks();
}

interface UseMiniPlayerSurfaceArgs {
  enabled: boolean;
  /** Live video rect in viewport CSS pixels; driven by the mini player chrome. */
  videoRectRef: RefObject<MiniVideoRect | null>;
  /** Gate the see-through hole on a live mpv surface so it can never show the desktop. */
  surfaceReady: boolean;
  /** Evaluated whenever the hole would clear (disable, rect loss). True on the
      expand handoff so the hole outlives the mini chrome until the expanded
      apply lands; close/unmount paths return false. */
  holdHoleOnRelease?: () => boolean;
}

/**
 * While minimized the video is letterboxed into the floating rect via margins,
 * and every app-painted layer gets a matching mask hole so the mpv surface
 * shows through. The mini chrome portals outside the masked layers.
 */
export function useMiniPlayerSurface({
  enabled,
  videoRectRef,
  surfaceReady,
  holdHoleOnRelease,
}: UseMiniPlayerSurfaceArgs) {
  const marginFingerprintRef = useRef<string | null>(null);
  const holeAppliedRef = useRef(false);
  // Fingerprint of the ratio mpv verifiably paints AND the hole was cut for —
  // scroll/resize applies reuse it to reposition holes without an IPC resend.
  const holeFingerprintRef = useRef<string | null>(null);
  const holdHoleOnReleaseRef = useRef(holdHoleOnRelease);
  useEffect(() => {
    holdHoleOnReleaseRef.current = holdHoleOnRelease;
  });

  const releaseMasks = useCallback(() => {
    if (holeAppliedRef.current && (holdHoleOnReleaseRef.current?.() ?? false)) {
      scheduleDeferredMiniMaskClear();
    } else {
      clearMiniMasks();
    }
    holeAppliedRef.current = false;
    holeFingerprintRef.current = null;
  }, []);

  const applyMiniSurface = useCallback((): Promise<boolean> => {
    if (!enabled) return Promise.resolve(false);

    const rect = videoRectRef.current;
    if (!rect || !surfaceReady) {
      releaseMasks();
      marginFingerprintRef.current = null;
      holeFingerprintRef.current = null;
      return Promise.resolve(false);
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    if (viewportWidth <= 0 || viewportHeight <= 0) return Promise.resolve(false);

    const ratio = buildVideoMarginRatio(viewportWidth, viewportHeight, {
      leftPx: rect.x,
      topPx: rect.y,
      rightPx: viewportWidth - (rect.x + rect.width),
      bottomPx: viewportHeight - (rect.y + rect.height),
    });

    // The painted ratio already matches this rect — only the document-space
    // holes moved (scroll, route restore), so reposition them without an IPC.
    const fingerprint = serializeVideoMarginRatio(ratio);
    if (
      holeAppliedRef.current &&
      holeFingerprintRef.current === fingerprint &&
      marginFingerprintRef.current === fingerprint
    ) {
      positionMiniMaskHoles(rect);
      return Promise.resolve(true);
    }

    const send = sendMarginRatio(marginFingerprintRef, ratio);
    // Intent is recorded synchronously — this is the fingerprint a later send
    // supersedes; the stale-send check relies on it.
    const sentFingerprint = marginFingerprintRef.current;
    return send.then((applied) => {
      // Only a verified margin may own the see-through hole, and only while
      // this send owns the fingerprint — a reject leaves mpv at its previous
      // rect, and a stale send would cut a hole for a rect mpv no longer paints.
      if (!applied || marginFingerprintRef.current !== sentFingerprint) return false;

      // A verified apply supersedes any deferred clear left over from an expand.
      cancelDeferredMiniMaskClear();
      holeAppliedRef.current = true;
      holeFingerprintRef.current = sentFingerprint;
      positionMiniMaskHoles(rect);
      return true;
    });
  }, [enabled, releaseMasks, surfaceReady, videoRectRef]);

  // Canvas transparency is owned by the mpv lifecycle — the hole only reveals it.
  useEffect(() => {
    if (!enabled) return;

    applyMiniSurface();

    let frameId: number | null = null;
    const scheduleSync = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        applyMiniSurface();
      });
    };

    window.addEventListener('resize', scheduleSync);
    // The in-flow mask target lives in document space — inner scroll panes
    // leave the hole glued in place.
    window.addEventListener('scroll', scheduleSync, { passive: true });

    return () => {
      window.removeEventListener('resize', scheduleSync);
      window.removeEventListener('scroll', scheduleSync);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      releaseMasks();
      marginFingerprintRef.current = null;
      holeFingerprintRef.current = null;
    };
  }, [enabled, applyMiniSurface, releaseMasks]);

  return applyMiniSurface;
}
