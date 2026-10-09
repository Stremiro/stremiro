import { Play } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AccentControls } from '@/components/accent-controls';
import {
  type AccentTargets,
  type LocalProfileUpdate,
  useLocalProfile,
} from '@/hooks/use-local-profile';
import { getErrorMessage } from '@/lib/api';
import { HEX_COLOR_PATTERN } from '@/lib/utils';
import {
  SettingsBody,
  SettingsGroup,
  SettingsGroupHeader,
  SettingsRow,
  SettingsSwitch,
} from './chrome';

const TINT_TARGETS: ReadonlyArray<{
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

// Miniature of each accent surface, bound to the same scoped CSS vars the
// real surfaces consume — color picks and toggles preview here live.
function TintPreview() {
  return (
    <div className='flex flex-wrap items-center gap-x-5 gap-y-2 py-1'>
      <div className='flex items-center gap-1.5'>
        <span className='accent-active rounded-md px-2 py-0.5 text-[11px] font-semibold'>Tab</span>
        <span className='text-[11px] text-zinc-400'>Navigation</span>
      </div>
      <div className='flex items-center gap-1.5'>
        <span className='accent-lattice flex h-5 w-5 items-center justify-center rounded-md'>
          <Play className='h-2.5 w-2.5 fill-current' />
        </span>
        <span className='text-[11px] text-zinc-400'>Actions</span>
      </div>
      <div className='flex items-center gap-1.5'>
        <span className='h-1.5 w-12 overflow-hidden rounded-full bg-white/10'>
          <span className='block h-full w-2/3 bg-(--accent-prog)' />
        </span>
        <span className='text-[11px] text-zinc-400'>Progress</span>
      </div>
      <div className='flex items-center gap-1.5'>
        <span
          className='h-5 w-9 rounded-md border border-white/10'
          style={{
            background:
              'linear-gradient(135deg, rgb(var(--accent-art-rgb) / 0.55), rgb(var(--accent-art-rgb) / 0.08))',
          }}
        />
        <span className='text-[11px] text-zinc-400'>Artwork</span>
      </div>
      <span className='ml-auto hidden text-[11px] text-zinc-500 sm:inline'>Live preview</span>
    </div>
  );
}

// Appearance applies live: preset/hex writes commit the moment the value is
// valid, and the glow slider persists once per gesture (`onValueCommit`) so a
// drag never bursts IPC writes. The whole app is the preview.
export function AppearanceSettings() {
  const { profile, updateProfile } = useLocalProfile();
  const [draftAccentColor, setDraftAccentColor] = useState<string>();
  const [draftIntensity, setDraftIntensity] = useState<number>();

  const saveProfile = (updates: LocalProfileUpdate) => {
    void updateProfile(updates).catch((error: unknown) => toast.error(getErrorMessage(error)));
  };

  const handleAccentColorChange = (color: string) => {
    if (HEX_COLOR_PATTERN.test(color)) {
      setDraftAccentColor(undefined);
      saveProfile({ accentColor: color });
    } else {
      setDraftAccentColor(color);
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
        <AccentControls
          accentColor={draftAccentColor ?? profile.accentColor}
          committedColor={profile.accentColor}
          intensity={draftIntensity ?? profile.accentIntensity}
          committedIntensity={profile.accentIntensity}
          onAccentColorChange={handleAccentColorChange}
          onIntensityChange={setDraftIntensity}
          onIntensityCommit={(value) => {
            setDraftIntensity(undefined);
            saveProfile({ accentIntensity: value });
          }}
        />
      </SettingsBody>
      <div className='border-t border-white/[0.06]'>
        <SettingsBody className='space-y-4'>
          <div className='flex flex-wrap items-baseline justify-between gap-2'>
            <p className='text-xs font-medium text-zinc-300'>Tint targets</p>
            <p className='text-[11px] text-zinc-500'>Disabled areas use neutral colors</p>
          </div>
          <TintPreview />
          <div className='divide-y divide-white/[0.05]'>
            {TINT_TARGETS.map((target) => (
              <SettingsRow
                key={target.field}
                label={target.label}
                description={target.description}
                className='py-3.5 first:pt-1 last:pb-0'
              >
                <SettingsSwitch
                  ariaLabel={target.label}
                  checked={profile.accentTargets[target.field]}
                  onChange={() => toggleTarget(target.field)}
                />
              </SettingsRow>
            ))}
          </div>
        </SettingsBody>
      </div>
    </SettingsGroup>
  );
}
