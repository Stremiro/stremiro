import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { RetryBanner } from '@/components/retry-banner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAppUiPreferences } from '@/hooks/use-app-ui-preferences';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import {
  supportedLanguagesQueryOptions,
  usePlaybackLanguagePreferences,
} from '@/hooks/use-playback-language-preferences';
import { type AppUiPreferences, getErrorMessage, type SupportedLanguage } from '@/lib/api';
import { normalizeLanguageToken } from '@/lib/player-track-utils';
import { clearTimer, cn, queryNeedsRetry } from '@/lib/utils';
import {
  SETTINGS_OUTLINE_BUTTON_CLASS,
  SettingsBody,
  SettingsGroup,
  SettingsGroupHeader,
  SettingsQueryError,
  SettingsRow,
  SettingsSwitch,
} from './chrome';

const PLAYBACK_MENU_ITEM_CLASS =
  'gap-2.5 py-2 px-3 text-sm rounded-lg cursor-pointer hover:bg-white/10 text-zinc-200 hover:text-white transition-colors';

type PlaybackUiPreferences = Pick<
  AppUiPreferences,
  | 'autoPlayNext'
  | 'nextEpisodeCountdownSecs'
  | 'controlsHideDelayMs'
  | 'autoSkipIntro'
  | 'spoilerProtection'
  | 'trailerPreviews'
>;

// Fixed-width slot keeps option labels aligned whether or not a check shows.
function MenuCheck({ active }: { active: boolean }) {
  return active ? <Check className='h-4 w-4 text-white' /> : <div className='w-4' />;
}

interface SecondsSelectProps {
  label: string;
  description: string;
  seconds: number;
  options: readonly number[];
  disabled: boolean;
  onChange: (seconds: number) => void;
}

