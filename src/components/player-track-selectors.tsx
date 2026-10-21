import { AudioLines, Captions, Check, Loader2, Minus, Moon, Plus } from 'lucide-react';
import { memo, useId, useState } from 'react';
import {
  CHROME_ICON_BUTTON_CLASS,
  CHROME_ICON_CLASS,
  CHROME_ICON_STROKE,
  CHROME_MENU_INDICATOR_CLASS,
  CHROME_MENU_ROW_FOCUS_CLASS,
  CHROME_POPOVER_CLASS,
} from '@/components/player-chrome-styles';
import { PlayerSlider } from '@/components/player-slider';
import { RetryBanner } from '@/components/retry-banner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAppUiPreferences, usePlayerKeymap } from '@/hooks/use-app-ui-preferences';
import type { AddonSubtitle } from '@/lib/api';
import { ariaKeyShortcuts, withShortcutHint } from '@/lib/player-keybindings';
import type { Track } from '@/lib/player-track-utils';
import { clamp, cn } from '@/lib/utils';

// Stable default — a fresh `[]` literal would defeat this component's memo.
const EMPTY_ADDON_SUBTITLES: AddonSubtitle[] = [];

const TRACK_NUDGE_BUTTON_CLASS = cn(
  CHROME_MENU_ROW_FOCUS_CLASS,
  'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white aria-disabled:cursor-default aria-disabled:opacity-35 aria-disabled:hover:bg-transparent aria-disabled:hover:text-zinc-300',
);
const SUBTITLE_VIEW_TAB_CLASS = cn(
  CHROME_MENU_ROW_FOCUS_CLASS,
  'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors',
);
const SUBTITLE_VIEW_TAB_ACTIVE_CLASS = 'bg-white/[0.09] text-white';
const SUBTITLE_VIEW_TAB_INACTIVE_CLASS = 'text-zinc-400 hover:text-white';
const TRACK_ROW_CLASS = cn(
  CHROME_MENU_ROW_FOCUS_CLASS,
  'flex min-h-10 w-full cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-[13px] font-medium leading-snug transition-colors aria-disabled:cursor-wait',
);

interface TrackSelectRowProps {
  label: string;
  selected: boolean;
  /** Switch in flight for this track kind — dims and locks the row. */
  busy: boolean;
  onSelect: () => void;
}

/** One row for every embedded-track list (audio, subtitles, Off). */
function TrackSelectRow({ label, selected, busy, onSelect }: TrackSelectRowProps) {
  return (
    <button
      type='button'
      className={cn(
        TRACK_ROW_CLASS,
        selected
          ? 'bg-white/[0.08] text-white'
          : 'text-zinc-300 hover:bg-white/[0.06] hover:text-white',
        busy && 'opacity-60',
      )}
      title={label}
      aria-pressed={selected}
      aria-disabled={busy || undefined}
      onClick={() => {
        if (!busy) onSelect();
      }}
    >
      <span className='min-w-0 flex-1 line-clamp-2 wrap-anywhere' title={label}>
        {label}
      </span>
      <span aria-hidden='true' className={CHROME_MENU_INDICATOR_CLASS}>
        {busy && selected ? (
          <Loader2 className='h-3.5 w-3.5 animate-spin text-white/70 motion-reduce:animate-none' />
        ) : selected ? (
          <Check className='h-3.5 w-3.5 text-white' strokeWidth={CHROME_ICON_STROKE} />
        ) : null}
      </span>
    </button>
  );
}

interface AudioTrackSelectorProps {
  audioTracks: Track[];
  trackSwitching: { audio: boolean; sub: boolean };
  onSelectTrack: (type: 'audio', id: number, options?: { persistPreference?: boolean }) => void;
}

