import { ChevronsRight } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { CHROME_ICON_STROKE, CHROME_SKIP_BUTTON_CLASS } from '@/components/player-chrome-styles';
import { MINI_ICON_BUTTON_CLASS } from '@/components/player-control-buttons';
import type { PlaybackClock } from '@/lib/player-clock';
import { ariaKeyShortcuts, type PlayerKeymap, withShortcutHint } from '@/lib/player-keybindings';
import { clamp, cn } from '@/lib/utils';

interface PlayerSkipAction {
  label: string;
  onSkip: () => void;
}

export function PlayerSkipButton({
  action,
  keymap,
  variant = 'full',
  className,
  tabIndex,
  clock,
  segmentStart,
  segmentEnd,
}: {
  action: PlayerSkipAction;
  keymap: PlayerKeymap;
  variant?: 'full' | 'compact' | 'icon';
  className?: string;
  tabIndex?: number;
  clock?: PlaybackClock;
  segmentStart?: number;
  segmentEnd?: number;
}) {
  return (
    <button
      type='button'
      data-player-interactive
      tabIndex={tabIndex}
      onClick={(event) => {
        event.stopPropagation();
        action.onSkip();
      }}
      aria-label={action.label}
      aria-keyshortcuts={ariaKeyShortcuts(keymap, 'skipSegment')}
      title={withShortcutHint(action.label, keymap, 'skipSegment')}
      className={cn(
        'relative flex min-w-0 max-w-full cursor-pointer items-center overflow-hidden',
        variant === 'icon'
          ? MINI_ICON_BUTTON_CLASS
          : variant === 'compact'
            ? 'gap-1.5 rounded-lg px-2.5 py-1.5 text-xs'
            : 'min-h-10 gap-2 rounded-lg px-3.5 py-2 text-[13px] font-medium tracking-tight animate-in fade-in duration-200 motion-reduce:animate-none',
        CHROME_SKIP_BUTTON_CLASS,
        className,
      )}
    >
      <ChevronsRight
        aria-hidden='true'
        className={cn(
          'shrink-0 text-(--accent-skip)',
          variant === 'compact' ? 'h-3.5 w-3.5' : 'h-4 w-4',
        )}
        strokeWidth={CHROME_ICON_STROKE}
      />
      {variant !== 'icon' && <span className='truncate'>{action.label}</span>}
      {clock &&
        segmentStart !== undefined &&
        segmentEnd !== undefined &&
        segmentEnd > segmentStart && (
          <SkipSegmentProgress clock={clock} start={segmentStart} end={segmentEnd} />
        )}
    </button>
  );
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
      className='pointer-events-none absolute inset-x-2.5 bottom-1.5 h-[2px] overflow-hidden rounded-[1px] bg-white/15'
    >
      <span className='block h-full bg-(--accent-skip)' style={{ width: `${pct}%` }} />
    </span>
  );
}
