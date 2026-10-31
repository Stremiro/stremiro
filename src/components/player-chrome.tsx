import {
  ArrowLeft,
  Cloud,
  Copy,
  Maximize,
  Minimize,
  PictureInPicture2,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import { memo, type ReactNode, type Ref, useId } from 'react';
import {
  CHROME_CORNER_BUTTON_CLASS,
  CHROME_ICON_BUTTON_CLASS,
  CHROME_ICON_CLASS,
  CHROME_ICON_STROKE,
  CHROME_MENU_ROW_FOCUS_CLASS,
  CHROME_PILL_CLASS,
  CHROME_POPOVER_CLASS,
} from '@/components/player-chrome-styles';
import {
  PlayerVolumeControl,
  PlayerNextButton,
  PlayerPlayButton,
  PlayerPreviousButton,
} from '@/components/player-control-buttons';
import { PlayerEpisodesToggleButton } from '@/components/player-episodes-panel';
import { PlayerTimeDisplay } from '@/components/player-progress-bar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu';
import { usePlayerKeymap } from '@/hooks/use-app-ui-preferences';
import type { PlaybackClock } from '@/lib/player-clock';
import { ariaKeyShortcuts, formatBindingKey, withShortcutHint } from '@/lib/player-keybindings';
import { preserveOpenPlayerMenuFocus } from '@/lib/player-dom';
import { cn, formatSeasonEpisode } from '@/lib/utils';

// Preset ladder shared by the popover and the speed hotkeys — one owner keeps them from drifting.
export const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export const PlayerContextActions = memo(function PlayerContextActions({
  canGoPrevious,
  canGoNext,
  canCopy,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
  onCopy,
}: {
  canGoPrevious: boolean;
  canGoNext: boolean;
  canCopy: boolean;
  previousLabel?: string;
  nextLabel?: string;
  onPrevious: () => void;
  onNext: () => void;
  onCopy: () => void;
}) {
  const actions = [
    {
      label: previousLabel ?? 'Previous episode',
      icon: SkipBack,
      disabled: !canGoPrevious,
      run: onPrevious,
    },
    { label: 'Copy stream link', icon: Copy, disabled: !canCopy, run: onCopy },
    { label: nextLabel ?? 'Next episode', icon: SkipForward, disabled: !canGoNext, run: onNext },
  ];
  return (
    <ContextMenuContent
      data-player-popover
      side='top'
      align='center'
      sideOffset={0}
      collisionPadding={8}
      aria-label='Player actions'
      aria-orientation='horizontal'
      className='flex min-w-0 items-end gap-1.5 overflow-visible rounded-none border-0 bg-transparent p-1 shadow-none backdrop-blur-none data-[state=open]:slide-in-from-top-0 data-[state=open]:slide-in-from-bottom-0'
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            '[role="menuitem"]:not([data-disabled])',
          ),
        );
        const current = items.indexOf(document.activeElement as HTMLElement);
        const next =
          event.key === 'ArrowRight'
            ? items[(current + 1) % items.length]
            : items.at(current < 0 ? -1 : current - 1);
        next?.focus();
      }}
    >
      {actions.map(({ label, icon: Icon, disabled, run }, index) => (
        <ContextMenuItem
          key={label}
          disabled={disabled}
          onSelect={run}
          aria-label={label}
          title={label}
          className={cn(
            'size-11 justify-center rounded-xl border border-white/12 p-0 shadow-lg backdrop-blur-md transition-colors motion-reduce:transition-none',
            index === 1
              ? 'size-12 -translate-y-1 bg-(--accent-act) text-(--on-accent-act) focus:bg-(--accent-act)/90 focus:text-(--on-accent-act)'
              : 'bg-zinc-950/90 text-white/75 focus:bg-zinc-800 focus:text-white',
          )}
        >
          <Icon aria-hidden='true' className='size-[18px]' strokeWidth={CHROME_ICON_STROKE} />
        </ContextMenuItem>
      ))}
    </ContextMenuContent>
  );
});

