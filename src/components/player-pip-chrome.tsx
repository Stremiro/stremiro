import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  ArrowDownRight,
  ArrowUpRight,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  X,
} from 'lucide-react';
import { memo, useState } from 'react';
import { CHROME_ICON_BUTTON_CLASS } from '@/components/player-chrome-styles';
import { PlayerProgressBar } from '@/components/player-progress-bar';
import { PlayerVolumeIcon } from '@/components/player-volume-icon';
import type { SkipSegment } from '@/lib/api';
import type { PlaybackClock } from '@/lib/player-clock';
import { snapPlayerPip } from '@/lib/player-window';
import { cn } from '@/lib/utils';

interface PlayerPipChromeProps {
  title: string;
  episodeLabel?: string;
  visible: boolean;
  isPlaying: boolean;
  isMuted: boolean;
  volume: number;
  clock: PlaybackClock;
  bufferedClock: PlaybackClock;
  duration: number;
  skipSegments: SkipSegment[];
  resetKey?: string;
  status?: string;
  error?: string | null;
  ended: boolean;
  autoPlaySecondsLeft: number | null;
  canGoNext: boolean;
  skipAction?: { label: string; onSkip: () => void } | null;
  onReturn: () => Promise<void>;
  onTogglePlay: () => Promise<void>;
  onToggleMute: () => Promise<void>;
  onVolumeStep: (delta: number) => void;
  onSeek: (seconds: number) => void;
  onNext: () => void;
  onReplay: () => void;
  onRetry: () => void;
  onCancelAutoPlay: () => void;
  onControlsHover: (hovered: boolean) => void;
}

