import { type ReactNode, type RefObject } from 'react';
import { cn, SIDEBAR_PAGE_COLUMN_INSETS } from '@/lib/utils';

/** Compact summary bar pinned under the titlebar once the owning toolbar scrolls past. */
export function CompactFloatingBar({
  show,
  label,
  maxWidthClass,
  className,
  children,
  ref,
}: {
  show: boolean;
  label: string;
  /** Page-column width the bar aligns to (e.g. 'max-w-7xl'). */
  maxWidthClass: string;
  /** Pill chrome that differs per surface (radius, padding, inner width). */
  className?: string;
  children: ReactNode;
  ref?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={ref}
      role='region'
      aria-label={label}
      aria-hidden={!show || undefined}
      inert={!show}
      className={cn(
        'pointer-events-none fixed inset-x-0 top-8 z-40 transition-[opacity,translate] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        show ? 'translate-y-0 opacity-100' : '-translate-y-1.5 opacity-0',
      )}
    >
      <div className={`mx-auto w-full ${maxWidthClass} pt-2 ${SIDEBAR_PAGE_COLUMN_INSETS}`}>
        <div
          className={cn(
            'flex h-11 items-center border border-white/[0.09] bg-zinc-950/85 shadow-[0_12px_32px_-14px_rgb(0_0_0/0.9),inset_0_1px_0_rgb(255_255_255/0.05)] backdrop-blur-md',
            show && 'pointer-events-auto',
            className,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
