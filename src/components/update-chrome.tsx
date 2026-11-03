import { cn } from '@/lib/utils';

/** Accent shared by update surfaces: a hairline, not a tint. */
export function UpdateAccentHairline({ className }: { className?: string }) {
  return (
    <span
      aria-hidden='true'
      className={cn(
        'absolute inset-x-5 top-0 h-px bg-linear-to-r from-transparent via-emerald-300/50 to-transparent',
        className,
      )}
    />
  );
}

/** Download progress bar shared by the update toast and Settings. */
export function UpdateProgressBar({
  percent,
  className,
  barClassName,
}: {
  percent: number | null;
  className?: string;
  barClassName?: string;
}) {
  return (
    <div
      className={cn('h-1 w-full overflow-hidden rounded-full bg-white/[0.07]', className)}
      role='progressbar'
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-label='Update download progress'
    >
      <div
        className={cn(
          'h-full origin-left rounded-full bg-emerald-300/90 transition-transform duration-300 motion-reduce:transition-none',
          percent === null && 'w-1/3 motion-safe:animate-pulse',
          barClassName,
        )}
        style={percent !== null ? { transform: `scaleX(${percent / 100})` } : undefined}
      />
    </div>
  );
}
