import {
  FastForward,
  Gauge,
  History,
  type LucideIcon,
  Music,
  Rewind,
  SkipForward,
  Subtitles,
} from 'lucide-react';
import { memo } from 'react';
import { PlayerVolumeIcon } from '@/components/player-volume-icon';
import { clamp, cn, formatTime } from '@/lib/utils';

export type PlayerOsdMessageIcon = 'history' | 'subtitles' | 'gauge' | 'audio' | 'skip';

const MESSAGE_ICONS: Record<PlayerOsdMessageIcon, LucideIcon> = {
  history: History,
  subtitles: Subtitles,
  gauge: Gauge,
  audio: Music,
  skip: SkipForward,
};

const OSD_CARD_CLASS =
  'flex max-w-full items-center rounded-md border border-white/10 bg-black/60 px-4 py-2 shadow-xl';

export type PlayerOsdAction =
  | { kind: 'seek'; direction?: 'forward' | 'backward'; seconds?: number; target?: number }
  | { kind: 'volume'; level: number }
  | {
      kind: 'message';
      text: string;
      icon?: PlayerOsdMessageIcon;
    };

interface PlayerOsdOverlayProps {
  action: PlayerOsdAction | null;
  visible: boolean;
  isFullscreen: boolean;
  compact: boolean;
}

// Memoized between OSD events. The live region stays mounted while idle — remounting can drop screen-reader output.
export const PlayerOsdOverlay = memo(function PlayerOsdOverlay({
  action,
  visible,
  isFullscreen,
  compact,
}: PlayerOsdOverlayProps) {
  const MessageIcon = action?.kind === 'message' && action.icon ? MESSAGE_ICONS[action.icon] : null;

  return (
    <div
      className={cn(
        'pointer-events-none absolute z-50 flex justify-center px-4 transition-opacity duration-100 motion-reduce:transition-none',
        // The title lane stays reserved even when chrome is hidden; feedback never shifts onto the center-stage state.
        compact
          ? 'inset-x-0 top-12'
          : isFullscreen
            ? 'inset-x-0 top-24'
            : 'left-[60px] right-0 top-28',
        visible ? 'opacity-100' : 'opacity-0',
      )}
      aria-live='polite'
      aria-atomic='true'
    >
      {action?.kind === 'seek' && (
        <div className={cn(OSD_CARD_CLASS, 'gap-2.5')}>
          {action.direction === 'forward' && (
            <FastForward className='h-4 w-4 shrink-0 text-white/90' strokeWidth={2.5} />
          )}
          {action.direction === 'backward' && (
            <Rewind className='h-4 w-4 shrink-0 text-white/90' strokeWidth={2.5} />
          )}
          <span
            className={cn(
              'truncate font-semibold tracking-tight text-white tabular-nums',
              compact ? 'text-xs' : 'text-base',
            )}
          >
            {action.direction === 'forward' ? '+' : action.direction === 'backward' ? '−' : ''}
            {action.seconds !== undefined ? `${action.seconds}s` : ''}
            {action.seconds !== undefined && action.target !== undefined ? ' · ' : ''}
            {action.target !== undefined ? formatTime(action.target) : ''}
          </span>
        </div>
      )}

      {action?.kind === 'volume' && (
        <div className={cn(OSD_CARD_CLASS, 'gap-3')}>
          <div className='flex shrink-0 items-center gap-2'>
            <PlayerVolumeIcon
              muted={action.level === 0}
              volume={action.level}
              className='h-4 w-4 text-white/90'
              strokeWidth={2.5}
            />
            <span
              className={cn(
                'font-semibold text-white tabular-nums',
                compact ? 'text-xs' : 'text-base',
              )}
            >
              {Math.round(action.level)}%
            </span>
          </div>
          <div className='h-[3px] w-20 overflow-hidden bg-white/20'>
            <div
              className='h-full w-full origin-left bg-white transition-transform duration-100 motion-reduce:transition-none'
              style={{ transform: `scaleX(${clamp(action.level, 0, 100) / 100})` }}
            />
          </div>
        </div>
      )}

      {action?.kind === 'message' && (
        <div className={cn(OSD_CARD_CLASS, 'gap-2.5')}>
          {MessageIcon && (
            <MessageIcon className='h-3.5 w-3.5 shrink-0 text-white/60' strokeWidth={2.25} />
          )}
          <span
            className={cn(
              'max-w-[560px] truncate font-medium tracking-wide text-white/90',
              compact ? 'text-xs' : 'text-[13px]',
            )}
          >
            {action.text}
          </span>
        </div>
      )}
    </div>
  );
});
