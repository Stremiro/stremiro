import { cn } from '@/lib/utils';

/** Thin accent progress strip pinned to a thumbnail's bottom edge — the
    shared watched-progress vocabulary for episode cards and panel rows. */
export function WatchProgressStrip({
  percent,
  className,
  animateEntrance = false,
}: {
  percent: number;
  className?: string;
  animateEntrance?: boolean;
}) {
  if (percent <= 0) return null;
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-white/15',
        className,
      )}
    >
      <div
        className={cn('h-full bg-(--accent-prog)', animateEntrance && 'watch-progress-entrance')}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
