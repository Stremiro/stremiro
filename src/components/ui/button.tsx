import { Slot } from '@radix-ui/react-slot';
import { Check, Plus } from 'lucide-react';
import * as React from 'react';

import { cn, prefersReducedMotion } from '@/lib/utils';

const BUTTON_VARIANTS = {
  default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
  accent: 'accent-lattice hover:brightness-110',
  destructive: 'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90',
  outline:
    'border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground',
  secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
};

const BUTTON_SIZES = {
  default: 'h-9 px-4 py-2',
  sm: 'h-8 rounded-md px-3 text-xs',
  icon: 'h-9 w-9',
};

interface ButtonProps extends React.ComponentProps<'button'> {
  variant?: keyof typeof BUTTON_VARIANTS | null;
  size?: keyof typeof BUTTON_SIZES | null;
  asChild?: boolean;
}

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
        variant && BUTTON_VARIANTS[variant],
        size && BUTTON_SIZES[size],
        className,
      )}
      {...props}
    />
  );
}

/** Library membership only; list membership keeps its own bookmark vocabulary. */
function SaveIndicator({ saved, className }: { saved: boolean; className?: string }) {
  return (
    <span
      aria-hidden='true'
      data-save-indicator
      className={cn('relative size-4 shrink-0', className)}
    >
      <span
        data-save-ring
        className='pointer-events-none absolute -inset-1 rounded-full border border-(--accent-act) opacity-0'
      />
      <Plus
        className={cn(
          'absolute inset-0 size-full transition-[opacity,transform] duration-150 motion-reduce:transition-none',
          saved ? 'scale-75 opacity-0' : 'scale-100 opacity-100',
        )}
      />
      <Check
        className={cn(
          'absolute inset-0 size-full transition-[opacity,transform] duration-150 motion-reduce:transition-none',
          saved ? 'scale-100 opacity-100' : 'scale-75 opacity-0',
        )}
      />
    </span>
  );
}

/** Call only after accepting a user add — query hydration must never pulse. */
function animateLibrarySave(control: HTMLElement) {
  if (prefersReducedMotion()) return;
  const indicator = control.querySelector<HTMLElement>('[data-save-indicator]');
  indicator?.animate(
    [
      { transform: 'scale(1)' },
      { transform: 'scale(1.25)', offset: 0.45 },
      { transform: 'scale(1)' },
    ],
    { duration: 220, easing: 'ease-out' },
  );
  indicator?.querySelector<HTMLElement>('[data-save-ring]')?.animate(
    [
      { transform: 'scale(0.9)', opacity: 0.45 },
      { transform: 'scale(1.5)', opacity: 0 },
    ],
    { duration: 220, easing: 'ease-out' },
  );
}

export { Button, SaveIndicator, animateLibrarySave };
