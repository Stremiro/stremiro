import {
  useCallback,
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  CHROME_ENTER_TIMING_CLASS,
  CHROME_EXIT_TIMING_CLASS,
  CHROME_VALUE_BUBBLE_CLASS,
} from '@/components/player-chrome-styles';
import type { SkipSegment } from '@/lib/api';
import { subscribeWhileHidden, type PlaybackClock } from '@/lib/player-clock';
import { SKIP_SEGMENT_LABELS } from '@/lib/player-skip';
import { clamp, cn, formatTime } from '@/lib/utils';

const SKIP_SEGMENT_STYLES: Record<string, { color: string; badge: string }> = {
  intro: { color: 'bg-amber-300/75', badge: 'bg-amber-500 text-black' },
  outro: { color: 'bg-sky-300/75', badge: 'bg-sky-500 text-black' },
  preview: { color: 'bg-violet-300/75', badge: 'bg-violet-500 text-black' },
};

const FALLBACK_SKIP_SEGMENT_STYLE = {
  color: 'bg-orange-300/75',
  badge: 'bg-orange-500 text-black',
};

const ENDS_AT_FORMATTER = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });

function getSegmentStyle(type: string): { color: string; badge: string } {
  return SKIP_SEGMENT_STYLES[type] ?? FALLBACK_SKIP_SEGMENT_STYLE;
}

interface PlayerTimeDisplayProps {
  clock: PlaybackClock;
  duration: number;
  playbackSpeed?: number;
  active?: boolean;
  className?: string;
}

export const PlayerTimeDisplay = memo(function PlayerTimeDisplay({
  clock,
  duration,
  playbackSpeed,
  active = true,
  className,
}: PlayerTimeDisplayProps) {
  const [showRemainingTime, setShowRemainingTime] = useState(false);
  const displayTime = useSyncExternalStore(active ? clock.subscribe : subscribeWhileHidden, () =>
    Math.floor(
      showRemainingTime && duration > 0
        ? Math.max(0, duration - clock.getSnapshot())
        : clock.getSnapshot(),
    ),
  );
  const [endsAtMinute, setEndsAtMinute] = useState<number | null>(null);
  const updateEndsAt = useCallback(() => {
    const remainingWallClockSecs = (duration - clock.getSnapshot()) / (playbackSpeed || 1);
    setEndsAtMinute(
      duration > 0 && remainingWallClockSecs >= 60
        ? Math.floor((Date.now() + remainingWallClockSecs * 1000) / 60_000)
        : null,
    );
  }, [clock, duration, playbackSpeed]);
  useEffect(() => {
    updateEndsAt();
  }, [displayTime, updateEndsAt]);

  const toggleLabel = showRemainingTime ? 'Show elapsed time' : 'Show remaining time';
  const displayedTime =
    showRemainingTime && duration > 0 ? `−${formatTime(displayTime)}` : formatTime(displayTime);
  const totalTime = formatTime(duration);
  const endsAtText = endsAtMinute === null ? null : ENDS_AT_FORMATTER.format(endsAtMinute * 60_000);
  return (
    <button
      type='button'
      onPointerEnter={updateEndsAt}
      onClick={(e) => {
        e.stopPropagation();
        setShowRemainingTime((value) => !value);
      }}
      aria-pressed={showRemainingTime}
      aria-label={`${displayedTime} of ${totalTime}, ${toggleLabel}`}
      className={cn(
        // Cap-height trimming centers the digits optically; line-box centering leaves them sitting low.
        'flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[13px] font-semibold leading-none tabular-nums tracking-tight text-white transition-colors hover:bg-white/12 select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 [&>span]:[text-box:trim-both_cap_alphabetic]',
        className,
      )}
      title={endsAtText ? `${toggleLabel} · Ends at ${endsAtText}` : toggleLabel}
    >
      <span>{displayedTime}</span>
      <span className='font-medium text-white/40'>/</span>
      <span className='font-medium text-white/60'>{totalTime}</span>
    </button>
  );
});

