import { Check, ChevronRight, Settings2, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AccentControls, resolveAccentPreviewColor } from '@/components/accent-controls';
import { ProfileAvatar } from '@/components/profile-avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { LocalProfile, LocalProfileUpdate } from '@/hooks/use-local-profile';
import { clamp, getAccentTextColor, nonBlank } from '@/lib/utils';

export function ProfileSettingsPopover({
  profile,
  onUpdate,
  isSaving,
}: {
  profile: LocalProfile;
  onUpdate: (updates: LocalProfileUpdate) => Promise<void>;
  isSaving: boolean;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState(profile.username);
  const [draftAccentColor, setDraftAccentColor] = useState(profile.accentColor);
  const [draftIntensity, setDraftIntensity] = useState(profile.accentIntensity);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setDraftName(profile.username);
      setDraftAccentColor(profile.accentColor);
      setDraftIntensity(profile.accentIntensity);
    }
    setOpen(next);
  };

  const previewAccentColor = resolveAccentPreviewColor(draftAccentColor, profile.accentColor);
  // Clamp locally so the preview never lies; Rust clamps again at the boundary.
  const previewIntensity = clamp(Math.round(draftIntensity), 0, 100);
  const previewName = nonBlank(draftName) || profile.username;

  const handleSave = async () => {
    const trimmedName = draftName.trim();
    if (!trimmedName || isSaving) return;

    try {
      await onUpdate({
        username: trimmedName,
        accentColor: previewAccentColor,
        accentIntensity: previewIntensity,
      });
      toast.success('Profile saved');
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save profile');
    }
  };

  const active = previewAccentColor;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type='button'
          title='Customize profile'
          aria-label='Customize profile'
          className='group flex h-6 items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] pl-2 pr-2.5 text-zinc-500 transition-all duration-200 hover:border-white/[0.14] hover:bg-white/[0.07] hover:text-zinc-200 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-white/25'
        >
          {/* Live accent dot — the chip doubles as the current-color readout. */}
          <span
            aria-hidden='true'
            className='h-1.5 w-1.5 rounded-full transition-transform duration-200 group-hover:scale-125'
            style={{ backgroundColor: profile.accentColor }}
          />
          <Settings2 className='w-3 h-3' />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align='start'
        sideOffset={8}
        className='w-72 p-0 bg-zinc-950 border border-white/10 rounded-xl shadow-2xl shadow-black/60 overflow-hidden'
      >
        <div
          className='h-px w-full'
          style={{ background: `linear-gradient(to right, transparent, ${active}55, transparent)` }}
        />

        <div className='px-3.5 pt-3 pb-2.5 border-b border-white/[0.06]'>
          <h2 className='text-[13px] font-semibold text-white'>Customize Profile</h2>
          <p className='text-[11px] text-zinc-600 mt-0.5'>
            Accent tints the app. Glow sets the tint strength.
          </p>
        </div>

        <div className='px-3.5 py-3 space-y-4'>
          {/* Live preview */}
          <div className='flex items-center gap-2.5 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-2'>
            <ProfileAvatar
              name={previewName}
              avatar={profile.avatar}
              className='h-8 w-8'
              fallbackClassName='text-[13px] font-black transition-colors duration-200'
              fallbackStyle={{ backgroundColor: `${active}1f`, color: active }}
            />
            <div className='min-w-0 flex-1'>
              <p className='truncate text-[12.5px] font-semibold text-white'>{previewName}</p>
              <p className='text-[10.5px] text-zinc-600'>Preview — save to apply</p>
            </div>
            <div
              className='h-5 w-5 shrink-0 rounded-md border border-white/10 transition-colors duration-200'
              style={{ backgroundColor: active }}
            />
          </div>

          <div className='space-y-1'>
            <label
              htmlFor='profile-display-name'
              className='text-[10px] font-bold uppercase tracking-widest text-zinc-600'
            >
              Display Name
            </label>
            <Input
              id='profile-display-name'
              value={draftName}
              // Code-point cap matching Rust's char limit; `maxLength` counts
              // UTF-16 units and would cut emoji names short.
              onChange={(e) => setDraftName(Array.from(e.target.value).slice(0, 32).join(''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSave();
              }}
              placeholder='Enter your name…'
              className='h-8 bg-zinc-900/80 border-white/8 text-[13px] text-white placeholder:text-zinc-700 focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-offset-0 rounded-md'
            />
          </div>

          <AccentControls
            accentColor={draftAccentColor}
            committedColor={profile.accentColor}
            intensity={draftIntensity}
            committedIntensity={profile.accentIntensity}
            onAccentColorChange={setDraftAccentColor}
            onIntensityChange={setDraftIntensity}
          />
        </div>

        <div className='px-3.5 pb-3.5 space-y-1.5'>
          <Button
            size='sm'
            onClick={handleSave}
            disabled={!draftName.trim() || isSaving}
            className='w-full text-xs font-semibold rounded-md h-8 flex items-center gap-1.5'
            style={{
              backgroundColor: active,
              color: getAccentTextColor(active),
            }}
          >
            <Check className='w-3 h-3' />
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
          <button
            type='button'
            onClick={() => {
              setOpen(false);
              navigate('/settings?section=appearance');
            }}
            className='flex w-full items-center justify-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] py-1.5 text-[11px] font-medium text-zinc-400 transition-colors hover:border-white/[0.12] hover:bg-white/[0.06] hover:text-zinc-200'
          >
            <SlidersHorizontal className='h-3 w-3' />
            Tint controls
            <ChevronRight className='h-3 w-3 opacity-60' />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
