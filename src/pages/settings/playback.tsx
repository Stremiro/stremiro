import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAppUiPreferences } from '@/hooks/use-app-ui-preferences';
import { usePlaybackLanguagePreferences } from '@/hooks/use-playback-language-preferences';
import {
  api,
  type AppUiPreferencesPatch,
  getErrorMessage,
  type SupportedLanguage,
} from '@/lib/api';
import { normalizeLanguageToken } from '@/lib/player-track-utils';
import { SUPPORTED_LANGUAGES_QUERY_KEY } from '@/lib/query-invalidation';
import {
  SettingsBody,
  SettingsGroup,
  SettingsGroupHeader,
  SettingsRow,
  SettingsSwitch,
} from './chrome';

// ── Constants ────────────────────────────────────────────────────────────────

const LANGUAGE_MENU_ITEM_CLASS =
  'gap-2.5 py-2 px-3 text-sm rounded-lg cursor-pointer hover:bg-white/10 text-zinc-200 hover:text-white transition-colors';

// Fixed-width slot keeps option labels aligned whether or not a check shows.
function MenuCheck({ active }: { active: boolean }) {
  return active ? <Check className='h-4 w-4 text-white' /> : <div className='w-4' />;
}

function formatLanguageLabel(
  value: string,
  kind: 'audio' | 'subtitle',
  options: readonly SupportedLanguage[],
): string {
  const normalized = normalizeLanguageToken(value);
  if (!normalized) return 'Auto';
  if (kind === 'subtitle' && normalized === 'off') return 'Off';
  const option = options.find((lang) => lang.code === normalized);
  return option ? `${option.label} (${option.code})` : normalized;
}

// ── Language selector ────────────────────────────────────────────────────────

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
  const normalized = normalizeLanguageToken(value);
  const selectorLabelId = `${kind}-language-selector-label`;

  return (
    <div className='space-y-2'>
      <div id={selectorLabelId} className='text-[12px] font-medium text-zinc-400'>
        {label}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant='outline'
            aria-labelledby={selectorLabelId}
            disabled={disabled}
            className='h-10 w-full justify-between rounded-xl border-white/[0.08] bg-white/[0.04] px-3.5 text-[13px] font-medium shadow-none transition-colors hover:border-white/15 hover:bg-white/[0.07]'
          >
            <span className='truncate text-zinc-100'>
              {formatLanguageLabel(value, kind, options)}
            </span>
            <ChevronDown className='ml-2 h-4 w-4 shrink-0 text-zinc-500 opacity-70' />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align='start'
          className='w-(--radix-dropdown-menu-trigger-width) bg-zinc-950 border-white/10'
        >
          <DropdownMenuItem onClick={() => onChange('')} className={LANGUAGE_MENU_ITEM_CLASS}>
            <MenuCheck active={!normalized} />
            Auto
          </DropdownMenuItem>
          {kind === 'subtitle' && (
            <DropdownMenuItem onClick={() => onChange('off')} className={LANGUAGE_MENU_ITEM_CLASS}>
              <MenuCheck active={normalized === 'off'} />
              Off
            </DropdownMenuItem>
          )}
          {options.map((option) => (
            <DropdownMenuItem
              key={option.code}
              onClick={() => onChange(option.code)}
              className={LANGUAGE_MENU_ITEM_CLASS}
            >
              <MenuCheck active={normalized === option.code} />
              {option.label} ({option.code})
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ── Playback language config ─────────────────────────────────────────────────

// Selections persist on pick — the write queue in the hook serializes rapid
// changes and merges each patch into the latest snapshot, so the two
// selectors can be toggled back-to-back without clobbering each other.
function PlaybackLanguageConfig() {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const pendingSavesRef = useRef(0);
  const savedResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const {
    globalPlaybackLanguagePreferences,
    isLoadingGlobalPlaybackLanguagePreferences,
    saveGlobalPlaybackLanguagePreferences,
  } = usePlaybackLanguagePreferences();
  // The closed set lives in Rust; the query is effectively static per run.
  const { data: languageOptions } = useQuery({
    queryKey: SUPPORTED_LANGUAGES_QUERY_KEY,
    queryFn: api.getSupportedLanguages,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const options = languageOptions ?? [];

  useEffect(
    () => () => {
      if (savedResetTimerRef.current) clearTimeout(savedResetTimerRef.current);
    },
    [],
  );

  const handleLanguageChange = (kind: 'audio' | 'subtitle', value: string) => {
    const next = normalizeLanguageToken(value) || undefined;
    const current =
      normalizeLanguageToken(
        kind === 'audio'
          ? globalPlaybackLanguagePreferences?.preferredAudioLanguage
          : globalPlaybackLanguagePreferences?.preferredSubtitleLanguage,
      ) || undefined;
    // Picking the already-active value is a no-op — skip the write entirely.
    if (next === current) return;

    pendingSavesRef.current += 1;
    setSaveState('saving');
    if (savedResetTimerRef.current) {
      clearTimeout(savedResetTimerRef.current);
      savedResetTimerRef.current = null;
    }

    void saveGlobalPlaybackLanguagePreferences(
      kind === 'audio' ? { preferredAudioLanguage: next } : { preferredSubtitleLanguage: next },
    )
      .then(() => {
        pendingSavesRef.current -= 1;
        if (pendingSavesRef.current > 0) return;
        setSaveState('saved');
        savedResetTimerRef.current = setTimeout(() => {
          savedResetTimerRef.current = null;
          setSaveState('idle');
        }, 1600);
      })
      .catch((error) => {
        pendingSavesRef.current -= 1;
        // Failed writes surface via toast — never flash "Saved" for them.
        if (pendingSavesRef.current === 0) setSaveState('idle');
        toast.error(getErrorMessage(error));
      });
  };

  return (
    <div className='space-y-3'>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
        <LanguageSelector
          label='Audio'
          value={globalPlaybackLanguagePreferences?.preferredAudioLanguage ?? ''}
          kind='audio'
          options={options}
          disabled={isLoadingGlobalPlaybackLanguagePreferences}
          onChange={(value) => handleLanguageChange('audio', value)}
        />
        <LanguageSelector
          label='Subtitles'
          value={globalPlaybackLanguagePreferences?.preferredSubtitleLanguage ?? ''}
          kind='subtitle'
          options={options}
          disabled={isLoadingGlobalPlaybackLanguagePreferences}
          onChange={(value) => handleLanguageChange('subtitle', value)}
        />
      </div>

      {/* Fixed-height status lane: the indicator appearing/fading never
          shifts the controls above it. */}
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

// ── Boolean app-UI preference toggle ─────────────────────────────────────────

function AppUiPreferenceToggle({
  appUiPreferences,
  field,
  label,
  description,
}: {
  appUiPreferences: ReturnType<typeof useAppUiPreferences>;
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
        onChange={() => {
          const patch: AppUiPreferencesPatch = {};
          patch[field] = !checked;
          updatePreferences(patch);
        }}
      />
    </SettingsRow>
  );
}

// ── Main export ──────────────────────────────────────────────────────────────

export function PlaybackSettings() {
  // One hook instance for the whole group: each mount carries its own
  // write-coalescing buffer, so four toggles would flush four IPC writes.
  const appUiPreferences = useAppUiPreferences();

  return (
    <SettingsGroup>
      <SettingsGroupHeader
        title='Playback'
        description='Preferred language codes — the player auto-selects matching tracks. Use Off to disable subtitles by default.'
      />
      <SettingsBody>
        <PlaybackLanguageConfig />
      </SettingsBody>
      <div className='border-t border-white/[0.06]'>
        <SettingsBody>
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
