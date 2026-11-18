import { AudioLines, Captions, Check, Loader2, Minus, Plus, RotateCcw } from 'lucide-react';
import { type ReactNode, useId, useRef, useState } from 'react';
import {
  CHROME_ICON_BUTTON_CLASS,
  CHROME_ICON_CLASS,
  CHROME_ICON_STROKE,
  CHROME_MENU_HEADING_CLASS,
  CHROME_MENU_INDICATOR_CLASS,
  CHROME_MENU_ITEM_IDLE_CLASS,
  CHROME_MENU_ITEM_SELECTED_CLASS,
  CHROME_MENU_ROW_FOCUS_CLASS,
  CHROME_POPOVER_CLASS,
} from '@/components/player-chrome-styles';
import { AudioSyncStepper, StepButton } from '@/components/audio-sync-stepper';
import { PlayerSlider } from '@/components/player-slider';
import { SubtitleAppearanceControls } from '@/components/subtitle-appearance-controls';
import { RetryBanner } from '@/components/retry-banner';
import { useSlidingIndicator } from '@/hooks/use-sliding-indicator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { useAppUiPreferences, usePlayerKeymap } from '@/hooks/use-app-ui-preferences';
import { type AddonSubtitle, hasSubtitleAppearance, SUBTITLE_APPEARANCE_RESET } from '@/lib/api';
import { ariaKeyShortcuts, withShortcutHint } from '@/lib/player-keybindings';
import { preserveOpenPlayerMenuFocus } from '@/lib/player-dom';
import type { Track } from '@/lib/player-track-utils';
import { clamp, cn, queryNeedsRetry } from '@/lib/utils';

const TRACK_SETTINGS_DOT_CLASS =
  'absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-(--accent-act)';
/** Nudge steppers and the icon-only resets share one compact square. */
const TRACK_ICON_BUTTON_CLASS = cn(
  CHROME_MENU_ROW_FOCUS_CLASS,
  'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/[0.08] hover:text-white aria-disabled:cursor-default aria-disabled:opacity-35 aria-disabled:hover:bg-transparent aria-disabled:hover:text-zinc-400',
);
const SUBTITLE_VIEW_TAB_CLASS = cn(
  CHROME_MENU_ROW_FOCUS_CLASS,
  'relative z-10 flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[12px] font-medium transition-colors duration-150 motion-reduce:transition-none',
);
const TRACK_ROW_CLASS = cn(
  CHROME_MENU_ROW_FOCUS_CLASS,
  'flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-[14px] font-medium leading-snug transition-colors aria-disabled:cursor-wait',
);
const TRACK_FOOTER_ROW_CLASS = 'flex min-h-8 items-center justify-between gap-2';
const TRACK_NOTE_CLASS = 'px-2 py-2.5 text-xs leading-relaxed text-zinc-400';
const RESET_ICON = <RotateCcw aria-hidden='true' className='size-3.5' />;

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
        selected ? CHROME_MENU_ITEM_SELECTED_CLASS : CHROME_MENU_ITEM_IDLE_CLASS,
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
          <Check className='h-3.5 w-3.5 text-(--accent-act)' strokeWidth={CHROME_ICON_STROKE} />
        ) : null}
      </span>
    </button>
  );
}

interface AudioTrackSelectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  audioTracks: Track[];
  trackSwitching: { audio: boolean; sub: boolean };
  onSelectTrack: (id: number) => void;
}