function SecondsSelect({
  label,
  description,
  seconds,
  options,
  disabled,
  onChange,
}: SecondsSelectProps) {
  return (
    <SettingsRow label={label} description={description}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant='outline'
            aria-label={`${label}: ${seconds} seconds`}
            disabled={disabled}
            className={cn(
              'h-9 min-w-36 justify-between px-3 text-[13px] shadow-none',
              SETTINGS_OUTLINE_BUTTON_CLASS,
            )}
          >
            {seconds} seconds
            <ChevronDown className='ml-3 h-4 w-4 text-zinc-500 opacity-70' />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align='end'
          className='min-w-40 border-white/10 bg-zinc-950 backdrop-blur-none'
        >
          {options.map((option) => (
            <DropdownMenuItem
              key={option}
              role='menuitemradio'
              aria-checked={seconds === option}
              onClick={() => onChange(option)}
              className={PLAYBACK_MENU_ITEM_CLASS}
            >
              <MenuCheck active={seconds === option} />
              {option} seconds
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  );
}

function formatLanguageLabel(
  value: string,
  kind: 'audio' | 'subtitle',
  options: readonly SupportedLanguage[],
): string {
  if (!value) return 'Auto';
  if (kind === 'subtitle' && value === 'off') return 'Off';
  const option = options.find((lang) => lang.code === value);
  return option ? `${option.label} (${option.code})` : value;
}

interface LanguageSelectorProps {
  label: string;
  value: string;
  kind: 'audio' | 'subtitle';
  options: readonly SupportedLanguage[];
  disabled?: boolean;
  onChange: (value: string) => void;
}

function LanguageSelector({
  label,
  value,
  kind,
  options,
  disabled,
  onChange,
}: LanguageSelectorProps) {
  const valueLabel = formatLanguageLabel(value, kind, options);

  return (
    <SettingsRow label={label}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant='outline'
            aria-label={`${label}: ${valueLabel}`}
            disabled={disabled}
            className={cn(
              'h-9 min-w-36 justify-between px-3 text-[13px] shadow-none',
              SETTINGS_OUTLINE_BUTTON_CLASS,
            )}
          >
            <span title={valueLabel} className='truncate text-zinc-100'>
              {valueLabel}
            </span>
            <ChevronDown className='ml-3 h-4 w-4 shrink-0 text-zinc-500 opacity-70' />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align='end'
          className='min-w-40 bg-zinc-950 border-white/10 backdrop-blur-none'
        >
          <DropdownMenuItem
            role='menuitemradio'
            aria-checked={!value}
            onClick={() => onChange('')}
            className={PLAYBACK_MENU_ITEM_CLASS}
          >
            <MenuCheck active={!value} />
            Auto
          </DropdownMenuItem>
          {kind === 'subtitle' && (
            <DropdownMenuItem
              role='menuitemradio'
              aria-checked={value === 'off'}
              onClick={() => onChange('off')}
              className={PLAYBACK_MENU_ITEM_CLASS}
            >
              <MenuCheck active={value === 'off'} />
              Off
            </DropdownMenuItem>
          )}
          {options.map((option) => (
            <DropdownMenuItem
              key={option.code}
              role='menuitemradio'
              aria-checked={value === option.code}
              onClick={() => onChange(option.code)}
              className={PLAYBACK_MENU_ITEM_CLASS}
            >
              <MenuCheck active={value === option.code} />
              {option.label} ({option.code})
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  );
}

// Picks persist immediately; the hook's write queue serializes rapid changes
// so back-to-back selector toggles can't clobber each other.
function PlaybackLanguageConfig() {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const pendingSavesRef = useRef(0);
  const savedResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clears the reset timer on unmount and flags late promise winners.
  const mountedRef = useMountedRef(() => clearTimer(savedResetTimerRef));
  const {
    globalPlaybackLanguagePreferences,
    globalPlaybackLanguagePreferencesQuery,
    isLoadingGlobalPlaybackLanguagePreferences,
    saveGlobalPlaybackLanguagePreference,
  } = usePlaybackLanguagePreferences();
  // The closed set lives in Rust; the query is effectively static per run.
  const languageOptionsQuery = useQuery(supportedLanguagesQueryOptions);
  const options = languageOptionsQuery.data ?? [];

  const handleLanguageChange = (kind: 'audio' | 'subtitle', value: string) => {
    const next = normalizeLanguageToken(value) || undefined;
    const save = saveGlobalPlaybackLanguagePreference(kind === 'audio' ? 'audio' : 'sub', next);

    pendingSavesRef.current += 1;
    setSaveState('saving');
    clearTimer(savedResetTimerRef);

    void save
      .then(() => {
        pendingSavesRef.current -= 1;
        if (pendingSavesRef.current > 0) return;
        if (!mountedRef.current) return;
        setSaveState('saved');
        savedResetTimerRef.current = setTimeout(() => {
          savedResetTimerRef.current = null;
          setSaveState('idle');
        }, 1600);
      })
      .catch((error) => {
        pendingSavesRef.current -= 1;
        // Failed writes surface via toast — never flash "Saved" for them.
        if (mountedRef.current && pendingSavesRef.current === 0) setSaveState('idle');
        toast.error(getErrorMessage(error));
      });
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

  return (
    <div className='space-y-3'>
      <div className='divide-y divide-white/[0.06]'>
        <LanguageSelector
          label='Audio'
          value={globalPlaybackLanguagePreferences?.preferredAudioLanguage ?? ''}
          kind='audio'
          options={options}
          disabled={isLoadingGlobalPlaybackLanguagePreferences || languageOptionsQuery.isLoading}
          onChange={(value) => handleLanguageChange('audio', value)}
        />
        <LanguageSelector
          label='Subtitles'
          value={globalPlaybackLanguagePreferences?.preferredSubtitleLanguage ?? ''}
          kind='subtitle'
          options={options}
          disabled={isLoadingGlobalPlaybackLanguagePreferences || languageOptionsQuery.isLoading}
          onChange={(value) => handleLanguageChange('subtitle', value)}
        />
      </div>

      <div className='flex h-5 items-center justify-end' role='status' aria-live='polite'>
        {saveState === 'saving' ? (
          <span className='flex items-center gap-1.5 text-[12px] font-medium text-zinc-500'>
            <Loader2 className='h-3 w-3 animate-spin' />
            Saving…
          </span>
        ) : saveState === 'saved' ? (
          <span className='flex items-center gap-1.5 text-[12px] font-medium text-emerald-300/90'>
            <Check className='h-3 w-3' />
            Saved
          </span>
        ) : null}
      </div>
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
        description='Select preferred track languages. Choose Off to disable subtitles by default.'
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
            description='Blur episode thumbnails and descriptions until they are watched.'
          />
          <AppUiPreferenceToggle
            appUiPreferences={appUiPreferences}
            field='trailerPreviews'
            label='Trailer previews'
            description='Play a muted trailer after hovering on a title card.'
          />
          <AppUiPreferenceToggle
            appUiPreferences={appUiPreferences}
            field='autoPlayNext'
            label='Auto-play next episode'
            description='When an episode ends, count down and start the next one automatically.'
          />
          <SecondsSelect
            label='Next episode countdown'
            description='Seconds before the next episode starts automatically.'
            seconds={preferences.nextEpisodeCountdownSecs}
            options={[5, 8, 10, 15, 30]}
            disabled={isHydrating || !preferences.autoPlayNext}
            onChange={(seconds) => updatePreferences({ nextEpisodeCountdownSecs: seconds })}
          />
          <SecondsSelect
            label='Hide player controls after'
            description='How long controls stay visible while playing.'
            seconds={preferences.controlsHideDelayMs / 1000}
            options={[2, 3, 5, 8]}
            disabled={isHydrating}
            onChange={(seconds) => updatePreferences({ controlsHideDelayMs: seconds * 1000 })}
          />
          <AppUiPreferenceToggle
            appUiPreferences={appUiPreferences}
            field='autoSkipIntro'
            label='Auto-skip intros & recaps'
            description='Jump past detected intro and recap segments. Outros and next-episode prompts stay manual.'
          />
        </SettingsBody>
      </div>
    </SettingsGroup>
  );
}
