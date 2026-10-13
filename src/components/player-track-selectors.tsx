import { Check, Headphones, Loader2, Minus, Plus, Subtitles } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { CHROME_ICON_BUTTON_CLASS, CHROME_POPOVER_CLASS } from '@/components/player-chrome-styles';
import { PlayerSlider } from '@/components/player-slider';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { AddonSubtitle } from '@/lib/api';
import { buildTrackLabelMap, type Track } from '@/lib/player-track-utils';
import { clamp, cn } from '@/lib/utils';

// Dropping the container extension keeps addon-provided release names readable for any provider.
const SUBTITLE_FILE_EXTENSION_RE = /\.(srt|ass|ssa|vtt|sub|idx|smi|txt)$/i;

// Stable default — a fresh `[]` literal would defeat this component's memo.
const EMPTY_ADDON_SUBTITLES: AddonSubtitle[] = [];

const SUBTITLE_NUDGE_BUTTON_CLASS =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30 disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-zinc-300';
const SUBTITLE_VIEW_TAB_CLASS =
  'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30';
const SUBTITLE_VIEW_TAB_ACTIVE_CLASS = 'bg-white/[0.09] text-white';
const SUBTITLE_VIEW_TAB_INACTIVE_CLASS = 'text-zinc-400 hover:text-white';
const TRACK_ROW_CLASS =
  'flex min-h-10 w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-[13px] font-medium leading-snug transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/30';

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
      disabled={busy}
      onClick={onSelect}
    >
      <span className='min-w-0 flex-1 wrap-anywhere'>{label}</span>
      {busy && selected ? (
        <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin text-white/70' />
      ) : selected ? (
        <Check className='h-3.5 w-3.5 shrink-0 text-white' strokeWidth={3} />
      ) : null}
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
  const audioTrackLabels = useMemo(() => buildTrackLabelMap(audioTracks), [audioTracks]);
  const selectedAudioTrack = audioTracks.find((track) => track.selected);
  const selectedAudioLabel = selectedAudioTrack
    ? audioTrackLabels.get(selectedAudioTrack.id)
    : undefined;

  if (audioTracks.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(CHROME_ICON_BUTTON_CLASS, 'active:scale-100')}
          aria-label={selectedAudioLabel ? `Audio: ${selectedAudioLabel}` : 'Audio track'}
          aria-keyshortcuts='a'
          title='Audio Track (A)'
          onClick={(e) => e.stopPropagation()}
        >
          <Headphones className='h-[18px] w-[18px]' strokeWidth={2.5} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='end'
        sideOffset={10}
        className={cn(
          CHROME_POPOVER_CLASS,
          'flex max-h-[min(24rem,var(--radix-popover-content-available-height))] w-72 max-w-[calc(100vw-1rem)] flex-col p-1.5 data-[state=closed]:animate-none!',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className='shrink-0 px-2.5 pb-2 pt-2 text-xs font-semibold text-zinc-300'>Audio</h4>
        <div className='min-h-0 space-y-px overflow-y-auto overscroll-contain'>
          {audioTracks.map((track) => (
            <TrackSelectRow
              key={track.id}
              label={audioTrackLabels.get(track.id) ?? `Track ${track.id}`}
              selected={!!track.selected}
              busy={trackSwitching.audio}
              onSelect={() => onSelectTrack('audio', track.id, { persistPreference: true })}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
});

interface SubtitleTrackSelectorProps {
  subTracks: Track[];
  trackSwitching: { audio: boolean; sub: boolean };
  subtitleDelay: number;
  subtitlePos: number;
  subtitleScale: number;
  onResetSubtitleSettings: () => void;
  onApplySubtitleDelay: (value: number) => void;
  onApplySubtitlePos: (value: number) => void;
  onApplySubtitleScale: (value: number) => void;
  onSelectTrack: (
    type: 'sub',
    id: number | 'no',
    options?: { persistPreference?: boolean },
  ) => void;
  addonSubtitles?: AddonSubtitle[];
  addonSubtitlesLoading?: boolean;
  addonSubtitlesError?: string;
  /** True once the addon-subtitle lookup has actually run — gates the empty-state hint. */
  addonSubtitlesQueried?: boolean;
  /** Rust-authored subtitle selection key. */
  activeAddonSubtitleId?: string | null;
  addonSubtitleLoadingId?: string | null;
  onSelectAddonSubtitle?: (subtitle: AddonSubtitle) => void;
  onOpenChange?: (open: boolean) => void;
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
  onSelectTrack,
  addonSubtitles = EMPTY_ADDON_SUBTITLES,
  addonSubtitlesLoading = false,
  addonSubtitlesError,
  addonSubtitlesQueried = false,
  activeAddonSubtitleId = null,
  addonSubtitleLoadingId = null,
  onSelectAddonSubtitle,
  onOpenChange,
}: SubtitleTrackSelectorProps) {
  const subtitleTrackLabels = useMemo(() => buildTrackLabelMap(subTracks), [subTracks]);
  const selectedSubTrack = subTracks.find((track) => track.selected);
  const selectedSubLabel = selectedSubTrack
    ? subtitleTrackLabels.get(selectedSubTrack.id)
    : undefined;
  const subtitlesShownOff = !selectedSubTrack;
  const subStateLabel = subtitlesShownOff ? 'Off' : (selectedSubLabel ?? 'On');
  const hasNonDefaultSettings = subtitleDelay !== 0 || subtitlePos !== 100 || subtitleScale !== 1.0;
  // Tabbed card — both lists share one bounded region so a long addon result set can't push settings out of view.
  const [view, setView] = useState<'tracks' | 'addons'>('tracks');

  const handleOpenChange = (open: boolean) => {
    // Reopen on the tab owning the active pick — an addon-selected subtitle shows checked immediately.
    if (open) setView(activeAddonSubtitleId ? 'addons' : 'tracks');
    onOpenChange?.(open);
  };

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(
            'relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
            subtitlesShownOff
              ? 'text-white/40 hover:text-white/70 hover:bg-white/10'
              : 'text-white/80 hover:text-white hover:bg-white/10',
          )}
          aria-label={`Subtitles: ${subStateLabel}`}
          aria-keyshortcuts='c'
          title='Subtitles (C)'
          onClick={(e) => e.stopPropagation()}
        >
          <Subtitles className='h-[18px] w-[18px]' strokeWidth={2.5} />
          {hasNonDefaultSettings && (
            <span className='absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-(--accent-act)' />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='end'
        sideOffset={10}
        className={cn(
          CHROME_POPOVER_CLASS,
          'flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-1rem)] flex-col overflow-y-auto overscroll-contain p-1.5 data-[state=closed]:animate-none!',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex min-h-9 shrink-0 items-center justify-between px-2.5'>
          <h4 className='text-xs font-semibold text-zinc-300'>Subtitles</h4>
          {hasNonDefaultSettings && (
            <button
              type='button'
              className='h-8 rounded-md px-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30'
              aria-label='Reset subtitle delay, position and size'
              onClick={onResetSubtitleSettings}
            >
              Reset
            </button>
          )}
        </div>

        {/* Off is shared by both views, including when an addon is active. */}
        <div className='mb-1.5 shrink-0'>
          <TrackSelectRow
            label='Off'
            selected={subtitlesShownOff}
            busy={trackSwitching.sub || !!addonSubtitleLoadingId}
            onSelect={() => onSelectTrack('sub', 'no', { persistPreference: true })}
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
                <Loader2 className='h-3 w-3 animate-spin' />
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
              {addonSubtitlesLoading && addonSubtitles.length === 0 ? (
                <p className='flex items-center gap-2 px-2.5 py-3 text-xs text-zinc-400'>
                  <Loader2 className='h-3 w-3 animate-spin' />
                  Loading addon subtitles…
                </p>
              ) : addonSubtitlesError ? (
                <p
                  className='px-2.5 py-3 text-xs leading-relaxed wrap-anywhere text-amber-400/90'
                  title={addonSubtitlesError}
                >
                  {addonSubtitlesError}
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
                  const detail = subtitle.label
                    ?.trim()
                    .replace(SUBTITLE_FILE_EXTENSION_RE, '')
                    .trim();
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
                      disabled={trackSwitching.sub || !!addonSubtitleLoadingId}
                      onClick={() => onSelectAddonSubtitle(subtitle)}
                    >
                      <span className='min-w-0 flex-1 text-left'>
                        <span className='block wrap-anywhere'>
                          {langCode && (
                            <span className='font-semibold text-current'>
                              {langCode}
                              <span className='font-normal text-zinc-500'> · </span>
                            </span>
                          )}
                          <span className='text-zinc-400'>{subtitle.sourceName}</span>
                        </span>
                        {detail && (
                          <span className='mt-0.5 block wrap-anywhere text-xs font-normal leading-relaxed text-zinc-400'>
                            {detail}
                          </span>
                        )}
                      </span>
                      {isLoading ? (
                        <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin text-white/70' />
                      ) : isActive ? (
                        <Check className='h-3.5 w-3.5 shrink-0 text-white' strokeWidth={3} />
                      ) : null}
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
                  label={subtitleTrackLabels.get(track.id) ?? `Track ${track.id}`}
                  selected={!!track.selected}
                  busy={trackSwitching.sub || !!addonSubtitleLoadingId}
                  onSelect={() => onSelectTrack('sub', track.id, { persistPreference: true })}
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
                    className={SUBTITLE_NUDGE_BUTTON_CLASS}
                    disabled={row.current <= row.min}
                    onClick={() => row.onApply(clamp(row.current - row.nudge, row.min, row.max))}
                  >
                    <Minus className='h-3 w-3' strokeWidth={2.5} />
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
                    className={SUBTITLE_NUDGE_BUTTON_CLASS}
                    disabled={row.current >= row.max}
                    onClick={() => row.onApply(clamp(row.current + row.nudge, row.min, row.max))}
                  >
                    <Plus className='h-3 w-3' strokeWidth={2.5} />
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
