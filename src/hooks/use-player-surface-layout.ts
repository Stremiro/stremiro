import { useCallback, type RefObject, useEffect, useRef } from 'react';
import type { VideoMarginRatio } from 'tauri-plugin-libmpv-api';
import { setMpvProperty, setVideoMarginRatio } from '@/lib/player-mpv';
import { clamp } from '@/lib/utils';

// Shared with the mini player's drag bounds so chrome resizes can't desync them.
export const PLAYER_SIDEBAR_WIDTH_PX = 60;
export const PLAYER_TITLEBAR_HEIGHT_PX = 32;
const MINI_MASK_TARGET_SELECTOR = '[data-mini-mask]';

function clampMarginRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp(value, 0, 0.98);
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

interface MarginRequest {
  fingerprint: string;
  ratio: VideoMarginRatio;
  promise: Promise<boolean>;
  resolve: (applied: boolean) => void;
  valid: boolean;
}

interface MarginSender {
  inFlight: MarginRequest;
  pending: MarginRequest | null;
}

const pendingMarginRequests = new WeakMap<RefObject<string | null>, MarginSender>();

function invalidateMarginRatio(fingerprintRef: RefObject<string | null>) {
  fingerprintRef.current = null;
  const sender = pendingMarginRequests.get(fingerprintRef);
  if (!sender) return;
  sender.inFlight.valid = false;
  sender.pending?.resolve(false);
  sender.pending = null;
}

async function flushMarginRequests(fingerprintRef: RefObject<string | null>, sender: MarginSender) {
  const request = sender.inFlight;
  let applied: boolean;
  try {
    await setVideoMarginRatio(request.ratio);
    applied = true;
  } catch {
    applied = false;
  }
  const pending = sender.pending;
  sender.pending = null;
  request.resolve(applied && request.valid);

  if (!pending) {
    pendingMarginRequests.delete(fingerprintRef);
    if (!applied && request.valid && fingerprintRef.current === request.fingerprint) {
      fingerprintRef.current = null;
    }
    return;
  }

  if (fingerprintRef.current !== pending.fingerprint) {
    pendingMarginRequests.delete(fingerprintRef);
    pending.resolve(false);
    return;
  }

  if (applied && request.valid && pending.fingerprint === request.fingerprint) {
    pendingMarginRequests.delete(fingerprintRef);
    pending.resolve(true);
    return;
  }

  sender.inFlight = pending;
  void flushMarginRequests(fingerprintRef, sender);
}