interface PlayerTopChromeProps {
  chromeRef?: Ref<HTMLDivElement>;
  title: string;
  season?: number;
  episode?: number;
  episodeCountInSeason: number | null;
  /** Playing episode's own title (details.episodes lookup) when known. */
  episodeTitle?: string;
  /** Live source label — reflects failover swaps, not just the launch pick. */
  streamSourceName?: string;
  onBack: () => Promise<void>;
  onOpenDetails: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => Promise<void>;
}

// Memoized — OSD and controls-visibility changes re-render the player; the static chrome must bail out.
export const PlayerTopChrome = memo(function PlayerTopChrome({
  chromeRef,
  title,
  season,
  episode,
  episodeCountInSeason,
  episodeTitle,
  streamSourceName,
  onBack,
  onOpenDetails,
  isFullscreen,
  onToggleFullscreen,
}: PlayerTopChromeProps) {
  const keymap = usePlayerKeymap();
  const seasonEpisode = formatSeasonEpisode(season, episode);
  const separator = (
    <span aria-hidden='true' className='h-[3px] w-[3px] shrink-0 rounded-full bg-white/30' />
  );

  return (
    <div
      ref={chromeRef}
      data-player-interactive
      className='cursor-auto relative grid grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center'
    >
      <button
        type='button'
        aria-label='Back'
        aria-keyshortcuts='Escape'
        title='Back (Esc)'
        onClick={() => void onBack().catch(() => undefined)}
        className={CHROME_CORNER_BUTTON_CLASS}
      >
        <ArrowLeft className='h-5 w-5' strokeWidth={CHROME_ICON_STROKE} />
      </button>
      <div className='min-w-0 px-3 text-center [text-shadow:0_1px_2px_rgba(0,0,0,0.55)]'>
        <h1 className='truncate text-center text-[16px] leading-6 font-semibold tracking-[-0.015em] text-white'>
          <button
            type='button'
            title='View details'
            onClick={(event) => {
              event.stopPropagation();
              onOpenDetails();
            }}
            className='inline-block max-w-full truncate rounded-sm text-center transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
          >
            {title}
          </button>
        </h1>
        {(seasonEpisode || episodeTitle || streamSourceName) && (
          <p className='flex min-w-0 items-center justify-center gap-1.5 text-[12.5px] leading-5'>
            {seasonEpisode && (
              <span className='shrink-0 font-medium tabular-nums tracking-tight text-white/85'>
                {seasonEpisode}
                {episodeCountInSeason ? (
                  <span className='font-normal text-white/40'> / {episodeCountInSeason}</span>
                ) : null}
              </span>
            )}
            {seasonEpisode && episodeTitle && separator}
            {episodeTitle && (
              <span className='min-w-0 truncate font-medium text-white/80'>{episodeTitle}</span>
            )}
            {(seasonEpisode || episodeTitle) && streamSourceName && separator}
            {streamSourceName && (
              <span className='max-w-[40%] shrink-0 truncate text-white/50'>
                via {streamSourceName}
              </span>
            )}
          </p>
        )}
      </div>
      <button
        type='button'
        onClick={(e) => {
          e.stopPropagation();
          void onToggleFullscreen().catch(() => undefined);
        }}
        className={cn(CHROME_CORNER_BUTTON_CLASS, 'justify-self-end')}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        aria-keyshortcuts={ariaKeyShortcuts(keymap, 'toggleFullscreen')}
        title={withShortcutHint(
          isFullscreen ? 'Exit fullscreen' : 'Fullscreen',
          keymap,
          'toggleFullscreen',
        )}
      >
        {isFullscreen ? (
          <Minimize className='h-5 w-5' strokeWidth={CHROME_ICON_STROKE} />
        ) : (
          <Maximize className='h-5 w-5' strokeWidth={CHROME_ICON_STROKE} />
        )}
      </button>
    </div>
  );
});

