import { Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
    <div className='flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5'>
      <div className='flex items-center gap-1.5'>
        <span className='accent-active rounded-md px-2 py-0.5 text-[11px] font-semibold'>Tab</span>
        <span className='text-[10.5px] text-zinc-600'>Nav</span>
      </div>
      <div className='flex items-center gap-1.5'>
        <span className='accent-lattice flex h-5 w-5 items-center justify-center rounded-md'>
          <Play className='h-2.5 w-2.5 fill-current' />
        </span>
        <span className='text-[10.5px] text-zinc-600'>Actions</span>
      </div>
      <div className='flex items-center gap-1.5'>
        <span className='h-1.5 w-12 overflow-hidden rounded-full bg-white/10'>
          <span className='block h-full w-2/3 bg-(--accent-prog)' />
        </span>
        <span className='text-[10.5px] text-zinc-600'>Progress</span>
      </div>
      <div className='flex items-center gap-1.5'>
        <span
          className='h-5 w-9 rounded-md border border-white/10'
          style={{
            background:
              'linear-gradient(135deg, rgb(var(--accent-art-rgb) / 0.55), rgb(var(--accent-art-rgb) / 0.08))',
          }}
        />
        <span className='text-[10.5px] text-zinc-600'>Artwork</span>
      </div>
      <span className='ml-auto hidden text-[10px] font-bold uppercase tracking-widest text-zinc-700 sm:inline'>
        Live preview
      </span>
    </div>
  );
}

// Appearance applies live: preset/hex writes commit the moment the value is
// valid, and the glow slider persists once per gesture (`onValueCommit`) so a
// drag never bursts IPC writes. The whole app is the preview.
export function AppearanceSettings() {
  const { profile, updateProfile } = useLocalProfile();
  const [draftAccentColor, setDraftAccentColor] = useState(profile.accentColor);
  const [draftIntensity, setDraftIntensity] = useState(profile.accentIntensity);

  const saveProfile = (updates: LocalProfileUpdate) => {
    void updateProfile(updates).catch((error: unknown) => toast.error(getErrorMessage(error)));
  };

  // Drafts may be seeded from placeholder data before the profile query
  // resolves — mirror late-arriving values unless the user already typed.
  const accentDirtyRef = useRef(false);
  const intensityDirtyRef = useRef(false);
  useEffect(() => {
    if (!accentDirtyRef.current) setDraftAccentColor(profile.accentColor);
  }, [profile.accentColor]);
  useEffect(() => {
    if (!intensityDirtyRef.current) setDraftIntensity(profile.accentIntensity);
  }, [profile.accentIntensity]);

  const handleAccentColorChange = (color: string) => {
    accentDirtyRef.current = true;
    setDraftAccentColor(color);
    // Persist only a complete hex — mid-typing drafts stay local.
    if (HEX_COLOR_PATTERN.test(color)) {
      saveProfile({ accentColor: color });
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
          accentColor={draftAccentColor}
          committedColor={profile.accentColor}
          intensity={draftIntensity}
          committedIntensity={profile.accentIntensity}
          onAccentColorChange={handleAccentColorChange}
          onIntensityChange={(value) => {
            intensityDirtyRef.current = true;
            setDraftIntensity(value);
          }}
          onIntensityCommit={(value) => saveProfile({ accentIntensity: value })}
        />
      </SettingsBody>
      <div className='border-t border-white/[0.06]'>
        <SettingsBody className='space-y-4'>
          <div className='flex items-baseline justify-between gap-3'>
            <p className='text-[10px] font-bold uppercase tracking-widest text-zinc-600'>
              Tint targets
            </p>
            <p className='text-[11px] text-zinc-600'>Off surfaces fall back to neutral</p>
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
