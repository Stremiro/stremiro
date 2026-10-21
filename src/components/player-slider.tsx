import * as SliderPrimitive from '@radix-ui/react-slider';
import React from 'react';
import { cn } from '@/lib/utils';

interface PlayerSliderProps extends React.ComponentPropsWithRef<typeof SliderPrimitive.Root> {
  /** 'bar' (volume): seek-bar style line that thickens on hover, no thumb. 'pill': hairline track, slim nub shown on hover/focus/scrub. 'track' (mini seek): the bar alone, no thumb or hover change. */
  variant?: 'pill' | 'bar' | 'track';
}

export function PlayerSlider({
  className,
  variant = 'pill',
  'aria-label': ariaLabel,
  'aria-valuetext': ariaValueText,
  onPointerDown,
  ...props
}: PlayerSliderProps) {
  return (
    <SliderPrimitive.Root
      className={cn(
        'relative flex w-full touch-none select-none items-center group/slider cursor-pointer data-[disabled]:cursor-default data-[disabled]:opacity-35',
        variant === 'bar' ? 'h-9' : 'h-5',
        className,
      )}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
          event.preventDefault();
          return;
        }
        onPointerDown?.(event);
      }}
      {...props}
    >
      <SliderPrimitive.Track
        className={cn(
          'relative w-full grow overflow-hidden',
          variant === 'bar'
            ? 'h-2 scale-y-75 rounded-[3px] bg-white/[0.16] transition-transform duration-150 group-hover/slider:scale-y-100 group-has-[:focus-visible]/slider:scale-y-100 group-has-[:focus-visible]/slider:ring-2 group-has-[:focus-visible]/slider:ring-white/60 motion-reduce:transition-none'
            : 'rounded-full bg-white/20',
          variant === 'track' &&
            'h-1 group-has-[:focus-visible]/slider:ring-2 group-has-[:focus-visible]/slider:ring-white/60',
          variant === 'pill' &&
            'h-[5px] scale-y-60 transition-transform duration-150 group-hover/slider:scale-y-100 group-focus-within/slider:scale-y-100 motion-reduce:transition-none',
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
          'block cursor-pointer focus-visible:outline-none data-[disabled]:cursor-default',
          // Touch has no hover — active keeps the nub visible for the whole drag.
          variant === 'pill' &&
            'h-[10px] w-[3px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.5)] opacity-0 transition-opacity duration-150 group-hover/slider:opacity-100 group-focus-within/slider:opacity-100 active:opacity-100 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black motion-reduce:transition-none',
          // Invisible but kept: the thumb is the focusable role=slider; focus shows on the track instead.
          variant !== 'pill' && 'h-3 w-0',
        )}
      />
    </SliderPrimitive.Root>
  );
}