interface PlayerControlsRowProps {
  clock: PlaybackClock;
  duration: number;
  active: boolean;
  onTogglePip?: () => Promise<void>;
  isPlaying: boolean;
  onTogglePlay: () => Promise<void>;
  onSeekRelative: (seconds: number) => Promise<void>;
  volume: number;
  isMuted: boolean;
  onToggleMute: () => Promise<void>;
  onVolumeChange: (volume: number) => Promise<void>;
  /** Shared wheel accumulator — trackpad gestures use the live volume ref. */
  onVolumeWheel: (event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>) => Promise<void>;
  playbackSpeed: number;
  onSpeedChange: (speed: number) => void;
  speedMenuOpen: boolean;
  onSpeedMenuOpenChange: (open: boolean) => void;
  hasEpisodes: boolean;
  episodesOpen: boolean;
  onToggleEpisodes: () => void;
  canChooseStream: boolean;
  streamSelectorOpen: boolean;
  onOpenStreamSelector: () => void;
  canGoPrevious: boolean;
  onPreviousEpisode: () => void;
  /** e.g. `Previous: S1E2 · Title` — no new keybinding action. */
  previousEpisodeLabel?: string;
  canGoNext: boolean;
  onNextEpisode: () => void;
  /** e.g. `Next: S1E3 · Title` — the button tooltip names where it goes. */
  nextEpisodeLabel?: string;
  trackSelectors: ReactNode;
}

const SEEK_BUTTONS = [
  { action: 'seekBackward', label: 'Rewind 10 seconds', hint: 'Rewind 10s', delta: -10 },
  { action: 'seekForward', label: 'Forward 10 seconds', hint: 'Forward 10s', delta: 10 },
] as const;

function SeekTenIcon({ forward }: { forward: boolean }) {
  const Icon = forward ? RotateCw : RotateCcw;
  return (
    <span aria-hidden='true' className={cn('relative', CHROME_ICON_CLASS)}>
      <Icon className={CHROME_ICON_CLASS} strokeWidth={CHROME_ICON_STROKE} />
      <span className='absolute inset-0 flex items-center justify-center pt-0.5 text-[8.5px] font-bold leading-none tabular-nums'>
        10
      </span>
    </span>
  );
}

