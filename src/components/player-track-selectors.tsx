import { Check, Headphones, Loader2, Minus, Plus, Subtitles } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { CHROME_ICON_BUTTON_CLASS, CHROME_POPOVER_CLASS } from '@/components/player-chrome-styles';
import { PlayerSlider } from '@/components/player-slider';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { AddonSubtitle } from '@/lib/api';
import { addonSubtitleKey, buildTrackLabelMap, type Track } from '@/lib/player-track-utils';
import { cn } from '@/lib/utils';

// Provider-agnostic noise reduction on the subtitle hint: dropping the
// container extension keeps release names readable for any addon.
const SUBTITLE_FILE_EXTENSION_RE = /\.(srt|ass|ssa|vtt|sub|idx|smi|txt)$/i;

// Stable default — a fresh `[]` literal would defeat this component's memo.
const EMPTY_ADDON_SUBTITLES: AddonSubtitle[] = [];

const SUBTITLE_NUDGE_BUTTON_CLASS =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:bg-white/[0.08] focus-visible:text-white';
const SUBTITLE_VIEW_TAB_CLASS =
  'flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30';
const SUBTITLE_VIEW_TAB_ACTIVE_CLASS = 'bg-white/[0.09] text-white';
const SUBTITLE_VIEW_TAB_INACTIVE_CLASS = 'text-zinc-500 hover:text-zinc-300';

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
        'flex h-8 w-full items-center justify-between gap-2 rounded-md px-2.5 text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/30',
        selected
          ? 'bg-white/[0.08] text-white'
          : 'text-zinc-400 hover:bg-white/[0.06] hover:text-white',
        busy && 'opacity-60',
      )}
      title={label}
      aria-pressed={selected}
      disabled={busy}
      onClick={onSelect}
    >
      <span className='truncate'>{label}</span>
      {busy && selected ? (
        <Loader2 className='h-3 w-3 shrink-0 animate-spin text-white/60' />
      ) : selected ? (
        <Check className='h-3 w-3 shrink-0 text-white' strokeWidth={3} />
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
          className={CHROME_ICON_BUTTON_CLASS}
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
        className={cn(CHROME_POPOVER_CLASS, 'w-56 p-1.5')}
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className='px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500'>
          Audio
        </h4>
        {/* Bound the viewport, not the root: `max-h` on the root leaves the
            `h-full` viewport indefinite, so `overflow-y` never engages. */}
        <ScrollArea className='[&>[data-radix-scroll-area-viewport]]:max-h-[38vh]'>
          <div className='space-y-px'>
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
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
});

interface SubtitleTrackSelectorProps {
  subTracks: Track[];
  subtitlesOff: boolean;
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
  /** Key from `addonSubtitleKey`. */
  activeAddonSubtitleId?: string | null;
  addonSubtitleLoadingId?: string | null;
  onSelectAddonSubtitle?: (subtitle: AddonSubtitle) => void;
  onOpenChange?: (open: boolean) => void;
}

