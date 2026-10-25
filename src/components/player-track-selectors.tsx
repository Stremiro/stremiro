import { AudioLines, Captions, Check, Loader2, Minus, Plus } from 'lucide-react';
import { memo, type ReactNode, useId, useRef, useState } from 'react';
import {
  CHROME_ICON_BUTTON_CLASS,
  CHROME_ICON_CLASS,
  CHROME_ICON_STROKE,
  CHROME_MENU_INDICATOR_CLASS,
  CHROME_MENU_ROW_FOCUS_CLASS,
  CHROME_POPOVER_CLASS,
} from '@/components/player-chrome-styles';
import { PlayerSlider } from '@/components/player-slider';
import { SubtitleAppearanceControls } from '@/components/subtitle-appearance-controls';
import { RetryBanner } from '@/components/retry-banner';
import { useSlidingIndicator } from '@/hooks/use-sliding-indicator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { useAppUiPreferences, usePlayerKeymap } from '@/hooks/use-app-ui-preferences';
import { type AddonSubtitle, hasSubtitleAppearance, SUBTITLE_APPEARANCE_RESET } from '@/lib/api';
import { ariaKeyShortcuts, withShortcutHint } from '@/lib/player-keybindings';
import type { Track } from '@/lib/player-track-utils';
import { clamp, cn, queryNeedsRetry } from '@/lib/utils';

// Stable default — a fresh `[]` literal would defeat this component's memo.
const EMPTY_ADDON_SUBTITLES: AddonSubtitle[] = [];

const TRACK_SETTINGS_DOT_CLASS =
  'absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-(--accent-act)';
const TRACK_RESET_BUTTON_CLASS = cn(
  CHROME_MENU_ROW_FOCUS_CLASS,
  'h-8 shrink-0 rounded-md px-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white aria-disabled:opacity-35 aria-disabled:hover:bg-transparent aria-disabled:hover:text-zinc-300',
);
const TRACK_NUDGE_BUTTON_CLASS = cn(
  CHROME_MENU_ROW_FOCUS_CLASS,
  'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white aria-disabled:cursor-default aria-disabled:opacity-35 aria-disabled:hover:bg-transparent aria-disabled:hover:text-zinc-300',
);
const SUBTITLE_VIEW_TAB_CLASS = cn(
  CHROME_MENU_ROW_FOCUS_CLASS,
  'relative z-10 flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition-colors duration-150 motion-reduce:transition-none',
);
const SUBTITLE_VIEW_TAB_ACTIVE_CLASS = 'text-white';
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
  /** Spinner in place of the check; defaults to the selected row while busy. */
  pending?: boolean;
  onSelect: () => void;
  /** Custom row body; defaults to the clamped label. */
  children?: ReactNode;
  className?: string;
}

