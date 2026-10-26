import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Switch({
  ariaDescribedBy,
  ariaLabel,
  checked,
  className,
  disabled,
  pending,
  onChange,
}: {
  ariaDescribedBy?: string;
  ariaLabel: string;
  checked: boolean;
  className?: string;
  disabled?: boolean;
  /** Blocks toggling but stays focusable, so a save never drops keyboard focus. */
  pending?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type='button'
      role='switch'
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-checked={checked}
      aria-busy={pending || undefined}
      aria-disabled={disabled || pending || undefined}
      disabled={disabled}
      onClick={() => {
        if (!pending) onChange();
      }}
      className={cn(
        'inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[7px] border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-act)/50 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 motion-reduce:transition-none',
        checked
          ? 'border-transparent bg-(--accent-act) text-(--on-accent-act)'
          : 'border-white/15 bg-white/[0.04] text-transparent hover:border-white/25 hover:bg-white/[0.08]',
        disabled && 'cursor-not-allowed opacity-45',
        pending && !disabled && 'cursor-default',
        className,
      )}
    >
      <Check
        aria-hidden='true'
        strokeWidth={3}
        className={cn(
          'h-3.5 w-3.5 transition-[opacity,scale] duration-150 motion-reduce:transition-none',
          checked ? 'scale-100 opacity-100' : 'scale-75 opacity-0',
        )}
      />
    </button>
  );
}
