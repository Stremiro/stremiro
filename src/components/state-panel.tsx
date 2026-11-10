import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Shared icon + title + body + action panel for empty, error and offline states. */
export function StatePanel({
  action,
  className,
  description,
  descriptionClassName,
  icon,
  iconClassName,
  role = 'status',
  title,
  titleClassName,
  titleRole,
}: {
  action?: ReactNode;
  className?: string;
  description?: ReactNode;
  descriptionClassName?: string;
  icon?: ReactNode;
  /** Extra chrome on the icon slot (e.g. ICON_CHIP_CLASS tile); 'h-auto w-auto' hugs the icon. */
  iconClassName?: string;
  role?: string;
  title: ReactNode;
  titleClassName?: string;
  /** 'alert'/'status' when the title itself carries the announcement. */
  titleRole?: string;
}) {
  return (
    <div
      role={role}
      className={cn('flex flex-col items-center justify-center gap-3 text-center', className)}
    >
      {icon ? (
        <div className={cn('flex h-10 w-10 items-center justify-center', iconClassName)}>
          {icon}
        </div>
      ) : null}
      <p
        role={titleRole}
        className={cn(
          'max-w-full [overflow-wrap:anywhere] text-[15px] font-semibold text-zinc-200',
          titleClassName,
        )}
      >
        {title}
      </p>
      {description ? (
        <p
          className={cn(
            'w-full max-w-xs [overflow-wrap:anywhere] text-sm leading-relaxed text-zinc-400',
            descriptionClassName,
          )}
        >
          {description}
        </p>
      ) : null}
      {action}
    </div>
  );
}
