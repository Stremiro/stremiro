import { cn } from '@/lib/utils';

const SAFE_ACCENT_FILL = 'color-mix(in srgb, var(--accent-act) 72%, white)';

/** Accent hairline shared by update surfaces: refined, accent-synced, never loud. */
export function UpdateAccentHairline({ className }: { className?: string }) {
  return (
    <span
      aria-hidden='true'
      className={cn('pointer-events-none absolute inset-x-5 top-0 h-px', className)}
      style={{
        background: `linear-gradient(90deg, transparent 0%, color-mix(in srgb, ${SAFE_ACCENT_FILL} 55%, transparent) 50%, transparent 100%)`,
      }}
    />
  );
}

/** Subtle architectural ASCII motif echoing the startup shimmer on update surfaces. */
export function UpdateAsciiMotif({
  active = false,
  className,
}: {
  active?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden='true'
      className={cn(
        'select-none font-mono text-[10px] leading-none tracking-[0.2em]',
        active && 'motion-safe:animate-pulse',
        className,
      )}
      style={{ color: `color-mix(in srgb, ${SAFE_ACCENT_FILL} 70%, transparent)` }}
    >
      ·∘┄∘·
    </span>
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
      className={cn('h-[3px] w-full overflow-hidden rounded-full bg-white/[0.08]', className)}
      role='progressbar'
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-label='Update download progress'
    >
      <div
        className={cn(
          'h-full origin-left rounded-full transition-transform duration-300 motion-reduce:transition-none',
          percent === null && 'w-1/3 motion-safe:animate-pulse',
          barClassName,
        )}
        style={{
          backgroundColor: SAFE_ACCENT_FILL,
          boxShadow: `0 0 10px color-mix(in srgb, ${SAFE_ACCENT_FILL} 35%, transparent)`,
          ...(percent !== null ? { transform: `scaleX(${percent / 100})` } : {}),
        }}
      />
    </div>
  );
}
