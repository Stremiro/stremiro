import * as SliderPrimitive from '@radix-ui/react-slider';
import { useEffect, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { cn, clamp, HEX_COLOR_PATTERN } from '@/lib/utils';

// Soft pastel palette: same hue families as classic accent sets but one
// shade lighter and less saturated, so the color reads as a premium tint
// across tabs/sidebar/progress instead of a neon highlight.
const ACCENT_PRESETS = [
  { color: '#ffffff', label: 'White' },
  { color: '#7dd3fc', label: 'Sky' },
  { color: '#93c5fd', label: 'Blue' },
  { color: '#a5b4fc', label: 'Indigo' },
  { color: '#c4b5fd', label: 'Lavender' },
  { color: '#f9a8d4', label: 'Pink' },
  { color: '#fda4af', label: 'Rose' },
  { color: '#fca5a5', label: 'Red' },
  { color: '#fdba74', label: 'Peach' },
  { color: '#fcd34d', label: 'Amber' },
  { color: '#bef264', label: 'Lime' },
  { color: '#6ee7b7', label: 'Mint' },
] as const;
const DEFAULT_ACCENT_COLOR = '#ffffff';
// Partial hex the draft field can hold mid-typing; HEX_COLOR_PATTERN gates apply.
const ACCENT_HEX_DRAFT_PATTERN = /^#[0-9a-fA-F]{0,6}$/;

/** The color surfaces should preview with: the draft when it parses, else the
    persisted value so an invalid draft never paints a broken swatch. */
export function resolveAccentPreviewColor(draft: string, committed: string): string {
  return HEX_COLOR_PATTERN.test(draft) ? draft : committed;
}

// Slider ticks paint --app-glow directly so the ambient tint follows the
// pointer frame-by-frame; the persisted value only writes on commit/close.
function setGlowVar(value: number) {
  document.documentElement.style.setProperty(
    '--app-glow',
    String(clamp(Math.round(value), 0, 100) / 100),
  );
}

interface AccentControlsProps {
  /** Current draft — may hold a partial hex the pattern rejects mid-typing. */
  accentColor: string;
  /** Persisted color: the preview fallback while the draft is invalid. */
  committedColor: string;
  intensity: number;
  /** Persisted intensity: restored on unmount so closing without saving
      undoes the live drag preview. */
  committedIntensity: number;
  onAccentColorChange: (color: string) => void;
  /** Per-tick draft update while the slider moves. */
  onIntensityChange: (value: number) => void;
  /** One-shot persist at gesture end — surfaces that save on commit (settings)
      pass it; draft+save surfaces (the profile popover) omit it. */
  onIntensityCommit?: (value: number) => void;
}

// Shared accent + glow editors: one owner for preset/hex/glow logic so the
// profile popover and Settings → Appearance can't drift.
export function AccentControls({
  accentColor,
  committedColor,
  intensity,
  committedIntensity,
  onAccentColorChange,
  onIntensityChange,
  onIntensityCommit,
}: AccentControlsProps) {
  const active = resolveAccentPreviewColor(accentColor, committedColor);
  const isAccentHexInvalid = accentColor.length > 0 && !HEX_COLOR_PATTERN.test(accentColor);
  // Clamp locally so the preview never lies; Rust clamps again at the boundary.
  const previewIntensity = clamp(Math.round(intensity), 0, 100);

  const committedIntensityRef = useRef(committedIntensity);
  committedIntensityRef.current = committedIntensity;
  // On unmount, snap the ambient back to whatever is actually persisted.
  useEffect(() => () => setGlowVar(committedIntensityRef.current), []);

  return (
    <>
      <div className='space-y-2'>
        <div className='flex items-center justify-between'>
          <div className='text-[10px] font-bold uppercase tracking-widest text-zinc-600'>
            Accent
          </div>
          {accentColor !== DEFAULT_ACCENT_COLOR && (
            <button
              type='button'
              onClick={() => onAccentColorChange(DEFAULT_ACCENT_COLOR)}
              className='text-[11px] font-medium text-zinc-600 hover:text-zinc-300 transition-colors'
            >
              Reset
            </button>
          )}
        </div>
        <div className='grid grid-cols-6 gap-1.5'>
          {ACCENT_PRESETS.map((p) => {
            const isActive = active === p.color;
            return (
              <button
                key={p.color}
                type='button'
                title={p.label}
                aria-label={`${p.label} accent`}
                aria-pressed={isActive}
                onClick={() => onAccentColorChange(p.color)}
                className={cn(
                  'h-7 rounded-md transition-all duration-150 hover:scale-[1.06] focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-white/40 border',
                  isActive
                    ? 'scale-[1.06] border-transparent'
                    : 'border-white/10 opacity-60 hover:opacity-100',
                )}
                // Selected ring uses the swatch's own color with a dark gap —
                // quiet on every hue where a white ring + glow shouted.
                style={{
                  backgroundColor: p.color,
                  boxShadow: isActive
                    ? `0 0 0 1.5px #0a0a0b, 0 0 0 3px ${p.color}b3, 0 4px 14px -6px ${p.color}80`
                    : undefined,
                }}
              />
            );
          })}
        </div>
        <div className='flex items-center gap-2'>
          <div
            className='h-7 w-7 rounded-md border border-white/10 shrink-0 transition-colors'
            style={{ backgroundColor: active }}
          />
          <Input
            value={accentColor}
            onChange={(e) => {
              const val = e.target.value;
              // Empty must pass too — otherwise the field can never be
              // cleared and retyped from scratch.
              if (val === '' || ACCENT_HEX_DRAFT_PATTERN.test(val)) onAccentColorChange(val);
            }}
            maxLength={7}
            placeholder='#ffffff'
            aria-label='Custom accent color hex'
            spellCheck={false}
            className='h-8 bg-zinc-900/80 border-white/8 text-xs font-mono text-white uppercase placeholder:text-zinc-700 focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-offset-0 rounded-md'
          />
          <input
            type='color'
            value={active}
            onChange={(e) => onAccentColorChange(e.target.value)}
            aria-label='Pick a custom accent color'
            title='Pick a custom color'
            className='h-8 w-9 shrink-0 cursor-pointer rounded-md border border-white/10 bg-zinc-900/80 p-1'
          />
        </div>
        {isAccentHexInvalid && (
          <p className='text-[11px] text-zinc-600'>
            Enter a 6-digit hex like #22d3ee — preview shows the last saved color.
          </p>
        )}
      </div>

      <div className='space-y-2'>
        <div className='flex items-center justify-between'>
          <div className='text-[10px] font-bold uppercase tracking-widest text-zinc-600'>Glow</div>
          <span
            className='text-[11px] font-semibold tabular-nums transition-colors'
            style={{ color: previewIntensity > 0 ? active : undefined }}
          >
            {previewIntensity}%
          </span>
        </div>
        <SliderPrimitive.Root
          value={[previewIntensity]}
          onValueChange={([value]) => {
            if (value === undefined) return;
            onIntensityChange(value);
            setGlowVar(value);
          }}
          onValueCommit={([value]) => {
            if (value !== undefined) onIntensityCommit?.(value);
          }}
          min={0}
          max={100}
          step={1}
          aria-label='Background glow intensity'
          className='relative flex h-5 w-full touch-none select-none items-center'
        >
          <SliderPrimitive.Track className='relative h-1.5 w-full grow overflow-hidden rounded-[2px] bg-white/10'>
            <SliderPrimitive.Range
              className='absolute h-full rounded-[2px]'
              style={{ backgroundColor: active }}
            />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            aria-label='Glow intensity'
            className='block h-[14px] w-[7px] rounded-[2px] border border-white/30 shadow-[0_1px_3px_rgb(0_0_0/0.5)] focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-white/50'
            style={{ backgroundColor: active }}
          />
        </SliderPrimitive.Root>
        <p className='text-[11px] text-zinc-600'>
          {previewIntensity === 0
            ? 'Off — pure black background.'
            : 'Subtle background tint derived from your accent — previews live.'}
        </p>
      </div>
    </>
  );
}
