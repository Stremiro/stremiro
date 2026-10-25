import { ChevronsRight } from 'lucide-react';
import { memo, type ReactNode, useSyncExternalStore } from 'react';
import { CHROME_ICON_STROKE, CHROME_SKIP_BUTTON_CLASS } from '@/components/player-chrome-styles';
import { MINI_ICON_BUTTON_CLASS } from '@/components/player-control-buttons';
import { usePlayerKeymap } from '@/hooks/use-app-ui-preferences';
import type { PlaybackClock } from '@/lib/player-clock';
import { ariaKeyShortcuts, type PlayerKeymap, withShortcutHint } from '@/lib/player-keybindings';
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

export function PlayerSkipButton({
  action,
  keymap,
  variant = 'full',
  className,
  tabIndex,
  children,
}: {
  action: PlayerSkipAction;
  keymap: PlayerKeymap;
  variant?: 'full' | 'compact' | 'icon';
  className?: string;
  tabIndex?: number;
  children?: ReactNode;
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
            ? 'gap-1 px-2 py-1.5 text-xs'
            : 'min-h-11 gap-2 px-4 py-2.5 text-[13px] font-semibold animate-in fade-in zoom-in-95 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none',
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
      {children}
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
      className='pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-white/10'
    >
      <span
        className='block h-full origin-left bg-(--accent-skip) transition-transform duration-200 ease-linear motion-reduce:transition-none'
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
      <PlayerSkipButton action={skipAction} keymap={keymap}>
        {segmentStart !== undefined && segmentEnd !== undefined && segmentEnd > segmentStart && (
          <SkipSegmentProgress clock={clock} start={segmentStart} end={segmentEnd} />
        )}
      </PlayerSkipButton>
    </div>
  );
});