interface PlayerEdgeProgressProps {
  clock: PlaybackClock;
  duration: number;
  visible: boolean;
}

export const PlayerEdgeProgress = memo(function PlayerEdgeProgress({
  clock,
  duration,
  visible,
}: PlayerEdgeProgressProps) {
  const currentTime = useSyncExternalStore(
    visible ? clock.subscribe : subscribeWhileHidden,
    clock.getSnapshot,
  );
  const progress = duration > 0 ? clamp(currentTime / duration, 0, 1) : 0;

  return (
    <div
      aria-hidden='true'
      className={cn(
        'pointer-events-none absolute bottom-0 left-[60px] right-0 z-40 h-[3px] bg-white/[0.08] transition-opacity motion-reduce:transition-none',
        // Hands off with the chrome: arrives on its slower exit, leaves on its quick entrance.
        visible
          ? cn(CHROME_EXIT_TIMING_CLASS, 'opacity-100')
          : cn(CHROME_ENTER_TIMING_CLASS, 'opacity-0'),
      )}
    >
      <div
        className='absolute inset-0 origin-left bg-white'
        style={{ transform: `scaleX(${progress})` }}
      />
    </div>
  );
});

interface SkipNotchesProps {
  duration: number;
  skipSegments: SkipSegment[];
  hoverSegment: SkipSegment | null;
}

// Memoized — the bar re-renders per clock tick, but segment geometry only changes with list/duration/hover.
const SkipNotches = memo(function SkipNotches({
  duration,
  skipSegments,
  hoverSegment,
}: SkipNotchesProps) {
  if (duration <= 0) return null;

  return (
    <>
      {skipSegments.map((seg) => {
        const leftPct = clamp((seg.start_time / duration) * 100, 0, 100);
        const widthPct = clamp(
          ((seg.end_time - seg.start_time) / duration) * 100,
          0,
          100 - leftPct,
        );
        const endPct = clamp((seg.end_time / duration) * 100, 0, 100);
        const segmentKey = `${seg.type}:${seg.start_time}:${seg.end_time}`;

        return (
          <Fragment key={segmentKey}>
            {/* Uniform segment band — the playhead nub marks position inside it, so color stays consistent past it. */}
            <div
              className={cn(
                'absolute inset-y-0 pointer-events-none overflow-hidden transition-opacity duration-100 z-10',
                hoverSegment === seg ? 'opacity-100' : 'opacity-85',
                getSegmentStyle(seg.type).color,
              )}
              style={{ left: `${leftPct}%`, width: `max(4px, ${widthPct}%)` }}
            />
            {/* Hard cuts that slice the bar at each segment edge. */}
            {leftPct > 0 && (
              <div
                className='absolute inset-y-0 w-[3px] bg-black z-20'
                style={{ left: `calc(${leftPct}% - 1.5px)` }}
              />
            )}
            {endPct < 100 && (
              <div
                className='absolute inset-y-0 w-[3px] bg-black z-20'
                style={{ left: `calc(${endPct}% - 1.5px)` }}
              />
            )}
          </Fragment>
        );
      })}
    </>
  );
});

interface PlayerProgressBarProps {
  /** Hidden chrome keeps local state without receiving playback ticks. */
  active?: boolean;
  duration: number;
  /** Playback clock — this bar is a tick subscriber; the player tree isn't. */
  clock: PlaybackClock;
  /** Demuxer cache ahead of the playhead — external store like `clock`. */
  bufferedClock: PlaybackClock;
  skipSegments: SkipSegment[];
  /** Stream-scoped reset: clears any in-flight drag preview on source change. */
  resetKey?: string;
  onSeek: (seconds: number) => void | Promise<void>;
}

