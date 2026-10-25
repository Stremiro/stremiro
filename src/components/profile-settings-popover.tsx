import { Check, ChevronRight, Settings2, SlidersHorizontal } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  AccentControls,
  normalizeAccentPreviewIntensity,
  resolveAccentPreviewColor,
} from '@/components/accent-controls';
import { ProfileAvatar } from '@/components/profile-avatar';
import { RetryBanner } from '@/components/retry-banner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { type LocalProfile, type LocalProfileUpdate } from '@/hooks/use-local-profile';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { cn, getAccentTextColor, HEX_COLOR_PATTERN, nonBlank } from '@/lib/utils';

export function ProfileSettingsPopover({
  profile,
  onUpdate,
  isSaving,
  isHydrating,
  isError,
  isRetrying,
  onRetry,
}: {
  profile: LocalProfile;
  onUpdate: (updates: LocalProfileUpdate) => Promise<void>;
  isSaving: boolean;
  isHydrating: boolean;
  isError: boolean;
  isRetrying: boolean;
  onRetry: () => void;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState(profile.username);
  const [draftAccentColor, setDraftAccentColor] = useState(profile.accentColor);
  const [draftIntensity, setDraftIntensity] = useState(profile.accentIntensity);
  const openingGenerationRef = useRef(0);
  const mountedRef = useMountedRef();

  if (isHydrating && open) setOpen(false);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      if (isHydrating) return;
      openingGenerationRef.current += 1;
      setDraftName(profile.username);
      setDraftAccentColor(profile.accentColor);
      setDraftIntensity(profile.accentIntensity);
    }
    setOpen(next);
  };

  const previewAccentColor = resolveAccentPreviewColor(draftAccentColor, profile.accentColor);
  const isAccentHexInvalid = !HEX_COLOR_PATTERN.test(draftAccentColor);
  const previewIntensity = normalizeAccentPreviewIntensity(draftIntensity);
  const previewName = nonBlank(draftName) || profile.username;

  const handleSave = async () => {
    const trimmedName = draftName.trim();
    if (!trimmedName || isAccentHexInvalid || isSaving || isHydrating || isError) return;
    const generation = openingGenerationRef.current;

    try {
      await onUpdate({
        username: trimmedName,
        accentColor: previewAccentColor,
        accentIntensity: previewIntensity,
      });
      toast.success('Profile saved');
      if (mountedRef.current && generation === openingGenerationRef.current) setOpen(false);
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
          disabled={isHydrating}
          className='flex h-8 items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] px-2.5 text-zinc-400 transition-colors duration-150 enabled:hover:border-white/[0.14] enabled:hover:bg-white/[0.07] enabled:hover:text-zinc-200 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/25 disabled:cursor-not-allowed disabled:opacity-50'
        >
          <span
            aria-hidden='true'
            className='h-1.5 w-1.5 rounded-full'
            style={{ backgroundColor: profile.accentColor }}
          />
          <Settings2 className='w-3 h-3' />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align='start'
        sideOffset={8}
        aria-label='Customize profile'
        className='flex max-h-[min(85dvh,var(--radix-popover-content-available-height))] w-72 flex-col p-0 bg-zinc-950 border border-white/10 rounded-xl shadow-2xl shadow-black/60 overflow-hidden'
      >
        <div className='shrink-0 px-3.5 pt-3 pb-2.5 border-b border-white/[0.06]'>
          <h2 className='text-[13px] font-semibold text-white'>Customize profile</h2>
        </div>

        {isError ? (
          <RetryBanner
            className='m-2 px-2.5 py-2'
            message="Couldn't load profile preferences."
            isRetrying={isRetrying}
            onRetry={() => {
              setOpen(false);
              onRetry();
            }}
          />
        ) : (
          <>
            <fieldset
              disabled={isSaving}
              inert={isSaving}
              className='min-h-0 min-w-0 overflow-y-auto overscroll-contain px-3.5 py-3 space-y-4'
            >
              <div className='flex items-center gap-2.5 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-2'>
                <ProfileAvatar
                  name={previewName}
                  avatar={profile.avatar}
                  className='h-8 w-8'
                  fallbackClassName='text-[13px] font-black transition-colors duration-200'
                  fallbackStyle={{ backgroundColor: `${active}1f`, color: active }}
                />
                <div className='min-w-0 flex-1'>
                  <p
                    dir='auto'
                    title={previewName}
                    className='truncate text-[12.5px] font-semibold text-white'
                  >
                    {previewName}
                  </p>
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
                  className='text-[12px] font-medium text-zinc-400'
                >
                  Display name
                </label>
                <Input
                  id='profile-display-name'
                  value={draftName}
                  // Code-point cap matching Rust's char limit — `maxLength` counts UTF-16 units.
                  onChange={(e) => setDraftName(Array.from(e.target.value).slice(0, 32).join(''))}
                  onKeyDown={(e) => {
                    if (
                      e.key !== 'Enter' ||
                      e.defaultPrevented ||
                      e.nativeEvent.isComposing ||
                      e.repeat
                    )
                      return;
                    e.preventDefault();
                    void handleSave();
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
            </fieldset>

            <div className='shrink-0 px-3.5 pb-3.5 space-y-1.5'>
              <Button
                size='sm'
                onClick={handleSave}
                disabled={!draftName.trim() || isHydrating}
                aria-disabled={isSaving || isAccentHexInvalid || undefined}
                aria-busy={isSaving || undefined}
                className={cn(
                  'w-full text-xs font-semibold rounded-md h-8 flex items-center gap-1.5 aria-disabled:cursor-default',
                  isAccentHexInvalid && 'opacity-50',
                )}
                style={{
                  backgroundColor: active,
                  color: getAccentTextColor(active),
                }}
              >
                <Check aria-hidden='true' className='w-3 h-3' />
                Save
              </Button>
              <button
                type='button'
                onClick={() => {
                  setOpen(false);
                  navigate('/settings?section=appearance');
                }}
                className='flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] text-[11px] font-medium text-zinc-400 transition-colors hover:border-white/[0.12] hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/25'
              >
                <SlidersHorizontal className='h-3 w-3' />
                Tint controls
                <ChevronRight className='h-3 w-3 opacity-60' />
              </button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
