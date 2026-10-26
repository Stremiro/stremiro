import { CalendarClock, Check, CircleCheck, CirclePlay, CircleSlash } from 'lucide-react';
import { type WatchStatus, WATCH_STATUS_COLORS } from '@/lib/api';
import { cn } from '@/lib/utils';

const STATUS_ICONS = {
  watching: CirclePlay,
  watched: CircleCheck,
  plan_to_watch: CalendarClock,
  dropped: CircleSlash,
};

export function SelectionCheck({ selected, className }: { selected: boolean; className?: string }) {
  return (
    <span
      aria-hidden='true'
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-md border [&_svg]:size-3',
        selected
          ? 'border-(--accent-nav) bg-(--accent-nav) text-(--on-accent-nav)'
          : 'border-white/25 text-transparent',
        className,
      )}
    >
      <Check strokeWidth={3} />
    </span>
  );
}

export function WatchStatusIcon({
  status,
  className,
  strokeWidth = 1.9,
}: {
  status: WatchStatus;
  className?: string;
  strokeWidth?: number;
}) {
  const Icon = STATUS_ICONS[status];
  return (
    <Icon
      aria-hidden='true'
      strokeWidth={strokeWidth}
      className={cn('shrink-0', WATCH_STATUS_COLORS[status].text, className)}
    />
  );
}