export function AudioTrackSelector({
  open,
  onOpenChange,
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
    <Popover open={open} onOpenChange={onOpenChange}>
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
        onCloseAutoFocus={preserveOpenPlayerMenuFocus}
        side='top'
        align='end'
        sideOffset={10}
        aria-labelledby={headingId}
        className={cn(
          CHROME_POPOVER_CLASS,
          'flex max-h-[min(30rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex shrink-0 items-center justify-between gap-2'>
          <h4 id={headingId} className={CHROME_MENU_HEADING_CLASS}>
            Audio
          </h4>
          {isHydrating && !hasPreferencesError && (
            <span role='status' className='px-2 pb-0.5 text-[11px] text-zinc-500'>
              Loading…
            </span>
          )}
        </div>
        {hasPreferencesError && (
          <RetryBanner
            className='mx-1 mb-1.5 px-2.5 py-2'
            message="Couldn't load your preferences."
            isRetrying={preferencesQuery.isFetching}
            onRetry={() => void preferencesQuery.refetch()}
          />
        )}
        <div className='min-h-0 flex-1 space-y-px overflow-y-auto overscroll-contain'>
          {audioTracks.map((track) => (
            <TrackSelectRow
              key={track.id}
              label={track.displayLabel}
              selected={!!track.selected}
              busy={trackSwitching.audio}
              onSelect={() => onSelectTrack(track.id)}
            />
          ))}
          {audioTracks.length === 0 && (
            <p className={TRACK_NOTE_CLASS}>No audio tracks in this stream.</p>
          )}
        </div>
        <div className='mt-1.5 shrink-0 border-t border-white/[0.07] px-2 pt-1'>
          {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- Switch renders the single labelable button. */}
          <label
            className={cn(TRACK_FOOTER_ROW_CLASS, isHydrating ? 'cursor-wait' : 'cursor-pointer')}
            title='Boosts quiet audio and smooths volume changes.'
          >
            <span className='min-w-0 py-2'>
              <span className='block text-[13px] font-medium text-zinc-200'>Night mode</span>
              <span
                id={`${headingId}-night-description`}
                className='mt-1 block text-xs leading-5 text-zinc-400'
              >
                Boosts quiet audio and smooths volume changes.
              </span>
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
            className={cn(TRACK_FOOTER_ROW_CLASS, 'gap-0.5')}
            title='Adjust only if sound and picture are out of sync.'
          >
            <span className='mr-auto text-[13px] font-medium text-zinc-200'>Audio sync</span>
            <AudioSyncStepper
              audioDelay={audioDelay}
              isHydrating={isHydrating}
              updatePreferences={updatePreferences}
              buttonClassName={TRACK_ICON_BUTTON_CLASS}
              resetClassName={TRACK_ICON_BUTTON_CLASS}
              outputClassName='w-11 shrink-0 text-center text-[12px] tabular-nums text-zinc-100'
              resetContent={RESET_ICON}
              resetTitle='Reset audio sync'
              live
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface SubtitleTrackSelectorProps {
  open: boolean;
  subTracks: Track[];
  trackSwitching: { audio: boolean; sub: boolean };
  subtitleDelay: number;
  subtitlePos: number;
  subtitleScale: number;
  onResetSubtitleSettings: () => void;
  onApplySubtitleDelay: (value: number) => void;
  onApplySubtitlePos: (value: number) => void;
  onApplySubtitleScale: (value: number) => void;
  onSelectSubTrack: (id: number | 'no') => void;
  addonSubtitles: AddonSubtitle[];
  addonSubtitlesLoading: boolean;
  addonSubtitlesFetching: boolean;
  addonSubtitlesError: string | undefined;
  onRetryAddonSubtitles: () => void;
  /** Query availability gates the empty-state hint. */
  addonSubtitlesAvailable: boolean;
  /** Rust-authored subtitle selection key. */
  activeAddonSubtitleId: string | null;
  addonSubtitleLoadingId: string | null;
  onSelectAddonSubtitle: (subtitle: AddonSubtitle) => void;
  onSubtitleMenuOpenChange: (open: boolean) => void;
}

export function SubtitleTrackSelector({
  open,
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
  addonSubtitles,
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
  const subtitlesShownOff = !selectedSubTrack;
  const subStateLabel = selectedSubTrack?.displayLabel ?? 'Off';
  const hasSubtitleAdjustments =
    subtitleDelay !== 0 || subtitlePos !== 100 || subtitleScale !== 1.0;
  const hasAppearanceChanges = hasSubtitleAppearance(preferences);
  const hasNonDefaultSettings = hasSubtitleAdjustments || hasAppearanceChanges;
  const canResetSubtitleSettings = !isHydrating && hasNonDefaultSettings;
  const subtitleSwitchBusy = trackSwitching.sub || !!addonSubtitleLoadingId;
  const [view, setView] = useState<'tracks' | 'addons' | 'style'>('tracks');
  const [viewTabsNode, setViewTabsNode] = useState<HTMLDivElement | null>(null);
  const viewTabButtons = useRef(new Map<string, HTMLButtonElement>());
  const viewIndicator = useSlidingIndicator(view, viewTabsNode, viewTabButtons);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setView(activeAddonSubtitleId ? 'addons' : 'tracks');
    onSubtitleMenuOpenChange(nextOpen);
  };

  const resetSubtitleSettings = () => {
    onResetSubtitleSettings();
    if (!isHydrating && hasAppearanceChanges) {
      updatePreferences(SUBTITLE_APPEARANCE_RESET);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
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
        onCloseAutoFocus={preserveOpenPlayerMenuFocus}
        side='top'
        align='end'
        sideOffset={10}
        aria-labelledby={headingId}
        className={cn(
          CHROME_POPOVER_CLASS,
          'flex max-h-[min(34rem,var(--radix-popover-content-available-height))] w-[19rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex shrink-0 items-center justify-between gap-2'>
          <h4 id={headingId} className={CHROME_MENU_HEADING_CLASS}>
            Subtitles
          </h4>
          <StepButton
            className={TRACK_ICON_BUTTON_CLASS}
            label='Reset subtitle settings'
            title='Reset subtitle settings'
            disabled={!canResetSubtitleSettings}
            onStep={resetSubtitleSettings}
          >
            {RESET_ICON}
          </StepButton>
        </div>

        {hasPreferencesError && (
          <RetryBanner
            className='mx-1 mb-1.5 px-2.5 py-2'
            message="Couldn't load your preferences."
            isRetrying={preferencesQuery.isFetching}
            onRetry={() => void preferencesQuery.refetch()}
          />
        )}
        <div
          role='group'
          aria-label='Subtitle view'
          ref={setViewTabsNode}
          className='relative isolate mb-1.5 flex shrink-0 rounded-lg bg-white/[0.05] p-0.5'
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
          {(
            [
              ['tracks', 'Tracks'],
              ['addons', 'Addons'],
              ['style', 'Style'],
            ] as const
          ).map(([tab, label]) => (
            <button
              key={tab}
              type='button'
              ref={(node) => {
                if (node) viewTabButtons.current.set(tab, node);
              }}
              aria-pressed={view === tab}
              className={cn(
                SUBTITLE_VIEW_TAB_CLASS,
                view === tab ? 'text-white' : 'text-zinc-400 hover:text-white',
              )}
              onClick={() => setView(tab)}
            >
              {label}
              {tab === 'addons' && (
                <>
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
                </>
              )}
            </button>
          ))}
        </div>

        {/* Keep the list-view floor inside the scrollport so short windows can shrink it. */}
        <div
          key={view}
          className='player-menu-swap min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain'
        >
          {view !== 'style' && (
            <div className='min-h-[8rem]'>
              {subTracks.length > 0 && (
                <TrackSelectRow
                  label='Turn subtitles off'
                  selected={subtitlesShownOff}
                  busy={subtitleSwitchBusy}
                  className='mb-px'
                  onSelect={() => onSelectSubTrack('no')}
                >
                  <span className='min-w-0 flex-1'>Off</span>
                </TrackSelectRow>
              )}
              {view === 'addons' ? (
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
                    <p role='status' className={cn(TRACK_NOTE_CLASS, 'flex items-center gap-2')}>
                      <Loader2
                        aria-hidden='true'
                        className='h-3 w-3 animate-spin motion-reduce:animate-none'
                      />
                      Loading addon subtitles…
                    </p>
                  ) : !addonSubtitlesAvailable ? (
                    <p className={TRACK_NOTE_CLASS}>
                      Addon subtitles are unavailable for this title.
                    </p>
                  ) : addonSubtitles.length === 0 ? (
                    <p className={TRACK_NOTE_CLASS}>No addon subtitles found for this title.</p>
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
                            <span className='flex min-w-0 items-baseline gap-2'>
                              <span className='min-w-0 truncate font-semibold text-current'>
                                {langCode || subtitle.label}
                              </span>
                              <span
                                className='ml-auto max-w-[50%] truncate text-[11px] font-normal text-zinc-500'
                                title={subtitle.sourceName}
                              >
                                {subtitle.sourceName}
                              </span>
                            </span>
                            {detail && (
                              <span
                                className='mt-0.5 block truncate text-xs font-normal leading-5 text-zinc-400'
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
                      onSelect={() => onSelectSubTrack(track.id)}
                    />
                  ))}
                  {subTracks.length === 0 && (
                    <p className={TRACK_NOTE_CLASS}>No subtitle tracks in this stream.</p>
                  )}
                </div>
              )}
            </div>
          )}

          {view === 'style' && (
            <div className='shrink-0 px-1.5 pb-1'>
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
              <div className='mt-2 space-y-0.5 border-t border-white/[0.07] pt-1'>
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
                      min: 0,
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
                  <div key={row.key} className='pt-1'>
                    <div className='flex items-baseline justify-between gap-2'>
                      <span className='text-[11px] font-medium text-zinc-400'>{row.label}</span>
                      <span className='text-[11px] font-medium tabular-nums text-zinc-200'>
                        {row.value}
                      </span>
                    </div>
                    <div className='flex items-center gap-1.5'>
                      <StepButton
                        className={TRACK_ICON_BUTTON_CLASS}
                        label={row.decreaseLabel}
                        title={row.decreaseLabel}
                        disabled={isHydrating || row.current <= row.min}
                        onStep={() => row.onApply(clamp(row.current - row.nudge, row.min, row.max))}
                      >
                        <Minus
                          aria-hidden='true'
                          className='h-3 w-3'
                          strokeWidth={CHROME_ICON_STROKE}
                        />
                      </StepButton>
                      <PlayerSlider
                        disabled={isHydrating}
                        value={[row.current]}
                        min={row.min}
                        max={row.max}
                        step={row.step}
                        aria-label={`Subtitle ${row.label.toLowerCase()}`}
                        aria-valuetext={row.value}
                        onValueChange={(values) => row.onApply(values[0]!)}
                        className='h-6 min-w-0 flex-1'
                      />
                      <StepButton
                        className={TRACK_ICON_BUTTON_CLASS}
                        label={row.increaseLabel}
                        title={row.increaseLabel}
                        disabled={isHydrating || row.current >= row.max}
                        onStep={() => row.onApply(clamp(row.current + row.nudge, row.min, row.max))}
                      >
                        <Plus
                          aria-hidden='true'
                          className='h-3 w-3'
                          strokeWidth={CHROME_ICON_STROKE}
                        />
                      </StepButton>
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
}