// Memoized like the sibling selectors/panel — primitive/stable props let the controls row skip playback ticks.
export const PlayerControlsRow = memo(function PlayerControlsRow({
  clock,
  duration,
  active,
  onTogglePip,
  isPlaying,
  onTogglePlay,
  onSeekRelative,
  volume,
  isMuted,
  onToggleMute,
  onVolumeChange,
  onVolumeWheel,
  playbackSpeed,
  onSpeedChange,
  speedMenuOpen,
  onSpeedMenuOpenChange,
  hasEpisodes,
  episodesOpen,
  onToggleEpisodes,
  canChooseStream,
  streamSelectorOpen,
  onOpenStreamSelector,
  canGoPrevious,
  onPreviousEpisode,
  previousEpisodeLabel,
  canGoNext,
  onNextEpisode,
  nextEpisodeLabel,
  trackSelectors,
}: PlayerControlsRowProps) {
  const keymap = usePlayerKeymap();
  const speedHeadingId = useId();
  const speedKeys = [keymap.keys.speedDown[0], keymap.keys.speedUp[0]]
    .filter((key) => key !== undefined)
    .map(formatBindingKey);
  return (
    <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-2'>
      <div className='flex min-w-0 max-w-full flex-wrap items-center gap-2'>
        <div className={CHROME_PILL_CLASS}>
          {hasEpisodes && (
            <PlayerPreviousButton
              variant='full'
              keymap={keymap}
              label={previousEpisodeLabel ?? 'Previous episode'}
              disabled={!canGoPrevious}
              onClick={(e) => {
                e.stopPropagation();
                onPreviousEpisode();
              }}
            />
          )}
          <PlayerPlayButton
            variant='full'
            keymap={keymap}
            icon={isPlaying ? 'pause' : 'play'}
            label={isPlaying ? 'Pause' : 'Play'}
            onClick={() => {
              void onTogglePlay().catch(() => undefined);
            }}
          />
          {hasEpisodes && (
            <PlayerNextButton
              variant='full'
              keymap={keymap}
              label={nextEpisodeLabel ?? 'Next episode'}
              disabled={!canGoNext}
              onClick={(e) => {
                e.stopPropagation();
                onNextEpisode();
              }}
            />
          )}
        </div>

        <PlayerVolumeControl
          variant='full'
          active={active}
          keymap={keymap}
          volume={volume}
          isMuted={isMuted}
          onToggleMute={onToggleMute}
          onVolumeChange={onVolumeChange}
          onVolumeWheel={onVolumeWheel}
        />

        <div className={CHROME_PILL_CLASS}>
          <PlayerTimeDisplay
            clock={clock}
            duration={duration}
            playbackSpeed={playbackSpeed}
            active={active}
          />
        </div>
      </div>

      <div className={cn(CHROME_PILL_CLASS, 'ml-auto gap-1.5 px-1.5')}>
        {SEEK_BUTTONS.map(({ action, label, hint, delta }) => (
          <button
            key={action}
            type='button'
            aria-label={label}
            aria-keyshortcuts={ariaKeyShortcuts(keymap, action)}
            onClick={() => {
              void onSeekRelative(delta).catch(() => undefined);
            }}
            className={CHROME_ICON_BUTTON_CLASS}
            title={withShortcutHint(hint, keymap, action)}
          >
            <SeekTenIcon forward={delta > 0} />
          </button>
        ))}

        {trackSelectors}

        <Popover open={speedMenuOpen} onOpenChange={onSpeedMenuOpenChange}>
          <PopoverTrigger asChild>
            <button
              type='button'
              aria-label={`Playback speed: ${playbackSpeed}x`}
              aria-keyshortcuts={
                [ariaKeyShortcuts(keymap, 'speedDown'), ariaKeyShortcuts(keymap, 'speedUp')]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
              title={
                speedKeys.length > 0
                  ? `Playback speed (${speedKeys.join(' / ')})`
                  : 'Playback speed'
              }
              className={cn(CHROME_ICON_BUTTON_CLASS, playbackSpeed !== 1 && 'text-(--accent-nav)')}
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <span className='text-xs font-semibold tabular-nums'>{playbackSpeed}x</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            data-player-popover
            onCloseAutoFocus={preserveOpenPlayerMenuFocus}
            side='top'
            sideOffset={10}
            aria-labelledby={speedHeadingId}
            className={cn(
              CHROME_POPOVER_CLASS,
              'max-h-(--radix-popover-content-available-height) w-64 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain p-2',
            )}
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <h4 id={speedHeadingId} className='px-2 py-2 text-[13px] font-semibold text-zinc-200'>
              Speed
            </h4>
            <div className='grid grid-cols-4 gap-1'>
              {SPEED_OPTIONS.map((s) => (
                <button
                  key={s}
                  type='button'
                  aria-label={`Playback speed: ${s}x`}
                  aria-pressed={s === playbackSpeed}
                  onClick={() => {
                    onSpeedChange(s);
                    onSpeedMenuOpenChange(false);
                  }}
                  className={cn(
                    CHROME_MENU_ROW_FOCUS_CLASS,
                    'flex min-h-10 items-center justify-center rounded-md px-1 text-[13px] tabular-nums transition-colors hover:bg-white/[0.08]',
                    s === playbackSpeed
                      ? 'bg-white/[0.08] text-white font-semibold'
                      : 'text-white/60 hover:text-white',
                  )}
                >
                  {s}x
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {canChooseStream && (
          <button
            type='button'
            aria-label='Choose stream or quality'
            aria-keyshortcuts={ariaKeyShortcuts(keymap, 'streamSelector')}
            aria-expanded={streamSelectorOpen}
            className={CHROME_ICON_BUTTON_CLASS}
            title={withShortcutHint('Choose stream / quality', keymap, 'streamSelector')}
            onClick={(e) => {
              e.stopPropagation();
              onOpenStreamSelector();
            }}
          >
            <Cloud className={CHROME_ICON_CLASS} strokeWidth={CHROME_ICON_STROKE} />
          </button>
        )}

        {hasEpisodes && (
          <PlayerEpisodesToggleButton open={episodesOpen} onToggle={onToggleEpisodes} />
        )}
        {onTogglePip && (
          <button
            type='button'
            className={CHROME_ICON_BUTTON_CLASS}
            aria-label='Picture in picture'
            title='Picture in picture'
            onClick={() => void onTogglePip().catch(() => undefined)}
          >
            <PictureInPicture2 className={CHROME_ICON_CLASS} strokeWidth={CHROME_ICON_STROKE} />
          </button>
        )}
      </div>
    </div>
  );
});
