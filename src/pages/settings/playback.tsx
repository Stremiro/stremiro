import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
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
import { type AppUiPreferences, getErrorMessage, type SupportedLanguage } from '@/lib/api';
import { cn, queryNeedsRetry } from '@/lib/utils';
import {
  SETTINGS_OUTLINE_BUTTON_CLASS,
  SettingsBody,
  SettingsGroup,
  SettingsGroupHeader,
  SettingsQueryError,
  SettingsRow,
  SettingsSelect,
  SettingsSwitch,
} from './chrome';

type PlaybackUiPreferences = Pick<
  AppUiPreferences,
  | 'autoPlayNext'
  | 'nextEpisodeCountdownSecs'
  | 'controlsHideDelayMs'
  | 'autoSkipIntro'
  | 'spoilerProtection'
  | 'trailerPreviews'
>;

const COUNTDOWN_SECONDS = [5, 8, 10, 15, 30];
const CONTROLS_HIDE_SECONDS = [2, 3, 5, 8];

function SecondsSelect({
  label,
  seconds,
  options,
  disabled,
  onChange,
}: {
  label: string;
  seconds: number;
  options: readonly number[];
  disabled: boolean;
  onChange: (seconds: number) => void;
}) {
  return (
    <SettingsRow label={label}>
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
  onChange,
}: {
  label: string;
  value: string;
  kind: 'audio' | 'subtitle';
  options: readonly SupportedLanguage[];
  disabled: boolean;
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
            aria-label={`${label}: ${selected?.label ?? value}`}
            disabled={disabled}
            className={cn(
              'h-9 w-52 justify-between gap-2 px-3 text-[13px] shadow-none',
              SETTINGS_OUTLINE_BUTTON_CLASS,
            )}
          >
            <span className='truncate'>{selected?.label ?? value}</span>
            <span className='ml-auto flex shrink-0 items-center gap-2'>
              {selected?.code && selected.code !== 'off' ? (
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
          className='w-64 overflow-hidden rounded-lg border-white/10 bg-zinc-950/95 p-0 shadow-[0_18px_48px_-12px_rgba(0,0,0,0.8)] backdrop-blur-xl'
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
    isLoadingGlobalPlaybackLanguagePreferences,
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

  const disabled = isLoadingGlobalPlaybackLanguagePreferences || languageOptionsQuery.isLoading;
  return (
    <div className='divide-y divide-white/[0.06]'>
      <LanguageSelector
        label='Audio'
        value={globalPlaybackLanguagePreferences?.preferredAudioLanguage ?? ''}
        kind='audio'
        options={options}
        disabled={disabled}
        onChange={(value) => handleLanguageChange('audio', value)}
      />
      <LanguageSelector
        label='Subtitles'
        value={globalPlaybackLanguagePreferences?.preferredSubtitleLanguage ?? ''}
        kind='subtitle'
        options={options}
        disabled={disabled}
        onChange={(value) => handleLanguageChange('sub', value)}
      />
    </div>
  );
}

function AppUiPreferenceToggle({
  appUiPreferences,
  field,
  label,
  description,
}: {
  appUiPreferences: ReturnType<typeof useAppUiPreferences<PlaybackUiPreferences>>;
  field: 'autoPlayNext' | 'autoSkipIntro' | 'spoilerProtection' | 'trailerPreviews';
  label: string;
  description: string;
}) {
  const { preferences, updatePreferences, isHydrating } = appUiPreferences;
  const checked = preferences[field];

  return (
    <SettingsRow label={label} description={description}>
      <SettingsSwitch
        ariaLabel={label}
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
    }) => ({
      spoilerProtection,
      trailerPreviews,
      autoPlayNext,
      nextEpisodeCountdownSecs,
      controlsHideDelayMs,
      autoSkipIntro,
    }),
  );
  const { preferences, isHydrating, updatePreferences } = appUiPreferences;

  return (
    <SettingsGroup>
      <SettingsGroupHeader
        title='Playback'
        description='Default track languages. Subtitles can be set to Off.'
      />
      <SettingsBody>
        <PlaybackLanguageConfig />
      </SettingsBody>
      <div className='border-t border-white/[0.06]'>
        <SettingsQueryError
          className='mx-5 mt-4'
          query={appUiPreferences.preferencesQuery}
          message="Couldn't load your preferences."
        />
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
          <AppUiPreferenceToggle
            appUiPreferences={appUiPreferences}
            field='autoPlayNext'
            label='Auto-play next episode'
            description='Count down and start the next episode automatically.'
          />
          <SecondsSelect
            label='Next episode countdown'
            seconds={preferences.nextEpisodeCountdownSecs}
            options={COUNTDOWN_SECONDS}
            disabled={isHydrating || !preferences.autoPlayNext}
            onChange={(seconds) => updatePreferences({ nextEpisodeCountdownSecs: seconds })}
          />
          <SecondsSelect
            label='Hide player controls after'
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
      </div>
    </SettingsGroup>
  );
}
