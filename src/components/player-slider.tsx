import * as SliderPrimitive from '@radix-ui/react-slider';
import React from 'react';
import { cn } from '@/lib/utils';

interface PlayerSliderProps extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
  /** 'bar' (volume): thin round track with an always-visible round thumb. 'pill': hairline track, slim nub shown on hover/focus/scrub. 'track' (mini seek): the bar alone, no thumb or hover change. */
  variant?: 'pill' | 'bar' | 'track';
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
          'relative w-full grow overflow-hidden rounded-full bg-white/20',
          variant === 'bar' && 'h-1',
          variant === 'track' &&
            'h-1 group-has-[:focus-visible]/slider:ring-2 group-has-[:focus-visible]/slider:ring-white/60',
          variant === 'pill' &&
            'h-[3px] transition-[height] duration-150 group-hover/slider:h-[5px] group-focus-within/slider:h-[5px] motion-reduce:transition-none',
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
          'block cursor-pointer focus-visible:outline-none',
          variant !== 'track' &&
            'bg-white focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black',
          variant === 'bar' &&
            'h-3 w-3 rounded-full shadow-[0_1px_4px_rgba(0,0,0,0.5)] transition-transform duration-150 group-hover/slider:scale-110 motion-reduce:transition-none',
          // Touch has no hover — active keeps the nub visible for the whole drag.
          variant === 'pill' &&
            'h-[10px] w-[3px] rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.5)] opacity-0 transition-opacity duration-150 group-hover/slider:opacity-100 group-focus-within/slider:opacity-100 active:opacity-100 motion-reduce:transition-none',
          // Invisible but kept: the thumb is the focusable role=slider; focus shows on the track instead.
          variant === 'track' && 'h-3 w-0',
        )}
      />
    </SliderPrimitive.Root>
  ),
);

PlayerSlider.displayName = SliderPrimitive.Root.displayName;
