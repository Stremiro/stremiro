import { Check, ChevronDown } from 'lucide-react';
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

export const SETTINGS_INSET_SURFACE_CLASS = 'rounded-xl border border-white/[0.06] bg-black/20';

/** Shared `SettingsRow` shells — used directly by rows with a custom label slot (clear-records). */
export const SETTINGS_ROW_CLASS =
  'flex flex-wrap items-center justify-between gap-x-5 gap-y-3 py-3.5 first:pt-0 last:pb-0';
export const SETTINGS_ROW_DESCRIPTION_CLASS =
  'mt-1 block max-w-[64ch] text-[13px] leading-normal text-zinc-400';

export function settingsControlId(label: string) {
  return `setting-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export {
  PageCard as SettingsCard,
  PageSection as SettingsGroup,
  PageSectionHeader as SettingsGroupHeader,
} from '@/components/page-section';

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
    <div id={settingsControlId(label)} className={cn(SETTINGS_ROW_CLASS, className)}>
      <div className='min-w-0 flex-1 basis-32'>
        <span className='block text-[14px] font-medium leading-snug text-zinc-100'>{label}</span>
        {description ? (
          <span id={descriptionId} className={SETTINGS_ROW_DESCRIPTION_CLASS}>
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
            'group/select h-9 w-40 min-w-0 max-w-full justify-between px-3 text-[14px] shadow-none',
            SETTINGS_OUTLINE_BUTTON_CLASS,
          )}
        >
          <span title={valueLabel} className='truncate'>
            {valueLabel}
          </span>
          <ChevronDown
            aria-hidden='true'
            className='ml-3 h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-150 group-data-[state=open]/select:rotate-180 motion-reduce:transition-none'
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align='end'
        className='max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] min-w-40 border-white/10 bg-zinc-950 backdrop-blur-none'
      >
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            role='menuitemradio'
            aria-checked={option.value === value}
            onSelect={() => {
              if (option.value !== value) onChange(option.value);
            }}
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
