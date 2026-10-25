import {
  ArrowLeft,
  Cloud,
  Maximize,
  Minimize,
  PictureInPicture2,
  RotateCcw,
  RotateCw,
} from 'lucide-react';
import { memo, type Ref, useId, useState } from 'react';
import {
  CHROME_ICON_BUTTON_CLASS,
  CHROME_ICON_CLASS,
  CHROME_ICON_STROKE,
  CHROME_MENU_ROW_FOCUS_CLASS,
  CHROME_PILL_CLASS,
  CHROME_POPOVER_CLASS,
  CHROME_VALUE_BUBBLE_CLASS,
} from '@/components/player-chrome-styles';
import {
  PlayerMuteButton,
  PlayerNextButton,
  PlayerPlayButton,
  PlayerPreviousButton,
} from '@/components/player-control-buttons';
import { PlayerEpisodesToggleButton } from '@/components/player-episodes-panel';
import { PlayerTimeDisplay } from '@/components/player-progress-bar';
import { PlayerSlider } from '@/components/player-slider';
import {
  AudioTrackSelector,
  SubtitleTrackSelector,
  type SubtitleTrackSelectorProps,
} from '@/components/player-track-selectors';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { usePlayerKeymap } from '@/hooks/use-app-ui-preferences';
import type { PlaybackClock } from '@/lib/player-clock';
import { ariaKeyShortcuts, formatBindingKey, withShortcutHint } from '@/lib/player-keybindings';
import type { Track } from '@/lib/player-track-utils';
import { cn, formatSeasonEpisode } from '@/lib/utils';

// Preset ladder shared by the popover and the speed hotkeys — one owner keeps them from drifting.
export const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

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
  isFullscreen,
  onToggleFullscreen,
}: PlayerTopChromeProps) {
  const keymap = usePlayerKeymap();
  const seasonEpisode = formatSeasonEpisode(season, episode);
  const separator = (
    <span aria-hidden='true' className='h-1 w-1 shrink-0 rounded-full bg-white/35' />
  );

  return (
    <div
      ref={chromeRef}
      data-player-interactive
      className='cursor-auto relative flex items-center justify-between'
    >
      <div className={CHROME_PILL_CLASS}>
        <button
          type='button'
          aria-label='Back'
          aria-keyshortcuts='Escape'
          title='Back (Esc)'
          onClick={() => void onBack().catch(() => undefined)}
          className={CHROME_ICON_BUTTON_CLASS}
        >
          <ArrowLeft className={CHROME_ICON_CLASS} strokeWidth={CHROME_ICON_STROKE} />
        </button>
      </div>
      <div className='mx-6 min-w-0 flex-1 text-center [text-shadow:0_1px_2px_rgba(0,0,0,0.55),0_2px_12px_rgba(0,0,0,0.45)]'>
        <h1 className='truncate text-[17px] leading-6 font-semibold tracking-tight text-white'>
          {title}
        </h1>
        {(seasonEpisode || episodeTitle || streamSourceName) && (
          <p className='mt-0.5 flex min-w-0 items-center justify-center gap-2 text-[13px] leading-5'>
            {seasonEpisode && (
              <span className='shrink-0 font-semibold tabular-nums text-white/90'>
                {seasonEpisode}
                {episodeCountInSeason ? (
                  <span className='font-medium text-white/45'> / {episodeCountInSeason}</span>
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
      <div className={CHROME_PILL_CLASS}>
        <button
          type='button'
          onClick={(e) => {
            e.stopPropagation();
            void onToggleFullscreen().catch(() => undefined);
          }}
          className={CHROME_ICON_BUTTON_CLASS}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          aria-keyshortcuts={ariaKeyShortcuts(keymap, 'toggleFullscreen')}
          title={withShortcutHint(
            isFullscreen ? 'Exit fullscreen' : 'Fullscreen',
            keymap,
            'toggleFullscreen',
          )}
        >
          {isFullscreen ? (
            <Minimize className={CHROME_ICON_CLASS} strokeWidth={CHROME_ICON_STROKE} />
          ) : (
            <Maximize className={CHROME_ICON_CLASS} strokeWidth={CHROME_ICON_STROKE} />
          )}
        </button>
      </div>
    </div>
  );
});

interface PlayerControlsRowProps extends SubtitleTrackSelectorProps {
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
  audioTracks: Track[];
  onSelectAudioTrack: (
    type: 'audio',
    id: number,
    options?: { persistPreference?: boolean },
  ) => void;
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
  audioTracks,
  trackSwitching,
  onSelectAudioTrack,
  ...subtitleProps
}: PlayerControlsRowProps) {
  const keymap = usePlayerKeymap();
  const speedHeadingId = useId();
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const volumeIsSilent = isMuted || volume === 0;
  const displayedVolume = isMuted ? 0 : Math.round(volume);
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

        {/* Always-visible volume rail reserves its space — hover/focus and pointer capture can't push adjacent controls. */}
        <div
          data-player-interactive
          className={cn(CHROME_PILL_CLASS, 'gap-1.5 pr-3')}
          // Interactive regions swallow the ambient wheel handler — scrolling here still adjusts volume.
          onWheel={(e) => {
            if (e.deltaY === 0) return;
            e.stopPropagation();
            void onVolumeWheel(e).catch(() => undefined);
          }}
        >
          <PlayerMuteButton
            variant='full'
            keymap={keymap}
            label={volumeIsSilent ? 'Unmute' : 'Mute'}
            muted={volumeIsSilent}
            volume={volume}
            onClick={() => void onToggleMute().catch(() => undefined)}
          />

          <div className='relative group/volume w-20 shrink-0'>
            <span
              aria-hidden='true'
              className={cn(
                CHROME_VALUE_BUBBLE_CLASS,
                'pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 opacity-0 transition-opacity group-hover/volume:opacity-100 group-has-[[data-keyboard-focus]]/volume:opacity-100 group-has-[:active]/volume:opacity-100 motion-reduce:transition-none',
              )}
            >
              {displayedVolume}%
            </span>
            <PlayerSlider
              variant='bar'
              active={active}
              value={[isMuted ? 0 : volume]}
              max={100}
              step={1}
              aria-label='Volume'
              aria-valuetext={isMuted ? 'Muted' : `${displayedVolume}%`}
              title={isMuted ? 'Volume: muted' : `Volume: ${displayedVolume}%`}
              onValueChange={(val) => void onVolumeChange(val[0]).catch(() => undefined)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                  event.stopPropagation();
                }
              }}
              className='w-20 shrink-0'
            />
          </div>
        </div>

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

        <SubtitleTrackSelector {...subtitleProps} trackSwitching={trackSwitching} />
        <AudioTrackSelector
          audioTracks={audioTracks}
          trackSwitching={trackSwitching}
          onSelectTrack={onSelectAudioTrack}
        />

        <Popover open={speedMenuOpen} onOpenChange={setSpeedMenuOpen}>
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
                    setSpeedMenuOpen(false);
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
