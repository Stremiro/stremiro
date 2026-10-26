import * as SliderPrimitive from '@radix-ui/react-slider';
import React, { useState } from 'react';
import { cn } from '@/lib/utils';

interface PlayerSliderProps extends React.ComponentPropsWithRef<typeof SliderPrimitive.Root> {
  /** Fixed tracks: volume bar, hairline with a focus/hover nub, or mini seek without a thumb. */
  variant?: 'pill' | 'bar' | 'track';
  active?: boolean;
}

export function PlayerSlider({
  className,
  variant = 'pill',
  active = true,
  'aria-label': ariaLabel,
  'aria-valuetext': ariaValueText,
  onPointerDown,
  onFocus,
  onBlur,
  ...props
}: PlayerSliderProps) {
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  if (!active && keyboardFocused) setKeyboardFocused(false);

  return (
    <SliderPrimitive.Root
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
        onPointerDown?.(event);
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
            ? 'h-1.5 rounded-[3px] bg-white/[0.16] group-data-[keyboard-focus]/slider:ring-2 group-data-[keyboard-focus]/slider:ring-white/60'
            : 'rounded-full bg-white/20',
          variant === 'track' &&
            'h-1 group-data-[keyboard-focus]/slider:ring-2 group-data-[keyboard-focus]/slider:ring-white/60',
          variant === 'pill' && 'h-[3px]',
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
            'h-[10px] w-[3px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.5)] opacity-0 transition-opacity duration-150 group-hover/slider:opacity-100 group-data-[keyboard-focus]/slider:opacity-100 group-active/slider:opacity-100 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black motion-reduce:transition-none',
          // Invisible but kept: the thumb is the focusable role=slider; focus shows on the track instead.
          variant !== 'pill' && 'h-3 w-0',
        )}
      />
    </SliderPrimitive.Root>
  );
}