export function PlayerProgressBar({
  active = true,
  duration,
  clock,
  bufferedClock,
  skipSegments,
  resetKey,
  onSeek,
}: PlayerProgressBarProps) {
  const progressBarRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const [tooltipSize, setTooltipSize] = useState({ rail: 0, tooltip: 0 });
  // The active pointer's id, not a boolean — a second pointer must never share or cancel a drag it didn't start.
  const dragPointerIdRef = useRef<number | null>(null);
  const dragRectRef = useRef<DOMRect | null>(null);
  const hoverRafRef = useRef<number | null>(null);
  const pendingHoverXRef = useRef<number | null>(null);

  // Preview state stays local — pointermove during a drag re-renders this bar only, not the player page.
  const [seekPreviewTime, setSeekPreviewTime] = useState<number | null>(null);
  const subscribeToTicks = active || seekPreviewTime !== null || keyboardFocused;
  const currentTime = useSyncExternalStore(
    subscribeToTicks ? clock.subscribe : subscribeWhileHidden,
    clock.getSnapshot,
  );
  const bufferedAheadSecs = useSyncExternalStore(
    subscribeToTicks ? bufferedClock.subscribe : subscribeWhileHidden,
    bufferedClock.getSnapshot,
  );
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  const hoverTime = hoverPct === null ? null : (hoverPct / 100) * duration;
  const hoverSegment =
    hoverTime === null
      ? null
      : (skipSegments.find((seg) => hoverTime >= seg.start_time && hoverTime <= seg.end_time) ??
        null);

  const getSeekFraction = (clientX: number, rectOverride?: DOMRect | null): number | null => {
    const rect = rectOverride || progressBarRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || !Number.isFinite(duration) || duration <= 0) {
      return null;
    }
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  };

  const scheduleHoverUpdate = (clientX: number) => {
    if (!active) return;
    pendingHoverXRef.current = clientX;
    if (hoverRafRef.current !== null) return;

    hoverRafRef.current = window.requestAnimationFrame(() => {
      hoverRafRef.current = null;
      const pendingClientX = pendingHoverXRef.current;
      pendingHoverXRef.current = null;
      if (pendingClientX === null) return;
      const fraction = getSeekFraction(pendingClientX, dragRectRef.current);
      if (fraction === null) return;
      setHoverPct(fraction * 100);
      if (dragPointerIdRef.current !== null) setSeekPreviewTime(fraction * duration);
    });
  };

  const clearHoverState = useCallback(() => {
    // Cancel the queued frame too — a pending rAF would resurrect hover after the pointer left.
    if (hoverRafRef.current !== null) {
      window.cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = null;
    }
    pendingHoverXRef.current = null;
    setHoverPct(null);
  }, []);

  // Abort the drag without seeking; safe twice — the pointer id clears first, so the release's `lostpointercapture` is a no-op.
  const cancelDrag = useCallback(() => {
    const pointerId = dragPointerIdRef.current;
    if (pointerId === null) return;
    dragPointerIdRef.current = null;
    dragRectRef.current = null;
    if (progressBarRef.current?.hasPointerCapture(pointerId)) {
      progressBarRef.current.releasePointerCapture(pointerId);
    }
    setSeekPreviewTime(null);
    clearHoverState();
  }, [clearHoverState]);

  // Stream/scrub resets and unmount cancel any in-flight drag and queued hover work.
  useEffect(() => {
    cancelDrag();
    clearHoverState();
    return clearHoverState;
  }, [resetKey, cancelDrag, clearHoverState]);

  useEffect(() => {
    const releaseInteraction = () => {
      cancelDrag();
      clearHoverState();
      setKeyboardFocused(false);
    };
    if (!active) releaseInteraction();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') releaseInteraction();
    };
    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null && dragPointerIdRef.current === null) clearHoverState();
    };
    window.addEventListener('blur', releaseInteraction);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('pointerout', handlePointerOut);
    return () => {
      window.removeEventListener('blur', releaseInteraction);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('pointerout', handlePointerOut);
    };
  }, [active, cancelDrag, clearHoverState]);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (dragPointerIdRef.current !== null) return;
    scheduleHoverUpdate(e.clientX);
  };

  const handleMouseLeave = () => {
    if (dragPointerIdRef.current !== null) return;
    clearHoverState();
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    // Gate before claiming the pointer: a second pointer, non-primary button, or unseekable bar must not capture or focus.
    if (!active || dragPointerIdRef.current !== null) return;
    if (e.button !== 0 || !e.isPrimary) return;
    if (!Number.isFinite(duration) || duration <= 0) return;

    const rect = progressBarRef.current?.getBoundingClientRect() || null;
    if (!rect || rect.width <= 0) return;

    const frac = getSeekFraction(e.clientX, rect);
    if (frac === null) return;

    clearHoverState();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Pointer focus must not trip :focus-visible — the ring is for keyboard tabbing only.
    e.currentTarget.focus({ preventScroll: true, focusVisible: false });
    dragPointerIdRef.current = e.pointerId;
    dragRectRef.current = rect;

    setSeekPreviewTime(frac * duration);
    setHoverPct(frac * 100);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== dragPointerIdRef.current) return;
    scheduleHoverUpdate(e.clientX);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.pointerId !== dragPointerIdRef.current) return;

    // Clear the pointer id before releasing capture so `lostpointercapture` can't cancel the seek committing here.
    const pointerId = e.pointerId;
    const rect = dragRectRef.current;
    dragPointerIdRef.current = null;
    dragRectRef.current = null;
    clearHoverState();

    const frac = getSeekFraction(e.clientX, rect);
    if (frac !== null) {
      void Promise.resolve(onSeek(frac * duration)).catch(() => undefined);
      // A mouse released over the bar keeps its hover readout instead of blinking out until the next move.
      if (
        e.pointerType === 'mouse' &&
        rect &&
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      ) {
        setHoverPct(frac * 100);
      }
    }

    if (e.currentTarget.hasPointerCapture(pointerId)) {
      e.currentTarget.releasePointerCapture(pointerId);
    }
    setSeekPreviewTime(null);
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId === dragPointerIdRef.current) cancelDrag();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    )
      return;
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }

    // Shift = fine scrub, matching the global arrow hotkeys (±10, Shift ±5).
    const step = event.shiftKey ? 5 : 10;
    const activeTime = seekPreviewTime ?? clock.ref.current;
    let nextTime: number | null = null;

    switch (event.key) {
      case 'ArrowLeft':
        nextTime = Math.max(0, activeTime - step);
        break;
      case 'ArrowRight':
        nextTime = Math.min(duration, activeTime + step);
        break;
      case 'Home':
        nextTime = 0;
        break;
      case 'End':
        nextTime = duration;
        break;
      default:
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    // No local preview — the parent's optimistic seek updates currentTime; a preview set here would pin the bar at the target.
    void Promise.resolve(onSeek(nextTime)).catch(() => undefined);
  };

  const canSeek = Number.isFinite(duration) && duration > 0;
  const displayTime = seekPreviewTime ?? currentTime;
  const progressPct = duration > 0 ? clamp((displayTime / duration) * 100, 0, 100) : 0;
  const showTooltip = canSeek && (hoverPct !== null || keyboardFocused);
  const tooltipTime = keyboardFocused ? displayTime : (hoverTime ?? displayTime);
  const tooltipPct = keyboardFocused ? progressPct : (hoverPct ?? progressPct);
  const tooltipSegment = keyboardFocused
    ? (skipSegments.find((seg) => displayTime >= seg.start_time && displayTime <= seg.end_time) ??
      null)
    : hoverSegment;
  const tooltipInset = Math.min(tooltipSize.tooltip / 2 + 4, tooltipSize.rail / 2);
  const tooltipLeft = clamp(
    (tooltipPct / 100) * tooltipSize.rail,
    tooltipInset,
    tooltipSize.rail - tooltipInset,
  );

  useLayoutEffect(() => {
    if (!showTooltip) return;
    const rail = progressBarRef.current;
    const tooltip = tooltipRef.current;
    if (!rail || !tooltip) return;
    const measure = () => {
      const railWidth = rail.getBoundingClientRect().width;
      const tooltipWidth = tooltip.getBoundingClientRect().width;
      setTooltipSize((previous) =>
        previous.rail === railWidth && previous.tooltip === tooltipWidth
          ? previous
          : { rail: railWidth, tooltip: tooltipWidth },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [showTooltip]);

  // Buffered band spans playhead → buffered end, anchored to the real position (never the drag preview);
  // clamped — fully-cached local-style streams report cache windows overshooting duration.
  const bufferedEndSecs =
    canSeek && bufferedAheadSecs > 0 ? Math.min(currentTime + bufferedAheadSecs, duration) : null;

  return (
    <div
      ref={progressBarRef}
      data-player-interactive
      role='slider'
      tabIndex={canSeek ? 0 : -1}
      aria-label='Playback progress'
      aria-orientation='horizontal'
      aria-disabled={canSeek ? undefined : true}
      aria-valuemin={0}
      aria-valuemax={canSeek ? duration : 0}
      aria-valuenow={canSeek ? clamp(displayTime, 0, duration) : 0}
      aria-valuetext={`${formatTime(displayTime)} of ${formatTime(duration)}`}
      className='relative cursor-pointer select-none h-8 -my-2 flex items-center rounded-md touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 aria-disabled:cursor-default'
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
      onKeyDown={handleKeyDown}
      onFocus={(event) =>
        setKeyboardFocused(document.hasFocus() && event.currentTarget.matches(':focus-visible'))
      }
      onBlur={() => setKeyboardFocused(false)}
      onPointerDownCapture={() => setKeyboardFocused(false)}
    >
      {showTooltip && (
        <div
          ref={tooltipRef}
          className='absolute bottom-full mb-2 w-max max-w-[calc(100%-8px)] -translate-x-1/2 pointer-events-none z-10 flex flex-col items-center gap-1'
          style={
            tooltipSize.rail > 0
              ? { left: 0, transform: `translateX(${tooltipLeft}px)` }
              : { left: '50%' }
          }
        >
          {tooltipSegment && (
            <span
              className={cn(
                'max-w-full truncate text-[9px] font-bold uppercase tracking-widest px-2 py-[3px] rounded-sm leading-none shadow-lg',
                getSegmentStyle(tooltipSegment.type).badge,
              )}
            >
              {`${SKIP_SEGMENT_LABELS[tooltipSegment.type]} · ${formatTime(tooltipSegment.start_time)}–${formatTime(tooltipSegment.end_time)}`}
            </span>
          )}
          <div className={CHROME_VALUE_BUBBLE_CLASS}>{formatTime(tooltipTime)}</div>
        </div>
      )}

      <div className='relative h-2.5 w-full overflow-hidden rounded-[2px] bg-white/[0.14]'>
        {bufferedEndSecs !== null && bufferedEndSecs > currentTime && (
          <div
            className='absolute inset-0 origin-left bg-white/[0.28] pointer-events-none'
            style={{
              transform: `translateX(${Math.min(100, (currentTime / duration) * 100)}%) scaleX(${(bufferedEndSecs - currentTime) / duration})`,
            }}
          />
        )}

        <div
          className='absolute inset-0 origin-left bg-(--accent-seek) pointer-events-none z-0'
          style={{ transform: `scaleX(${progressPct / 100})` }}
        />

        <SkipNotches duration={duration} skipSegments={skipSegments} hoverSegment={hoverSegment} />

        {hoverPct !== null && canSeek && (
          <div
            className='absolute inset-0 pointer-events-none z-20'
            style={{ transform: `translateX(${hoverPct}%)` }}
          >
            <div className='absolute inset-y-0 left-0 w-px -translate-x-1/2 bg-white/60' />
          </div>
        )}

        {/* Playhead nub sits above slices so position stays readable inside a segment band. */}
        {canSeek && (
          <div
            className='absolute inset-0 pointer-events-none z-30'
            style={{ transform: `translateX(${progressPct}%)` }}
          >
            <div className='absolute inset-y-0 left-0 w-[2px] -translate-x-1/2 bg-(--accent-seek)' />
          </div>
        )}
      </div>
    </div>
  );
}
