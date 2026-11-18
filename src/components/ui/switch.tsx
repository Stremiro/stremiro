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
        'inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border p-[3px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-act)/50 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 motion-reduce:transition-none',
        checked
          ? 'border-transparent bg-(--accent-act) text-(--on-accent-act)'
          : 'border-white/20 bg-white/[0.1] text-zinc-300 hover:border-white/30 hover:bg-white/[0.14]',
        disabled && 'cursor-not-allowed opacity-45',
        pending && !disabled && 'cursor-default',
        className,
      )}
    >
      <span
        aria-hidden='true'
        className={cn(
          'size-[18px] rounded-full bg-current shadow-sm transition-transform duration-150 motion-reduce:transition-none',
          checked ? 'translate-x-[22px]' : 'translate-x-0',
        )}
      />
    </button>
  );
}