export const AudioTrackSelector = memo(function AudioTrackSelector({
  audioTracks,
  trackSwitching,
  onSelectTrack,
}: AudioTrackSelectorProps) {
  const keymap = usePlayerKeymap();
  const { preferences, isHydrating, updatePreferences } = useAppUiPreferences(
    ({ audioDelay, nightMode }) => ({ audioDelay, nightMode }),
  );
  const { audioDelay, nightMode } = preferences;
  const hasAudioSettings = audioDelay !== 0 || nightMode;
  const headingId = useId();
  const selectedAudioTrack = audioTracks.find((track) => track.selected);
  const selectedAudioLabel = selectedAudioTrack?.displayLabel;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(CHROME_ICON_BUTTON_CLASS, 'relative')}
          aria-label={`${selectedAudioLabel ? `Audio: ${selectedAudioLabel}` : 'Audio settings'}${nightMode ? ', Night mode on' : ''}`}
          aria-keyshortcuts={ariaKeyShortcuts(keymap, 'cycleAudio')}
          title={withShortcutHint(
            nightMode ? 'Audio · Night mode on' : 'Audio',
            keymap,
            'cycleAudio',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <AudioLines className={CHROME_ICON_CLASS} strokeWidth={CHROME_ICON_STROKE} />
          {nightMode ? (
            <Moon
              aria-hidden='true'
              className='absolute -top-1 -right-1 h-2.5 w-2.5 text-(--accent-act)'
              strokeWidth={2.5}
            />
          ) : hasAudioSettings ? (
            <span
              aria-hidden='true'
              className='absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-(--accent-act)'
            />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='end'
        sideOffset={10}
        aria-labelledby={headingId}
        className={cn(
          CHROME_POPOVER_CLASS,
          'flex max-h-[min(32rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-1rem)] flex-col overflow-y-auto overscroll-contain p-1.5',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex min-h-9 shrink-0 items-center justify-between px-2.5'>
          <h4 id={headingId} className='text-xs font-semibold text-zinc-300'>
            Audio
          </h4>
          <span className='text-[10px] text-zinc-500'>
            {isHydrating ? 'Loading preferences…' : 'Saved for all videos'}
          </span>
        </div>
        <button
          type='button'
          role='switch'
          aria-checked={nightMode}
          aria-labelledby={`${headingId}-night`}
          aria-describedby={`${headingId}-night-description`}
          aria-disabled={isHydrating || undefined}
          onClick={() => {
            if (!isHydrating) updatePreferences({ nightMode: !nightMode });
          }}
          className={cn(
            CHROME_MENU_ROW_FOCUS_CLASS,
            'mx-1 my-1 flex shrink-0 cursor-pointer items-center gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.025] px-2.5 py-3 text-left transition-colors hover:bg-white/[0.05] aria-disabled:cursor-wait aria-disabled:opacity-35',
          )}
        >
          <Moon
            aria-hidden='true'
            className={cn('h-4 w-4 shrink-0', nightMode ? 'text-(--accent-act)' : 'text-zinc-400')}
            strokeWidth={CHROME_ICON_STROKE}
          />
          <span className='min-w-0 flex-1'>
            <span id={`${headingId}-night`} className='block text-xs font-medium text-zinc-100'>
              Night mode
            </span>
            <span
              id={`${headingId}-night-description`}
              className='mt-1 block text-[11px] leading-relaxed text-zinc-400'
            >
              Boosts quiet audio and smooths volume changes.
            </span>
          </span>
          <span
            aria-hidden='true'
            className={cn(
              'relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-md transition-colors duration-150 motion-reduce:transition-none',
              nightMode ? 'bg-(--accent-act)' : 'bg-zinc-800',
            )}
          >
            <span
              className={cn(
                'inline-block h-4 w-4 rounded-[3px] shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-[translate,background-color] duration-150 motion-reduce:transition-none',
                nightMode
                  ? 'translate-x-[21px] bg-(--on-accent-act)'
                  : 'translate-x-[3px] bg-zinc-400',
              )}
            />
          </span>
        </button>
        {audioTracks.length > 0 && (
          <p className='px-2.5 pt-2 pb-1 text-[10px] font-medium text-zinc-500'>Audio track</p>
        )}
        <div className='min-h-0 max-h-[36vh] space-y-px overflow-y-auto overscroll-contain'>
          {audioTracks.map((track) => (
            <TrackSelectRow
              key={track.id}
              label={track.displayLabel}
              selected={!!track.selected}
              busy={trackSwitching.audio}
              onSelect={() => onSelectTrack('audio', track.id, { persistPreference: true })}
            />
          ))}
        </div>
        <div className='mx-2.5 mt-2 shrink-0 border-t border-white/[0.07] pt-2 pb-1.5'>
          <div className='flex items-center justify-between gap-2'>
            <span className='text-xs font-medium text-zinc-300'>Audio sync</span>
            <button
              type='button'
              className={cn(
                CHROME_MENU_ROW_FOCUS_CLASS,
                'h-8 rounded-md px-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white aria-disabled:opacity-35 aria-disabled:hover:bg-transparent aria-disabled:hover:text-zinc-300',
              )}
              aria-label='Reset audio sync'
              aria-disabled={isHydrating || audioDelay === 0 || undefined}
              onClick={() => {
                if (!isHydrating && audioDelay !== 0) updatePreferences({ audioDelay: 0 });
              }}
            >
              Reset
            </button>
          </div>
          <div className='flex items-center justify-between gap-2'>
            <span className='text-[11px] text-zinc-400'>Earlier / later</span>
            <div className='flex items-center gap-1'>
              <button
                type='button'
                className={TRACK_NUDGE_BUTTON_CLASS}
                aria-label='Play audio 0.1 seconds earlier'
                aria-disabled={isHydrating || audioDelay <= -5 || undefined}
                onClick={() => {
                  if (!isHydrating && audioDelay > -5)
                    updatePreferences({
                      audioDelay: Math.round(clamp(audioDelay - 0.1, -5, 5) * 10) / 10,
                    });
                }}
              >
                <Minus aria-hidden='true' className='h-3.5 w-3.5' />
              </button>
              <output
                className='w-16 text-center text-xs tabular-nums text-zinc-100'
                aria-live='polite'
              >
                {audioDelay > 0 ? '+' : ''}
                {audioDelay.toFixed(1)}s
              </output>
              <button
                type='button'
                className={TRACK_NUDGE_BUTTON_CLASS}
                aria-label='Play audio 0.1 seconds later'
                aria-disabled={isHydrating || audioDelay >= 5 || undefined}
                onClick={() => {
                  if (!isHydrating && audioDelay < 5)
                    updatePreferences({
                      audioDelay: Math.round(clamp(audioDelay + 0.1, -5, 5) * 10) / 10,
                    });
                }}
              >
                <Plus aria-hidden='true' className='h-3.5 w-3.5' />
              </button>
            </div>
          </div>
          <p className='text-[11px] leading-relaxed text-zinc-400'>
            Adjust only if sound and picture are out of sync.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
});

export interface SubtitleTrackSelectorProps {
  subTracks: Track[];
  trackSwitching: { audio: boolean; sub: boolean };
  subtitleDelay: number;
  subtitlePos: number;
  subtitleScale: number;
  onResetSubtitleSettings: () => void;
  onApplySubtitleDelay: (value: number) => void;
  onApplySubtitlePos: (value: number) => void;
  onApplySubtitleScale: (value: number) => void;
  onSelectSubTrack: (
    type: 'sub',
    id: number | 'no',
    options?: { persistPreference?: boolean },
  ) => void;
  addonSubtitles?: AddonSubtitle[];
  addonSubtitlesLoading?: boolean;
  addonSubtitlesFetching: boolean;
  addonSubtitlesError?: string;
  onRetryAddonSubtitles: () => void;
  /** True once the addon-subtitle lookup has actually run — gates the empty-state hint. */
  addonSubtitlesQueried?: boolean;
  /** Rust-authored subtitle selection key. */
  activeAddonSubtitleId?: string | null;
  addonSubtitleLoadingId?: string | null;
  onSelectAddonSubtitle?: (subtitle: AddonSubtitle) => void;
  onSubtitleMenuOpenChange?: (open: boolean) => void;
}

export const SubtitleTrackSelector = memo(function SubtitleTrackSelector({
  subTracks,
  trackSwitching,
  subtitleDelay,
  subtitlePos,
  subtitleScale,
  onResetSubtitleSettings,
  onApplySubtitleDelay,
  onApplySubtitlePos,
  onApplySubtitleScale,
  onSelectSubTrack,
  addonSubtitles: addonSubtitlesProp,
  addonSubtitlesLoading,
  addonSubtitlesFetching,
  addonSubtitlesError,
  onRetryAddonSubtitles,
  addonSubtitlesQueried,
  activeAddonSubtitleId,
  addonSubtitleLoadingId,
  onSelectAddonSubtitle,
  onSubtitleMenuOpenChange,
}: SubtitleTrackSelectorProps) {
  const addonSubtitles =
    addonSubtitlesProp === undefined ? EMPTY_ADDON_SUBTITLES : addonSubtitlesProp;
  const keymap = usePlayerKeymap();
  const headingId = useId();
  const selectedSubTrack = subTracks.find((track) => track.selected);
  const selectedSubLabel = selectedSubTrack?.displayLabel;
  const subtitlesShownOff = !selectedSubTrack;
  const subStateLabel = subtitlesShownOff ? 'Off' : (selectedSubLabel ?? 'On');
  const hasNonDefaultSettings = subtitleDelay !== 0 || subtitlePos !== 100 || subtitleScale !== 1.0;
  // Tabbed card — both lists share one bounded region so a long addon result set can't push settings out of view.
  const [view, setView] = useState<'tracks' | 'addons'>('tracks');

  const handleOpenChange = (open: boolean) => {
    // Reopen on the tab owning the active pick — an addon-selected subtitle shows checked immediately.
    if (open) setView(activeAddonSubtitleId ? 'addons' : 'tracks');
    onSubtitleMenuOpenChange?.(open);
  };

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(CHROME_ICON_BUTTON_CLASS, 'relative')}
          aria-label={`Subtitles: ${subStateLabel}`}
          aria-keyshortcuts={ariaKeyShortcuts(keymap, 'cycleSubtitles')}
          title={withShortcutHint('Subtitles', keymap, 'cycleSubtitles')}
          onClick={(e) => e.stopPropagation()}
        >
          <Captions className={CHROME_ICON_CLASS} strokeWidth={CHROME_ICON_STROKE} />
          {hasNonDefaultSettings && (
            <span className='absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-(--accent-act)' />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='end'
        sideOffset={10}
        aria-labelledby={headingId}
        className={cn(
          CHROME_POPOVER_CLASS,
          'flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-1rem)] flex-col overflow-y-auto overscroll-contain p-1.5',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex min-h-9 shrink-0 items-center justify-between px-2.5'>
          <h4 id={headingId} className='text-xs font-semibold text-zinc-300'>
            Subtitles
          </h4>
          <button
            type='button'
            className={cn(
              CHROME_MENU_ROW_FOCUS_CLASS,
              'h-8 rounded-md px-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white aria-disabled:opacity-35 aria-disabled:hover:bg-transparent aria-disabled:hover:text-zinc-300',
            )}
            aria-label='Reset subtitle delay, position and size'
            aria-disabled={!hasNonDefaultSettings || undefined}
            onClick={() => {
              if (hasNonDefaultSettings) onResetSubtitleSettings();
            }}
          >
            Reset
          </button>
        </div>

        {/* Off is shared by both views, including when an addon is active. */}
        <div className='mb-1.5 shrink-0'>
          <TrackSelectRow
            label='Off'
            selected={subtitlesShownOff}
            busy={trackSwitching.sub || !!addonSubtitleLoadingId}
            onSelect={() => onSelectSubTrack('sub', 'no', { persistPreference: true })}
          />
        </div>

        {onSelectAddonSubtitle && (
          <div className='mx-1 mb-1.5 flex shrink-0 rounded-lg bg-white/[0.05] p-0.5'>
            <button
              type='button'
              aria-pressed={view === 'tracks'}
              className={cn(
                SUBTITLE_VIEW_TAB_CLASS,
                view === 'tracks'
                  ? SUBTITLE_VIEW_TAB_ACTIVE_CLASS
                  : SUBTITLE_VIEW_TAB_INACTIVE_CLASS,
              )}
              onClick={() => setView('tracks')}
            >
              Tracks
            </button>
            <button
              type='button'
              aria-pressed={view === 'addons'}
              className={cn(
                SUBTITLE_VIEW_TAB_CLASS,
                view === 'addons'
                  ? SUBTITLE_VIEW_TAB_ACTIVE_CLASS
                  : SUBTITLE_VIEW_TAB_INACTIVE_CLASS,
              )}
              onClick={() => setView('addons')}
            >
              Addons
              {addonSubtitlesLoading ? (
                <Loader2
                  aria-hidden='true'
                  className='h-3 w-3 animate-spin motion-reduce:animate-none'
                />
              ) : addonSubtitles.length > 0 ? (
                <span className='px-0.5 text-[11px] tabular-nums text-zinc-400'>
                  {addonSubtitles.length}
                </span>
              ) : null}
              {activeAddonSubtitleId && <span className='h-1 w-1 rounded-full bg-(--accent-act)' />}
            </button>
          </div>
        )}

        {/* The list yields to pinned settings; at very short heights the whole card scrolls so no control is unreachable. */}
        <div className='min-h-20 max-h-[42vh] overflow-y-auto'>
          {view === 'addons' && onSelectAddonSubtitle ? (
            <div className='space-y-px'>
              {addonSubtitlesError && (
                <RetryBanner
                  className='mx-1 px-2.5 py-2 wrap-anywhere'
                  message={addonSubtitlesError}
                  isRetrying={addonSubtitlesFetching}
                  onRetry={onRetryAddonSubtitles}
                />
              )}
              {addonSubtitlesError && addonSubtitles.length === 0 ? null : addonSubtitlesLoading &&
                addonSubtitles.length === 0 ? (
                <p className='flex items-center gap-2 px-2.5 py-3 text-xs text-zinc-400'>
                  <Loader2
                    aria-hidden='true'
                    className='h-3 w-3 animate-spin motion-reduce:animate-none'
                  />
                  Loading addon subtitles…
                </p>
              ) : !addonSubtitlesQueried ? (
                <p className='px-2.5 py-3 text-xs leading-relaxed text-zinc-400'>
                  Addon subtitles are unavailable for this title.
                </p>
              ) : addonSubtitles.length === 0 ? (
                <p className='px-2.5 py-3 text-xs leading-relaxed text-zinc-400'>
                  No addon subtitles found for this title.
                </p>
              ) : (
                addonSubtitles.map((subtitle) => {
                  const langCode = subtitle.lang?.trim().toUpperCase();
                  const detail = subtitle.detail;
                  const subtitleKey = subtitle.selectionKey;
                  const isActive = activeAddonSubtitleId === subtitleKey;
                  const isLoading = addonSubtitleLoadingId === subtitleKey;
                  const titleText = `${langCode ? `${langCode} · ` : ''}${
                    subtitle.sourceName
                  }${detail ? ` — ${detail}` : ''}`;
                  return (
                    <button
                      key={subtitleKey}
                      type='button'
                      className={cn(
                        TRACK_ROW_CLASS,
                        isActive
                          ? 'bg-white/[0.08] text-white'
                          : 'text-zinc-300 hover:bg-white/[0.06] hover:text-white',
                        (trackSwitching.sub || addonSubtitleLoadingId) && 'opacity-60',
                      )}
                      title={titleText}
                      aria-pressed={isActive}
                      aria-disabled={trackSwitching.sub || !!addonSubtitleLoadingId || undefined}
                      onClick={() => {
                        if (!trackSwitching.sub && !addonSubtitleLoadingId) {
                          onSelectAddonSubtitle(subtitle);
                        }
                      }}
                    >
                      <span className='min-w-0 flex-1 text-left'>
                        <span className='line-clamp-2 wrap-anywhere' title={titleText}>
                          {langCode && (
                            <span className='font-semibold text-current'>
                              {langCode}
                              <span className='font-normal text-zinc-500'> · </span>
                            </span>
                          )}
                          <span className='text-zinc-400'>{subtitle.sourceName}</span>
                        </span>
                        {detail && (
                          <span
                            className='mt-0.5 line-clamp-2 wrap-anywhere text-xs font-normal leading-relaxed text-zinc-400'
                            title={detail}
                          >
                            {detail}
                          </span>
                        )}
                      </span>
                      <span aria-hidden='true' className={CHROME_MENU_INDICATOR_CLASS}>
                        {isLoading ? (
                          <Loader2 className='h-3.5 w-3.5 animate-spin text-white/70 motion-reduce:animate-none' />
                        ) : isActive ? (
                          <Check
                            className='h-3.5 w-3.5 text-white'
                            strokeWidth={CHROME_ICON_STROKE}
                          />
                        ) : null}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          ) : (
            <div className='space-y-px'>
              {subTracks.map((track) => (
                <TrackSelectRow
                  key={track.id}
                  label={track.displayLabel}
                  selected={!!track.selected}
                  busy={trackSwitching.sub || !!addonSubtitleLoadingId}
                  onSelect={() => onSelectSubTrack('sub', track.id, { persistPreference: true })}
                />
              ))}
              {subTracks.length === 0 && (
                <p className='px-2.5 py-3 text-xs leading-relaxed text-zinc-400'>
                  No subtitle tracks in this stream.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Settings — only when a track is selected; pinned below the list so a long result set can't push them away. */}
        {selectedSubTrack && (
          <div className='mx-2.5 mt-2 shrink-0 border-t border-white/[0.07] pt-2 pb-1.5'>
            <p className='mb-2 text-[11px] leading-relaxed text-zinc-400'>
              Delay: − earlier · + later
            </p>
            <div className='space-y-1'>
              {(
                [
                  {
                    key: 'sync',
                    label: 'Delay',
                    value: `${subtitleDelay > 0 ? '+' : ''}${subtitleDelay.toFixed(1)}s`,
                    decreaseLabel: 'Show subtitles 0.5 seconds earlier',
                    increaseLabel: 'Show subtitles 0.5 seconds later',
                    min: -5,
                    max: 5,
                    step: 0.1,
                    current: subtitleDelay,
                    nudge: 0.5,
                    onApply: onApplySubtitleDelay,
                  },
                  {
                    key: 'pos',
                    label: 'Position',
                    value: `${Math.round(subtitlePos)}%`,
                    decreaseLabel: 'Move subtitles up',
                    increaseLabel: 'Move subtitles down',
                    min: 65,
                    max: 100,
                    step: 1,
                    current: subtitlePos,
                    nudge: 2,
                    onApply: onApplySubtitlePos,
                  },
                  {
                    key: 'scale',
                    label: 'Size',
                    value: `×${subtitleScale.toFixed(2)}`,
                    decreaseLabel: 'Decrease subtitle size',
                    increaseLabel: 'Increase subtitle size',
                    min: 0.25,
                    max: 3.0,
                    step: 0.05,
                    current: subtitleScale,
                    nudge: 0.1,
                    onApply: onApplySubtitleScale,
                  },
                ] as const
              ).map((row) => (
                <div key={row.key} className='flex items-center gap-1.5'>
                  <span className='w-14 shrink-0 text-xs font-medium text-zinc-300'>
                    {row.label}
                  </span>
                  <button
                    type='button'
                    aria-label={row.decreaseLabel}
                    title={row.decreaseLabel}
                    className={TRACK_NUDGE_BUTTON_CLASS}
                    aria-disabled={row.current <= row.min || undefined}
                    onClick={() => {
                      if (row.current > row.min)
                        row.onApply(clamp(row.current - row.nudge, row.min, row.max));
                    }}
                  >
                    <Minus
                      aria-hidden='true'
                      className='h-3 w-3'
                      strokeWidth={CHROME_ICON_STROKE}
                    />
                  </button>
                  <PlayerSlider
                    value={[row.current]}
                    min={row.min}
                    max={row.max}
                    step={row.step}
                    aria-label={`Subtitle ${row.label.toLowerCase()}`}
                    aria-valuetext={row.value}
                    onValueChange={(values) => row.onApply(values[0])}
                    className='h-8 min-w-0 flex-1'
                  />
                  <button
                    type='button'
                    aria-label={row.increaseLabel}
                    title={row.increaseLabel}
                    className={TRACK_NUDGE_BUTTON_CLASS}
                    aria-disabled={row.current >= row.max || undefined}
                    onClick={() => {
                      if (row.current < row.max)
                        row.onApply(clamp(row.current + row.nudge, row.min, row.max));
                    }}
                  >
                    <Plus aria-hidden='true' className='h-3 w-3' strokeWidth={CHROME_ICON_STROKE} />
                  </button>
                  <span className='w-11 shrink-0 text-right text-xs font-medium tabular-nums text-zinc-300'>
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
});
