import { CalendarClock, CircleCheck, CirclePlay, CircleSlash, type LucideIcon } from 'lucide-react';
import { type WatchStatus, WATCH_STATUS_COLORS } from '@/lib/api';
import { cn } from '@/lib/utils';

const STATUS_ICONS: Record<WatchStatus, LucideIcon> = {
  watching: CirclePlay,
  watched: CircleCheck,
  plan_to_watch: CalendarClock,
  dropped: CircleSlash,
};

/**
 * Watch status as a tinted icon rather than a bare dot — same color family as
 * WATCH_STATUS_COLORS, but recognizable at a glance and before the label.
 */
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
