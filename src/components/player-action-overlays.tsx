import { FastForward } from 'lucide-react';
import { memo, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { usePlayerKeymap } from '@/hooks/use-app-ui-preferences';
import type { PlaybackClock } from '@/lib/player-clock';
import { ariaKeyShortcuts, withShortcutHint } from '@/lib/player-keybindings';
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
        className='block h-full origin-left bg-white/70 transition-transform duration-300 ease-linear motion-reduce:transition-none'
        style={{ transform: `scaleX(${pct / 100})` }}
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
  const keymap = usePlayerKeymap();
  if (!skipAction) {
    return null;
  }

  return (
    <div data-player-interactive className='pointer-events-auto flex max-w-full items-end'>
      <Button
        onClick={skipAction.onSkip}
        variant='outline'
        aria-label={skipAction.label}
        aria-keyshortcuts={ariaKeyShortcuts(keymap, 'skipSegment')}
        title={withShortcutHint(skipAction.label, keymap, 'skipSegment')}
        className={cn(
          'relative min-h-11 max-w-full overflow-hidden px-4 py-2.5 text-sm font-semibold rounded-xl',
          'bg-zinc-950/80 hover:bg-zinc-900/90 text-white',
          'border border-white/20 hover:border-white/40',
          'shadow-2xl shadow-black/60',
          'flex items-center gap-2 transition-colors duration-150',
          'animate-in fade-in duration-150 motion-reduce:animate-none',
        )}
      >
        <FastForward className='h-4 w-4 shrink-0' strokeWidth={2.5} />
        <span className='truncate'>{skipAction.label}</span>
        {segmentStart !== undefined && segmentEnd !== undefined && segmentEnd > segmentStart && (
          <SkipSegmentProgress clock={clock} start={segmentStart} end={segmentEnd} />
        )}
      </Button>
    </div>
  );
});
