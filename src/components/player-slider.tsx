import * as SliderPrimitive from '@radix-ui/react-slider';
import React, { useRef, useState } from 'react';
import { chapterCutMask } from '@/lib/player-chapter-cuts';
import { clamp, cn } from '@/lib/utils';

export interface PlayerSliderMark {
  start: number;
  end: number;
  className: string;
}

interface PlayerSliderProps extends React.ComponentPropsWithRef<typeof SliderPrimitive.Root> {
  /** Fixed tracks: volume bar, hairline with a focus/hover nub, or mini seek without a thumb. */
  variant?: 'pill' | 'bar' | 'track';
  active?: boolean;
  /** Painted bands on the track, in the same units as `max`. */
  marks?: readonly PlayerSliderMark[];
  /** Hover or drag target in the same units as `max`. `null` when the pointer leaves. */
  onAimChange?: (value: number | null) => void;
}

export function PlayerSlider({
  className,
  variant = 'pill',
  active = true,
  marks,
  onAimChange,
  'aria-label': ariaLabel,
  'aria-valuetext': ariaValueText,
  onPointerDown,
  onPointerMove,
  onPointerLeave,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  onFocus,
  onBlur,
  ...props
}: PlayerSliderProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const [aimPct, setAimPct] = useState<number | null>(null);
  if (!active && keyboardFocused) setKeyboardFocused(false);

  const max = typeof props.max === 'number' && props.max > 0 ? props.max : 100;
  const current = Array.isArray(props.value) ? props.value[0] : undefined;
  const valuePct = typeof current === 'number' ? clamp(current / max, 0, 1) : null;
  // `bar` keeps a resting value marker (volume); `track` is a hover line — the fill edge already marks position.
  const markerPct = variant === 'track' ? aimPct : (aimPct ?? valuePct);
  const marksMask = marks?.length
    ? chapterCutMask(
        max,
        marks.flatMap((mark) => [mark.start, mark.end]),
      )
    : undefined;
  const aimFromPointer = (clientX: number) => {
    if (variant === 'pill') return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const next = clamp((clientX - rect.left) / rect.width, 0, 1);
    setAimPct(next);
    onAimChange?.(Math.round(next * max));
  };
  const clearAim = () => {
    setAimPct(null);
    if (variant !== 'pill') onAimChange?.(null);
  };
  // Pointer capture can swallow a leave that ends outside — recheck the rect on release.
  const settleAim = (event: React.PointerEvent) => {
    if (variant === 'pill') return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (
      rect &&
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    ) {
      aimFromPointer(event.clientX);
    } else {
      clearAim();
    }
  };

  return (
    <SliderPrimitive.Root
      ref={rootRef}
      data-keyboard-focus={keyboardFocused ? '' : undefined}
      className={cn(
        'relative flex w-full touch-none select-none items-center group/slider cursor-pointer data-[disabled]:cursor-default data-[disabled]:opacity-35',
        variant === 'bar' ? 'h-9' : 'h-5',
        className,
      )}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(event) => {
        event.stopPropagation();
        setKeyboardFocused(false);
        if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
          event.preventDefault();
          return;
        }
        aimFromPointer(event.clientX);
        onPointerDown?.(event);
      }}
      onPointerMove={(event) => {
        aimFromPointer(event.clientX);
        onPointerMove?.(event);
      }}
      onPointerLeave={(event) => {
        clearAim();
        onPointerLeave?.(event);
      }}
      onPointerUp={(event) => {
        settleAim(event);
        onPointerUp?.(event);
      }}
      onPointerCancel={(event) => {
        clearAim();
        onPointerCancel?.(event);
      }}
      onLostPointerCapture={(event) => {
        settleAim(event);
        onLostPointerCapture?.(event);
      }}
      onFocus={(event) => {
        setKeyboardFocused(document.hasFocus() && event.target.matches(':focus-visible'));
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setKeyboardFocused(false);
        onBlur?.(event);
      }}
      {...props}
    >
      <SliderPrimitive.Track
        className={cn(
          'relative w-full grow overflow-hidden',
          variant === 'bar'
            ? 'h-1.5 rounded-[2px] group-data-[keyboard-focus]/slider:ring-2 group-data-[keyboard-focus]/slider:ring-white/60'
            : variant === 'track'
              ? 'h-2 rounded-[2px] group-data-[keyboard-focus]/slider:ring-2 group-data-[keyboard-focus]/slider:ring-white/60'
              : 'h-[3px] rounded-full',
        )}
      >
        {/* Fill layers share the chapter mask; the marker stays uncut above it. */}
        <div
          aria-hidden='true'
          className={cn(
            'absolute inset-0',
            variant === 'bar'
              ? 'bg-white/[0.16]'
              : variant === 'track'
                ? 'bg-white/[0.18]'
                : 'bg-white/20',
          )}
          style={marksMask ? { maskImage: marksMask } : undefined}
        >
          <SliderPrimitive.Range className='absolute h-full bg-white' />
          {marks?.map((mark) => {
            const left = clamp(mark.start / max, 0, 1) * 100;
            const width = clamp((mark.end - mark.start) / max, 0, 1 - left / 100) * 100;
            if (width <= 0) return null;
            return (
              <span
                key={`${mark.start}:${mark.end}`}
                aria-hidden='true'
                className={cn('pointer-events-none absolute inset-y-0 z-10', mark.className)}
                style={{ left: `${left}%`, width: `max(2px, ${width}%)` }}
              />
            );
          })}
        </div>
        {variant !== 'pill' && markerPct !== null && !props.disabled && (
          <span
            aria-hidden='true'
            className={cn(
              'pointer-events-none absolute z-20 w-px -translate-x-1/2 bg-white mix-blend-difference shadow-[0_0_0_1px_rgba(0,0,0,0.55)]',
              variant === 'track' ? '-inset-y-1' : 'inset-y-0',
            )}
            style={{ left: `${markerPct * 100}%` }}
          />
        )}
      </SliderPrimitive.Track>
      {/* Radix reads `aria-label`/`aria-valuetext` off the Thumb (the
        role=slider element) — the Root prop lands on an inert wrapper div. */}
      <SliderPrimitive.Thumb
        aria-label={ariaLabel}
        aria-valuetext={ariaValueText}
        className={cn(
          'block cursor-pointer focus-visible:outline-none data-[disabled]:cursor-default',
          // Touch has no hover — active keeps the nub visible for the whole drag.
          variant === 'pill' &&
            'h-[10px] w-[3px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.5)] opacity-0 transition-opacity duration-150 group-hover/slider:opacity-100 group-data-[keyboard-focus]/slider:opacity-100 group-active/slider:opacity-100 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black motion-reduce:transition-none',
          // Invisible but kept: the thumb is the focusable role=slider; focus shows on the track instead.
          variant !== 'pill' && 'h-3 w-0',
        )}
      />
    </SliderPrimitive.Root>
  );
}
