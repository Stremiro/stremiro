import { getCurrentWindow } from '@tauri-apps/api/window';
import { AppWindow, ArrowDownRight, GripHorizontal, Loader2 } from 'lucide-react';
import { memo, useEffect, useState, useSyncExternalStore } from 'react';
import { PlayerSkipButton } from '@/components/player-action-overlays';
import {
  CHROME_ENTER_TIMING_CLASS,
  CHROME_EXIT_TIMING_CLASS,
  CHROME_ICON_BUTTON_CLASS,
  CHROME_ICON_STROKE,
} from '@/components/player-chrome-styles';
import {
  PlayerMuteButton,
  PlayerNextButton,
  PlayerPlayButton,
} from '@/components/player-control-buttons';
import { PlayerProgressBar, PlayerTimeDisplay } from '@/components/player-progress-bar';
import { usePlayerKeymap } from '@/hooks/use-app-ui-preferences';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import type { SkipSegment } from '@/lib/api';
import type { PlaybackClock } from '@/lib/player-clock';
import { snapPlayerPip } from '@/lib/player-pip';
import type { SubscribableStore } from '@/lib/subscribable-store';
import { cn } from '@/lib/utils';

interface PlayerPipChromeProps {
  title: string;
  episodeLabel?: string;
  visible: boolean;
  /** Returning to the app: fade everything out so only video shows while the window grows. */
  leaving: boolean;
  isPlaying: boolean;
  isMuted: boolean;
  volume: number;
  clock: PlaybackClock;
  bufferedClock: PlaybackClock;
  duration: number;
  playbackSpeed?: number;
  skipSegments: SkipSegment[];
  resetKey?: string;
  status?: string;
  error?: string | null;
  ended: boolean;
  autoPlayCountdown: SubscribableStore<number | null>;
  canGoNext: boolean;
  skipAction?: { label: string; onSkip: () => void } | null;
  onReturn: () => Promise<void>;
  onTogglePlay: () => Promise<void>;
  onToggleMute: () => Promise<void>;
  onVolumeWheel: (event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>) => Promise<void>;
  onSeek: (seconds: number) => void;
  onNext: () => void;
  onReplay: () => void;
  onRetry: () => void;
  onCancelAutoPlay: () => void;
  onControlsHover: (hovered: boolean) => void;
}

