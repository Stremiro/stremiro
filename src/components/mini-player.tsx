import {
  ChevronLeft,
  Loader2,
  Maximize2,
  Pause,
  Play,
  TriangleAlert,
  VolumeX,
  X,
} from 'lucide-react';
import {
  useCallback,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { InlineMenu } from '@/components/inline-menu';
import { PlayerSkipButton } from '@/components/player-action-overlays';
import { CHROME_ICON_STROKE } from '@/components/player-chrome-styles';
import {
  MINI_ICON_BUTTON_CLASS,
  PlayerNextButton,
  PlayerPlayButton,
  PlayerPreviousButton,
  PlayerVolumeControl,
} from '@/components/player-control-buttons';
import { PlayerSlider, type PlayerSliderMark } from '@/components/player-slider';
import { PlayerEndCard } from '@/components/player-state-overlays';
import { RemoteImage } from '@/components/remote-image';
import { useInlineMenu } from '@/hooks/use-inline-menu';
import { useDelayedUnmount } from '@/hooks/use-delayed-unmount';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { usePointerIdle } from '@/hooks/use-pointer-idle';
import {
  PLAYER_SIDEBAR_WIDTH_PX,
  PLAYER_TITLEBAR_HEIGHT_PX,
  type MiniVideoRect,
} from '@/hooks/use-player-surface-layout';
import { usePlayerKeymap } from '@/hooks/use-app-ui-preferences';
import type { SkipSegment } from '@/lib/api';
import { subscribeWhileHidden, type PlaybackClock } from '@/lib/player-clock';
import { createWheelSeekAccumulator } from '@/lib/player-dom';
import {
  ariaKeyShortcuts,
  formatBindingKey,
  type PlayerKeymap,
  withShortcutHint,
} from '@/lib/player-keybindings';
import { createSubscribableStore, type SubscribableStore } from '@/lib/subscribable-store';
import type { MiniPlayerPosition } from '@/lib/player-session';
import { clamp, clearTimer, cn, formatTime, prefersReducedMotion } from '@/lib/utils';

const MINI_MIN_WIDTH_PX = 300;
const MINI_MAX_WIDTH_PX = 420;
const MINI_WIDTH_RATIO = 0.26;
const MINI_BEZEL_PX = 2;
const MINI_FRAME_RADIUS_CLASS = 'rounded-lg';
const MINI_SURFACE_RADIUS_CLASS = 'rounded-md';
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
const SURFACE_RETRY_MAX_MS = 1_000;

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

function cancelFrame(frameRef: { current: number | null }) {
  if (frameRef.current === null) return;
  window.cancelAnimationFrame(frameRef.current);
  frameRef.current = null;
}

// Shared ease for snap glides and the dock FLIP — fast start, soft landing.
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// Expand/close render twice (hover chrome + error/empty overlay), so the buttons live here once.
function MiniExpandButton({ keymap, onClick }: { keymap: PlayerKeymap; onClick: () => void }) {
  return (
    <button
      type='button'
      aria-label='Back to player'
      aria-keyshortcuts={ariaKeyShortcuts(keymap, 'toggleFullscreen')}
      onClick={onClick}
      className={MINI_ICON_BUTTON_CLASS}
    >
      <Maximize2 aria-hidden='true' className='h-4 w-4' strokeWidth={CHROME_ICON_STROKE} />
    </button>
  );
}

function MiniCloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type='button'
      aria-label='Close mini player'
      onClick={onClick}
      className={cn(MINI_ICON_BUTTON_CLASS, 'hover:bg-red-500/25 hover:text-red-200')}
    >
      <X aria-hidden='true' className='h-4 w-4' strokeWidth={CHROME_ICON_STROKE} />
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

function useMiniDisplayTime(
  clock: PlaybackClock,
  duration: number,
  seekPreviewStore: SeekPreviewStore,
  active = true,
  wholeSeconds = false,
): number {
  const seekPreview = useSyncExternalStore(
    seekPreviewStore.subscribe,
    wholeSeconds
      ? () => {
          const preview = seekPreviewStore.getSnapshot();
          return preview === null ? null : Math.floor(preview);
        }
      : seekPreviewStore.getSnapshot,
  );
  const currentTime = useSyncExternalStore(
    active || seekPreview !== null ? clock.subscribe : subscribeWhileHidden,
    wholeSeconds ? () => Math.floor(clock.getSnapshot()) : clock.getSnapshot,
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
  active,
  clock,
  duration,
  seekPreviewStore,
}: MiniPlayerTickProps) {
  const displayTime = useMiniDisplayTime(clock, duration, seekPreviewStore, active);
  const progressPct = duration > 0 ? clamp((displayTime / duration) * 100, 0, 100) : 0;
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-2.5 bottom-1.5 z-10 h-[3px] overflow-hidden rounded-[1px] bg-white/10 transition-opacity motion-reduce:transition-none',
        !active && 'opacity-0',
      )}
    >
      <div
        className='h-full w-full origin-left bg-(--accent-prog)'
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
  const displayTime = useMiniDisplayTime(clock, duration, seekPreviewStore, active, true);
  return (
    <span className='shrink-0 text-[11px] tabular-nums text-white/80'>
      {formatTime(displayTime)}
      {duration > 0 && <span className='text-white/55'> / {formatTime(duration)}</span>}
    </span>
  );
});