/** One row for every track list (audio, subtitles, addon subtitles, Off). */
function TrackSelectRow({
  label,
  selected,
  busy,
  pending,
  onSelect,
  children,
  className,
}: TrackSelectRowProps) {
  const showSpinner = pending === undefined ? busy && selected : pending;
  return (
    <button
      type='button'
      className={cn(
        TRACK_ROW_CLASS,
        selected
          ? 'bg-white/[0.08] text-white'
          : 'text-zinc-300 hover:bg-white/[0.06] hover:text-white',
        busy && 'opacity-60',
        className,
      )}
      title={label}
      aria-label={label}
      aria-pressed={selected}
      aria-disabled={busy || undefined}
      onClick={() => {
        if (!busy) onSelect();
      }}
    >
      {children ?? (
        <span className='min-w-0 flex-1 line-clamp-2 wrap-anywhere' title={label}>
          {label}
        </span>
      )}
      <span aria-hidden='true' className={CHROME_MENU_INDICATOR_CLASS}>
        {showSpinner ? (
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
  const { preferences, preferencesQuery, isHydrating, updatePreferences } = useAppUiPreferences(
    ({ audioDelay, nightMode }) => ({ audioDelay, nightMode }),
  );
  const hasPreferencesError = queryNeedsRetry(preferencesQuery);
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
          {hasAudioSettings && <span aria-hidden='true' className={TRACK_SETTINGS_DOT_CLASS} />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-player-popover
        side='top'
        align='end'
        sideOffset={10}
        aria-labelledby={headingId}
        className={cn(
          CHROME_POPOVER_CLASS,
          'flex max-h-[min(32rem,var(--radix-popover-content-available-height))] w-[22rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-2',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex min-h-10 shrink-0 items-center justify-between gap-2 px-2.5'>
          <h4 id={headingId} className='text-[13px] font-semibold text-zinc-200'>
            Audio
          </h4>
          {isHydrating && !hasPreferencesError && (
            <span role='status' className='text-xs text-zinc-400'>
              Loading preferences…
            </span>
          )}
        </div>
        {hasPreferencesError && (
          <RetryBanner
            className='mx-2.5 mb-2 px-2.5 py-2'
            message="Couldn't load your preferences."
            isRetrying={preferencesQuery.isFetching}
            onRetry={() => void preferencesQuery.refetch()}
          />
        )}
        <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain'>
          <div className='space-y-px'>
            {audioTracks.map((track) => (
              <TrackSelectRow
                key={track.id}
                label={track.displayLabel}
                selected={!!track.selected}
                busy={trackSwitching.audio}
                onSelect={() => onSelectTrack('audio', track.id, { persistPreference: true })}
              />
            ))}
            {audioTracks.length === 0 && (
              <p className='px-2.5 py-3 text-[13px] leading-relaxed text-zinc-400'>
                No audio tracks in this stream.
              </p>
            )}
          </div>
        </div>
        <div className='mx-2.5 mt-2 shrink-0 border-t border-white/[0.07] pt-1 pb-1'>
          {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- Switch renders the single labelable button. */}
          <label
            className={cn(
              'flex min-h-10 items-center justify-between gap-3',
              isHydrating ? 'cursor-wait' : 'cursor-pointer',
            )}
          >
            <span className='text-[13px] font-medium text-zinc-200'>Night mode</span>
            <span id={`${headingId}-night-description`} className='sr-only'>
              Boosts quiet audio and smooths volume changes.
            </span>
            <Switch
              ariaLabel='Night mode'
              ariaDescribedBy={`${headingId}-night-description`}
              checked={nightMode}
              pending={isHydrating}
              className='cursor-inherit'
              onChange={() => {
                if (!isHydrating) updatePreferences({ nightMode: !nightMode });
              }}
            />
          </label>
          <div
            className='flex min-h-10 items-center justify-between gap-1'
            title='Adjust only if sound and picture are out of sync.'
          >
            <span className='mr-auto text-[13px] font-medium text-zinc-300'>Audio sync</span>
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
              className='w-14 shrink-0 text-center text-[13px] tabular-nums text-zinc-100'
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
            <button
              type='button'
              className={TRACK_RESET_BUTTON_CLASS}
              aria-label='Reset audio sync'
              aria-disabled={isHydrating || audioDelay === 0 || undefined}
              onClick={() => {
                if (!isHydrating && audioDelay !== 0) updatePreferences({ audioDelay: 0 });
              }}
            >
              Reset
            </button>
          </div>
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
  /** Query availability gates the empty-state hint. */
  addonSubtitlesAvailable?: boolean;
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
  addonSubtitlesAvailable,
  activeAddonSubtitleId,
  addonSubtitleLoadingId,
  onSelectAddonSubtitle,
  onSubtitleMenuOpenChange,
}: SubtitleTrackSelectorProps) {
  const addonSubtitles =
    addonSubtitlesProp === undefined ? EMPTY_ADDON_SUBTITLES : addonSubtitlesProp;
  const keymap = usePlayerKeymap();
  const { preferences, preferencesQuery, isHydrating, updatePreferences } = useAppUiPreferences(
    ({ subtitleFont, subtitleColor, subtitleEdge, subtitleBold, subtitleItalic }) => ({
      subtitleFont,
      subtitleColor,
      subtitleEdge,
      subtitleBold,
      subtitleItalic,
    }),
  );
  const hasPreferencesError = queryNeedsRetry(preferencesQuery);
  const { subtitleFont, subtitleColor, subtitleEdge, subtitleBold, subtitleItalic } = preferences;
  const headingId = useId();
  const selectedSubTrack = subTracks.find((track) => track.selected);
  const selectedSubLabel = selectedSubTrack?.displayLabel;
  const subtitlesShownOff = !selectedSubTrack;
  const subStateLabel = subtitlesShownOff ? 'Off' : (selectedSubLabel ?? 'On');
  const hasSubtitleAdjustments =
    subtitleDelay !== 0 || subtitlePos !== 100 || subtitleScale !== 1.0;
  const hasAppearanceChanges = hasSubtitleAppearance(preferences);
  const hasNonDefaultSettings = hasSubtitleAdjustments || hasAppearanceChanges;
  const canResetSubtitleSettings = hasSubtitleAdjustments || (!isHydrating && hasAppearanceChanges);
  const subtitleSwitchBusy = trackSwitching.sub || !!addonSubtitleLoadingId;
  const [view, setView] = useState<'tracks' | 'addons' | 'style'>('tracks');
  const viewTabsRef = useRef<HTMLDivElement>(null);
  const viewTabButtons = useRef(new Map<string, HTMLButtonElement>());
  const viewIndicator = useSlidingIndicator(view, viewTabsRef, viewTabButtons);

  const handleOpenChange = (open: boolean) => {
    if (open) setView(activeAddonSubtitleId && onSelectAddonSubtitle ? 'addons' : 'tracks');
    onSubtitleMenuOpenChange?.(open);
  };

  const resetSubtitleSettings = () => {
    onResetSubtitleSettings();
    if (!isHydrating && hasAppearanceChanges) {
      updatePreferences(SUBTITLE_APPEARANCE_RESET);
    }
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
            <span aria-hidden='true' className={TRACK_SETTINGS_DOT_CLASS} />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-player-popover
        side='top'
        align='end'
        sideOffset={10}
        aria-labelledby={headingId}
        className={cn(
          CHROME_POPOVER_CLASS,
          'flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-[22rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-2',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex min-h-10 shrink-0 items-center justify-between gap-2 pl-2.5 pr-1'>
          <h4 id={headingId} className='text-[13px] font-semibold text-zinc-200'>
            Subtitles
          </h4>
          <div className='flex items-center gap-1'>
            <TrackSelectRow
              label='Turn subtitles off'
              selected={subtitlesShownOff}
              busy={subtitleSwitchBusy}
              className='min-h-8 w-auto gap-1.5 px-2 py-1 text-xs'
              onSelect={() => onSelectSubTrack('sub', 'no', { persistPreference: true })}
            >
              <span>Off</span>
            </TrackSelectRow>
            <button
              type='button'
              className={TRACK_RESET_BUTTON_CLASS}
              aria-label='Reset subtitle settings'
              aria-disabled={!canResetSubtitleSettings || undefined}
              onClick={() => {
                if (canResetSubtitleSettings) resetSubtitleSettings();
              }}
            >
              Reset
            </button>
          </div>
        </div>

        {hasPreferencesError && (
          <RetryBanner
            className='mx-2.5 mb-2 px-2.5 py-2'
            message="Couldn't load your preferences."
            isRetrying={preferencesQuery.isFetching}
            onRetry={() => void preferencesQuery.refetch()}
          />
        )}
        <div
          role='group'
          aria-label='Subtitle view'
          ref={viewTabsRef}
          className='relative isolate mx-1 mb-1.5 mt-1 flex shrink-0 rounded-lg bg-white/[0.05] p-0.5'
        >
          {viewIndicator && (
            <span
              aria-hidden='true'
              className='nav-sliding-pill pointer-events-none absolute left-0 top-0 rounded-md bg-white/[0.09]'
              style={{
                width: viewIndicator.width,
                height: viewIndicator.height,
                transform: `translate3d(${viewIndicator.left}px, ${viewIndicator.top}px, 0)`,
              }}
            />
          )}
          <button
            type='button'
            ref={(node) => {
              if (node) viewTabButtons.current.set('tracks', node);
            }}
            aria-pressed={view === 'tracks'}
            className={cn(
              SUBTITLE_VIEW_TAB_CLASS,
              view === 'tracks' ? SUBTITLE_VIEW_TAB_ACTIVE_CLASS : SUBTITLE_VIEW_TAB_INACTIVE_CLASS,
            )}
            onClick={() => setView('tracks')}
          >
            Tracks
          </button>
          {onSelectAddonSubtitle && (
            <button
              type='button'
              ref={(node) => {
                if (node) viewTabButtons.current.set('addons', node);
              }}
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
              {activeAddonSubtitleId && (
                <span aria-hidden='true' className='h-1 w-1 rounded-full bg-(--accent-act)' />
              )}
            </button>
          )}
          <button
            type='button'
            ref={(node) => {
              if (node) viewTabButtons.current.set('style', node);
            }}
            aria-pressed={view === 'style'}
            className={cn(
              SUBTITLE_VIEW_TAB_CLASS,
              view === 'style' ? SUBTITLE_VIEW_TAB_ACTIVE_CLASS : SUBTITLE_VIEW_TAB_INACTIVE_CLASS,
            )}
            onClick={() => setView('style')}
          >
            Style
          </button>
        </div>

        {/* Keep the list-view floor inside the scrollport so short windows can shrink it. */}
        <div
          key={view}
          className='player-menu-swap min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain'
        >
          {view !== 'style' && (
            <div className='min-h-[9rem]'>
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
                  {addonSubtitlesError &&
                  addonSubtitles.length === 0 ? null : addonSubtitlesLoading &&
                    addonSubtitles.length === 0 ? (
                    <p
                      role='status'
                      className='flex items-center gap-2 px-2.5 py-3 text-xs text-zinc-400'
                    >
                      <Loader2
                        aria-hidden='true'
                        className='h-3 w-3 animate-spin motion-reduce:animate-none'
                      />
                      Loading addon subtitles…
                    </p>
                  ) : !addonSubtitlesAvailable ? (
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
                      const titleText = `${langCode ? `${langCode} · ` : ''}${
                        subtitle.sourceName
                      }${detail ? ` — ${detail}` : ''}`;
                      return (
                        <TrackSelectRow
                          key={subtitleKey}
                          label={titleText}
                          selected={activeAddonSubtitleId === subtitleKey}
                          busy={subtitleSwitchBusy}
                          pending={addonSubtitleLoadingId === subtitleKey}
                          onSelect={() => onSelectAddonSubtitle(subtitle)}
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
                        </TrackSelectRow>
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
                      busy={subtitleSwitchBusy}
                      onSelect={() =>
                        onSelectSubTrack('sub', track.id, { persistPreference: true })
                      }
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
          )}

          {view === 'style' && (
            <div className='shrink-0 px-2.5 pt-1 pb-1.5'>
              <SubtitleAppearanceControls
                subtitleFont={subtitleFont}
                subtitleColor={subtitleColor}
                subtitleEdge={subtitleEdge}
                subtitleBold={subtitleBold}
                subtitleItalic={subtitleItalic}
                disabled={isHydrating}
                compact
                onPatch={updatePreferences}
              />
              <div className='mt-2.5 space-y-1 border-t border-white/[0.07] pt-2'>
                {(
                  [
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
                  ] as const
                ).map((row) => (
                  // Label + value on one line, the slider underneath: the control
                  // gets the full panel width instead of a squeezed middle third.
                  <div key={row.key} className='pt-1.5'>
                    <div className='flex items-baseline justify-between gap-2'>
                      <span className='text-[11px] font-medium text-zinc-400'>{row.label}</span>
                      <span className='text-[11px] font-medium tabular-nums text-zinc-200'>
                        {row.value}
                      </span>
                    </div>
                    <div className='flex items-center gap-1.5'>
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
                        className='h-6 min-w-0 flex-1'
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
                        <Plus
                          aria-hidden='true'
                          className='h-3 w-3'
                          strokeWidth={CHROME_ICON_STROKE}
                        />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
});