export const PlayerPipChrome = memo(function PlayerPipChrome(props: PlayerPipChromeProps) {
  const mountedRef = useMountedRef();
  const { title, episodeLabel, visible, leaving, status, error, ended, onReturn } = props;
  const autoPlaySecondsLeft = useSyncExternalStore(
    props.autoPlayCountdown.subscribe,
    props.autoPlayCountdown.getSnapshot,
  );
  const keymap = usePlayerKeymap();
  const [snapping, setSnapping] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const clearFocus = () => setFocused(false);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') clearFocus();
    };
    window.addEventListener('blur', clearFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('blur', clearFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);
  const chromeVisible =
    !leaving && (visible || !props.isPlaying || !!status || !!error || ended || focused);
  const leavingClass = cn(
    'transition-opacity duration-[90ms] motion-reduce:transition-none',
    leaving && 'opacity-0',
  );
  const volumeIsSilent = props.isMuted || props.volume === 0;
  const returnToApp = () => void onReturn().catch(() => undefined);
  const snapToCorner = () => {
    if (snapping) return;
    setSnapping(true);
    void snapPlayerPip()
      .catch(() => undefined)
      .finally(() => {
        if (mountedRef.current) setSnapping(false);
      });
  };
  return (
    <>
      <div
        aria-hidden='true'
        className={cn(
          'pointer-events-none absolute inset-0 z-60 border border-white/15',
          leavingClass,
        )}
      />
      {(status || error || ended) && (
        <div className={cn('pointer-events-none absolute inset-0 z-30 bg-black/65', leavingClass)}>
          <div className='absolute inset-x-4 top-11 bottom-24 flex min-h-0 items-center justify-center gap-2 text-center'>
            {status && !error && (
              <Loader2
                aria-hidden='true'
                className='h-4 w-4 shrink-0 animate-spin text-white/65 motion-reduce:animate-none'
              />
            )}
            <p
              role={error ? 'alert' : 'status'}
              className='line-clamp-2 min-w-0 text-xs leading-4 text-white/80'
              title={error || status}
            >
              {error ||
                status ||
                (autoPlaySecondsLeft !== null
                  ? `Next episode in ${autoPlaySecondsLeft}s`
                  : 'Playback finished')}
            </p>
          </div>
        </div>
      )}
      <div
        data-player-pip-chrome
        onFocus={(event) =>
          setFocused(document.hasFocus() && event.target.matches(':focus-visible'))
        }
        onPointerDownCapture={() => setFocused(false)}
        onBlur={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            setFocused(false);
        }}
        className={cn(
          'pointer-events-none absolute inset-0 z-40 flex cursor-auto flex-col justify-between transition-opacity motion-reduce:transition-none',
          leaving
            ? 'opacity-0 duration-[90ms]'
            : chromeVisible
              ? cn(CHROME_ENTER_TIMING_CLASS, 'opacity-100')
              : cn(CHROME_EXIT_TIMING_CLASS, 'opacity-0'),
        )}
      >
        <div
          data-player-interactive
          className={cn(
            'flex min-w-0 items-center gap-1 bg-linear-to-b from-black/80 to-transparent px-2 pt-1',
            chromeVisible ? 'pointer-events-auto' : 'pointer-events-none',
          )}
          onPointerEnter={() => props.onControlsHover(true)}
          onPointerLeave={() => props.onControlsHover(false)}
        >
          <button
            type='button'
            aria-label='Drag picture in picture title to move. Enter snaps to bottom-right.'
            title='Drag title to move · Enter to snap to bottom-right'
            className='flex min-w-0 flex-1 cursor-grab items-center gap-1.5 rounded-md px-1 py-2 text-left text-xs font-medium text-white/75 transition-colors hover:bg-white/5 hover:text-white active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
            onPointerDown={(event) => {
              if (event.button === 0)
                void getCurrentWindow()
                  .startDragging()
                  .catch(() => undefined);
            }}
            onClick={(event) => {
              if (event.detail === 0) snapToCorner();
            }}
          >
            <GripHorizontal aria-hidden='true' className='size-3.5 shrink-0 text-white/45' />
            <span className='truncate'>
              {title}
              {episodeLabel ? ` · ${episodeLabel}` : ''}
            </span>
          </button>
          <button
            type='button'
            className={cn(
              CHROME_ICON_BUTTON_CLASS,
              'h-8 w-auto gap-1.5 rounded-md px-2 text-xs font-medium',
            )}
            onClick={returnToApp}
            aria-label='Return to app'
            title='Return to app (Esc)'
            aria-keyshortcuts='Escape'
          >
            <AppWindow aria-hidden='true' className='h-4 w-4' strokeWidth={CHROME_ICON_STROKE} />
            Back to app
          </button>
        </div>
        <div
          data-player-interactive
          className={cn(
            'shrink-0 bg-linear-to-t from-black/90 via-black/60 to-transparent px-3 pb-2 pt-3',
            chromeVisible ? 'pointer-events-auto' : 'pointer-events-none',
          )}
          onPointerEnter={() => props.onControlsHover(true)}
          onPointerLeave={() => props.onControlsHover(false)}
        >
          <div className='flex justify-end pb-1'>
            <PlayerTimeDisplay
              active={chromeVisible}
              clock={props.clock}
              duration={props.duration}
              playbackSpeed={props.playbackSpeed}
              className='h-6 px-1 text-xs'
            />
          </div>
          <PlayerProgressBar
            active={chromeVisible}
            duration={props.duration}
            clock={props.clock}
            bufferedClock={props.bufferedClock}
            skipSegments={props.skipSegments}
            resetKey={props.resetKey}
            onSeek={props.onSeek}
          />
          <div className='flex items-center gap-1'>
            <PlayerPlayButton
              variant='pip'
              keymap={keymap}
              icon={error || ended ? 'replay' : props.isPlaying ? 'pause' : 'play'}
              label={
                error ? 'Try again' : ended ? 'Watch again' : props.isPlaying ? 'Pause' : 'Play'
              }
              title={error ? 'Try again' : ended ? 'Watch again' : undefined}
              onClick={() =>
                error
                  ? props.onRetry()
                  : ended
                    ? props.onReplay()
                    : void props.onTogglePlay().catch(() => undefined)
              }
            />
            <PlayerMuteButton
              variant='pip'
              keymap={keymap}
              label={volumeIsSilent ? 'Unmute' : 'Mute'}
              muted={volumeIsSilent}
              volume={props.volume}
              title={
                volumeIsSilent
                  ? undefined
                  : `Volume ${Math.round(props.volume)}% · scroll to adjust`
              }
              onClick={() => void props.onToggleMute().catch(() => undefined)}
              onWheel={(event) => {
                if (event.deltaY === 0) return;
                event.stopPropagation();
                void props.onVolumeWheel(event).catch(() => undefined);
              }}
            />
            {props.canGoNext && (
              <PlayerNextButton
                variant='pip'
                keymap={keymap}
                label='Next episode'
                onClick={props.onNext}
              />
            )}
            <div className='ml-auto flex min-w-0 items-center gap-1'>
              {ended && autoPlaySecondsLeft !== null ? (
                <button
                  type='button'
                  className='min-w-0 cursor-pointer truncate rounded-md px-2 py-1.5 text-xs text-white/75 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
                  onClick={props.onCancelAutoPlay}
                  title='Cancel autoplay'
                >
                  Cancel autoplay
                </button>
              ) : props.skipAction && !status && !error && !ended ? (
                <PlayerSkipButton action={props.skipAction} keymap={keymap} variant='compact' />
              ) : null}
              <button
                type='button'
                className={CHROME_ICON_BUTTON_CLASS}
                aria-label='Snap picture in picture to bottom-right'
                title='Snap to bottom-right of this screen'
                disabled={snapping}
                onClick={snapToCorner}
              >
                <ArrowDownRight
                  aria-hidden='true'
                  className='h-4 w-4'
                  strokeWidth={CHROME_ICON_STROKE}
                />
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
});
