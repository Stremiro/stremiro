import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { SkipSegment } from '@/lib/api';
import type { PlaybackClock } from '@/lib/player-clock';
import { getSkipLabel } from '@/lib/player-skip';
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

function getSegmentStyle(type: string): { color: string; badge: string } {
  return SKIP_SEGMENT_STYLES[type] ?? FALLBACK_SKIP_SEGMENT_STYLE;
}

interface SkipNotchesProps {
  duration: number;
  skipSegments: SkipSegment[];
  hoverSegment: SkipSegment | null;
}

// Memoized: the bar re-renders on every clock tick for the playhead, but the
// segment geometry only changes with the segment list, duration, or hover.
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
            {/* Uniform segment band — the playhead nub marks position inside
                it, so the color stays consistent before and after it's passed. */}
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
  duration,
  clock,
  bufferedClock,
  skipSegments,
  resetKey,
  onSeek,
}: PlayerProgressBarProps) {
  const progressBarRef = useRef<HTMLDivElement>(null);
  // The active pointer's id, not a boolean: a second pointer (touch + mouse,
  // two fingers) must never share or cancel a drag it didn't start.
  const dragPointerIdRef = useRef<number | null>(null);
  const dragRectRef = useRef<DOMRect | null>(null);
  const hoverRafRef = useRef<number | null>(null);
  const pendingHoverXRef = useRef<number | null>(null);

  // Preview state stays local: pointermove during a drag re-renders this bar
  // only, not the whole player page.
  const [seekPreviewTime, setSeekPreviewTime] = useState<number | null>(null);
  const currentTime = useSyncExternalStore(clock.subscribe, clock.getSnapshot);
  const bufferedAheadSecs = useSyncExternalStore(
    bufferedClock.subscribe,
    bufferedClock.getSnapshot,
  );
  const [showRemainingTime, setShowRemainingTime] = useState(false);
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  const [hoverSegment, setHoverSegment] = useState<SkipSegment | null>(null);

  const updateHoverAtClientX = useCallback(
    (clientX: number, rectOverride?: DOMRect | null) => {
      const rect = rectOverride || progressBarRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || !Number.isFinite(duration) || duration <= 0) return;

      const pct = clamp(((clientX - rect.left) / rect.width) * 100, 0, 100);
      const hoverTime = (pct / 100) * duration;
      const segment =
        skipSegments.find((seg) => hoverTime >= seg.start_time && hoverTime <= seg.end_time) ||
        null;

      setHoverPct(pct);
      setHoverSegment(segment);
    },
    [duration, skipSegments],
  );

  const scheduleHoverUpdate = useCallback(
    (clientX: number) => {
      pendingHoverXRef.current = clientX;
      if (hoverRafRef.current !== null) return;

      hoverRafRef.current = window.requestAnimationFrame(() => {
        hoverRafRef.current = null;
        const pendingClientX = pendingHoverXRef.current;
        if (pendingClientX === null) return;
        updateHoverAtClientX(pendingClientX);
      });
    },
    [updateHoverAtClientX],
  );

  const getSeekFraction = useCallback(
    (clientX: number, rectOverride?: DOMRect | null): number | null => {
      const rect = rectOverride || progressBarRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || !Number.isFinite(duration) || duration <= 0) {
        return null;
      }
      return clamp((clientX - rect.left) / rect.width, 0, 1);
    },
    [duration],
  );

  const clearHoverState = useCallback(() => {
    // Cancel the queued frame too: a pending rAF would otherwise resurrect
    // hover state after the pointer already left.
    if (hoverRafRef.current !== null) {
      window.cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = null;
    }
    pendingHoverXRef.current = null;
    setHoverPct(null);
    setHoverSegment(null);
  }, []);

  // Abort the active drag without seeking. Safe to call twice: the pointer
  // id is cleared first, so the `lostpointercapture` fired by the release
  // below is a no-op.
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

  // Stream/scrub resets cancel any in-flight drag and queued hover work.
  useEffect(() => {
    cancelDrag();
    clearHoverState();
  }, [resetKey, cancelDrag, clearHoverState]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (dragPointerIdRef.current !== null) return;
      scheduleHoverUpdate(e.clientX);
    },
    [scheduleHoverUpdate],
  );

  const handleMouseLeave = useCallback(() => {
    if (dragPointerIdRef.current !== null) return;
    clearHoverState();
  }, [clearHoverState]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      // Gate before claiming the pointer: a second pointer, a non-primary
      // button, or an unseekable bar must not capture or focus.
      if (dragPointerIdRef.current !== null) return;
      if (e.button !== 0 || !e.isPrimary) return;
      if (!Number.isFinite(duration) || duration <= 0) return;

      const rect = progressBarRef.current?.getBoundingClientRect() || null;
      if (!rect || rect.width <= 0) return;

      const frac = getSeekFraction(e.clientX, rect);
      if (frac === null) return;

      clearHoverState();
      e.currentTarget.setPointerCapture(e.pointerId);
      // Pointer focus must not trip :focus-visible — the ring is for
      // keyboard tabbing only, a click shouldn't paint a box around the bar.
      e.currentTarget.focus({ preventScroll: true, focusVisible: false });
      dragPointerIdRef.current = e.pointerId;
      dragRectRef.current = rect;

      setSeekPreviewTime(frac * duration);
      updateHoverAtClientX(e.clientX, rect);
    },
    [clearHoverState, duration, getSeekFraction, updateHoverAtClientX],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerId !== dragPointerIdRef.current) return;

      const frac = getSeekFraction(e.clientX, dragRectRef.current);
      if (frac === null) return;

      setSeekPreviewTime(frac * duration);
      updateHoverAtClientX(e.clientX, dragRectRef.current);
    },
    [duration, getSeekFraction, updateHoverAtClientX],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (e.pointerId !== dragPointerIdRef.current) return;

      // Clear the pointer id before releasing capture so the resulting
      // `lostpointercapture` cannot cancel the seek being committed here.
      const pointerId = e.pointerId;
      dragPointerIdRef.current = null;

      const frac = getSeekFraction(e.clientX, dragRectRef.current);
      if (frac !== null) {
        void Promise.resolve(onSeek(frac * duration)).catch(() => undefined);
      }

      if (e.currentTarget.hasPointerCapture(pointerId)) {
        e.currentTarget.releasePointerCapture(pointerId);
      }
      dragRectRef.current = null;
      setSeekPreviewTime(null);
      clearHoverState();
    },
    [clearHoverState, duration, getSeekFraction, onSeek],
  );

  const handlePointerCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerId === dragPointerIdRef.current) cancelDrag();
    },
    [cancelDrag],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
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
      const activeTime = seekPreviewTime ?? currentTime;
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
      // No local preview: the parent's optimistic seek updates currentTime,
      // and a preview left set here would pin the bar at the seek target.
      void Promise.resolve(onSeek(nextTime)).catch(() => undefined);
    },
    [currentTime, duration, onSeek, seekPreviewTime],
  );

  // Unmount: cancel queued work only — state writes on a dead component are
  // wasted renders, and a dangling capture belongs to the removed element.
  useEffect(() => {
    return () => {
      if (hoverRafRef.current !== null) {
        window.cancelAnimationFrame(hoverRafRef.current);
        hoverRafRef.current = null;
      }
      pendingHoverXRef.current = null;
    };
  }, []);

  const canSeek = Number.isFinite(duration) && duration > 0;

  // Buffered band spans playhead → buffered end. Anchored to the real
  // position (never the drag preview) and clamped: fully-cached local-style
  // streams report cache windows that overshoot duration.
  const bufferedEndSecs =
    canSeek && bufferedAheadSecs > 0 ? Math.min(currentTime + bufferedAheadSecs, duration) : null;

  return (
    <>
      {/* Time display — right-aligned above the progress bar; click toggles remaining. */}
      <div className='flex items-center justify-end px-0.5 pb-2'>
        <div className='shrink-0'>
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation();
              setShowRemainingTime((v) => !v);
            }}
            aria-pressed={showRemainingTime}
            aria-label={showRemainingTime ? 'Show elapsed time' : 'Show remaining time'}
            className='text-[13px] font-mono text-white/75 tabular-nums leading-none hover:text-white transition-colors duration-150 cursor-pointer select-none'
            title={showRemainingTime ? 'Show elapsed time' : 'Show remaining time'}
          >
            {showRemainingTime && duration > 0 ? (
              <>
                <span className='text-white/40'>-</span>
                {formatTime(Math.max(0, duration - (seekPreviewTime ?? currentTime)))}
                <span className='text-white/30'> / </span>
                {formatTime(duration)}
              </>
            ) : (
              <>
                {formatTime(seekPreviewTime ?? currentTime)}
                <span className='text-white/30'> / </span>
                {formatTime(duration)}
              </>
            )}
          </button>
        </div>
      </div>

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
        aria-valuenow={
          canSeek ? Math.max(0, Math.min(duration, seekPreviewTime ?? currentTime)) : 0
        }
        aria-valuetext={formatTime(seekPreviewTime ?? currentTime)}
        className='relative group/bar cursor-pointer select-none h-8 -my-2 flex items-center touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handlePointerCancel}
        onKeyDown={handleKeyDown}
      >
        {hoverPct !== null && duration > 0 && (
          <div
            className='absolute bottom-full mb-2 -translate-x-1/2 pointer-events-none z-10 flex flex-col items-center gap-1'
            style={{ left: `${clamp(hoverPct, 5, 95)}%` }}
          >
            {hoverSegment && (
              <span
                className={cn(
                  'text-[9px] font-bold uppercase tracking-widest px-2 py-[3px] rounded-sm leading-none shadow-lg',
                  getSegmentStyle(hoverSegment.type).badge,
                )}
              >
                {getSkipLabel(hoverSegment.type)}
              </span>
            )}
            <div className='bg-zinc-900/95 text-white text-[11px] font-mono tabular-nums whitespace-nowrap px-2.5 py-[5px] rounded-md shadow-xl leading-none border border-white/10'>
              {formatTime((hoverPct / 100) * duration)}
            </div>
          </div>
        )}

        <div className='relative w-full h-2 group-hover/bar:h-[10px] transition-[height] duration-150 rounded-[3px] overflow-hidden bg-white/[0.16]'>
          {hoverPct !== null && duration > 0 && (
            <div
              className='absolute inset-y-0 left-0 bg-white/25 pointer-events-none'
              style={{ width: `${hoverPct}%` }}
            />
          )}

          {bufferedEndSecs !== null && bufferedEndSecs > currentTime && (
            <div
              className='absolute inset-y-0 bg-white/[0.28] pointer-events-none'
              style={{
                left: `${Math.min(100, (currentTime / duration) * 100)}%`,
                width: `${((bufferedEndSecs - currentTime) / duration) * 100}%`,
              }}
            />
          )}

          <div
            className='absolute inset-y-0 left-0 bg-white pointer-events-none z-0'
            style={{
              width:
                duration > 0
                  ? `${Math.min(100, ((seekPreviewTime ?? currentTime) / duration) * 100)}%`
                  : '0%',
            }}
          />

          <SkipNotches
            duration={duration}
            skipSegments={skipSegments}
            hoverSegment={hoverSegment}
          />

          {/* Playhead nub sits above slices so position stays readable inside
              a segment band. */}
          {duration > 0 && (seekPreviewTime ?? currentTime) > 0 && (
            <div
              className='absolute inset-y-0 w-[2px] -translate-x-1/2 bg-white pointer-events-none z-30'
              style={{
                left: `${Math.min(100, ((seekPreviewTime ?? currentTime) / duration) * 100)}%`,
              }}
            />
          )}
        </div>
      </div>
    </>
  );
}