function sendMarginRatio(
  fingerprintRef: RefObject<string | null>,
  ratio: VideoMarginRatio,
  fingerprint = serializeVideoMarginRatio(ratio),
): Promise<boolean> {
  const sender = pendingMarginRequests.get(fingerprintRef);
  const latest = sender?.pending ?? sender?.inFlight;
  if (fingerprintRef.current === fingerprint) {
    return latest?.valid && latest.fingerprint === fingerprint
      ? latest.promise
      : Promise.resolve(false);
  }
  fingerprintRef.current = fingerprint;
  if (sender?.pending) {
    sender.pending.fingerprint = fingerprint;
    sender.pending.ratio = ratio;
    return sender.pending.promise;
  }

  let resolve!: (applied: boolean) => void;
  const promise = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  const request: MarginRequest = { fingerprint, ratio, promise, resolve, valid: true };
  if (sender) {
    sender.pending = request;
  } else {
    const nextSender: MarginSender = { inFlight: request, pending: null };
    pendingMarginRequests.set(fingerprintRef, nextSender);
    void flushMarginRequests(fingerprintRef, nextSender);
  }
  return promise;
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
  isPip?: boolean;
  isLoading: boolean;
  isResolving: boolean;
  showErrorOverlay: boolean;
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
  isPip,
  isLoading,
  isResolving,
  showErrorOverlay,
  presentation,
}: UsePlayerSurfaceLayoutArgs) {
  const lastAppliedMarginFingerprintRef = useRef<string | null>(null);
  // Last ratio actually sent — the mini dock FLIP's origin; kept across
  // presentation flips so the mini mount reads where the video visibly was.
  const lastAppliedRatioRef = useRef<VideoMarginRatio | null>(null);
  // Stale async applies must never overwrite a newer computation.
  const marginGenerationRef = useRef(0);
  const isMini = presentation === 'mini';
  const shouldReserveOverlayChrome = !isPip && (isLoading || isResolving);
  useEffect(() => {
    if (!mpvSurfaceReady || !activeStreamUrl) return;
    // Margins shrink video, not subtitle text; keep the track and saved tuning intact.
    void setMpvProperty('sub-visibility', !isMini).catch(() => undefined);
  }, [activeStreamUrl, isMini, mpvSurfaceReady]);

  const applyMarginRatio = useCallback(
    async (ratio: VideoMarginRatio, generation: number): Promise<boolean> => {
      // Stale-generation calls must return before the send records intent —
      // a deduped chase frame would poison the fingerprint for a ratio never sent.
      if (generation !== marginGenerationRef.current) return false;
      const sent = await sendMarginRatio(lastAppliedMarginFingerprintRef, ratio);
      // Record only after a verified send — the dock FLIP treats it as the
      // rect the surface actually painted.
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

      if (generation !== marginGenerationRef.current) return false;

      // The stream selector deliberately keeps the frame painted; only the
      // error overlay collapses the surface.
      if (showErrorOverlay) {
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

      const topChromeRect = shouldReserveOverlayChrome
        ? topChromeRef.current?.getBoundingClientRect()
        : undefined;
      const bottomChromeRect = shouldReserveOverlayChrome
        ? bottomChromeRef.current?.getBoundingClientRect()
        : undefined;
      const baseTopInsetPx = !isFullscreen && !isPip ? PLAYER_TITLEBAR_HEIGHT_PX : 0;
      const topInsetPx = topChromeRect
        ? Math.max(baseTopInsetPx, topChromeRect.bottom - containerRect.top)
        : baseTopInsetPx;
      const bottomInsetPx = bottomChromeRect
        ? Math.max(0, containerRect.bottom - bottomChromeRect.top)
        : 0;
      const leftInsetPx = !isFullscreen && !isPip ? PLAYER_SIDEBAR_WIDTH_PX : 0;

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
      isPip,
      playerContainerRef,
      showErrorOverlay,
      shouldReserveOverlayChrome,
      topChromeRef,
    ],
  );

  // Latest-render binding for imperative callers; a state token would re-render
  // the player tree per margin event. Write precedes every effect that reads it.
  const marginRequestRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    marginRequestRef.current = () => {
      if (isMini || !mpvSurfaceReady || !activeStreamUrl) return;

      const generation = ++marginGenerationRef.current;
      // The expanded apply is the hole-release signal: until it lands the
      // deferred mask keeps the surface where the frame left it. A failed or
      // deduped send must not lift the mask on an unverified paint.
      void applyVideoMargins(generation).then((applied) => {
        if (applied && generation === marginGenerationRef.current) releaseDeferredMiniMasks();
      });
    };
  });

  // Ref reads live inside the effect — `.current` is still null during render.
  useEffect(() => {
    if (isMini) return;
    if (typeof ResizeObserver === 'undefined') return;

    const container = playerContainerRef.current;
    const topChrome = shouldReserveOverlayChrome ? topChromeRef.current : null;
    const bottomChrome = shouldReserveOverlayChrome ? bottomChromeRef.current : null;

    if (!container && !topChrome && !bottomChrome) return;

    let animationFrameId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }

      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        // Imperative apply — a chrome resize never re-renders the tree.
        marginRequestRef.current();
      });
    });

    if (container) observer.observe(container);
    if (topChrome) observer.observe(topChrome);
    if (bottomChrome) observer.observe(bottomChrome);

    return () => {
      observer.disconnect();
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
    };
    // PiP unmounts the chrome; returning mounts new nodes behind the same refs.
  }, [
    bottomChromeRef,
    isMini,
    isPip,
    playerContainerRef,
    shouldReserveOverlayChrome,
    topChromeRef,
  ]);

  useEffect(() => {
    marginRequestRef.current();
    return () => {
      marginGenerationRef.current += 1;
      invalidateMarginRatio(lastAppliedMarginFingerprintRef);
    };
  }, [activeStreamUrl, applyVideoMargins, isMini, mpvSurfaceReady]);

  // Stable handle for mpv reconfig triggers; routes to the latest gated apply.
  const requestMarginApply = () => {
    marginRequestRef.current();
  };

  // Where the expanded surface last painted — the mini player's FLIP origin,
  // rebuilt from the live container rect.
  const getExpandedVideoRect = (): MiniVideoRect | null => {
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
  };

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
// descendants painting outside the border box; only the second layer cuts the hole.
const MINI_MASK_BASE_SIZE = 'calc(100% + 10000px) calc(100% + 10000px)';
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
  // All reads before any write — interleaving thrashes layout per chased frame.
  const bounds = elements.map((element) => element.getBoundingClientRect());
  elements.forEach((element, index) => {
    const holeX = rect.x - bounds[index].left;
    const holeY = rect.y - bounds[index].top;
    const key = `${rect.width}x${rect.height}@${holeX},${holeY}`;
    const previousKey = maskHoleCache.get(element);
    if (previousKey === key) return;
    // Legacy -webkit- values first so the standard property wins where supported.
    if (previousKey === undefined) {
      element.style.setProperty('-webkit-mask-image', MINI_MASK_IMAGES);
      element.style.setProperty('-webkit-mask-repeat', 'no-repeat, no-repeat');
      element.style.setProperty('-webkit-mask-composite', 'xor');
      element.style.maskImage = MINI_MASK_IMAGES;
      element.style.maskRepeat = 'no-repeat, no-repeat';
      element.style.maskComposite = 'exclude';
    }
    element.style.setProperty(
      '-webkit-mask-size',
      `${MINI_MASK_BASE_SIZE}, ${rect.width}px ${rect.height}px`,
    );
    element.style.setProperty(
      '-webkit-mask-position',
      `${MINI_MASK_BASE_POSITION}, ${holeX}px ${holeY}px`,
    );
    element.style.maskSize = `${MINI_MASK_BASE_SIZE}, ${rect.width}px ${rect.height}px`;
    element.style.maskPosition = `${MINI_MASK_BASE_POSITION}, ${holeX}px ${holeY}px`;
    maskHoleCache.set(element, key);
  });
}