export const PlayerPipChrome = memo(function PlayerPipChrome(props: PlayerPipChromeProps) {
  const { title, episodeLabel, visible, status, error, ended, onReturn } = props;
  const [snapping, setSnapping] = useState(false);
  const returnToApp = () => void onReturn().catch(() => undefined);
  const snapToCorner = () => {
    if (snapping) return;
    setSnapping(true);
    void snapPlayerPip()
      .catch(() => undefined)
      .finally(() => setSnapping(false));
  };
  return (
    <>
      <div
        aria-hidden='true'
        className='pointer-events-none absolute inset-0 z-60 border border-white/15'
      />
      {(status || error || ended) && (
        <div className='pointer-events-none absolute inset-0 z-30 bg-black/65'>
          <div className='absolute inset-x-4 top-11 bottom-24 flex min-h-0 items-center justify-center gap-2 text-center'>
            {status && !error && (
              <Loader2 className='h-4 w-4 shrink-0 animate-spin text-white/65' />
            )}
            <p
              role={error ? 'alert' : 'status'}
              className='line-clamp-2 min-w-0 text-xs leading-4 text-white/80'
              title={error || status}
            >
              {error ||
                status ||
                (props.autoPlaySecondsLeft !== null
                  ? `Next episode in ${props.autoPlaySecondsLeft}s`
                  : 'Playback finished')}
            </p>
          </div>
        </div>
      )}
      <div
        className={cn(
          'pointer-events-none absolute inset-0 z-40 flex cursor-auto flex-col justify-between transition-opacity duration-200 motion-reduce:transition-none focus-within:opacity-100',
          visible || !props.isPlaying || status || error || ended ? 'opacity-100' : 'opacity-0',
        )}
      >
        <div
          data-player-interactive
          className='pointer-events-auto flex min-w-0 items-center gap-1 bg-linear-to-b from-black/80 to-transparent px-2 pt-1'
          onPointerEnter={() => props.onControlsHover(true)}
          onPointerLeave={() => props.onControlsHover(false)}
        >
          <button
            type='button'
            aria-label='Move picture in picture window'
            title='Drag to move'
            className='min-w-0 flex-1 cursor-grab truncate rounded-md px-1 py-2 text-left text-xs font-medium text-white/75 transition-colors hover:bg-white/5 hover:text-white active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
            onPointerDown={(event) => {
              if (event.button === 0)
                void getCurrentWindow()
                  .startDragging()
                  .catch(() => undefined);
            }}
          >
            {title}
            {episodeLabel ? ` · ${episodeLabel}` : ''}
          </button>
          <button
            type='button'
            className={cn(CHROME_ICON_BUTTON_CLASS, 'cursor-pointer')}
            onClick={returnToApp}
            aria-label='Return to app'
            title='Return to app (Esc)'
            aria-keyshortcuts='Escape'
          >
            <ArrowUpRight className='h-4 w-4' />
          </button>
          <button
            type='button'
            className={cn(CHROME_ICON_BUTTON_CLASS, 'cursor-pointer hover:bg-red-500/20')}
            onClick={returnToApp}
            aria-label='Close picture in picture and return to app'
            title='Close picture in picture'
          >
            <X className='h-4 w-4' />
          </button>
        </div>
        <div
          data-player-interactive
          className='pointer-events-auto shrink-0 bg-linear-to-t from-black/90 via-black/60 to-transparent px-3 pb-2 pt-3'
          onPointerEnter={() => props.onControlsHover(true)}
          onPointerLeave={() => props.onControlsHover(false)}
        >
          <PlayerProgressBar
            duration={props.duration}
            clock={props.clock}
            bufferedClock={props.bufferedClock}
            skipSegments={props.skipSegments}
            resetKey={props.resetKey}
            onSeek={props.onSeek}
          />
          <div className='flex items-center gap-1'>
            <button
              type='button'
              className={cn(
                CHROME_ICON_BUTTON_CLASS,
                'cursor-pointer bg-white/10 text-white hover:bg-white/20',
              )}
              aria-label={
                error ? 'Try again' : ended ? 'Watch again' : props.isPlaying ? 'Pause' : 'Play'
              }
              title={
                error
                  ? 'Try again'
                  : ended
                    ? 'Watch again'
                    : props.isPlaying
                      ? 'Pause (Space)'
                      : 'Play (Space)'
              }
              aria-keyshortcuts='Space k'
              onClick={() =>
                error
                  ? props.onRetry()
                  : ended
                    ? props.onReplay()
                    : void props.onTogglePlay().catch(() => undefined)
              }
            >
              {error || ended ? (
                <RotateCcw className='h-4 w-4' />
              ) : props.isPlaying ? (
                <Pause className='h-4 w-4 fill-current' />
              ) : (
                <Play className='h-4 w-4 fill-current' />
              )}
            </button>
            <button
              type='button'
              className={cn(CHROME_ICON_BUTTON_CLASS, 'cursor-pointer')}
              aria-label={props.isMuted ? 'Unmute' : 'Mute'}
              aria-keyshortcuts='m'
              title={
                props.isMuted
                  ? 'Unmute (M)'
                  : `Volume ${Math.round(props.volume)}% · scroll to adjust`
              }
              onClick={() => void props.onToggleMute().catch(() => undefined)}
              onWheel={(event) => {
                if (event.deltaY === 0) return;
                event.stopPropagation();
                props.onVolumeStep(event.deltaY < 0 ? 5 : -5);
              }}
            >
              <PlayerVolumeIcon
                muted={props.isMuted || props.volume === 0}
                volume={props.volume}
                className='h-4 w-4'
              />
            </button>
            {props.canGoNext && (
              <button
                type='button'
                className={cn(CHROME_ICON_BUTTON_CLASS, 'cursor-pointer')}
                aria-label='Next episode'
                title='Next episode (N)'
                aria-keyshortcuts='n'
                onClick={props.onNext}
              >
                <SkipForward className='h-4 w-4' />
              </button>
            )}
            <div className='ml-auto flex min-w-0 items-center gap-1'>
              {ended && props.autoPlaySecondsLeft !== null ? (
                <button
                  type='button'
                  className='min-w-0 cursor-pointer truncate rounded-md px-2 py-1.5 text-xs text-white/75 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
                  onClick={props.onCancelAutoPlay}
                  title='Cancel autoplay'
                >
                  Cancel autoplay
                </button>
              ) : props.skipAction && !status && !error && !ended ? (
                <button
                  type='button'
                  onClick={props.skipAction.onSkip}
                  className='min-w-0 cursor-pointer truncate rounded-md bg-white/15 px-2 py-1.5 text-xs text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
                >
                  {props.skipAction.label}
                </button>
              ) : null}
              <button
                type='button'
                className={cn(
                  CHROME_ICON_BUTTON_CLASS,
                  'cursor-pointer disabled:cursor-wait disabled:opacity-50',
                )}
                aria-label='Snap picture in picture to bottom-right'
                title='Snap to bottom-right of this screen'
                disabled={snapping}
                onClick={() => void snapToCorner()}
              >
                <ArrowDownRight className='h-4 w-4' />
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
});
