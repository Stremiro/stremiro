import { Film, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AccentControls, resolveAccentPreviewColor } from '@/components/accent-controls';
import {
  type AccentTargets,
  type LocalProfileUpdate,
  useLocalProfile,
} from '@/hooks/use-local-profile';
import { getErrorMessage } from '@/lib/api';
import { applyAccentVars } from '@/lib/utils';
import {
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
    description: 'Sidebar, tab pills, filters, checkmarks, and selected states.',
  },
  {
    field: 'actions',
    label: 'Buttons & badges',
    description: 'Accent buttons, soft chips, hover play, switches, and text selection.',
  },
  {
    field: 'progress',
    label: 'Progress bars',
    description: 'Continue-watching bars, episode progress, and resume strips.',
  },
  {
    field: 'artwork',
    label: 'Artwork tints',
    description: 'Hero and backdrop gradients that borrow the accent hue.',
  },
];

// Miniatures bound to the same scoped CSS vars the real surfaces consume.
function TintPreview() {
  return (
    <div
      aria-label='Live accent preview'
      className='flex gap-4 rounded-lg border border-white/[0.07] bg-white/[0.02] p-4'
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
  const profileRef = useRef(profile);
  profileRef.current = profile;

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
    try {
      await updateProfile({ accentColor: color });
    } catch (error) {
      toast.error(getErrorMessage(error));
      throw error;
    } finally {
      setDraftAccentColor((draft) => (draft === color ? undefined : draft));
    }
  };

  const toggleTarget = (field: keyof AccentTargets) => {
    saveProfile({ accentTargets: { [field]: !profile.accentTargets[field] } });
  };

  return (
    <SettingsGroup>
      <SettingsGroupHeader
        title='Appearance'
        description='Pick an accent and how strongly it tints the app — changes apply live.'
      />
      <SettingsBody className='space-y-5'>
        <SettingsQueryError
          query={profilePreferencesQuery}
          message="Couldn't load your appearance preferences."
        />
        <TintPreview />
        <fieldset
          disabled={isHydrating}
          inert={isHydrating}
          className='grid min-w-0 items-start gap-6 disabled:opacity-50 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] sm:gap-8'
        >
          <AccentControls
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
      <div className='border-t border-white/[0.06]'>
        <SettingsBody className='pb-0'>
          <div className='flex flex-wrap items-baseline justify-between gap-2'>
            <p className='text-[14px] font-medium text-zinc-100'>Tint targets</p>
            <p className='text-xs text-zinc-400'>Disabled areas stay neutral</p>
          </div>
        </SettingsBody>
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
      </div>
    </SettingsGroup>
  );
}
