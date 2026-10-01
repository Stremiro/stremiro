import * as SliderPrimitive from '@radix-ui/react-slider';
import React from 'react';
import { cn } from '@/lib/utils';

interface PlayerSliderProps extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
  /** 'bar' matches the playback progress bar: a blocky rounded track with an
      always-visible nub thumb instead of the pill track's hover-grow. */
  variant?: 'pill' | 'bar';
}

export const PlayerSlider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  PlayerSliderProps
>(
  (
    {
      className,
      variant = 'pill',
      'aria-label': ariaLabel,
      'aria-valuetext': ariaValueText,
      ...props
    },
    ref,
  ) => (
    <SliderPrimitive.Root
      ref={ref}
      className={cn(
        'relative flex w-full touch-none select-none items-center group/slider cursor-pointer',
        variant === 'bar' ? 'h-9' : 'h-5',
        className,
      )}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      {...props}
    >
      <SliderPrimitive.Track
        className={cn(
          'relative w-full grow overflow-hidden',
          variant === 'bar'
            ? 'h-2 rounded-[3px] bg-white/[0.16] transition-[height] duration-150 group-hover/slider:h-[10px] group-focus-within/slider:h-[10px] motion-reduce:transition-none'
            : 'h-[5px] rounded-full bg-white/15 transition-[height] duration-150 group-hover/slider:h-[7px]',
        )}
      >
        <SliderPrimitive.Range className='absolute h-full bg-white' />
      </SliderPrimitive.Track>
      {/* Radix reads `aria-label`/`aria-valuetext` off the Thumb (the
        role=slider element) — the Root prop lands on an inert wrapper div. */}
      <SliderPrimitive.Thumb
        aria-label={ariaLabel}
        aria-valuetext={ariaValueText}
        className={cn(
          'block cursor-pointer',
          variant === 'bar'
            ? // Blocky nub — the playback bar's playhead shape at slider scale.
              'h-[14px] w-[6px] rounded-[2px] bg-white shadow-[0_1px_4px_rgba(0,0,0,0.5)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black'
            : // Pill thumb stays invisible until hover/focus/scrub (touch has no
              // hover — without the active state the handle is invisible for the
              // whole drag).
              'h-4 w-4 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.5)] opacity-0 transition-opacity duration-150 group-hover/slider:opacity-100 group-focus-within/slider:opacity-100 active:opacity-100 motion-reduce:transition-none',
        )}
      />
    </SliderPrimitive.Root>
  ),
);

PlayerSlider.displayName = SliderPrimitive.Root.displayName;
