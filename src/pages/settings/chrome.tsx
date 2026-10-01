import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Glass chrome for outline `Button`s across sections; callers own size. */
export const SETTINGS_OUTLINE_BUTTON_CLASS =
  'rounded-lg border-white/10 bg-white/[0.04] font-medium text-zinc-100 hover:bg-white/[0.08] hover:text-white';

export function SettingsGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.025]',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function SettingsGroupHeader({
  action,
  description,
  title,
}: {
  action?: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <div className='flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4'>
      <div className='min-w-0'>
        <h3 className='text-[15px] font-semibold tracking-tight text-white'>{title}</h3>
        {description ? (
          <p className='mt-1 text-[13px] leading-relaxed text-zinc-500'>{description}</p>
        ) : null}
      </div>
      {action ? <div className='shrink-0'>{action}</div> : null}
    </div>
  );
}

export function SettingsBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-5 py-4', className)}>{children}</div>;
}

export function SettingsRow({
  children,
  className,
  description,
  label,
}: {
  children: ReactNode;
  className?: string;
  description?: string;
  label: string;
}) {
  return (
    <label className={cn('flex items-center justify-between gap-6 cursor-pointer', className)}>
      <div className='min-w-0'>
        <span className='block text-[14px] font-medium text-zinc-100'>{label}</span>
        {description ? (
          <span className='mt-0.5 block text-[12.5px] leading-relaxed text-zinc-500'>
            {description}
          </span>
        ) : null}
      </div>
      <div className='shrink-0'>{children}</div>
    </label>
  );
}

export function SettingsSwitch({
  ariaLabel,
  checked,
  disabled,
  onChange,
}: {
  ariaLabel: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type='button'
      role='switch'
      aria-label={ariaLabel}
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/20',
        !checked && 'bg-zinc-800',
        disabled && 'cursor-not-allowed opacity-50',
      )}
      style={checked ? { backgroundColor: 'var(--accent-act)' } : undefined}
    >
      <span
        className={cn(
          'inline-block h-[18px] w-[18px] rounded-full transition-[translate,background-color] duration-200',
          checked ? 'translate-x-[22px] bg-(--on-accent-act)' : 'translate-x-0.5 bg-zinc-400',
        )}
      />
    </button>
  );
}
