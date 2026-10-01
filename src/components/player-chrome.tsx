import {
  ArrowLeft,
  Cloud,
  FastForward,
  Maximize,
  Minimize,
  Pause,
  Play,
  Rewind,
  SkipForward,
} from 'lucide-react';
import { memo, type Ref, useState } from 'react';
import { CHROME_ICON_BUTTON_CLASS, CHROME_POPOVER_CLASS } from '@/components/player-chrome-styles';
import { PlayerEpisodesToggleButton } from '@/components/player-episodes-panel';
import { PlayerSlider } from '@/components/player-slider';
import { AudioTrackSelector, SubtitleTrackSelector } from '@/components/player-track-selectors';
import { PlayerVolumeIcon } from '@/components/player-volume-icon';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { AddonSubtitle } from '@/lib/api';
import type { Track } from '@/lib/player-track-utils';
import { cn, formatSeasonEpisode } from '@/lib/utils';

// The preset ladder is shared: the popover renders it and the `[`/`]`
// hotkeys step through it — one owner keeps the two from drifting.
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
  isFullscreen: boolean;
  onBack: () => Promise<void>;
  onToggleFullscreen: () => Promise<void>;
}

// Memoized: the player re-renders on every time-pos tick, so chrome subtrees
// with no tick-dependent props must bail out ~3x per second.
export const PlayerTopChrome = memo(function PlayerTopChrome({
  chromeRef,
  title,
  season,
  episode,
  episodeCountInSeason,
  episodeTitle,
  streamSourceName,
  isFullscreen,
  onBack,
  onToggleFullscreen,
}: PlayerTopChromeProps) {
  const secondaryParts: string[] = [];
  const seasonEpisode = formatSeasonEpisode(season, episode);
  if (seasonEpisode) {
    secondaryParts.push(
      `${seasonEpisode}${episodeCountInSeason ? ` / ${episodeCountInSeason}` : ''}`,
    );
  }
  if (episodeTitle) secondaryParts.push(episodeTitle);
  if (streamSourceName) secondaryParts.push(`via ${streamSourceName}`);

  return (
    <div
      ref={chromeRef}
      data-player-interactive
      className='pointer-events-auto relative flex items-center justify-between'
    >
      <button
        type='button'
        aria-label='Back'
        aria-keyshortcuts='Escape'
        title='Back (Esc)'
        onClick={() => void onBack().catch(() => undefined)}
        className={CHROME_ICON_BUTTON_CLASS}
      >
        <ArrowLeft className='w-5 h-5' strokeWidth={2.5} />
      </button>
      <div className='text-center min-w-0 flex-1 mx-4'>
        <h1 className='text-[15px] font-semibold line-clamp-1 leading-snug'>{title}</h1>
        {secondaryParts.length > 0 && (
          <p className='text-xs text-white/50 mt-0.5 truncate'>{secondaryParts.join(' · ')}</p>
        )}
      </div>
      <button
        type='button'
        onClick={(e) => {
          e.stopPropagation();
          void onToggleFullscreen().catch(() => undefined);
        }}
        className={CHROME_ICON_BUTTON_CLASS}
        aria-label={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
        aria-keyshortcuts='f'
        title={isFullscreen ? 'Exit Fullscreen (F)' : 'Fullscreen (F)'}
      >
        {isFullscreen ? (
          <Minimize className='w-5 h-5' strokeWidth={2.5} />
        ) : (
          <Maximize className='w-5 h-5' strokeWidth={2.5} />
        )}
      </button>
    </div>
  );
});

interface PlayerControlsRowProps {
  isPlaying: boolean;
  onTogglePlay: () => Promise<void>;
  onSeekRelative: (seconds: number) => Promise<void>;
  volume: number;
  isMuted: boolean;
  onToggleMute: () => Promise<void>;
  onVolumeChange: (volume: number) => Promise<void>;
  /** Wheel/key nudges — the parent owns the live volume ref. */
  onVolumeStep: (delta: number) => void;
  playbackSpeed: number;
  onSpeedChange: (speed: number) => void;
  hasEpisodes: boolean;
  episodesOpen: boolean;
  onToggleEpisodes: () => void;
  canChooseStream: boolean;
  streamSelectorOpen: boolean;
  onOpenStreamSelector: () => void;
  canGoNext: boolean;
  onNextEpisode: () => void;
  audioTracks: Track[];
  trackSwitching: { audio: boolean; sub: boolean };
  onSelectAudioTrack: (
    type: 'audio',
    id: number,
    options?: { persistPreference?: boolean },
  ) => void;
  subTracks: Track[];
  subtitlesOff: boolean;
  subtitleDelay: number;
  subtitlePos: number;
  subtitleScale: number;
  addonSubtitles: AddonSubtitle[];
  addonSubtitlesLoading: boolean;
  addonSubtitlesError?: string;
  addonSubtitlesQueried: boolean;
  activeAddonSubtitleId: string | null;
  addonSubtitleLoadingId: string | null;
  onSubtitleMenuOpenChange: (open: boolean) => void;
  onSelectAddonSubtitle: (subtitle: AddonSubtitle) => void;
  onResetSubtitleSettings: () => void;
  onApplySubtitleDelay: (value: number) => void;
  onApplySubtitlePos: (value: number) => void;
  onApplySubtitleScale: (value: number) => void;
  onSelectSubTrack: (
    type: 'sub',
    id: number | 'no',
    options?: { persistPreference?: boolean },
  ) => void;
}

// Memoized like the sibling selectors/panel: every prop is a primitive or a
// stable callback, so the ~200-element controls row skips every playback tick.
export const PlayerControlsRow = memo(function PlayerControlsRow({
  isPlaying,
  onTogglePlay,
  onSeekRelative,
  volume,
  isMuted,
  onToggleMute,
  onVolumeChange,
  onVolumeStep,
  playbackSpeed,
  onSpeedChange,
  hasEpisodes,
  episodesOpen,
  onToggleEpisodes,
  canChooseStream,
  streamSelectorOpen,
  onOpenStreamSelector,
  canGoNext,
  onNextEpisode,
  audioTracks,
  trackSwitching,
  onSelectAudioTrack,
  subTracks,
  subtitlesOff,
  subtitleDelay,
  subtitlePos,
  subtitleScale,
  addonSubtitles,
  addonSubtitlesLoading,
  addonSubtitlesError,
  addonSubtitlesQueried,
  activeAddonSubtitleId,
  addonSubtitleLoadingId,
  onSubtitleMenuOpenChange,
  onSelectAddonSubtitle,
  onResetSubtitleSettings,
  onApplySubtitleDelay,
  onApplySubtitlePos,
  onApplySubtitleScale,
  onSelectSubTrack,
}: PlayerControlsRowProps) {
  // Held during a volume drag: Radix captures the pointer, so pointer-up still
  // bubbles here when the cursor leaves — the card stays visible for the drag.
  const [volumeSliderHeld, setVolumeSliderHeld] = useState(false);
  return (
    <div className='flex items-center justify-between pt-1'>
      <div className='flex items-center gap-1'>
        {/* Rewind 10s */}
        <button
          type='button'
          aria-label='Rewind 10 seconds'
          aria-keyshortcuts='ArrowLeft'
          onClick={() => {
            void onSeekRelative(-10).catch(() => undefined);
          }}
          className={CHROME_ICON_BUTTON_CLASS}
          title='Rewind 10s (←)'
        >
          <Rewind className='w-[18px] h-[18px]' strokeWidth={2.5} />
        </button>

        {/* Play / Pause */}
        <button
          type='button'
          aria-label={isPlaying ? 'Pause' : 'Play'}
          aria-keyshortcuts='Space k'
          title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
          onClick={() => {
            void onTogglePlay().catch(() => undefined);
          }}
          className='flex h-11 w-11 items-center justify-center rounded-xl text-white transition-colors hover:bg-white/10 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
        >
          {isPlaying ? (
            <Pause className='w-[26px] h-[26px] fill-white' />
          ) : (
            <Play className='w-[26px] h-[26px] fill-white' />
          )}
        </button>

        {/* Forward 10s */}
        <button
          type='button'
          aria-label='Forward 10 seconds'
          aria-keyshortcuts='ArrowRight'
          onClick={() => {
            void onSeekRelative(10).catch(() => undefined);
          }}
          className={CHROME_ICON_BUTTON_CLASS}
          title='Forward 10s (→)'
        >
          <FastForward className='w-[18px] h-[18px]' strokeWidth={2.5} />
        </button>

        {/* Next Episode */}
        {canGoNext && (
          <button
            type='button'
            aria-label='Next episode'
            aria-keyshortcuts='n'
            title='Next Episode (N)'
            onClick={(e) => {
              e.stopPropagation();
              onNextEpisode();
            }}
            className={CHROME_ICON_BUTTON_CLASS}
          >
            <SkipForward className='w-[18px] h-[18px]' strokeWidth={2.5} />
          </button>
        )}

        {/* Volume: mute button plus an inline slider that slides out to its
            right — the playback bar's blocky track shape, no floating card. */}
        <div
          data-player-interactive
          className='flex items-center group/vol'
          // Interactive regions swallow the ambient wheel handler — scrolling
          // over the cluster still adjusts volume, like hovering the icon.
          onWheel={(e) => {
            if (e.deltaY === 0) return;
            e.stopPropagation();
            onVolumeStep(e.deltaY < 0 ? 5 : -5);
          }}
        >
          <button
            type='button'
            aria-label={isMuted ? 'Unmute' : 'Mute'}
            aria-keyshortcuts='m'
            title={isMuted ? 'Unmute (M)' : 'Mute (M)'}
            onClick={() => void onToggleMute().catch(() => undefined)}
            className={cn(CHROME_ICON_BUTTON_CLASS, 'z-10')}
          >
            <PlayerVolumeIcon
              muted={isMuted || volume === 0}
              volume={volume}
              className='h-[18px] w-[18px]'
              strokeWidth={2.5}
            />
          </button>

          {/* Held during a volume drag: Radix captures the pointer, so a drag
              wandering off the cluster can't collapse the slider mid-gesture.
              Touch has no hover — coarse pointers keep the rail open. */}
          <div
            className={cn(
              'invisible flex w-0 items-center overflow-hidden opacity-0 transition-[width,opacity,visibility] duration-200 ease-out motion-reduce:transition-none',
              'group-hover/vol:visible group-hover/vol:w-[128px] group-hover/vol:opacity-100',
              'group-focus-within/vol:visible group-focus-within/vol:w-[128px] group-focus-within/vol:opacity-100',
              '[@media(hover:none)]:visible [@media(hover:none)]:w-[128px] [@media(hover:none)]:opacity-100',
              volumeSliderHeld && 'visible w-[128px] opacity-100',
            )}
            onPointerDown={() => setVolumeSliderHeld(true)}
            onPointerUp={() => setVolumeSliderHeld(false)}
            onPointerCancel={() => setVolumeSliderHeld(false)}
            onLostPointerCapture={() => setVolumeSliderHeld(false)}
          >
            <PlayerSlider
              variant='bar'
              value={[isMuted ? 0 : volume]}
              max={100}
              step={1}
              aria-label='Volume'
              aria-valuetext={isMuted ? 'Muted' : `${Math.round(volume)}%`}
              title={isMuted ? 'Volume: muted' : `Volume: ${Math.round(volume)}%`}
              onValueChange={(val) => void onVolumeChange(val[0]).catch(() => undefined)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                  event.stopPropagation();
                }
              }}
              className='ml-1.5 w-[116px] shrink-0'
            />
          </div>
        </div>

        {/* Speed */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type='button'
              aria-label={`Playback speed: ${playbackSpeed}x`}
              title='Playback speed ([/])'
              className={cn(
                'flex h-9 items-center justify-center rounded-lg px-2 text-[11px] font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
                playbackSpeed === 1
                  ? 'text-white/50 hover:text-white hover:bg-white/10'
                  : 'text-[var(--accent-nav)] hover:bg-white/10',
              )}
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              {playbackSpeed}x
            </button>
          </PopoverTrigger>
          <PopoverContent
            side='top'
            sideOffset={10}
            className={cn(CHROME_POPOVER_CLASS, 'w-20 p-1')}
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className='flex flex-col'>
              {SPEED_OPTIONS.map((s) => (
                <button
                  key={s}
                  type='button'
                  aria-pressed={s === playbackSpeed}
                  onClick={() => onSpeedChange(s)}
                  className={cn(
                    'flex h-7 items-center justify-between rounded-md px-2.5 text-left text-[11px] tabular-nums transition-colors hover:bg-white/[0.08] focus-visible:outline-none focus-visible:bg-white/[0.08] focus-visible:text-white',
                    s === playbackSpeed
                      ? 'text-white font-semibold'
                      : 'text-white/60 hover:text-white',
                  )}
                >
                  {s}x{s === playbackSpeed && <span className='h-1 w-1 rounded-full bg-white' />}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className='flex items-center gap-1'>
        {/* Episodes List Toggle */}
        {hasEpisodes && (
          <PlayerEpisodesToggleButton open={episodesOpen} onToggle={onToggleEpisodes} />
        )}

        {/* Stream / Quality Hot-Swap */}
        {canChooseStream && (
          <button
            type='button'
            aria-label='Choose stream or quality'
            aria-keyshortcuts='q'
            aria-expanded={streamSelectorOpen}
            className={cn(CHROME_ICON_BUTTON_CLASS, streamSelectorOpen && 'bg-white/15 text-white')}
            title='Choose Stream / Quality (Q)'
            onClick={(e) => {
              e.stopPropagation();
              onOpenStreamSelector();
            }}
          >
            <Cloud className='w-[18px] h-[18px]' strokeWidth={2.5} />
          </button>
        )}

        {/* Audio Track Selector */}
        <AudioTrackSelector
          audioTracks={audioTracks}
          trackSwitching={trackSwitching}
          onSelectTrack={onSelectAudioTrack}
        />

        {/* Subtitle Track Selector */}
        <SubtitleTrackSelector
          subTracks={subTracks}
          subtitlesOff={subtitlesOff}
          trackSwitching={trackSwitching}
          subtitleDelay={subtitleDelay}
          subtitlePos={subtitlePos}
          subtitleScale={subtitleScale}
          addonSubtitles={addonSubtitles}
          addonSubtitlesLoading={addonSubtitlesLoading}
          addonSubtitlesError={addonSubtitlesError}
          addonSubtitlesQueried={addonSubtitlesQueried}
          activeAddonSubtitleId={activeAddonSubtitleId}
          addonSubtitleLoadingId={addonSubtitleLoadingId}
          onOpenChange={onSubtitleMenuOpenChange}
          onSelectAddonSubtitle={onSelectAddonSubtitle}
          onResetSubtitleSettings={onResetSubtitleSettings}
          onApplySubtitleDelay={onApplySubtitleDelay}
          onApplySubtitlePos={onApplySubtitlePos}
          onApplySubtitleScale={onApplySubtitleScale}
          onSelectTrack={onSelectSubTrack}
        />
      </div>
    </div>
  );
});
