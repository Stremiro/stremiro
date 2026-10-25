import { useQuery } from '@tanstack/react-query';
import {
  Captions,
  Check,
  ChevronsUpDown,
  Clapperboard,
  Compass,
  Languages,
  Minus,
  Plus,
  RotateCcw,
  Search,
  Volume2,
} from 'lucide-react';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { RetryBanner } from '@/components/retry-banner';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAppUiPreferences } from '@/hooks/use-app-ui-preferences';
import {
  supportedLanguagesQueryOptions,
  usePlaybackLanguagePreferences,
} from '@/hooks/use-playback-language-preferences';
import { SubtitleAppearanceControls } from '@/components/subtitle-appearance-controls';
import {
  type AppUiPreferences,
  getErrorMessage,
  hasSubtitleAppearance,
  SUBTITLE_APPEARANCE_RESET,
  type SupportedLanguage,
} from '@/lib/api';
import { clamp, cn, queryNeedsRetry } from '@/lib/utils';
import {
  SETTINGS_OUTLINE_BUTTON_CLASS,
  SettingsBody,
  SettingsGroup,
  SettingsGroupHeader,
  SettingsQueryError,
  SettingsRow,
  SettingsSelect,
  SettingsSwitch,
  settingsControlId,
} from './chrome';

type PlaybackUiPreferences = Pick<
  AppUiPreferences,
  | 'autoPlayNext'
  | 'nextEpisodeCountdownSecs'
  | 'controlsHideDelayMs'
  | 'autoSkipIntro'
  | 'spoilerProtection'
  | 'trailerPreviews'
  | 'audioDelay'
  | 'nightMode'
  | 'subtitleFont'
  | 'subtitleColor'
  | 'subtitleEdge'
  | 'subtitleBold'
  | 'subtitleItalic'
  | 'autoLoadAddonSubtitles'
>;

const COUNTDOWN_SECONDS = [5, 8, 10, 15, 30];
const CONTROLS_HIDE_SECONDS = [2, 3, 5, 8];

const STEP_BUTTON_CLASS =
  'flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-nav) aria-disabled:cursor-default aria-disabled:opacity-35 aria-disabled:hover:bg-white/[0.04] motion-reduce:transition-none';

function SecondsSelect({
  label,
  description,
  seconds,
  options,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  seconds: number;
  options: readonly number[];
  disabled: boolean;
  onChange: (seconds: number) => void;
}) {
  return (
    <SettingsRow label={label} description={description}>
      <SettingsSelect
        ariaLabel={label}
        valueLabel={`${seconds} seconds`}
        value={String(seconds)}
        options={options.map((option) => ({ value: String(option), label: `${option} seconds` }))}
        disabled={disabled}
        onChange={(value) => onChange(Number(value))}
      />
    </SettingsRow>
  );
}

const isPrefixMatch = (choice: SupportedLanguage, needle: string) =>
  choice.code === needle || choice.label.toLowerCase().startsWith(needle);

