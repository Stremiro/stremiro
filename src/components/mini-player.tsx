import {
  FastForward,
  Loader2,
  Maximize2,
  Move,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  TriangleAlert,
  VolumeX,
  X,
} from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { PlayerSlider } from '@/components/player-slider';
import { PlayerEndCard } from '@/components/player-state-overlays';
import { PlayerVolumeIcon } from '@/components/player-volume-icon';
import { RemoteImage } from '@/components/remote-image';
import {
  PLAYER_SIDEBAR_WIDTH_PX,
  PLAYER_TITLEBAR_HEIGHT_PX,
  type MiniVideoRect,
} from '@/hooks/use-player-surface-layout';
import { isEditableTarget } from '@/lib/dom';
import type { PlaybackClock } from '@/lib/player-clock';
import { createSubscribableStore, type SubscribableStore } from '@/lib/subscribable-store';
import type { MiniPlayerPosition } from '@/lib/player-session';
import { clamp, clearTimer, cn, formatTime, prefersReducedMotion } from '@/lib/utils';

const MINI_MIN_WIDTH_PX = 300;
const MINI_MAX_WIDTH_PX = 420;
const MINI_WIDTH_RATIO = 0.26;
const MINI_BEZEL_PX = 3;
const MINI_EDGE_PAD_PX = 14;
// Bounds derive from shared chrome constants so a rail/titlebar resize can't desync drag bounds from margin math.
const MINI_LEFT_BOUND_PX = PLAYER_SIDEBAR_WIDTH_PX + 8;
const MINI_TOP_BOUND_PX = PLAYER_TITLEBAR_HEIGHT_PX + 4;
const DRAG_CLICK_TOLERANCE_PX = 6;
// Two video taps inside this window expand — pointer capture retargets dblclick, so pairing happens on pointer-up.
const DOUBLE_TAP_MS = 320;
const SNAP_RADIUS_PX = 150;
const SNAP_DURATION_MS = 200;
const FLASH_DURATION_MS = 550;
// Dock entrance FLIP — same duration as the decorative keyframe it replaces.
const DOCK_FLIP_MS = 260;
const DOCK_FLIP_EASING = 'cubic-bezier(0.33, 1, 0.68, 1)';
// The margin IPC lands a frame or two after the last rect report; the cover stays up so the surface is never seen chasing.
const SURFACE_SETTLE_MS = 180;

// Discrete actions ignore auto-repeat; arrows keep repeating.
const MINI_NON_REPEAT_KEYS = new Set([' ', 'enter', 'escape', 'f', 'm', 'n', 'i', 's', 'k']);

interface MiniPlayerMetrics {
  frameWidth: number;
  videoHeight: number;
}

function computeMiniMetrics(): MiniPlayerMetrics {
  const frameWidth = Math.round(
    clamp(window.innerWidth * MINI_WIDTH_RATIO, MINI_MIN_WIDTH_PX, MINI_MAX_WIDTH_PX),
  );
  return { frameWidth, videoHeight: Math.round((frameWidth * 9) / 16) };
}

function getMiniBounds(metrics: MiniPlayerMetrics): { maxX: number; maxY: number } {
  return {
    maxX: Math.max(MINI_LEFT_BOUND_PX, window.innerWidth - metrics.frameWidth - MINI_EDGE_PAD_PX),
    maxY: Math.max(MINI_TOP_BOUND_PX, window.innerHeight - metrics.videoHeight - MINI_EDGE_PAD_PX),
  };
}

function clampMiniPosition(
  position: MiniPlayerPosition,
  metrics: MiniPlayerMetrics,
): MiniPlayerPosition {
  const { maxX, maxY } = getMiniBounds(metrics);
  return {
    x: clamp(position.x, MINI_LEFT_BOUND_PX, maxX),
    y: clamp(position.y, MINI_TOP_BOUND_PX, maxY),
  };
}

function snapAnchors(metrics: MiniPlayerMetrics): MiniPlayerPosition[] {
  const { maxX, maxY } = getMiniBounds(metrics);
  return [
    { x: MINI_LEFT_BOUND_PX, y: MINI_TOP_BOUND_PX },
    { x: maxX, y: MINI_TOP_BOUND_PX },
    { x: MINI_LEFT_BOUND_PX, y: maxY },
    { x: maxX, y: maxY },
  ];
}

function defaultMiniPosition(metrics: MiniPlayerMetrics): MiniPlayerPosition {
  return snapAnchors(metrics)[3];
}

function fitRectToAspect(rect: MiniVideoRect, aspect: number): MiniVideoRect {
  const width = Math.min(rect.width, rect.height * aspect);
  const height = width / aspect;
  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height,
  };
}

// Shared ease for snap glides and the dock FLIP — fast start, soft landing.
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

const MINI_ICON_BUTTON_CLASS =
  'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-white/85 transition-colors hover:bg-white/15 hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60';

// Expand/close render twice (hover chrome + error/empty overlay), so the buttons live here once.
function MiniExpandButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type='button'
      aria-label='Back to player'
      aria-keyshortcuts='f'
      title='Back to player (F)'
      onClick={onClick}
      className={MINI_ICON_BUTTON_CLASS}
    >
      <Maximize2 className='h-3.5 w-3.5' strokeWidth={2.25} />
    </button>
  );
}

// Dragging is pointer-only — this button is the keyboard path; each press glides to the next corner.
function MiniSnapButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type='button'
      aria-label='Move mini player to another corner'
      title='Move to another corner'
      onClick={onClick}
      className={MINI_ICON_BUTTON_CLASS}
    >
      <Move className='h-3.5 w-3.5' strokeWidth={2.25} />
    </button>
  );
}

function MiniCloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type='button'
      aria-label='Close mini player'
      title='Close'
      onClick={onClick}
      className={cn(MINI_ICON_BUTTON_CLASS, 'hover:bg-red-500/25 hover:text-red-200')}
    >
      <X className='h-3.5 w-3.5' strokeWidth={2.25} />
    </button>
  );
}

// Title + episode suffix — the motion cover, hover chrome, and status overlay each tint it differently.
function MiniTitle({ title, episodeLabel }: { title: string; episodeLabel?: string }) {
  return (
    <>
      {title}
      {episodeLabel && <span className='font-normal opacity-60'> · {episodeLabel}</span>}
    </>
  );
}

// -- Tick leaves: the only clock/seek-preview subscribers — a ~3 Hz tick or drag re-renders a leaf, not the chrome tree.

/** Scrub-preview store scoped to the mini player — a drag never re-renders the portal root. */
type SeekPreviewStore = SubscribableStore<number | null>;
const subscribeWhileHidden = () => () => {};

function useMiniDisplayTime(
  clock: PlaybackClock,
  duration: number,
  seekPreviewStore: SeekPreviewStore,
  active = true,
): number {
  const seekPreview = useSyncExternalStore(
    seekPreviewStore.subscribe,
    seekPreviewStore.getSnapshot,
  );
  const currentTime = useSyncExternalStore(
    active || seekPreview !== null ? clock.subscribe : subscribeWhileHidden,
    clock.getSnapshot,
  );
  return Math.min(seekPreview ?? currentTime, duration > 0 ? duration : currentTime);
}

interface MiniPlayerTickProps {
  active?: boolean;
  clock: PlaybackClock;
  duration: number;
  seekPreviewStore: SeekPreviewStore;
}

const MiniPlayerHairline = memo(function MiniPlayerHairline({
  clock,
  duration,
  seekPreviewStore,
}: MiniPlayerTickProps) {
  const displayTime = useMiniDisplayTime(clock, duration, seekPreviewStore);
  const progressPct = duration > 0 ? clamp((displayTime / duration) * 100, 0, 100) : 0;
  return (
    <div className='pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[2px] bg-white/[0.08]'>
      <div
        className='h-full origin-left bg-white/75'
        style={{ transform: `scaleX(${progressPct / 100})` }}
      />
    </div>
  );
});

const MiniPlayerTimeLabel = memo(function MiniPlayerTimeLabel({
  active,
  clock,
  duration,
  seekPreviewStore,
}: MiniPlayerTickProps) {
  const displayTime = useMiniDisplayTime(clock, duration, seekPreviewStore, active);
  return (
    <span className='shrink-0 text-[11px] tabular-nums text-white/80'>
      {formatTime(displayTime)}
      {duration > 0 && <span className='text-white/55'> / {formatTime(duration)}</span>}
    </span>
  );
});

interface MiniPlayerSeekSliderProps extends MiniPlayerTickProps {
  onSeek: (seconds: number) => void;
}

const MiniPlayerSeekSlider = memo(function MiniPlayerSeekSlider({
  active,
  clock,
  duration,
  seekPreviewStore,
  onSeek,
}: MiniPlayerSeekSliderProps) {
  const displayTime = useMiniDisplayTime(clock, duration, seekPreviewStore, active);
  return (
    <PlayerSlider
      variant='track'
      aria-label='Seek'
      value={[Math.max(0, displayTime)]}
      max={Math.max(duration, 1)}
      step={0.5}
      aria-valuetext={`${formatTime(displayTime)} of ${formatTime(duration)}`}
      disabled={duration <= 0}
      onValueChange={(value) => seekPreviewStore.publish(value[0] ?? null)}
      onValueCommit={(value) => {
        const target = value[0];
        seekPreviewStore.publish(null);
        if (typeof target === 'number') onSeek(target);
      }}
      onPointerUp={() => seekPreviewStore.publish(null)}
      onPointerCancel={() => seekPreviewStore.publish(null)}
      className='h-6 w-full'
    />
  );
});

interface MiniPlayerProps {
  title: string;
  episodeLabel?: string;
  backdrop?: string;
  isPlaying: boolean;
  isWorking: boolean;
  statusText?: string;
  error?: string | null;
  /** Playback clock — the mini player is a tick subscriber; the tree isn't. */
  clock: PlaybackClock;
  duration: number;
  canGoNext: boolean;
  hasVideo: boolean;
  isMuted: boolean;
  /** 0–100 master volume; mirrors the expanded player's slider. */
  volume: number;
  /** EOF offer: stream ended and a next episode exists — a docked player isn't a dead end. */
  upNext?: { label: string };
  /** EOF with no next episode (movies, finales): replay/back strip over the frozen frame. */
  endOfMedia?: boolean;
  /** Active skip-segment CTA — `s` fires it from the focused surface. */
  skipAction?: { label: string; onSkip: () => void } | null;
  /** Rendered one extra beat after expand so the chrome dissolves out — inert while it plays. */
  exiting?: boolean;
  initialPosition?: MiniPlayerPosition | null;
  /** Expanded surface rect at dock time — the frame FLIPs from it into the docked corner. */
  dockOrigin?: MiniVideoRect | null;
  /** True only on the expanded→mini transition: keyboard minimize orphans focus on unmounted chrome, so the fresh dock claims it. */
  claimFocusOnMount?: boolean;
  onVideoRectChange: (rect: MiniVideoRect | null) => Promise<boolean> | void;
  onPositionChange: (position: MiniPlayerPosition) => void;
  onTogglePlay: () => void;
  onToggleMute: () => void;
  onVolumeChange: (volume: number) => void;
  /** Relative wheel/key nudges — the parent owns the live volume ref. */
  onVolumeStep: (delta: number) => void;
  onSeek: (seconds: number) => void;
  onSeekRelative: (deltaSeconds: number) => void;
  onExpand: () => void;
  onClose: () => void;
  onNextEpisode: () => void;
  onReplay: () => void;
  onBackToTitle: () => void;
}

