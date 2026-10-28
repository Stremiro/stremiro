import { Film, Paintbrush, Palette, Play, RotateCcw } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AccentControls, resolveAccentPreviewColor } from '@/components/accent-controls';
import { Button } from '@/components/ui/button';
import {
  type AccentTargets,
  DEFAULT_PROFILE_ACCENT,
  type LocalProfileUpdate,
  useLocalProfile,
} from '@/hooks/use-local-profile';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { getErrorMessage } from '@/lib/api';
import { applyAccentVars, cn } from '@/lib/utils';
import {
  SETTINGS_INSET_SURFACE_CLASS,
  SettingsBody,
  SettingsGroup,
  SettingsGroupHeader,
  SettingsQueryError,
  SettingsRow,
  SettingsSwitch,
} from './chrome';

export const TINT_TARGETS: ReadonlyArray<{
  field: keyof AccentTargets;
  label: string;
  description: string;
}> = [
  {
    field: 'navigation',
    label: 'Navigation & selection',
    description: 'Sidebar, tabs, filters and selected states.',
  },
  {
    field: 'actions',
    label: 'Buttons & badges',
    description: 'Accent buttons, chips, switches and text selection.',
  },
  {
    field: 'skip',
    label: 'Skip button',
    description: 'Skip intro and recap pill in the player.',
  },
  {
    field: 'progress',
    label: 'Progress bars',
    description: 'Continue-watching and episode progress.',
  },
  {
    field: 'seekbar',
    label: 'Player seekbar',
    description: 'Played bar and playhead in the player. Off stays white.',
  },
  {
    field: 'artwork',
    label: 'Artwork tints',
    description: 'Hero and backdrop gradients.',
  },
];

// Miniatures bound to the same scoped CSS vars the real surfaces consume.
function TintPreview() {
  return (
    <div
      aria-label='Live accent preview'
      className={cn('flex gap-4 p-4', SETTINGS_INSET_SURFACE_CLASS)}
    >
      <div className='min-w-0 flex-1'>
        <div className='flex items-center gap-2'>
          <span className='accent-active rounded-md px-2.5 py-1 text-xs font-medium motion-reduce:transition-none'>
            Library
          </span>
          <span className='text-xs text-zinc-400'>Lists</span>
          <span className='ml-auto hidden text-[11px] text-zinc-400 sm:inline'>Live preview</span>
        </div>
        <div className='mt-4 flex flex-wrap items-center justify-between gap-3'>
          <div>
            <p className='text-[14px] font-medium text-zinc-100'>Continue watching</p>
            <p className='mt-0.5 text-xs text-zinc-400'>Your next episode, ready to play.</p>
          </div>
          <span className='accent-lattice inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium motion-reduce:transition-none'>
            <Play aria-hidden='true' className='h-3 w-3 fill-current' />
            Resume
          </span>
        </div>
        <div className='mt-4 h-1 overflow-hidden rounded-full bg-white/10'>
          <div className='h-full w-2/3 bg-(--accent-prog)' />
        </div>
      </div>
      <div
        aria-hidden='true'
        className='flex w-20 shrink-0 flex-col items-center justify-center gap-2 rounded-md border border-white/[0.08] sm:w-24'
        style={{
          background:
            'linear-gradient(145deg, rgb(var(--accent-art-rgb) / 0.35), rgb(var(--accent-art-rgb) / 0.04) 85%)',
        }}
      >
        <Film className='h-6 w-6 text-white/60' strokeWidth={1.25} />
        <span className='text-[11px] text-zinc-300'>Artwork</span>
      </div>
    </div>
  );
}