function LanguageSelector({
  label,
  value,
  kind,
  options,
  disabled,
  loading,
  onChange,
}: {
  label: string;
  value: string;
  kind: 'audio' | 'subtitle';
  options: readonly SupportedLanguage[];
  disabled: boolean;
  loading: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const choices = [
    { code: '', label: 'Auto' },
    ...(kind === 'subtitle' ? [{ code: 'off', label: 'Off' }] : []),
    ...options,
  ];
  const selected = choices.find((choice) => choice.code === value);
  const valueLabel = loading ? 'Loading…' : (selected?.label ?? value);
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? choices
        .filter((choice) => `${choice.label} ${choice.code}`.toLowerCase().includes(needle))
        .toSorted((a, b) => Number(!isPrefixMatch(a, needle)) - Number(!isPrefixMatch(b, needle)))
    : choices;
  const activeIndex = Math.min(active, matches.length - 1);

  const moveActive = (index: number) => {
    setActive(index);
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const pick = (code: string) => {
    setOpen(false);
    if (code !== value) onChange(code);
  };

  const handleListKey = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (matches.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      moveActive((activeIndex + step + matches.length) % matches.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (matches.length > 0) pick(matches[activeIndex].code);
    }
  };

  return (
    <SettingsRow label={label}>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setQuery('');
          setActive(Math.max(0, choices.indexOf(selected ?? choices[0])));
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant='outline'
            aria-label={`${label}: ${valueLabel}`}
            disabled={disabled}
            className={cn(
              'h-9 w-52 min-w-0 max-w-full justify-between gap-2 px-3 text-[13px] shadow-none',
              SETTINGS_OUTLINE_BUTTON_CLASS,
            )}
          >
            <span className='truncate'>{valueLabel}</span>
            <span className='ml-auto flex shrink-0 items-center gap-2'>
              {!loading && selected?.code && selected.code !== 'off' ? (
                <span className='font-mono text-[10.5px] uppercase text-zinc-500'>
                  {selected.code}
                </span>
              ) : null}
              <ChevronsUpDown aria-hidden='true' className='h-3.5 w-3.5 text-zinc-500' />
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align='end'
          sideOffset={6}
          onOpenAutoFocus={() => requestAnimationFrame(() => moveActive(activeIndex))}
          className='w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border-white/10 bg-zinc-950/95 p-0 shadow-[0_18px_48px_-12px_rgba(0,0,0,0.8)] backdrop-blur-xl'
        >
          <div className='flex items-center gap-2 border-b border-white/[0.07] px-3'>
            <Search aria-hidden='true' className='h-3.5 w-3.5 shrink-0 text-zinc-500' />
            <input
              role='combobox'
              aria-expanded='true'
              aria-controls={listId}
              aria-activedescendant={
                matches.length > 0 ? `${listId}-${matches[activeIndex].code || 'auto'}` : undefined
              }
              aria-label={`Search ${label.toLowerCase()} languages`}
              placeholder='Search languages'
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
                listRef.current?.scrollTo({ top: 0 });
              }}
              onKeyDown={handleListKey}
              className='h-10 min-w-0 flex-1 bg-transparent text-[13px] text-zinc-100 outline-hidden placeholder:text-zinc-500'
            />
          </div>
          <div
            ref={listRef}
            id={listId}
            role='listbox'
            aria-label={`${label} languages`}
            className='max-h-72 overflow-y-auto overscroll-contain p-1'
          >
            {matches.length === 0 ? (
              <p className='px-3 py-6 text-center text-[12.5px] text-zinc-500'>
                No languages match “{query.trim()}”
              </p>
            ) : (
              matches.map((choice, index) => {
                const isSelected = choice.code === value;
                return (
                  <div
                    key={choice.code || 'auto'}
                    id={`${listId}-${choice.code || 'auto'}`}
                    role='option'
                    aria-selected={isSelected}
                    data-index={index}
                    tabIndex={-1}
                    onPointerMove={() => {
                      if (index !== activeIndex) setActive(index);
                    }}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => pick(choice.code)}
                    onKeyDown={handleListKey}
                    className={cn(
                      'flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors duration-100',
                      index === activeIndex ? 'bg-white/[0.07] text-white' : 'text-zinc-300',
                    )}
                  >
                    <Check
                      aria-hidden='true'
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 text-(--accent-nav)',
                        !isSelected && 'invisible',
                      )}
                    />
                    <span className='truncate'>{choice.label}</span>
                    {choice.code && choice.code !== 'off' ? (
                      <span className='ml-auto shrink-0 font-mono text-[10.5px] uppercase text-zinc-500'>
                        {choice.code}
                      </span>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
    </SettingsRow>
  );
}

// Picks persist immediately; the hook's write queue serializes rapid changes
// so back-to-back selector toggles can't clobber each other.
function PlaybackLanguageConfig() {
  const {
    globalPlaybackLanguagePreferences,
    globalPlaybackLanguagePreferencesQuery,
    saveGlobalPlaybackLanguagePreference,
  } = usePlaybackLanguagePreferences();
  // The closed set lives in Rust; the query is effectively static per run.
  const languageOptionsQuery = useQuery(supportedLanguagesQueryOptions);
  const options = languageOptionsQuery.data ?? [];

  const handleLanguageChange = (kind: 'audio' | 'sub', value: string) => {
    void saveGlobalPlaybackLanguagePreference(kind, value || undefined).catch((error) =>
      toast.error(getErrorMessage(error)),
    );
  };

  if (
    queryNeedsRetry(globalPlaybackLanguagePreferencesQuery) ||
    queryNeedsRetry(languageOptionsQuery)
  ) {
    return (
      <RetryBanner
        message="Couldn't load playback languages."
        isRetrying={
          globalPlaybackLanguagePreferencesQuery.isFetching || languageOptionsQuery.isFetching
        }
        onRetry={() => {
          void globalPlaybackLanguagePreferencesQuery.refetch();
          void languageOptionsQuery.refetch();
        }}
      />
    );
  }

  const loading =
    globalPlaybackLanguagePreferences === undefined || languageOptionsQuery.data === undefined;
  return (
    <>
      <LanguageSelector
        label='Audio'
        value={globalPlaybackLanguagePreferences?.preferredAudioLanguage ?? ''}
        kind='audio'
        options={options}
        disabled={loading}
        loading={loading}
        onChange={(value) => handleLanguageChange('audio', value)}
      />
      <LanguageSelector
        label='Subtitles'
        value={globalPlaybackLanguagePreferences?.preferredSubtitleLanguage ?? ''}
        kind='subtitle'
        options={options}
        disabled={loading}
        loading={loading}
        onChange={(value) => handleLanguageChange('sub', value)}
      />
    </>
  );
}

function AppUiPreferenceToggle({
  appUiPreferences,
  field,
  label,
  description,
}: {
  appUiPreferences: ReturnType<typeof useAppUiPreferences<PlaybackUiPreferences>>;
  field:
    | 'autoPlayNext'
    | 'autoSkipIntro'
    | 'spoilerProtection'
    | 'trailerPreviews'
    | 'nightMode'
    | 'autoLoadAddonSubtitles';
  label: string;
  description: string;
}) {
  const { preferences, updatePreferences, isHydrating } = appUiPreferences;
  const checked = preferences[field];
  const descriptionId = useId();

  return (
    <SettingsRow label={label} description={description} descriptionId={descriptionId}>
      <SettingsSwitch
        ariaLabel={label}
        ariaDescribedBy={descriptionId}
        checked={checked}
        disabled={isHydrating}
        onChange={() => updatePreferences({ [field]: !checked })}
      />
    </SettingsRow>
  );
}

export function PlaybackSettings() {
  const appUiPreferences = useAppUiPreferences(
    ({
      spoilerProtection,
      trailerPreviews,
      autoPlayNext,
      nextEpisodeCountdownSecs,
      controlsHideDelayMs,
      autoSkipIntro,
      audioDelay,
      nightMode,
      subtitleFont,
      subtitleColor,
      subtitleEdge,
      subtitleBold,
      subtitleItalic,
      autoLoadAddonSubtitles,
    }) => ({
      spoilerProtection,
      trailerPreviews,
      autoPlayNext,
      nextEpisodeCountdownSecs,
      controlsHideDelayMs,
      autoSkipIntro,
      audioDelay,
      nightMode,
      subtitleFont,
      subtitleColor,
      subtitleEdge,
      subtitleBold,
      subtitleItalic,
      autoLoadAddonSubtitles,
    }),
  );
  const { preferences, isHydrating, updatePreferences } = appUiPreferences;
  const subtitleAppearanceChanged = hasSubtitleAppearance(preferences);

  return (
    <div className='@container/playback space-y-4'>
      <SettingsQueryError
        query={appUiPreferences.preferencesQuery}
        message="Couldn't load your preferences."
      />
      <div className='grid items-start gap-4 @min-[54rem]/playback:grid-cols-2'>
        <div className='min-w-0 space-y-4'>
          <SettingsGroup>
            <SettingsGroupHeader
              icon={Languages}
              title='Languages'
              description='Preferred tracks for every stream.'
            />
            <SettingsBody rows>
              <PlaybackLanguageConfig />
              <AppUiPreferenceToggle
                appUiPreferences={appUiPreferences}
                field='autoLoadAddonSubtitles'
                label='Load addon subtitles automatically'
                description='Use a matching addon subtitle when the stream has none in your preferred language.'
              />
            </SettingsBody>
          </SettingsGroup>
          <SettingsGroup>
            <SettingsGroupHeader
              icon={Volume2}
              title='Sound'
              description='Applied to all videos.'
            />
            <SettingsBody rows>
              <AppUiPreferenceToggle
                appUiPreferences={appUiPreferences}
                field='nightMode'
                label='Night mode'
                description='Boost quiet audio and smooth volume changes. Off keeps the original sound.'
              />
              <SettingsRow
                label='Audio sync'
                description='Positive delays audio; negative plays it earlier.'
              >
                <span className='flex max-w-full items-center gap-2.5'>
                  <button
                    type='button'
                    aria-label='Play audio 0.1 seconds earlier'
                    aria-disabled={isHydrating || preferences.audioDelay <= -5 || undefined}
                    onClick={() => {
                      if (!isHydrating && preferences.audioDelay > -5)
                        updatePreferences({
                          audioDelay:
                            Math.round(clamp(preferences.audioDelay - 0.1, -5, 5) * 10) / 10,
                        });
                    }}
                    className={STEP_BUTTON_CLASS}
                  >
                    <Minus aria-hidden='true' className='size-3.5' />
                  </button>
                  <output className='w-12 shrink-0 text-center text-[13px] font-medium tabular-nums text-zinc-100'>
                    {preferences.audioDelay > 0 ? '+' : ''}
                    {preferences.audioDelay.toFixed(1)}s
                  </output>
                  <button
                    type='button'
                    aria-label='Play audio 0.1 seconds later'
                    aria-disabled={isHydrating || preferences.audioDelay >= 5 || undefined}
                    onClick={() => {
                      if (!isHydrating && preferences.audioDelay < 5)
                        updatePreferences({
                          audioDelay:
                            Math.round(clamp(preferences.audioDelay + 0.1, -5, 5) * 10) / 10,
                        });
                    }}
                    className={STEP_BUTTON_CLASS}
                  >
                    <Plus aria-hidden='true' className='size-3.5' />
                  </button>
                  <button
                    type='button'
                    aria-label='Reset audio sync'
                    title='Reset audio sync'
                    aria-disabled={isHydrating || preferences.audioDelay === 0 || undefined}
                    onClick={() => {
                      if (!isHydrating && preferences.audioDelay !== 0)
                        updatePreferences({ audioDelay: 0 });
                    }}
                    className={cn(STEP_BUTTON_CLASS, 'ml-0.5')}
                  >
                    <RotateCcw aria-hidden='true' className='size-3.5' />
                  </button>
                </span>
              </SettingsRow>
            </SettingsBody>
          </SettingsGroup>
          <SettingsGroup>
            <SettingsGroupHeader icon={Compass} title='Browsing' />
            <SettingsBody rows>
              <AppUiPreferenceToggle
                appUiPreferences={appUiPreferences}
                field='spoilerProtection'
                label='Spoiler protection'
                description='Blur unwatched episode thumbnails and descriptions.'
              />
              <AppUiPreferenceToggle
                appUiPreferences={appUiPreferences}
                field='trailerPreviews'
                label='Trailer previews'
                description='Play a muted trailer when hovering a title card.'
              />
            </SettingsBody>
          </SettingsGroup>
        </div>
        <div className='min-w-0 space-y-4'>
          <SettingsGroup>
            <SettingsGroupHeader
              icon={Captions}
              title='Subtitles'
              description='Appearance for all videos.'
              action={
                <Button
                  variant='ghost'
                  aria-label='Reset subtitle appearance'
                  aria-disabled={isHydrating || !subtitleAppearanceChanged || undefined}
                  onClick={() => {
                    if (!isHydrating && subtitleAppearanceChanged)
                      updatePreferences(SUBTITLE_APPEARANCE_RESET);
                  }}
                  className='h-8 gap-1.5 px-2 text-xs text-zinc-400 hover:bg-white/[0.05] hover:text-white aria-disabled:opacity-35'
                >
                  <RotateCcw aria-hidden='true' className='size-3' />
                  Reset
                </Button>
              }
            />
            <SettingsBody>
              <div id={settingsControlId('Subtitle appearance')}>
                <SubtitleAppearanceControls
                  subtitleFont={preferences.subtitleFont}
                  subtitleColor={preferences.subtitleColor}
                  subtitleEdge={preferences.subtitleEdge}
                  subtitleBold={preferences.subtitleBold}
                  subtitleItalic={preferences.subtitleItalic}
                  disabled={isHydrating}
                  onPatch={updatePreferences}
                />
              </div>
            </SettingsBody>
          </SettingsGroup>
          <SettingsGroup>
            <SettingsGroupHeader icon={Clapperboard} title='While watching' />
            <SettingsBody rows>
              <AppUiPreferenceToggle
                appUiPreferences={appUiPreferences}
                field='autoPlayNext'
                label='Auto-play next episode'
                description='Start the next episode after the countdown.'
              />
              <SecondsSelect
                label='Next episode countdown'
                seconds={preferences.nextEpisodeCountdownSecs}
                options={COUNTDOWN_SECONDS}
                disabled={isHydrating || !preferences.autoPlayNext}
                onChange={(seconds) => updatePreferences({ nextEpisodeCountdownSecs: seconds })}
              />
              <SecondsSelect
                label='Controls after keyboard input'
                description='Mouse movement hides controls after 0.5 seconds of inactivity.'
                seconds={preferences.controlsHideDelayMs / 1000}
                options={CONTROLS_HIDE_SECONDS}
                disabled={isHydrating}
                onChange={(seconds) => updatePreferences({ controlsHideDelayMs: seconds * 1000 })}
              />
              <AppUiPreferenceToggle
                appUiPreferences={appUiPreferences}
                field='autoSkipIntro'
                label='Auto-skip intros & recaps'
                description='Skip detected intros and recaps. Outros stay manual.'
              />
            </SettingsBody>
          </SettingsGroup>
        </div>
      </div>
    </div>
  );
}
