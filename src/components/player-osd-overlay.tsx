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
  isLoading: boolean;
  isResolving: boolean;
}

// Memoized between OSD events. The live region stays mounted while idle — remounting can drop screen-reader output.
export const PlayerOsdOverlay = memo(function PlayerOsdOverlay({
  action,
  visible,
  isLoading,
  isResolving,
}: PlayerOsdOverlayProps) {
  const suppressed = isLoading || isResolving;
  const MessageIcon = action?.kind === 'message' && action.icon ? MESSAGE_ICONS[action.icon] : null;

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 z-50 flex items-center justify-center transition-opacity duration-100',
        visible && !suppressed ? 'opacity-100' : 'opacity-0',
      )}
      aria-live='polite'
      aria-atomic='true'
    >
      {action?.kind === 'seek' && !suppressed && (
        <div className='flex items-center gap-3 rounded-2xl border border-white/15 bg-black/50 px-6 py-3.5 shadow-xl'>
          {action.direction === 'forward' && (
            <FastForward className='h-5 w-5 text-white/90' strokeWidth={2.5} />
          )}
          {action.direction === 'backward' && (
            <Rewind className='h-5 w-5 text-white/90' strokeWidth={2.5} />
          )}
          <span className='text-xl font-semibold tracking-tight text-white tabular-nums'>
            {action.direction === 'forward' ? '+' : action.direction === 'backward' ? '−' : ''}
            {action.seconds !== undefined ? `${action.seconds}s` : ''}
            {action.seconds !== undefined && action.target !== undefined ? ' · ' : ''}
            {action.target !== undefined ? formatTime(action.target) : ''}
          </span>
        </div>
      )}

      {action?.kind === 'volume' && !suppressed && (
        <div className='flex min-w-[130px] flex-col items-center gap-2.5 rounded-2xl border border-white/15 bg-black/50 px-5 py-3.5 shadow-xl'>
          <div className='flex items-center gap-2'>
            <PlayerVolumeIcon
              muted={action.level === 0}
              volume={action.level}
              className='h-5 w-5 text-white/90'
              strokeWidth={2.5}
            />
            <span className='text-base font-semibold text-white tabular-nums'>
              {Math.round(action.level)}%
            </span>
          </div>
          <div className='h-[3px] w-28 overflow-hidden rounded-full bg-white/20'>
            <div
              className='h-full rounded-full bg-white'
              style={{ width: `${clamp(Math.round(action.level), 0, 100)}%` }}
            />
          </div>
        </div>
      )}

      {action?.kind === 'message' && !suppressed && (
        <div className='flex items-center gap-2.5 rounded-full border border-white/10 bg-black/55 px-4 py-2 shadow-xl'>
          {MessageIcon && (
            <MessageIcon className='h-3.5 w-3.5 shrink-0 text-white/60' strokeWidth={2.25} />
          )}
          <span className='max-w-[min(70vw,560px)] truncate text-[13px] font-medium tracking-wide text-white/90'>
            {action.text}
          </span>
        </div>
      )}
    </div>
  );
});