export function AppearanceSettings() {
  const { profile, isHydrating, profilePreferencesQuery, updateProfile } = useLocalProfile();
  const [draftAccentColor, setDraftAccentColor] = useState<string>();
  const [draftIntensity, setDraftIntensity] = useState<number>();
  const mountedRef = useMountedRef();
  const profileRef = useRef(profile);
  useLayoutEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    if (draftAccentColor === undefined) return;
    applyAccentVars(
      resolveAccentPreviewColor(draftAccentColor, profile.accentColor),
      profile.accentTargets,
    );
    return () => applyAccentVars(profileRef.current.accentColor, profileRef.current.accentTargets);
  }, [draftAccentColor, profile.accentColor, profile.accentTargets]);

  const saveProfile = (updates: LocalProfileUpdate) => {
    if (isHydrating) return;
    void updateProfile(updates).catch((error: unknown) => toast.error(getErrorMessage(error)));
  };

  const commitAccentColor = async (color: string) => {
    if (isHydrating) return;
    await updateProfile({ accentColor: color })
      .catch((error: unknown) => {
        toast.error(getErrorMessage(error));
        throw error;
      })
      .finally(() => {
        if (mountedRef.current) {
          setDraftAccentColor((draft) => (draft === color ? undefined : draft));
        }
      });
  };

  const toggleTarget = (field: keyof AccentTargets) => {
    saveProfile({ accentTargets: { [field]: !profile.accentTargets[field] } });
  };

  const appearanceChanged =
    profile.accentColor.toLowerCase() !== DEFAULT_PROFILE_ACCENT.accentColor ||
    profile.accentIntensity !== DEFAULT_PROFILE_ACCENT.accentIntensity ||
    TINT_TARGETS.some(
      ({ field }) => profile.accentTargets[field] !== DEFAULT_PROFILE_ACCENT.accentTargets[field],
    );

  const resetAppearance = () => {
    if (isHydrating || !appearanceChanged) return;
    setDraftAccentColor(undefined);
    setDraftIntensity(undefined);
    saveProfile(DEFAULT_PROFILE_ACCENT);
  };

  return (
    <div className='@container/appearance space-y-4'>
      <SettingsQueryError
        query={profilePreferencesQuery}
        message="Couldn't load your appearance preferences."
      />
      <div className='grid items-start gap-4 @min-[54rem]/appearance:grid-cols-2'>
        <SettingsGroup>
          <SettingsGroupHeader
            icon={Palette}
            title='Color & glow'
            description='Choose an accent and background intensity. Changes apply live.'
            action={
              <Button
                variant='ghost'
                aria-label='Reset appearance'
                title='Reset color, glow and tint targets'
                aria-disabled={isHydrating || !appearanceChanged || undefined}
                onClick={resetAppearance}
                className='h-8 gap-1.5 px-2 text-xs text-zinc-400 hover:bg-white/[0.05] hover:text-white aria-disabled:opacity-35'
              >
                <RotateCcw aria-hidden='true' className='size-3' />
                Reset all
              </Button>
            }
          />
          <SettingsBody className='@container/appearance-controls space-y-5'>
            <TintPreview />
            <fieldset
              disabled={isHydrating}
              inert={isHydrating}
              className='grid min-w-0 items-start gap-6 disabled:opacity-50 @min-[36rem]/appearance-controls:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]'
            >
              <AccentControls
                idPrefix='setting-appearance'
                accentColor={draftAccentColor ?? profile.accentColor}
                committedColor={profile.accentColor}
                intensity={draftIntensity ?? profile.accentIntensity}
                committedIntensity={profile.accentIntensity}
                onAccentColorChange={setDraftAccentColor}
                onAccentColorCommit={commitAccentColor}
                onIntensityChange={setDraftIntensity}
                onIntensityCommit={(value) => {
                  setDraftIntensity(undefined);
                  saveProfile({ accentIntensity: value });
                }}
              />
            </fieldset>
          </SettingsBody>
        </SettingsGroup>
        <SettingsGroup>
          <SettingsGroupHeader
            icon={Paintbrush}
            title='Tint targets'
            description='Choose where your accent appears. Off areas stay neutral.'
          />
          <SettingsBody rows>
            {TINT_TARGETS.map((target) => (
              <SettingsRow key={target.field} label={target.label} description={target.description}>
                <SettingsSwitch
                  ariaLabel={target.label}
                  checked={profile.accentTargets[target.field]}
                  disabled={isHydrating}
                  onChange={() => toggleTarget(target.field)}
                />
              </SettingsRow>
            ))}
          </SettingsBody>
        </SettingsGroup>
      </div>
    </div>
  );
}
