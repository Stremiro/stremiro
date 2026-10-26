import { Check, ChevronDown, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { RetryBanner } from '@/components/retry-banner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export { Switch as SettingsSwitch } from '@/components/ui/switch';

export function SettingsQueryError({
  query,
  message,
  className,
}: {
  query: {
    isError: boolean;
    isFetching: boolean;
    isFetched: boolean;
    isPending: boolean;
    isPlaceholderData: boolean;
    refetch: () => Promise<unknown>;
  };
  message: string;
  className?: string;
}) {
  if (!query.isError && !(query.isFetched && (query.isPending || query.isPlaceholderData)))
    return null;
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
  'block pt-0.5 text-[13px] font-medium leading-5 tabular-nums text-zinc-400';

/** Glass chrome for outline `Button`s across sections; callers own size. */
export const SETTINGS_OUTLINE_BUTTON_CLASS =
  'rounded-lg border-white/10 bg-white/[0.04] font-medium text-zinc-100 hover:bg-white/[0.08] hover:text-white';

/** Small uppercase caption that groups rows inside one card. */
export const SETTINGS_CAPTION_CLASS =
  'text-[13px] font-semibold uppercase leading-5 tracking-[0.08em] text-zinc-400';

export const SETTINGS_INSET_SURFACE_CLASS = 'rounded-lg border border-white/[0.06] bg-black/20';

export function settingsControlId(label: string) {
  return `setting-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export function SettingsGroup({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        'relative isolate min-w-0 overflow-hidden rounded-xl border border-white/[0.07] bg-zinc-950/70 bg-linear-to-b from-white/[0.04] to-transparent shadow-[0_2px_6px_-2px_rgba(0,0,0,0.4),0_16px_36px_-20px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors duration-300 hover:border-white/[0.1] motion-reduce:transition-none',
        className,
      )}
    >
      <span
        aria-hidden='true'
        className='pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(24rem_12rem_at_top_left,rgb(var(--accent-nav-rgb)/calc(0.07*var(--app-glow,1))),transparent_75%)]'
      />
      <span
        aria-hidden='true'
        className='pointer-events-none absolute inset-x-6 top-0 h-px bg-linear-to-r from-transparent via-white/[0.14] to-transparent'
      />
      {children}
    </section>
  );
}

export function SettingsGroupHeader({
  action,
  description,
  icon: Icon,
  title,
}: {
  action?: ReactNode;
  description?: string;
  icon?: LucideIcon;
  title: string;
}) {
  return (
    <div className='flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.06] px-4 py-4 sm:px-5'>
      <div className='flex min-w-0 flex-1 basis-48 items-start gap-3'>
        {Icon ? (
          <span className='flex size-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-b from-white/[0.08] to-white/[0.02] ring-1 ring-inset ring-white/[0.08]'>
            <Icon aria-hidden='true' className='size-4 text-(--accent-nav)' strokeWidth={1.75} />
          </span>
        ) : null}
        <div className='min-w-0 flex-1 self-center'>
          <h3 className='text-[15px] font-semibold tracking-tight text-white'>{title}</h3>
          {description ? (
            <p className='mt-1 max-w-[64ch] text-[13px] leading-relaxed text-zinc-400'>
              {description}
            </p>
          ) : null}
        </div>
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
    <div className={cn('px-4 py-4 sm:px-5', rows && 'divide-y divide-white/[0.06]', className)}>
      {children}
    </div>
  );
}

/**
 * Row chrome only — deliberately not a <label>. A label wrapping the control
 * makes every click on the title or description activate it, which reads as an
 * over-sensitive row. Controls own their own accessible name instead.
 */
export function SettingsRow({
  children,
  className,
  description,
  descriptionId,
  label,
}: {
  children: ReactNode;
  className?: string;
  description?: string;
  descriptionId?: string;
  label: string;
}) {
  return (
    <div
      id={settingsControlId(label)}
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-5 gap-y-3 py-3.5 first:pt-0 last:pb-0',
        className,
      )}
    >
      <div className='min-w-0 flex-1 basis-32'>
        <span className='block text-[14px] font-medium leading-snug text-zinc-100'>{label}</span>
        {description ? (
          <span
            id={descriptionId}
            className='mt-1 block max-w-[64ch] text-[13px] leading-relaxed text-zinc-400'
          >
            {description}
          </span>
        ) : null}
      </div>
      <div className='min-w-0 max-w-full shrink-0 [&>button]:max-w-full'>{children}</div>
    </div>
  );
}

export function SettingsSelect<Value extends string>({
  ariaLabel,
  disabled,
  onChange,
  options,
  value,
  valueLabel,
}: {
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: Value) => void;
  options: readonly { value: Value; label: string }[];
  value: Value;
  valueLabel: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant='outline'
          aria-label={`${ariaLabel}: ${valueLabel}`}
          disabled={disabled}
          className={cn(
            'h-9 w-40 min-w-0 max-w-full justify-between px-3 text-[14px] shadow-none',
            SETTINGS_OUTLINE_BUTTON_CLASS,
          )}
        >
          <span title={valueLabel} className='truncate'>
            {valueLabel}
          </span>
          <ChevronDown aria-hidden='true' className='ml-3 h-4 w-4 shrink-0 text-zinc-500' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align='end'
        className='max-h-80 min-w-40 overflow-y-auto border-white/10 bg-zinc-950 backdrop-blur-none'
      >
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            role='menuitemradio'
            aria-checked={option.value === value}
            onClick={() => onChange(option.value)}
            className='cursor-pointer gap-2.5 px-3 py-2 text-sm text-zinc-200'
          >
            {option.value === value ? (
              <Check aria-hidden='true' className='h-4 w-4 text-white' />
            ) : (
              <span className='w-4' />
            )}
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