export const MiniPlayer = memo(function MiniPlayer({
  title,
  episodeLabel,
  backdrop,
  isPlaying,
  isWorking,
  statusText,
  error,
  clock,
  duration,
  canGoNext,
  hasVideo,
  isMuted,
  volume,
  upNext,
  endOfMedia = false,
  skipAction,
  exiting = false,
  initialPosition,
  dockOrigin,
  claimFocusOnMount = false,
  onVideoRectChange,
  onPositionChange,
  onTogglePlay,
  onToggleMute,
  onVolumeChange,
  onVolumeStep,
  onSeek,
  onSeekRelative,
  onExpand,
  onClose,
  onNextEpisode,
  onReplay,
  onBackToTitle,
}: MiniPlayerProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const videoSurfaceRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusClaimRef = useRef(claimFocusOnMount);
  const [hovered, setHovered] = useState(false);
  const [hasFocus, setHasFocus] = useState(false);
  const positionRef = useRef<MiniPlayerPosition | null>(null);
  const [metrics, setMetrics] = useState<MiniPlayerMetrics>(computeMiniMetrics);
  if (positionRef.current === null) {
    // A saved position can outlive its viewport — clamp at init; the mount re-clamp runs a frame too late.
    positionRef.current = clampMiniPosition(
      initialPosition ?? defaultMiniPosition(metrics),
      metrics,
    );
  }
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
    videoClick: boolean;
  } | null>(null);
  const reportFrameRef = useRef<number | null>(null);
  const snapFrameRef = useRef<number | null>(null);
  // External store, not state — per-pointermove publishes reach only the tick leaves.
  const seekPreviewStore = useMemo(() => createSubscribableStore<number | null>(null), []);
  const [isMoving, setIsMoving] = useState(false);
  // Mount veiled when a live surface exists — the mask hole beats the first margin IPC, and an uncovered gap
  // shows a wrong-cropped slice. The exiting instance dissolves over live video — never veiled.
  const [isSettling, setIsSettling] = useState(hasVideo && !exiting);
  // One-shot dock entrance: FLIP the frame from the expanded rect so the surface doesn't visibly teleport later;
  // reduced-motion/videoless mounts use the plain keyframe.
  const [dockFlipFrom] = useState<MiniVideoRect | null>(() => {
    if (exiting || !hasVideo || !dockOrigin || prefersReducedMotion()) return null;
    // A collapsed-surface margin (overlays shrink it to a sliver) is not a valid FLIP source.
    const fitted = fitRectToAspect(dockOrigin, metrics.frameWidth / metrics.videoHeight);
    return fitted.width > metrics.frameWidth ? fitted : null;
  });
  const [isDocking, setIsDocking] = useState(dockFlipFrom !== null);
  const [snapTargetIndex, setSnapTargetIndex] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ kind: 'play' | 'pause'; id: number } | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const flashIdRef = useRef(0);
  // Toggle intent for the flash icon — the prop can't keep up inside the double-tap window.
  const flashKindRef = useRef<'play' | 'pause' | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const landingRef = useRef(false);
  const lastVideoTapAtRef = useRef(0);
  const renderPosition = positionRef.current;
  const anchors = useMemo(() => snapAnchors(metrics), [metrics]);

  // The reported hole is the video's content box (frame minus bezel); the painted border covers the rim and square corners.
  const reportVideoRect = useCallback(() => {
    const position = positionRef.current;
    if (!position) return;
    return onVideoRectChange({
      x: position.x + MINI_BEZEL_PX,
      y: position.y + MINI_BEZEL_PX,
      width: metrics.frameWidth - MINI_BEZEL_PX * 2,
      height: metrics.videoHeight - MINI_BEZEL_PX * 2,
    });
  }, [metrics.frameWidth, metrics.videoHeight, onVideoRectChange]);

  const scheduleVideoRectReport = useCallback(() => {
    if (reportFrameRef.current !== null) return;
    reportFrameRef.current = window.requestAnimationFrame(() => {
      reportFrameRef.current = null;
      reportVideoRect();
    });
  }, [reportVideoRect]);

  const cancelSnap = useCallback(() => {
    if (snapFrameRef.current !== null) {
      window.cancelAnimationFrame(snapFrameRef.current);
      snapFrameRef.current = null;
    }
  }, []);

  const applyPosition = useCallback(
    (position: MiniPlayerPosition) => {
      const next = clampMiniPosition(position, metrics);
      positionRef.current = next;
      if (frameRef.current) {
        frameRef.current.style.transform = `translate3d(${Math.round(next.x)}px, ${Math.round(next.y)}px, 0)`;
      }
      return next;
    },
    [metrics],
  );

  // Drop the motion cover only after the last margin IPC lands — earlier reveals the surface mid-chase.
  const startSurfaceSettle = useCallback(() => {
    setIsSettling(true);
    clearTimer(settleTimerRef);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      setIsSettling(false);
    }, SURFACE_SETTLE_MS);
  }, []);

  const endMotion = useCallback(() => {
    setIsMoving(false);
    startSurfaceSettle();
  }, [startSurfaceSettle]);

  // Resize aborts the dock FLIP (render path snaps back); dependency-free so it fits the mount effect's dep list.
  const cancelDockFlip = useCallback(() => {
    setIsDocking(false);
  }, []);

  // Click-to-toggle fires immediately; a double-click toggles twice (net: unchanged) before expand lands.
  const triggerPlaybackFlash = useCallback(() => {
    // Icon shows requested state, not mpv's — a second tap inside the double-tap window beats the pause
    // round-trip, so intent alternates off the last icon shown.
    const kind =
      flashKindRef.current === null
        ? isPlaying
          ? 'pause'
          : 'play'
        : flashKindRef.current === 'pause'
          ? 'play'
          : 'pause';
    flashKindRef.current = kind;
    flashIdRef.current += 1;
    setFlash({ kind, id: flashIdRef.current });
    clearTimer(flashTimerRef);
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      setFlash(null);
    }, FLASH_DURATION_MS);
  }, [isPlaying]);

  // mpv's state beats tracked intent: once the echo lands, the next tap seeds from the real prop again.
  useEffect(() => {
    flashKindRef.current = null;
  }, [isPlaying]);

  // Eased glide to a snap anchor — each frame re-reports the rect so mpv tracks the motion; reduced-motion skips it (CSS can't reach rAF).
  const animateTo = useCallback(
    (target: MiniPlayerPosition) => {
      cancelSnap();
      const start = positionRef.current;
      if (!start) return;
      if (prefersReducedMotion()) {
        const landed = applyPosition(target);
        reportVideoRect();
        endMotion();
        onPositionChange(landed);
        return;
      }
      const startTime = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - startTime) / SNAP_DURATION_MS);
        const eased = easeOutCubic(t);
        applyPosition({
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
        });
        scheduleVideoRectReport();
        if (t < 1) {
          snapFrameRef.current = window.requestAnimationFrame(step);
        } else {
          snapFrameRef.current = null;
          endMotion();
          if (positionRef.current) onPositionChange(positionRef.current);
        }
      };
      snapFrameRef.current = window.requestAnimationFrame(step);
    },
    [
      applyPosition,
      cancelSnap,
      endMotion,
      onPositionChange,
      reportVideoRect,
      scheduleVideoRectReport,
    ],
  );

  // Callback churn must not restart the dock flight.
  const rectOpsRef = useRef({ reportVideoRect, onVideoRectChange });
  useEffect(() => {
    rectOpsRef.current = { reportVideoRect, onVideoRectChange };
  });

  // The dock flight owns geometry until landing.
  useEffect(() => {
    if (isDocking) return;
    if (positionRef.current) {
      onPositionChange(applyPosition(positionRef.current));
    }
    reportVideoRect();
  }, [applyPosition, reportVideoRect, isDocking, onPositionChange]);

  // Dock entrance: a WAAPI flight scales the frame from the expanded rect — no per-frame rect reports or margin
  // IPC. The motion cover hides the interior until the landing hole is verified.
  useLayoutEffect(() => {
    if (!isDocking || !dockFlipFrom) return;
    const frame = frameRef.current;
    const target = positionRef.current;
    if (!frame || !target) {
      setIsDocking(false);
      return;
    }
    const scale = dockFlipFrom.width / metrics.frameWidth;
    const animation = frame.animate(
      [
        {
          transform: `translate3d(${dockFlipFrom.x}px, ${dockFlipFrom.y}px, 0) scale(${scale})`,
        },
        {
          transform: `translate3d(${Math.round(target.x)}px, ${Math.round(target.y)}px, 0)`,
        },
      ],
      { duration: DOCK_FLIP_MS, easing: DOCK_FLIP_EASING, fill: 'forwards' },
    );
    let active = true;
    animation.finished.then(
      () => {
        if (!active) return;
        applyPosition(target);
        animation.cancel();
        landingRef.current = true;
        onPositionChange(target);
        setIsDocking(false);
        void Promise.resolve(rectOpsRef.current.reportVideoRect()).then((holeReady) => {
          if (holeReady === true) {
            clearTimer(settleTimerRef);
            setIsSettling(false);
          } else {
            startSurfaceSettle();
          }
        });
      },
      () => undefined,
    );
    return () => {
      active = false;
      animation.cancel();
    };
  }, [isDocking, dockFlipFrom, metrics, applyPosition, onPositionChange, startSurfaceSettle]);

  // Retain the mount-only claim through parent updates during docking.
  useEffect(() => {
    if (exiting || !pendingFocusClaimRef.current || isDocking) return;
    pendingFocusClaimRef.current = false;
    const active = document.activeElement;
    if (active === document.body || active === document.documentElement || active === null) {
      videoSurfaceRef.current?.focus({ preventScroll: true });
    }
  }, [exiting, isDocking]);

  // A live surface or resize starts a margin chase — cover until margins settle; the dock FLIP holds its own
  // cover and the exiting instance never veils.
  useEffect(() => {
    // A just-landed FLIP owns its reveal via hole verification — arming the fixed cover would only extend it.
    if (landingRef.current) {
      landingRef.current = false;
      return;
    }
    if (hasVideo && !isDocking && !exiting) startSurfaceSettle();
  }, [hasVideo, startSurfaceSettle, isDocking, exiting]);

  useEffect(() => {
    const handleResize = () => {
      // Stop old-geometry frames before the new metrics clamp/report.
      cancelSnap();
      if (reportFrameRef.current !== null) {
        window.cancelAnimationFrame(reportFrameRef.current);
        reportFrameRef.current = null;
      }
      if (!dragStateRef.current) setIsMoving(false);
      setSnapTargetIndex(null);
      cancelDockFlip();
      setMetrics(computeMiniMetrics());
      startSurfaceSettle();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [cancelDockFlip, cancelSnap, startSurfaceSettle]);

  // Unmount-only teardown — a rebuilt `onVideoRectChange` mid-life would kill an in-flight snap.
  useEffect(() => {
    return () => {
      if (reportFrameRef.current !== null) {
        window.cancelAnimationFrame(reportFrameRef.current);
        reportFrameRef.current = null;
      }
      cancelSnap();
      clearTimer(flashTimerRef);
      clearTimer(settleTimerRef);
      rectOpsRef.current.onVideoRectChange(null);
    };
  }, [cancelSnap]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !event.isPrimary || dragStateRef.current !== null) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('button, a, input, [role="slider"]')) return;

      const position = positionRef.current;
      if (!position || !frameRef.current) return;

      cancelSnap();
      frameRef.current.setPointerCapture(event.pointerId);
      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: position.x,
        originY: position.y,
        moved: false,
        videoClick: !!target.closest('[data-mini-video]'),
      };
    },
    [cancelSnap],
  );

  // Keyboard path to moving: hop to the next corner with the same eased glide and cover a drag-snap produces.
  const snapToNextAnchor = useCallback(() => {
    const position = positionRef.current;
    if (!position || anchors.length === 0) return;
    // Nearest corner without the drag magnet's radius cap — the cycle must advance from a free-floating position.
    let nearest = 0;
    let bestDistance = Infinity;
    anchors.forEach((anchor, index) => {
      const distance = Math.hypot(anchor.x - position.x, anchor.y - position.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        nearest = index;
      }
    });
    setIsMoving(true);
    animateTo(anchors[(nearest + 1) % anchors.length] as MiniPlayerPosition);
  }, [anchors, animateTo]);

  // Nearest snap anchor within the magnet radius — drives the release glide and the drag ghost outline.
  const findSnapAnchorIndex = useCallback(
    (position: MiniPlayerPosition): number | null => {
      let bestIndex: number | null = null;
      let bestDistance = SNAP_RADIUS_PX;
      anchors.forEach((anchor, index) => {
        const distance = Math.hypot(anchor.x - position.x, anchor.y - position.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      return bestIndex;
    },
    [anchors],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(deltaX, deltaY) < DRAG_CLICK_TOLERANCE_PX) return;

      drag.moved = true;
      setIsMoving(true);
      applyPosition({ x: drag.originX + deltaX, y: drag.originY + deltaY });
      const live = positionRef.current;
      setSnapTargetIndex(live ? findSnapAnchorIndex(live) : null);
      scheduleVideoRectReport();
    },
    [applyPosition, findSnapAnchorIndex, scheduleVideoRectReport],
  );

  // Ends the drag this pointer owns; null when it isn't the tracked pointer.
  const releaseDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return null;
    dragStateRef.current = null;
    setSnapTargetIndex(null);
    if (frameRef.current?.hasPointerCapture(event.pointerId)) {
      frameRef.current.releasePointerCapture(event.pointerId);
    }
    return drag;
  }, []);

  const finishDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = releaseDrag(event);
      if (!drag) return;
      reportVideoRect();

      const position = positionRef.current;
      if (position) {
        if (drag.moved) {
          // Magnetic corner snap: release near a corner and the frame glides in.
          const anchorIndex = findSnapAnchorIndex(position);
          if (anchorIndex !== null) {
            animateTo(anchors[anchorIndex]);
          } else {
            endMotion();
            onPositionChange(position);
          }
        } else {
          setIsMoving(false);
          onPositionChange(position);
          if (drag.videoClick) {
            // A second tap inside the window is a double-click: undo the first tap's toggle (net-zero) and expand.
            const now = performance.now();
            const isDoubleTap = now - lastVideoTapAtRef.current < DOUBLE_TAP_MS;
            lastVideoTapAtRef.current = isDoubleTap ? 0 : now;
            triggerPlaybackFlash();
            onTogglePlay();
            if (isDoubleTap) onExpand();
          }
        }
      } else {
        setIsMoving(false);
      }
    },
    [
      anchors,
      animateTo,
      endMotion,
      findSnapAnchorIndex,
      onExpand,
      onPositionChange,
      onTogglePlay,
      releaseDrag,
      reportVideoRect,
      triggerPlaybackFlash,
    ],
  );

  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = releaseDrag(event);
      if (!drag) return;
      if (drag.moved) {
        // A cancelled drag still owns its end position: flush the rect report and persist so a remount lands there.
        reportVideoRect();
        endMotion();
        const position = positionRef.current;
        if (position) onPositionChange(position);
      } else {
        setIsMoving(false);
      }
    },
    [endMotion, onPositionChange, releaseDrag, reportVideoRect],
  );

  useEffect(() => {
    if (!isMoving) return;
    document.body.style.cursor = 'grabbing';
    return () => {
      document.body.style.cursor = '';
    };
  }, [isMoving]);

  // Scroll = volume, Shift+scroll = seek (expanded-player contract); React binds wheel passively, so a native listener owns preventDefault.
  useEffect(() => {
    const surface = videoSurfaceRef.current;
    if (!surface) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      if (event.shiftKey) {
        onSeekRelative(event.deltaY < 0 ? 5 : -5);
        return;
      }
      onVolumeStep(event.deltaY < 0 ? 5 : -5);
    };
    surface.addEventListener('wheel', handleWheel, { passive: false });
    return () => surface.removeEventListener('wheel', handleWheel);
  }, [onVolumeStep, onSeekRelative]);

  const handleVideoSurfaceKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Scoped to the focused frame — child-handled, composing, or modifier-chord keys are never media shortcuts.
      if (
        event.defaultPrevented ||
        event.nativeEvent.isComposing ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey
      ) {
        return;
      }
      const keyTarget = event.target;
      const key = event.key.toLowerCase();
      if (keyTarget instanceof HTMLElement && keyTarget !== event.currentTarget) {
        // Text inputs own every key outright.
        if (isEditableTarget(keyTarget)) return;
        // A focused control keeps only its activation keys — sliders self-consume arrows via Radix
        // (defaultPrevented above). Matches the expanded player's contract.
        if ((key === ' ' || key === 'enter') && keyTarget.closest('button, a')) {
          return;
        }
      }
      if (event.repeat && MINI_NON_REPEAT_KEYS.has(key)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const handled = (() => {
        switch (key) {
          case ' ':
          case 'k':
            onTogglePlay();
            return true;
          case 'enter':
          case 'escape':
          case 'f':
          case 'i':
            onExpand();
            return true;
          case 'arrowleft':
          case 'j':
            onSeekRelative(event.shiftKey ? -5 : -10);
            return true;
          case 'arrowright':
          case 'l':
            onSeekRelative(event.shiftKey ? 5 : 10);
            return true;
          case 'arrowup':
            onVolumeStep(5);
            return true;
          case 'arrowdown':
            onVolumeStep(-5);
            return true;
          case 'm':
            onToggleMute();
            return true;
          case 'n':
            if (canGoNext) onNextEpisode();
            return canGoNext;
          case 's':
            // Skip the active segment — same key as the expanded player.
            if (skipAction) skipAction.onSkip();
            return !!skipAction;
          default:
            return false;
        }
      })();
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [
      canGoNext,
      onExpand,
      onNextEpisode,
      onSeekRelative,
      onToggleMute,
      onTogglePlay,
      onVolumeStep,
      skipAction,
    ],
  );

  const snapGhostAnchor = snapTargetIndex !== null ? anchors[snapTargetIndex] : null;
  const showLiveSurface = hasVideo && !error;
  const controlsActive =
    showLiveSurface &&
    !exiting &&
    !isMoving &&
    !isDocking &&
    !isSettling &&
    (hovered || hasFocus || !isPlaying || isWorking || !!upNext || endOfMedia);
  const effectivelyMuted = isMuted || volume === 0;
  const displayedVolume = isMuted ? 0 : Math.round(volume);

  const frame = (
    <div
      ref={frameRef}
      role='dialog'
      aria-label='Mini player'
      inert={exiting || isDocking}
      className={cn(
        // will-change: the frame's transform is rewritten per pointermove via direct style writes.
        'fixed left-0 top-0 z-[45] touch-none select-none will-change-transform',
        isMoving ? 'cursor-grabbing' : 'cursor-grab',
        (exiting || isDocking) && 'pointer-events-none',
      )}
      aria-hidden={exiting || undefined}
      style={{
        width: metrics.frameWidth,
        height: metrics.videoHeight,
        // While the dock FLIP owns the transform, the render value holds the first-frame delta.
        transform:
          isDocking && dockFlipFrom
            ? `translate3d(${Math.round(dockFlipFrom.x)}px, ${Math.round(dockFlipFrom.y)}px, 0) scale(${(dockFlipFrom.width / metrics.frameWidth).toFixed(4)})`
            : `translate3d(${Math.round(renderPosition.x)}px, ${Math.round(renderPosition.y)}px, 0)`,
        // The FLIP's translate-then-scale math anchors on the top-left corner.
        transformOrigin: '0 0',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setHasFocus(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHasFocus(false);
      }}
    >
      {/* Inner wrapper owns the entrance animation so outer-frame drag transforms are never overridden;
          stays transparent — a fill would cover the mask hole below. */}
      <div
        className={cn(
          'group/mini overflow-hidden rounded-[14px] transition-[scale,box-shadow] duration-200 ease-out motion-reduce:animate-none',
          // A FLIPped mount already entered — the pop-in would restart at the dock rect and read as a second pop.
          exiting ? 'animate-mini-undock' : dockFlipFrom ? '' : 'animate-mini-dock',
          isMoving
            ? 'scale-[1.025] shadow-[0_0_0_1px_rgba(255,255,255,0.14),0_40px_80px_-20px_rgba(0,0,0,0.95)]'
            : 'shadow-[0_0_0_1px_rgba(255,255,255,0.09),0_24px_56px_-16px_rgba(0,0,0,0.9)] hover:shadow-[0_0_0_1px_rgba(255,255,255,0.16),0_28px_64px_-16px_rgba(0,0,0,0.92)]',
        )}
      >
        {/* Video surface: the transparent interior reveals mpv behind the webview; the painted border is the
            bezel covering the mask hole's rim, and overflow-hidden clips children to its inner edge. */}
        {/* Focusable media region scopes hotkeys without making controls children of a button. */}
        {/* eslint-disable jsx-a11y/no-noninteractive-tabindex */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <div
          data-mini-video
          ref={videoSurfaceRef}
          role='application'
          tabIndex={0}
          aria-label={`Mini player: ${title}. Space to play or pause, F to expand.`}
          onKeyDown={handleVideoSurfaceKeyDown}
          className='relative w-full cursor-pointer overflow-hidden rounded-[14px] border-[3px] border-[#08080d] bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40'
          style={{ height: metrics.videoHeight }}
        >
          {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
          {/* Motion cover: mpv margins chase the DOM rect over async IPC — an opaque poster hides the surface mid-move. */}
          <div
            aria-hidden='true'
            className={cn(
              'pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-[11px] bg-[#0a0a0e] transition-opacity duration-150',
              isMoving || isSettling || isDocking ? 'opacity-100' : 'opacity-0',
            )}
          >
            {backdrop && (
              <RemoteImage
                src={backdrop}
                alt=''
                className='absolute inset-0 h-full w-full object-cover opacity-45'
              />
            )}
            <div className='absolute inset-0 bg-linear-to-t from-black/75 via-black/35 to-black/45' />
            <p
              className={cn(
                'absolute inset-x-0 bottom-2 truncate px-3 text-[10px] font-medium text-white/70 drop-shadow',
                isDocking && 'opacity-0',
              )}
            >
              <MiniTitle title={title} episodeLabel={episodeLabel} />
            </p>
          </div>

          {/* Center icon flash on click-to-toggle — bare glyph, no circle. */}
          {flash && !upNext && !endOfMedia && (
            <div
              key={flash.id}
              className='pointer-events-none absolute inset-0 z-30 flex items-center justify-center'
            >
              {flash.kind === 'pause' ? (
                <Pause className='animate-mini-flash h-9 w-9 fill-white text-white drop-shadow-[0_3px_14px_rgba(0,0,0,0.8)]' />
              ) : (
                <Play className='animate-mini-flash ml-1 h-9 w-9 fill-white text-white drop-shadow-[0_3px_14px_rgba(0,0,0,0.8)]' />
              )}
            </div>
          )}

          {/* Always-on progress hairline pinned inside the bezel. */}
          {showLiveSurface && duration > 0 && (
            <MiniPlayerHairline
              clock={clock}
              duration={duration}
              seekPreviewStore={seekPreviewStore}
            />
          )}

          {/* During playback the skip chip yields to the hover controls. */}
          {skipAction && showLiveSurface && isPlaying && !upNext && !endOfMedia && (
            <button
              type='button'
              // Same rest-state contract as the Up Next strip — docked chrome owns the action under hover/focus.
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                skipAction.onSkip();
              }}
              aria-keyshortcuts='s'
              className='absolute bottom-2.5 right-2 z-[25] flex min-h-9 items-center gap-2 rounded-lg border border-white/15 bg-black/80 px-3 py-2 transition-opacity duration-200 hover:bg-black/90 group-hover/mini:pointer-events-none group-hover/mini:opacity-0 group-focus-within/mini:pointer-events-none group-focus-within/mini:opacity-0'
            >
              <FastForward className='h-3 w-3 shrink-0 text-white/90' strokeWidth={2.5} />
              <span className='text-xs font-medium leading-tight text-white'>
                {skipAction.label}
              </span>
            </button>
          )}

          {/* EOF without next: the end card in strip form — never fades; docked chrome has no replay control. */}
          {endOfMedia && showLiveSurface && (
            <PlayerEndCard
              variant='strip'
              title={title}
              thumbnail={backdrop}
              onReplay={onReplay}
              onBackToTitle={onBackToTitle}
            />
          )}

          {/* Rest-state indicators: buffering and mute are invisible until hover otherwise. */}
          {showLiveSurface && (isWorking || effectivelyMuted) && (
            <div className='pointer-events-none absolute right-2 top-2 z-[15] flex items-center gap-1.5 transition-opacity duration-200 group-hover/mini:opacity-0 group-focus-within/mini:opacity-0'>
              {effectivelyMuted && (
                <VolumeX
                  aria-hidden='true'
                  className='h-3.5 w-3.5 text-white/50 drop-shadow-[0_1px_4px_rgba(0,0,0,0.7)]'
                />
              )}
              {isWorking && (
                <Loader2
                  aria-hidden='true'
                  className='h-3.5 w-3.5 animate-spin text-white/50 drop-shadow-[0_1px_4px_rgba(0,0,0,0.7)]'
                />
              )}
            </div>
          )}

          {showLiveSurface && (
            <div
              className={cn(
                'pointer-events-none absolute inset-0 z-20 flex flex-col justify-between transition-opacity duration-200',
                controlsActive ? 'opacity-100' : 'opacity-0',
              )}
            >
              {/* Empty space on the title scrim still passes through to drag. */}
              <div
                className={cn(
                  'flex items-center gap-1 bg-linear-to-b from-black/85 via-black/40 to-transparent px-1.5 pb-4 pt-1.5',
                  controlsActive && 'pointer-events-auto',
                )}
              >
                <MiniExpandButton onClick={onExpand} />
                <MiniSnapButton onClick={snapToNextAnchor} />
                <p
                  className='min-w-0 flex-1 truncate px-1 text-xs font-medium leading-tight text-white drop-shadow'
                  title={title}
                >
                  <MiniTitle title={title} episodeLabel={episodeLabel} />
                </p>
                <MiniCloseButton onClick={onClose} />
              </div>

              {/* Movies and finales use the replay strip instead. */}
              {!endOfMedia && (
                <div
                  className={cn(
                    'bg-linear-to-t from-black/90 via-black/60 to-transparent px-2.5 pb-2 pt-5',
                    controlsActive && 'pointer-events-auto',
                  )}
                >
                  <div className='flex min-w-0 items-center justify-between gap-2'>
                    {upNext ? (
                      <button
                        type='button'
                        onClick={onNextEpisode}
                        aria-label={`Next episode: ${upNext.label}`}
                        title={`Next episode: ${upNext.label} (N)`}
                        className='min-w-0 truncate rounded px-1 py-1 text-left text-xs font-medium text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60'
                      >
                        Up next · {upNext.label}
                      </button>
                    ) : (
                      <span className='min-w-0 truncate text-[11px] text-white/65'>
                        {isWorking ? 'Loading…' : !isPlaying ? 'Paused' : ''}
                      </span>
                    )}
                    <MiniPlayerTimeLabel
                      active={controlsActive}
                      clock={clock}
                      duration={duration}
                      seekPreviewStore={seekPreviewStore}
                    />
                  </div>
                  <MiniPlayerSeekSlider
                    active={controlsActive}
                    clock={clock}
                    duration={duration}
                    seekPreviewStore={seekPreviewStore}
                    onSeek={onSeek}
                  />
                  <div className='flex items-center gap-1'>
                    <button
                      type='button'
                      aria-label={upNext ? 'Watch again' : isPlaying ? 'Pause' : 'Play'}
                      aria-keyshortcuts='Space k'
                      title={
                        upNext
                          ? 'Watch again (Space)'
                          : isPlaying
                            ? 'Pause (Space)'
                            : 'Play (Space)'
                      }
                      onClick={upNext ? onReplay : onTogglePlay}
                      className={cn(MINI_ICON_BUTTON_CLASS, 'bg-white/10 text-white')}
                    >
                      {upNext ? (
                        <RotateCcw className='h-4 w-4' />
                      ) : isPlaying ? (
                        <Pause className='h-4 w-4 fill-white' />
                      ) : (
                        <Play className='ml-px h-4 w-4 fill-white' />
                      )}
                    </button>

                    {canGoNext && !upNext && (
                      <button
                        type='button'
                        aria-label='Next episode'
                        aria-keyshortcuts='n'
                        title='Next episode (N)'
                        onClick={onNextEpisode}
                        className={MINI_ICON_BUTTON_CLASS}
                      >
                        <SkipForward className='h-[15px] w-[15px]' strokeWidth={2.25} />
                      </button>
                    )}

                    {/* Hover-state skip: the resting chip fades under the chrome. */}
                    {skipAction && (
                      <button
                        type='button'
                        aria-label={skipAction.label}
                        title={skipAction.label}
                        aria-keyshortcuts='s'
                        onClick={skipAction.onSkip}
                        className={MINI_ICON_BUTTON_CLASS}
                      >
                        <FastForward className='h-[15px] w-[15px]' strokeWidth={2.25} />
                      </button>
                    )}

                    <div className='ml-auto flex shrink-0 items-center gap-2'>
                      <button
                        type='button'
                        aria-label={effectivelyMuted ? 'Unmute' : 'Mute'}
                        aria-keyshortcuts='m'
                        title={effectivelyMuted ? 'Unmute (M)' : 'Mute (M)'}
                        onClick={onToggleMute}
                        className={MINI_ICON_BUTTON_CLASS}
                      >
                        <PlayerVolumeIcon
                          muted={effectivelyMuted}
                          volume={volume}
                          className='h-[15px] w-[15px]'
                          strokeWidth={2.25}
                        />
                      </button>
                      <PlayerSlider
                        variant='bar'
                        aria-label='Volume'
                        aria-valuetext={effectivelyMuted ? 'Muted' : `${displayedVolume}%`}
                        title={effectivelyMuted ? 'Volume: muted' : `Volume: ${displayedVolume}%`}
                        value={[isMuted ? 0 : volume]}
                        max={100}
                        step={1}
                        onValueChange={(value) => onVolumeChange(value[0] ?? 0)}
                        className='h-8 w-14 shrink-0'
                      />
                      <span className='w-7 text-right text-[11px] tabular-nums text-white/75'>
                        {displayedVolume}%
                      </span>
                    </div>

                    {isWorking && (
                      <Loader2 className='ml-1 h-3 w-3 shrink-0 animate-spin text-white/40' />
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {!showLiveSurface && (
            <div
              className={cn(
                'absolute inset-0 z-20 overflow-hidden rounded-[11px] bg-[#0a0a0e]',
                error && 'cursor-pointer',
              )}
            >
              {/* Full-surface expand target on error — rendered before the chrome buttons so they stay clickable. */}
              {error && (
                <button
                  type='button'
                  aria-label='Back to player'
                  title='Click to return to the player'
                  onClick={onExpand}
                  className='absolute inset-0 rounded-[11px] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-inset'
                />
              )}
              {backdrop && (
                <RemoteImage
                  src={backdrop}
                  alt=''
                  className='pointer-events-none absolute inset-0 h-full w-full object-cover opacity-25'
                />
              )}
              <div className='pointer-events-none absolute inset-0 bg-linear-to-t from-black/70 via-black/30 to-black/50' />
              <div className='absolute inset-x-0 top-0 z-10 flex items-center justify-between p-1.5'>
                <div className='flex items-center gap-1'>
                  <MiniExpandButton onClick={onExpand} />
                  <MiniSnapButton onClick={snapToNextAnchor} />
                </div>
                <MiniCloseButton onClick={onClose} />
              </div>
              {/* Pointer-transparent — rendered last, it would otherwise cover the buttons/expand target above. */}
              <div className='pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center'>
                {error ? (
                  <>
                    <TriangleAlert className='h-5 w-5 text-amber-400/90' strokeWidth={1.75} />
                    <p className='line-clamp-2 text-[11px] font-medium leading-snug text-white/80'>
                      {error}
                    </p>
                  </>
                ) : (
                  <>
                    <Loader2 className='h-5 w-5 animate-spin text-white/70' />
                    <p className='line-clamp-2 text-[11px] font-medium leading-snug text-white/70'>
                      {statusText || 'Preparing playback'}
                    </p>
                  </>
                )}
                <p className='absolute inset-x-0 bottom-2 truncate px-3 text-[10px] text-white/50'>
                  <MiniTitle title={title} episodeLabel={episodeLabel} />
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // Portaled to body so the chrome sits above the mask-hole layers; the snap ghost sits one layer under the frame.
  return createPortal(
    <>
      {snapGhostAnchor && (
        <div
          aria-hidden='true'
          className='pointer-events-none fixed left-0 top-0 z-[44] animate-mini-ghost rounded-[14px] border-[1.5px] border-dashed border-white/35 bg-white/[0.05] backdrop-blur-sm'
          style={{
            width: metrics.frameWidth,
            height: metrics.videoHeight,
            transform: `translate3d(${Math.round(snapGhostAnchor.x)}px, ${Math.round(snapGhostAnchor.y)}px, 0)`,
          }}
        />
      )}
      {frame}
    </>,
    document.body,
  );
});