// On expand, mpv margins still describe the corner rect for a frame or two —
// clearing immediately would flash app surface. Clear defers until the
// expanded apply lands or the cap elapses.
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
  /** True on the expand handoff so the hole outlives the mini chrome until the
      expanded apply lands; close/unmount paths return false. */
  holdHoleOnRelease?: () => boolean;
}

/**
 * While minimized, the video is letterboxed into the floating rect via margins
 * and app-painted layers get a matching mask hole so mpv shows through.
 */
export function useMiniPlayerSurface({
  enabled,
  videoRectRef,
  surfaceReady,
  holdHoleOnRelease,
}: UseMiniPlayerSurfaceArgs) {
  const marginFingerprintRef = useRef<string | null>(null);
  const marginApplyGenerationRef = useRef(0);
  const holeAppliedRef = useRef(false);
  // Ratio mpv verifiably paints AND the hole was cut for — scroll/resize
  // applies reuse it to reposition holes without an IPC resend.
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
      invalidateMarginRatio(marginFingerprintRef);
      return Promise.resolve(false);
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    if (viewportWidth <= 0 || viewportHeight <= 0) return Promise.resolve(false);

    const generation = ++marginApplyGenerationRef.current;
    const ratio = buildVideoMarginRatio(viewportWidth, viewportHeight, {
      leftPx: rect.x,
      topPx: rect.y,
      rightPx: viewportWidth - (rect.x + rect.width),
      bottomPx: viewportHeight - (rect.y + rect.height),
    });

    // Painted ratio already matches — only the document-space holes moved
    // (scroll, route restore), so reposition without an IPC.
    const fingerprint = serializeVideoMarginRatio(ratio);
    if (
      holeAppliedRef.current &&
      holeFingerprintRef.current === fingerprint &&
      marginFingerprintRef.current === fingerprint
    ) {
      positionMiniMaskHoles(rect);
      return Promise.resolve(true);
    }

    // The send records `fingerprint` as intent synchronously — the stale-send
    // check below relies on that.
    holeFingerprintRef.current = null;
    return sendMarginRatio(marginFingerprintRef, ratio, fingerprint).then((applied) => {
      // Only a verified margin may own the hole: a reject leaves mpv at its
      // previous rect, a stale send would cut a hole for a rect mpv no longer paints.
      if (
        !applied ||
        generation !== marginApplyGenerationRef.current ||
        marginFingerprintRef.current !== fingerprint
      )
        return false;

      // A verified apply supersedes any deferred clear left over from an expand.
      cancelDeferredMiniMaskClear();
      holeAppliedRef.current = true;
      holeFingerprintRef.current = fingerprint;
      positionMiniMaskHoles(rect);
      return true;
    });
  }, [enabled, releaseMasks, surfaceReady, videoRectRef]);

  // Canvas transparency is owned by the mpv lifecycle — the hole only reveals it.
  useEffect(() => {
    if (!enabled) return;

    void applyMiniSurface();

    let frameId: number | null = null;
    const scheduleSync = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        void applyMiniSurface();
      });
    };

    window.addEventListener('resize', scheduleSync);
    // The mask target lives in document space — inner scroll panes move it.
    window.addEventListener('scroll', scheduleSync, { passive: true });

    return () => {
      marginApplyGenerationRef.current += 1;
      window.removeEventListener('resize', scheduleSync);
      window.removeEventListener('scroll', scheduleSync);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      releaseMasks();
      invalidateMarginRatio(marginFingerprintRef);
    };
  }, [enabled, applyMiniSurface, releaseMasks]);

  return applyMiniSurface;
}
