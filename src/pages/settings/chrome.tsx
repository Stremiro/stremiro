import type { ReactNode } from 'react';
import { RetryBanner } from '@/components/retry-banner';
import { cn } from '@/lib/utils';

export function SettingsQueryError({
  query,
  message,
  className,
}: {
  query: {
    isError: boolean;
    isFetching: boolean;
    errorUpdatedAt: number;
    dataUpdatedAt: number;
    refetch: () => Promise<unknown>;
  };
  message: string;
  className?: string;
}) {
  if (!query.isError && query.errorUpdatedAt <= query.dataUpdatedAt) return null;
  return (
    <RetryBanner
      className={className}
      message={message}
      isRetrying={query.isFetching}
      onRetry={() => void query.refetch()}
    />
  );
}

/** Plain status text for a group header's action slot — no chip chrome. */
export const SETTINGS_HEADER_STATUS_CLASS =
  'block pt-0.5 text-[12.5px] font-medium tabular-nums text-zinc-500';

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
        'overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-950/45 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_8px_28px_-20px_rgba(0,0,0,0.65)]',
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
    <div className='flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4'>
      <div className='min-w-0 flex-1 basis-48'>
        <h2 className='text-[15px] font-medium tracking-tight text-white'>{title}</h2>
        {description ? (
          <p className='mt-1 max-w-prose text-[13px] leading-relaxed text-zinc-400'>
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className='shrink-0'>{action}</div> : null}
    </div>
  );
}

export function SettingsBody({
  children,
  className,
  rows = false,
}: {
  children: ReactNode;
  className?: string;
  rows?: boolean;
}) {
  return (
    <div className={cn('px-5 py-5', rows && 'divide-y divide-white/[0.06]', className)}>
      {children}
    </div>
  );
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
    <label
      className={cn(
        'flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0 cursor-pointer',
        className,
      )}
    >
      <div className='min-w-0'>
        <span className='block text-[14px] font-medium text-zinc-100'>{label}</span>
        {description ? (
          <span className='mt-1 block text-[13px] leading-relaxed text-zinc-400'>
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
  pending,
  onChange,
}: {
  ariaLabel: string;
  checked: boolean;
  disabled?: boolean;
  /** Blocks toggling but stays focusable, so a save never drops keyboard focus. */
  pending?: boolean;
  onChange: () => void;
}) {
  const inactive = disabled || pending;
  return (
    <button
      type='button'
      role='switch'
      aria-label={ariaLabel}
      aria-checked={checked}
      aria-disabled={inactive || undefined}
      disabled={disabled}
      onClick={() => {
        if (!pending) onChange();
      }}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--accent-act)/50 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 motion-reduce:transition-none',
        !checked && 'bg-zinc-800',
        !checked && !inactive && 'hover:bg-zinc-700',
        inactive && 'cursor-not-allowed opacity-50',
      )}
      style={checked ? { backgroundColor: 'var(--accent-act)' } : undefined}
    >
      <span
        className={cn(
          'inline-block h-[18px] w-[18px] rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-[translate,background-color] duration-150 motion-reduce:transition-none',
          checked ? 'translate-x-[22px] bg-(--on-accent-act)' : 'translate-x-0.5 bg-zinc-400',
        )}
      />
    </button>
  );
}