export const SubtitleTrackSelector = memo(function SubtitleTrackSelector({
  subTracks,
  subtitlesOff,
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
  // `subtitlesOff` is the user's choice (it feeds preference memory); a file
  // with no subtitle tracks is still visibly off without recording one.
  const subtitlesShownOff = subtitlesOff || !selectedSubTrack;
  const subStateLabel = subtitlesShownOff ? 'Off' : (selectedSubLabel ?? 'On');
  const hasNonDefaultSettings = subtitleDelay !== 0 || subtitlePos !== 100 || subtitleScale !== 1.0;
  // Tabbed card: stream tracks and addon subtitles share one bounded list,
  // so a long addon result set never pushes the settings rows out of view.
  const [view, setView] = useState<'tracks' | 'addons'>('tracks');

  const handleOpenChange = (open: boolean) => {
    // Reopen on the tab that owns the active pick — an addon-selected
    // subtitle should be visible (checked) the moment the menu opens.
    setView(open && activeAddonSubtitleId ? 'addons' : 'tracks');
    onOpenChange?.(open);
  };

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(
            'relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
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
        className={cn(CHROME_POPOVER_CLASS, 'w-72 p-1.5')}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Pinned header — stays outside the scroll region. */}
        <div className='flex items-center justify-between px-2.5 pb-1 pt-1.5'>
          <h4 className='text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500'>
            Subtitles
          </h4>
          {hasNonDefaultSettings && (
            <button
              type='button'
              className='rounded px-1 text-[10px] font-medium text-zinc-500 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30'
              onClick={onResetSubtitleSettings}
            >
              Reset
            </button>
          )}
        </div>

        {/* View switch: stream-provided tracks vs addon-provided subtitles. */}
        {onSelectAddonSubtitle && (
          <div className='mx-1 mb-1.5 flex rounded-lg bg-white/[0.05] p-0.5'>
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
                <Loader2 className='h-2.5 w-2.5 animate-spin' />
              ) : addonSubtitles.length > 0 ? (
                <span className='rounded-full bg-white/[0.09] px-1.5 text-[9px] leading-4 tabular-nums text-zinc-400'>
                  {addonSubtitles.length}
                </span>
              ) : null}
              {activeAddonSubtitleId && <span className='h-1 w-1 rounded-full bg-(--accent-act)' />}
            </button>
          </div>
        )}

        {/* Only the list scrolls — header, tabs, and settings stay pinned. */}
        <ScrollArea className='[&>[data-radix-scroll-area-viewport]]:max-h-[42vh]'>
          {view === 'addons' && onSelectAddonSubtitle ? (
            <div className='space-y-px'>
              {addonSubtitlesLoading && addonSubtitles.length === 0 ? (
                <p className='flex items-center gap-2 px-2.5 py-2 text-[11px] text-zinc-500'>
                  <Loader2 className='h-3 w-3 animate-spin' />
                  Loading addon subtitles…
                </p>
              ) : addonSubtitlesError ? (
                <p
                  className='px-2.5 py-2 text-[11px] leading-snug text-amber-400/90'
                  title={addonSubtitlesError}
                >
                  {addonSubtitlesError}
                </p>
              ) : !addonSubtitlesQueried ? (
                <p className='px-2.5 py-2 text-[11px] text-zinc-500'>
                  Addon subtitles are unavailable for this title.
                </p>
              ) : addonSubtitles.length === 0 ? (
                <p className='px-2.5 py-2 text-[11px] text-zinc-500'>
                  No addon subtitles found for this title.
                </p>
              ) : (
                addonSubtitles.map((subtitle) => {
                  const langCode = subtitle.lang?.trim().toUpperCase();
                  const detail = subtitle.label
                    ?.trim()
                    .replace(SUBTITLE_FILE_EXTENSION_RE, '')
                    .trim();
                  const subtitleKey = addonSubtitleKey(subtitle);
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
                        'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/30',
                        isActive
                          ? 'bg-white/[0.08] text-white'
                          : 'text-zinc-400 hover:bg-white/[0.06] hover:text-white',
                        (trackSwitching.sub || addonSubtitleLoadingId) && 'opacity-60',
                      )}
                      title={titleText}
                      aria-pressed={isActive}
                      disabled={trackSwitching.sub || !!addonSubtitleLoadingId}
                      onClick={() => onSelectAddonSubtitle(subtitle)}
                    >
                      <span className='min-w-0 flex-1 text-left'>
                        <span className='block truncate'>
                          {langCode && (
                            <span className='font-semibold text-current'>
                              {langCode}
                              <span className='font-normal text-zinc-500'> · </span>
                            </span>
                          )}
                          <span className='text-zinc-500'>{subtitle.sourceName}</span>
                        </span>
                        {detail && (
                          <span className='block truncate text-[10px] font-normal leading-snug text-zinc-500'>
                            {detail}
                          </span>
                        )}
                      </span>
                      {isLoading ? (
                        <Loader2 className='h-3 w-3 shrink-0 animate-spin text-white/60' />
                      ) : isActive ? (
                        <Check className='h-3 w-3 shrink-0 text-white' strokeWidth={3} />
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          ) : (
            <div className='space-y-px'>
              <TrackSelectRow
                label='Off'
                selected={subtitlesShownOff}
                busy={trackSwitching.sub}
                onSelect={() => onSelectTrack('sub', 'no', { persistPreference: true })}
              />
              {subTracks.map((track) => (
                <TrackSelectRow
                  key={track.id}
                  label={subtitleTrackLabels.get(track.id) ?? `Track ${track.id}`}
                  selected={!!track.selected}
                  busy={trackSwitching.sub}
                  onSelect={() => onSelectTrack('sub', track.id, { persistPreference: true })}
                />
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Settings - only show if tracks exist; pinned below the list so a
            long addon result set never pushes them out of reach. */}
        {subTracks.length > 0 && !subtitlesOff && (
          <>
            <div className='mx-2.5 my-2 h-px bg-white/[0.07]' />
            <div className='space-y-2 px-2.5 pb-1.5'>
              {(
                [
                  {
                    key: 'sync',
                    label: 'Sync',
                    value: `${subtitleDelay.toFixed(1)}s`,
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
                    min: 0.25,
                    max: 3.0,
                    step: 0.05,
                    current: subtitleScale,
                    nudge: 0.1,
                    onApply: onApplySubtitleScale,
                  },
                ] as const
              ).map((row) => (
                <div key={row.key} className='flex items-center gap-2'>
                  <span className='w-12 shrink-0 text-[10px] font-medium text-zinc-500'>
                    {row.label}
                  </span>
                  <button
                    type='button'
                    aria-label={`Decrease ${row.label}`}
                    className={SUBTITLE_NUDGE_BUTTON_CLASS}
                    onClick={() => row.onApply(row.current - row.nudge)}
                  >
                    <Minus className='h-3 w-3' strokeWidth={2.5} />
                  </button>
                  <PlayerSlider
                    value={[row.current]}
                    min={row.min}
                    max={row.max}
                    step={row.step}
                    aria-label={row.label}
                    onValueChange={(values) => row.onApply(values[0])}
                    className='flex-1'
                  />
                  <button
                    type='button'
                    aria-label={`Increase ${row.label}`}
                    className={SUBTITLE_NUDGE_BUTTON_CLASS}
                    onClick={() => row.onApply(row.current + row.nudge)}
                  >
                    <Plus className='h-3 w-3' strokeWidth={2.5} />
                  </button>
                  <span className='w-10 shrink-0 text-right text-[10px] font-medium tabular-nums text-zinc-400'>
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
});
