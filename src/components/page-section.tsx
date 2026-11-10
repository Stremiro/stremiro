import type { LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn, ICON_CHIP_CLASS } from '@/lib/utils';

/** Elevated content surface — the one card style shared by settings, calendar and panel states. */
export function PageCard({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      {...props}
      className={cn(
        'relative min-w-0 overflow-hidden rounded-xl border border-white/[0.07] bg-linear-to-b from-white/[0.04] to-white/[0.02] shadow-[0_1px_2px_rgba(0,0,0,0.3),0_12px_30px_-18px_rgba(0,0,0,0.55)] transition-colors duration-300 motion-reduce:transition-none',
        className,
      )}
    >
      <span
        aria-hidden='true'
        className='pointer-events-none absolute inset-x-5 top-0 h-px bg-linear-to-r from-transparent via-white/[0.12] to-transparent'
      />
      {children}
    </div>
  );
}

/** Flat section wrapper — the header hangs above the card instead of inside it. */
export function PageSection({ children, className, ...props }: ComponentProps<'section'>) {
  return (
    <section {...props} className={cn('min-w-0', className)}>
      {children}
    </section>
  );
}

export function PageSectionHeader({
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
    <div className='flex flex-wrap items-start justify-between gap-3 px-1 pb-3'>
      <div className='flex min-w-0 flex-1 basis-48 items-start gap-3'>
        {Icon ? (
          <span aria-hidden='true' className={cn(ICON_CHIP_CLASS, 'size-9 shrink-0 rounded-lg')}>
            <Icon className='size-[17px] text-(--accent-nav)' strokeWidth={1.75} />
          </span>
        ) : null}
        <div className='min-w-0 flex-1 self-center'>
          <h3 className='text-[17px] font-semibold tracking-tight text-white'>{title}</h3>
          {description ? (
            <p className='mt-1 block max-w-[64ch] text-[14px] leading-normal text-zinc-400'>
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {action ? <div className='shrink-0'>{action}</div> : null}
    </div>
  );
}
