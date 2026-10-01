import { FastForward } from 'lucide-react';
import { memo, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import type { PlaybackClock } from '@/lib/player-clock';
import { clamp, cn } from '@/lib/utils';

interface PlayerSkipAction {
  label: string;
  onSkip: () => void;
}

interface PlayerActionOverlaysProps {
  clock: PlaybackClock;
  skipAction?: PlayerSkipAction | null;
  /** Active segment bounds (seconds) — drive the progress hairline. */
  segmentStart?: number;
  segmentEnd?: number;
}

// Only this leaf subscribes to the clock, so ticks never re-render the button.
function SkipSegmentProgress({
  clock,
  start,
  end,
}: {
  clock: PlaybackClock;
  start: number;
  end: number;
}) {
  const time = useSyncExternalStore(clock.subscribe, clock.getSnapshot);
  const pct = clamp(((time - start) / (end - start)) * 100, 0, 100);
  return (
    <span
      aria-hidden='true'
      className='pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-white/10'
    >
      <span
        className='block h-full bg-white/70 transition-[width] duration-300 ease-linear motion-reduce:transition-none'
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

// Memoized: `skipAction` is built to keep a stable identity across playback
// ticks, so the overlay subtree only re-renders on real action changes.
export const PlayerActionOverlays = memo(function PlayerActionOverlays({
  clock,
  skipAction,
  segmentStart,
  segmentEnd,
}: PlayerActionOverlaysProps) {
  if (!skipAction) {
    return null;
  }

  return (
    <div
      data-player-interactive
      className='absolute bottom-[116px] right-6 z-55 flex flex-col items-end gap-2 pointer-events-auto'
    >
      <Button
        onClick={skipAction.onSkip}
        variant='outline'
        aria-label={skipAction.label}
        aria-keyshortcuts='s'
        title={`${skipAction.label} (S)`}
        className={cn(
          'relative h-auto overflow-hidden px-5 py-2.5 text-sm font-semibold rounded-lg',
          'bg-zinc-950/80 hover:bg-zinc-900/90 text-white backdrop-blur-xl',
          'border border-white/20 hover:border-white/40',
          'shadow-2xl shadow-black/60',
          'flex items-center gap-2 transition-all duration-150',
          'animate-in fade-in slide-in-from-right-4 duration-300',
        )}
      >
        <FastForward className='h-4 w-4 shrink-0' strokeWidth={2.5} />
        <span>{skipAction.label}</span>
        {segmentStart !== undefined && segmentEnd !== undefined && segmentEnd > segmentStart && (
          <SkipSegmentProgress clock={clock} start={segmentStart} end={segmentEnd} />
        )}
      </Button>
    </div>
  );
});
