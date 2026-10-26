import { Slot } from '@radix-ui/react-slot';
import { Check, Link2, Plus } from 'lucide-react';
import * as React from 'react';
import { useMountedRef } from '@/hooks/use-mounted-ref';

import { cn } from '@/lib/utils';

const BUTTON_VARIANTS = {
  default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
  destructive: 'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90',
  outline:
    'border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground',
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

/** Membership feedback keeps the control's dimensions fixed. */
function SaveIndicator({ saved, className }: { saved: boolean; className?: string }) {
  return (
    <span aria-hidden='true' className={cn('relative size-4 shrink-0', className)}>
      <Plus
        className={cn(
          'absolute inset-0 size-full transition-opacity duration-150 motion-reduce:transition-none',
          saved ? 'opacity-0' : 'opacity-100',
        )}
      />
      <Check
        className={cn(
          'absolute inset-0 size-full transition-[opacity,transform] duration-150 motion-reduce:transition-none',
          saved ? 'translate-y-0 opacity-100' : 'translate-y-0.5 opacity-0',
        )}
      />
    </span>
  );
}

function CopyButton({
  onCopy,
  className,
  title,
  ...props
}: Omit<React.ComponentProps<'button'>, 'onClick' | 'children'> & {
  onCopy: () => Promise<boolean>;
}) {
  const [state, setState] = React.useState<'idle' | 'copying' | 'copied'>('idle');
  const mountedRef = useMountedRef();
  const copied = state === 'copied';
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setState('idle'), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type='button'
      {...props}
      title={copied ? 'Copied' : title}
      aria-busy={state === 'copying' || undefined}
      aria-disabled={state !== 'idle' || undefined}
      data-copied={copied}
      className={cn(
        'copy-button transition-[background-color,border-color,color] duration-150 data-[copied=true]:border-(--accent-act)/20 data-[copied=true]:bg-(--accent-act)/10 data-[copied=true]:text-(--accent-act) motion-reduce:transition-none',
        className,
      )}
      onClick={() => {
        if (state !== 'idle') return;
        setState('copying');
        void onCopy().then(
          (success) => {
            if (mountedRef.current) setState(success ? 'copied' : 'idle');
          },
          () => {
            if (mountedRef.current) setState('idle');
          },
        );
      }}
    >
      <span aria-hidden='true' className='relative size-4 shrink-0'>
        <Link2
          className={cn(
            'absolute inset-0 size-full transition-opacity duration-150 motion-reduce:transition-none',
            copied ? 'opacity-0' : 'opacity-100',
          )}
        />
        <Check
          className={cn(
            'copy-check absolute inset-0 size-full transition-opacity duration-150 motion-reduce:transition-none',
            copied ? 'opacity-100' : 'opacity-0',
          )}
        />
      </span>
    </button>
  );
}

export { Button, CopyButton, SaveIndicator };