const MINI_SKIP_MARK: Record<string, string> = {
  intro: 'bg-amber-200/90',
  recap: 'bg-orange-200/90',
  outro: 'bg-sky-200/90',
  preview: 'bg-violet-200/90',
};

function miniSkipMarks(segments: readonly SkipSegment[]): PlayerSliderMark[] {
  return segments.map((segment) => ({
    start: segment.start_time,
    end: segment.end_time,
    className: MINI_SKIP_MARK[segment.type] ?? 'bg-white/70',
  }));
}

interface MiniPlayerSeekSliderProps extends MiniPlayerTickProps {
  onSeek: (seconds: number) => void;
  skipSegments?: readonly SkipSegment[];
}

const MiniPlayerSeekSlider = memo(function MiniPlayerSeekSlider({
  active,
  clock,
  duration,
  seekPreviewStore,
  onSeek,
  skipSegments,
}: MiniPlayerSeekSliderProps) {
  const displayTime = useMiniDisplayTime(clock, duration, seekPreviewStore, active);
  const isDraggingRef = useRef(false);
  useEffect(() => {
    return () => seekPreviewStore.publish(null);
  }, [seekPreviewStore]);
  const clearDragPreview = () => {
    isDraggingRef.current = false;
    seekPreviewStore.publish(null);
  };
  return (
    <PlayerSlider
      variant='track'
      aria-label='Seek'
      value={[Math.max(0, displayTime)]}
      max={Math.max(duration, 1)}
      step={0.5}
      aria-valuetext={`${formatTime(displayTime)} of ${formatTime(duration)}`}
      disabled={duration <= 0}
      marks={skipSegments?.length ? miniSkipMarks(skipSegments) : undefined}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
        isDraggingRef.current = true;
      }}
      onValueChange={(value) => {
        // Radix commits keyboard steps before firing onValueChange.
        if (isDraggingRef.current) seekPreviewStore.publish(value[0] ?? null);
      }}
      onValueCommit={(value) => {
        const target = value[0];
        seekPreviewStore.publish(null);
        if (typeof target === 'number') onSeek(target);
      }}
      onPointerUp={clearDragPreview}
      onPointerCancel={clearDragPreview}
      onLostPointerCapture={clearDragPreview}
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
  skipSegments?: readonly SkipSegment[];
  canGoPrevious: boolean;
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
  getInitialPosition: () => MiniPlayerPosition | null;
  /** Expanded surface rect at dock time — the frame FLIPs from it into the docked corner. */
  dockOrigin?: MiniVideoRect | null;
  /** True only on the expanded→mini transition: keyboard minimize orphans focus on unmounted chrome, so the fresh dock claims it. */
  claimFocusOnMount?: boolean;
  onVideoRectChange: (rect: MiniVideoRect | null) => Promise<boolean> | void;
  onPositionChange: (position: MiniPlayerPosition) => void;
  onTogglePlay: () => void;
  onToggleMute: () => void;
  onVolumeChange: (volume: number) => void;
  onVolumeWheel: (event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>) => Promise<void>;
  onSeek: (seconds: number) => void;
  onSeekRelative: (deltaSeconds: number) => void;
  onExpand: () => void;
  onClose: () => void;
  onPreviousEpisode: () => void;
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
  skipSegments,
  canGoPrevious,
  canGoNext,
  hasVideo,
  isMuted,
  volume,
  upNext,
  endOfMedia,
  skipAction,
  exiting,
  getInitialPosition,
  dockOrigin,
  claimFocusOnMount,
  onVideoRectChange,
  onPositionChange,
  onTogglePlay,
  onToggleMute,
  onVolumeChange,
  onVolumeWheel,
  onSeek,
  onSeekRelative,
  onExpand,
  onClose,
  onPreviousEpisode,
  onNextEpisode,
  onReplay,
  onBackToTitle,
}: MiniPlayerProps) {
  const keymap = usePlayerKeymap();
  const playKey = keymap.keys.togglePlay[0];
  const expandKey = keymap.keys.toggleFullscreen[0];
  const mountedRef = useMountedRef();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const videoSurfaceRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusClaimRef = useRef(claimFocusOnMount);
  const [hovered, setHovered] = useState(false);
  const [hasFocus, setHasFocus] = useState(false);
  const { idle: pointerIdle, wake: wakePointer } = usePointerIdle();
  const menu = useInlineMenu({
    rootRef: frameRef,
    enabled: !exiting,
    returnFocus: () => videoSurfaceRef.current,
  });
  useEffect(() => {
    const releaseInteraction = () => {
      setHovered(false);
      setHasFocus(false);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') releaseInteraction();
    };
    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) setHovered(false);
    };
    window.addEventListener('blur', releaseInteraction);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('pointerout', handlePointerOut);
    return () => {
      window.removeEventListener('blur', releaseInteraction);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('pointerout', handlePointerOut);
    };
  }, []);
  const [metrics, setMetrics] = useState<MiniPlayerMetrics>(computeMiniMetrics);
  const [renderPosition] = useState(() =>
    clampMiniPosition(getInitialPosition() ?? defaultMiniPosition(metrics), metrics),
  );
  const positionRef = useRef<MiniPlayerPosition>(renderPosition);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
    videoClick: boolean;
  } | null>(null);
  const snapFrameRef = useRef<number | null>(null);
  // External store, not state — per-pointermove publishes reach only the tick leaves.
  const [seekPreviewStore] = useState(() => createSubscribableStore<number | null>(null));
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
  const motionGenerationRef = useRef(0);
  const landingRef = useRef(false);
  const lastVideoTapAtRef = useRef(0);
  const anchors = snapAnchors(metrics);

  // The reported hole is the video's content box (frame minus bezel); the painted border covers the rim and square corners.
  const reportVideoRect = useCallback(() => {
    const position = positionRef.current;
    return onVideoRectChange({
      x: position.x + MINI_BEZEL_PX,
      y: position.y + MINI_BEZEL_PX,
      width: metrics.frameWidth - MINI_BEZEL_PX * 2,
      height: metrics.videoHeight - MINI_BEZEL_PX * 2,
    });
  }, [metrics.frameWidth, metrics.videoHeight, onVideoRectChange]);

  // Callback churn must not restart the dock flight.
  const rectOpsRef = useRef({ reportVideoRect, onVideoRectChange, hasVideo });
  useEffect(() => {
    rectOpsRef.current = { reportVideoRect, onVideoRectChange, hasVideo };
  });

  const cancelSnap = useCallback(() => {
    motionGenerationRef.current += 1;
    clearTimer(settleTimerRef);
    cancelFrame(snapFrameRef);
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

  const revealSurface = useCallback(
    (generation: number) => {
      const isCurrent = () =>
        mountedRef.current &&
        rectOpsRef.current.hasVideo &&
        generation === motionGenerationRef.current;
      const attempt = async (retryDelay: number) => {
        if (!isCurrent()) return;
        const holeReady = await Promise.resolve(rectOpsRef.current.reportVideoRect()).catch(
          () => false,
        );
        if (!isCurrent()) return;
        if (holeReady === true) {
          setIsSettling(false);
          return;
        }
        // A failed apply keeps the cover; retry with backoff until it lands or new motion supersedes it.
        settleTimerRef.current = window.setTimeout(() => {
          settleTimerRef.current = null;
          void attempt(Math.min(retryDelay * 2, SURFACE_RETRY_MAX_MS));
        }, retryDelay);
      };
      void attempt(SURFACE_SETTLE_MS);
    },
    [mountedRef],
  );

  // Keep the motion cover until the final rectangle is verified.
  const startSurfaceSettle = useCallback(() => {
    if (!rectOpsRef.current.hasVideo) return;
    setIsSettling(true);
    clearTimer(settleTimerRef);
    const generation = ++motionGenerationRef.current;
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      revealSurface(generation);
    }, SURFACE_SETTLE_MS);
  }, [revealSurface]);

  const endMotion = useCallback(() => {
    setIsMoving(false);
    startSurfaceSettle();
  }, [startSurfaceSettle]);

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

  // Only the covered frame moves; the native surface lands once the glide ends.
  const animateTo = useCallback(
    (target: MiniPlayerPosition) => {
      cancelSnap();
      const start = positionRef.current;
      if (prefersReducedMotion()) {
        const landed = applyPosition(target);
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
        if (t < 1) {
          snapFrameRef.current = window.requestAnimationFrame(step);
        } else {
          snapFrameRef.current = null;
          endMotion();
          onPositionChange(positionRef.current);
        }
      };
      snapFrameRef.current = window.requestAnimationFrame(step);
    },
    [applyPosition, cancelSnap, endMotion, onPositionChange],
  );

  // The dock flight owns geometry until landing.
  useEffect(() => {
    if (isDocking) return;
    onPositionChange(applyPosition(positionRef.current));
  }, [applyPosition, isDocking, onPositionChange]);

  // Dock entrance: a WAAPI flight scales the frame from the expanded rect — no per-frame rect reports or margin
  // IPC. The motion cover hides the interior until the landing hole is verified.
  useLayoutEffect(() => {
    if (!isDocking || !dockFlipFrom) return;
    const generation = ++motionGenerationRef.current;
    const frame = frameRef.current;
    const target = positionRef.current;
    if (!frame) {
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
        if (!active || generation !== motionGenerationRef.current) return;
        applyPosition(target);
        animation.cancel();
        landingRef.current = rectOpsRef.current.hasVideo;
        onPositionChange(target);
        setIsDocking(false);
        revealSurface(generation);
      },
      () => undefined,
    );
    return () => {
      active = false;
      animation.cancel();
    };
  }, [isDocking, dockFlipFrom, metrics, applyPosition, onPositionChange, revealSurface]);

  // Retain the mount-only claim through parent updates during docking.
  useEffect(() => {
    if (exiting || !pendingFocusClaimRef.current || isDocking) return;
    pendingFocusClaimRef.current = false;
    const active = document.activeElement;
    if (active === document.body || active === document.documentElement || active === null) {
      videoSurfaceRef.current?.focus({ preventScroll: true });
    }
  }, [exiting, isDocking]);

  // A live surface or resize keeps its cover until landing; the dock FLIP holds its own
  // cover and the exiting instance never veils.
  useEffect(() => {
    if (!hasVideo) clearTimer(settleTimerRef);
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
      void rectOpsRef.current.onVideoRectChange(null);
      if (dragStateRef.current?.moved) {
        setIsSettling(rectOpsRef.current.hasVideo);
      } else {
        endMotion();
      }
      setSnapTargetIndex(null);
      setIsDocking(false);
      setMetrics(computeMiniMetrics());
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [cancelSnap, endMotion]);

  // Unmount-only teardown — a rebuilt `onVideoRectChange` mid-life would kill an in-flight snap.
  useEffect(() => {
    return () => {
      cancelSnap();
      clearTimer(flashTimerRef);
      void rectOpsRef.current.onVideoRectChange(null);
    };
  }, [cancelSnap]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || dragStateRef.current !== null) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('button, a, input, [role="slider"]')) return;

    const position = positionRef.current;
    if (!frameRef.current) return;

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
  };

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

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < DRAG_CLICK_TOLERANCE_PX) return;

    if (!drag.moved) {
      drag.moved = true;
      cancelSnap();
      void rectOpsRef.current.onVideoRectChange(null);
      setIsMoving(true);
    }
    setSnapTargetIndex(
      findSnapAnchorIndex(applyPosition({ x: drag.originX + deltaX, y: drag.originY + deltaY })),
    );
  };

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
      const position = positionRef.current;
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
        if (isMoving || isSettling) startSurfaceSettle();
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
    },
    [
      anchors,
      animateTo,
      endMotion,
      findSnapAnchorIndex,
      isMoving,
      isSettling,
      onExpand,
      onPositionChange,
      onTogglePlay,
      releaseDrag,
      startSurfaceSettle,
      triggerPlaybackFlash,
    ],
  );

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = releaseDrag(event);
    if (!drag) return;
    if (drag.moved) {
      endMotion();
      onPositionChange(positionRef.current);
    } else {
      setIsMoving(false);
      if (isMoving || isSettling) startSurfaceSettle();
    }
  };

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
    const accumulateWheelSeek = createWheelSeekAccumulator();
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      if (event.shiftKey) {
        const seconds = accumulateWheelSeek(event);
        if (seconds !== 0) onSeekRelative(seconds);
        return;
      }
      void onVolumeWheel(event).catch(() => undefined);
    };
    surface.addEventListener('wheel', handleWheel, { passive: false });
    return () => surface.removeEventListener('wheel', handleWheel);
  }, [onVolumeWheel, onSeekRelative]);

  const snapGhostAnchor = snapTargetIndex !== null ? anchors[snapTargetIndex] : null;
  const showLiveSurface = hasVideo && !error;
  const controlsActive =
    showLiveSurface &&
    !exiting &&
    !isMoving &&
    !isDocking &&
    !isSettling &&
    !menu.presence.mounted &&
    (hasFocus || !isPlaying || isWorking || !!upNext || endOfMedia || (hovered && !pointerIdle));
  const effectivelyMuted = isMuted || volume === 0;
  const motionCover = useDelayedUnmount(isMoving || isSettling || isDocking, 150);

  const frame = (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- menu keys and right-click morph the docked chrome in place.
    <div
      ref={frameRef}
      data-mini-player
      role='region'
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
      onPointerMove={(event) => {
        handlePointerMove(event);
        wakePointer();
      }}
      onPointerUp={finishDrag}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
      onPointerEnter={() => {
        setHovered(document.visibilityState !== 'hidden');
        wakePointer();
      }}
      onPointerLeave={() => {
        setHovered(false);
        menu.rootProps.onPointerLeave();
      }}
      onContextMenu={menu.rootProps.onContextMenu}
      onKeyDown={menu.rootProps.onKeyDown}
      onPointerDownCapture={() => setHasFocus(false)}
      onFocusCapture={(event) =>
        setHasFocus(document.hasFocus() && event.target.matches(':focus-visible'))
      }
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHasFocus(false);
      }}
    >
      {/* Inner wrapper owns the entrance animation so outer-frame drag transforms are never overridden;
          stays transparent — a fill would cover the mask hole below. */}
      <div
        className={cn(
          MINI_FRAME_RADIUS_CLASS,
          'relative overflow-hidden transition-shadow duration-200 ease-out motion-reduce:animate-none',
          // A FLIPped mount already entered — the pop-in would restart at the dock rect and read as a second pop.
          exiting ? 'animate-mini-undock' : dockFlipFrom ? '' : 'animate-mini-dock',
          isMoving
            ? 'shadow-[0_0_0_1px_rgba(255,255,255,0.16),0_20px_44px_-16px_rgba(0,0,0,0.88)]'
            : 'shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_16px_36px_-18px_rgba(0,0,0,0.78)]',
        )}
      >
        {/* Video surface: the transparent interior reveals mpv behind the webview; the painted border is the
            bezel covering the mask hole's rim, and overflow-hidden clips children to its inner edge. */}
        {/* Focusable media region scopes hotkeys without making controls children of a button. */}
        {/* eslint-disable jsx-a11y/no-noninteractive-tabindex */}
        <div
          data-mini-video
          ref={videoSurfaceRef}
          role='application'
          tabIndex={0}
          aria-label={`Mini player: ${title}.${playKey !== undefined ? ` ${formatBindingKey(playKey)} to play or pause.` : ''}${expandKey !== undefined ? ` ${formatBindingKey(expandKey)} to expand.` : ''}`}
          className={cn(
            MINI_FRAME_RADIUS_CLASS,
            'relative w-full cursor-pointer overflow-hidden border-2 border-black bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40',
          )}
          style={{ height: metrics.videoHeight }}
        >
          {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
          {/* Keep the cover opaque until the final native rectangle is verified. */}
          {motionCover.mounted && (
            <div
              aria-hidden='true'
              className={cn(
                MINI_SURFACE_RADIUS_CLASS,
                'pointer-events-none absolute inset-0 z-10 overflow-hidden bg-[#0a0a0e] transition-opacity',
                isMoving || isSettling || isDocking
                  ? 'opacity-100 duration-0'
                  : 'opacity-0 duration-150',
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
          )}

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
              active={!controlsActive && !isMoving && !isSettling && !isDocking}
              clock={clock}
              duration={duration}
              seekPreviewStore={seekPreviewStore}
            />
          )}

          {/* During playback the skip chip yields to the hover controls. */}
          {skipAction && showLiveSurface && isPlaying && !upNext && !endOfMedia && (
            <PlayerSkipButton
              action={skipAction}
              keymap={keymap}
              variant='compact'
              // Same rest-state contract as the Up Next strip — docked chrome owns the action under hover/focus.
              tabIndex={-1}
              className={cn(
                'absolute bottom-2.5 right-2 z-[25] min-h-9 gap-2 px-3 py-2 font-medium leading-tight transition-[opacity,color,background-color,border-color]',
                controlsActive && 'pointer-events-none opacity-0',
              )}
            />
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
            <div
              className={cn(
                'pointer-events-none absolute right-2 top-2 z-[15] flex items-center gap-1.5 transition-opacity duration-200',
                controlsActive && 'opacity-0',
              )}
            >
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
                <MiniExpandButton keymap={keymap} onClick={onExpand} />
                <p className='min-w-0 flex-1 truncate px-1 text-xs font-medium leading-tight text-white drop-shadow'>
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
                        title={withShortcutHint(
                          `Next episode: ${upNext.label}`,
                          keymap,
                          'nextEpisode',
                        )}
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
                    skipSegments={skipSegments}
                    onSeek={onSeek}
                  />
                  <div className='flex items-center gap-1'>
                    {canGoPrevious && !upNext && (
                      <PlayerPreviousButton
                        variant='mini'
                        keymap={keymap}
                        label='Previous episode'
                        onClick={onPreviousEpisode}
                      />
                    )}

                    <PlayerPlayButton
                      variant='mini'
                      keymap={keymap}
                      icon={upNext ? 'replay' : isPlaying ? 'pause' : 'play'}
                      label={upNext ? 'Watch again' : isPlaying ? 'Pause' : 'Play'}
                      onClick={upNext ? onReplay : onTogglePlay}
                    />

                    {canGoNext && !upNext && (
                      <PlayerNextButton
                        variant='mini'
                        keymap={keymap}
                        label='Next episode'
                        onClick={onNextEpisode}
                      />
                    )}

                    {/* Hover-state skip: the resting chip fades under the chrome. */}
                    {skipAction && (
                      <PlayerSkipButton action={skipAction} keymap={keymap} variant='icon' />
                    )}

                    <PlayerVolumeControl
                      variant='mini'
                      active={controlsActive}
                      keymap={keymap}
                      volume={volume}
                      isMuted={isMuted}
                      onToggleMute={onToggleMute}
                      onVolumeChange={onVolumeChange}
                    />

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
                MINI_SURFACE_RADIUS_CLASS,
                'absolute inset-0 z-20 overflow-hidden bg-[#0a0a0e]',
                error && 'cursor-pointer',
              )}
            >
              {/* Full-surface expand target on error — rendered before the chrome buttons so they stay clickable. */}
              {error && (
                <button
                  type='button'
                  aria-label='Back to player'
                  onClick={onExpand}
                  className={cn(
                    MINI_SURFACE_RADIUS_CLASS,
                    'absolute inset-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-inset',
                  )}
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
                  <MiniExpandButton keymap={keymap} onClick={onExpand} />
                </div>
                <MiniCloseButton onClick={onClose} />
              </div>
              {/* Pointer-transparent — rendered last, it would otherwise cover the buttons/expand target above. */}
              <div className='pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center'>
                {error ? (
                  <TriangleAlert className='h-5 w-5 text-amber-400/90' strokeWidth={1.75} />
                ) : (
                  <Loader2 className='h-5 w-5 animate-spin text-white/70' />
                )}
                <p
                  role={error ? 'alert' : 'status'}
                  className={cn(
                    'line-clamp-2 text-[11px] font-medium leading-snug',
                    error ? 'text-white/80' : 'text-white/70',
                  )}
                >
                  {error || statusText || 'Preparing playback'}
                </p>
                <p className='absolute inset-x-0 bottom-2 truncate px-3 text-[10px] text-white/50'>
                  <MiniTitle title={title} episodeLabel={episodeLabel} />
                </p>
              </div>
            </div>
          )}
        </div>
        <InlineMenu
          presence={menu.presence}
          orientation='horizontal'
          label='Mini player actions'
          className={cn(MINI_FRAME_RADIUS_CLASS, 'z-40 bg-zinc-950/88 backdrop-blur-md')}
          onAction={menu.close}
          actions={[
            { key: 'back', label: 'Back', icon: ChevronLeft, muted: true, onSelect: menu.close },
            {
              key: 'expand',
              label: 'Expand',
              icon: Maximize2,
              onSelect: onExpand,
            },
            {
              key: 'close',
              label: 'Close',
              icon: X,
              destructive: true,
              onSelect: onClose,
            },
          ]}
        />
      </div>
    </div>
  );

  // Portaled to body so the chrome sits above the mask-hole layers; the snap ghost sits one layer under the frame.
  return createPortal(
    <>
      {snapGhostAnchor && (
        <div
          aria-hidden='true'
          className={cn(
            MINI_FRAME_RADIUS_CLASS,
            'pointer-events-none fixed left-0 top-0 z-[44] animate-mini-ghost border border-dashed border-white/30 bg-white/[0.04]',
          )}
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
