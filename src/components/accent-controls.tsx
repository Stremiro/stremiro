import * as SliderPrimitive from '@radix-ui/react-slider';
import { Check } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { registerPendingAppWriteFlusher } from '@/lib/pending-app-writes';
import { cn, clamp, clearTimer, getAccentTextColor, HEX_COLOR_PATTERN } from '@/lib/utils';

const ACCENT_PRESETS = [
  { label: 'White', soft: '#ffffff', vivid: '#ffffff' },
  { label: 'Red', soft: '#fca5a5', vivid: '#f87171' },
  { label: 'Peach', soft: '#fdba74', vivid: '#fb923c' },
  { label: 'Amber', soft: '#fcd34d', vivid: '#fbbf24' },
  { label: 'Lime', soft: '#bef264', vivid: '#a3e635' },
  { label: 'Green', soft: '#86efac', vivid: '#4ade80' },
  { label: 'Mint', soft: '#6ee7b7', vivid: '#34d399' },
  { label: 'Teal', soft: '#5eead4', vivid: '#2dd4bf' },
  { label: 'Cyan', soft: '#67e8f9', vivid: '#22d3ee' },
  { label: 'Sky', soft: '#7dd3fc', vivid: '#38bdf8' },
  { label: 'Blue', soft: '#93c5fd', vivid: '#60a5fa' },
  { label: 'Indigo', soft: '#a5b4fc', vivid: '#818cf8' },
  { label: 'Lavender', soft: '#c4b5fd', vivid: '#a78bfa' },
  { label: 'Fuchsia', soft: '#f0abfc', vivid: '#e879f9' },
  { label: 'Pink', soft: '#f9a8d4', vivid: '#f472b6' },
  { label: 'Rose', soft: '#fda4af', vivid: '#fb7185' },
] as const;
export const ACCENT_PRESET_LABELS = ACCENT_PRESETS.map((preset) => preset.label);
type AccentTone = 'soft' | 'vivid';
const DEFAULT_ACCENT_COLOR = '#ffffff';
const VIVID_ACCENTS = new Set<string>(
  ACCENT_PRESETS.map((preset) => preset.vivid).filter((color) => color !== DEFAULT_ACCENT_COLOR),
);
// Partial hex the draft field can hold mid-typing; HEX_COLOR_PATTERN gates apply.
const ACCENT_HEX_DRAFT_PATTERN = /^#[0-9a-fA-F]{0,6}$/;

/** The color surfaces should preview with: the draft when it parses, else the
    persisted value so an invalid draft never paints a broken swatch. */
export function resolveAccentPreviewColor(draft: string, committed: string): string {
  return HEX_COLOR_PATTERN.test(draft) ? draft : committed;
}

export function normalizeAccentPreviewIntensity(value: number): number {
  return clamp(Math.round(value), 0, 100);
}

function setGlowVar(value: number) {
  document.documentElement.style.setProperty(
    '--app-glow',
    String(normalizeAccentPreviewIntensity(value) / 100),
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
  /** Optional autosave; draft-only surfaces keep their explicit Save flow. */
  onAccentColorCommit?: (color: string) => void | Promise<void>;
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
  onAccentColorCommit,
  onIntensityChange,
  onIntensityCommit,
}: AccentControlsProps) {
  const active = resolveAccentPreviewColor(accentColor, committedColor);
  // Derived until the user picks a tone, so a profile that hydrates after mount
  // (or is restored from a backup) still opens on the tone holding its color.
  const [toneOverride, setTone] = useState<AccentTone | null>(null);
  const tone = toneOverride ?? (VIVID_ACCENTS.has(active.toLowerCase()) ? 'vivid' : 'soft');
  const isAccentHexInvalid = !HEX_COLOR_PATTERN.test(accentColor);
  const validationId = useId();
  const colorCommitRef = useRef(onAccentColorCommit);
  const committedIntensityRef = useRef(committedIntensity);
  useLayoutEffect(() => {
    colorCommitRef.current = onAccentColorCommit;
    committedIntensityRef.current = committedIntensity;
  }, [onAccentColorCommit, committedIntensity]);
  const pendingColorRef = useRef<string | null>(null);
  const colorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushColor = useCallback(async () => {
    clearTimer(colorTimerRef);
    const color = pendingColorRef.current;
    pendingColorRef.current = null;
    if (color !== null) await colorCommitRef.current?.(color);
  }, []);
  const changeColor = (color: string) => {
    onAccentColorChange(color);
    clearTimer(colorTimerRef);
    pendingColorRef.current = null;
    if (!colorCommitRef.current || !HEX_COLOR_PATTERN.test(color)) return;
    pendingColorRef.current = color;
    colorTimerRef.current = setTimeout(() => void flushColor().catch(() => undefined), 300);
  };
  useEffect(() => {
    const unregister = registerPendingAppWriteFlusher(flushColor);
    return () => {
      unregister();
      void flushColor().catch(() => undefined);
    };
  }, [flushColor]);
  const previewIntensity = normalizeAccentPreviewIntensity(intensity);

  useLayoutEffect(() => setGlowVar(previewIntensity), [previewIntensity]);

  // On unmount, snap the ambient back to whatever is actually persisted.
  useEffect(() => () => setGlowVar(committedIntensityRef.current), []);

  return (
    <>
      <div
        className='space-y-3'
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            void flushColor().catch(() => undefined);
          }
        }}
      >
        <div className='flex items-center justify-between gap-2'>
          <div className='text-[10px] font-semibold uppercase tracking-widest text-zinc-400'>
            Accent
          </div>
          <div className='flex items-center gap-3'>
            <div
              role='group'
              aria-label='Accent tone'
              className='flex rounded-md border border-white/[0.08] bg-white/[0.03] p-0.5'
            >
              {(['soft', 'vivid'] as const).map((option) => (
                <button
                  key={option}
                  type='button'
                  aria-pressed={tone === option}
                  onClick={() => setTone(option)}
                  className={cn(
                    'h-6 rounded-sm px-2 text-[11px] font-medium capitalize transition-colors motion-reduce:transition-none focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-white/40',
                    tone === option
                      ? 'bg-white/[0.1] text-white shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200',
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
            <button
              type='button'
              aria-disabled={accentColor === DEFAULT_ACCENT_COLOR}
              onClick={() => {
                if (accentColor !== DEFAULT_ACCENT_COLOR) changeColor(DEFAULT_ACCENT_COLOR);
              }}
              className='rounded-sm text-[11px] font-medium text-zinc-400 transition-colors motion-reduce:transition-none hover:text-zinc-200 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-white/40 aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:text-zinc-400'
            >
              Reset
            </button>
          </div>
        </div>
        <div
          className='grid grid-cols-8 gap-x-2 gap-y-3 py-1'
          role='group'
          aria-label='Accent presets'
        >
          {ACCENT_PRESETS.map((preset) => {
            const color = preset[tone];
            const isActive = active.toLowerCase() === color;
            return (
              <button
                key={preset.label}
                type='button'
                title={`${preset.label} · ${tone}`}
                aria-label={`${preset.label} accent`}
                aria-pressed={isActive}
                onClick={() => changeColor(color)}
                className='flex h-6 w-6 items-center justify-center justify-self-center rounded-full border border-white/10 transition-transform duration-150 hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/60 motion-reduce:transition-none motion-reduce:transform-none'
                // Selected ring uses the swatch's own color with a dark gap —
                // quiet on every hue where a white ring + glow shouted.
                style={{
                  backgroundColor: color,
                  color: getAccentTextColor(color),
                  boxShadow: isActive ? `0 0 0 2px #0a0a0b, 0 0 0 3.5px ${color}99` : undefined,
                }}
              >
                {isActive && <Check aria-hidden='true' className='h-3.5 w-3.5' strokeWidth={2.5} />}
              </button>
            );
          })}
        </div>
        <div className='relative'>
          <Input
            value={accentColor}
            onChange={(e) => {
              const val = e.target.value;
              // Empty must pass too — otherwise the field can never be
              // cleared and retyped from scratch.
              if (val === '' || ACCENT_HEX_DRAFT_PATTERN.test(val)) changeColor(val);
            }}
            maxLength={7}
            placeholder='#ffffff'
            aria-label='Custom accent color hex'
            aria-invalid={isAccentHexInvalid}
            aria-describedby={isAccentHexInvalid ? validationId : undefined}
            spellCheck={false}
            className='h-9 rounded-lg border-white/[0.08] bg-white/[0.03] pl-11 text-xs font-mono text-zinc-100 uppercase placeholder:text-zinc-500 focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-offset-0'
          />
          <div
            className='absolute left-2.5 top-1/2 h-5 w-5 -translate-y-1/2 overflow-hidden rounded-md border border-white/10 focus-within:ring-2 focus-within:ring-white/50 focus-within:ring-offset-2 focus-within:ring-offset-zinc-950'
            style={{ backgroundColor: active }}
          >
            <input
              type='color'
              value={active}
              onChange={(e) => changeColor(e.target.value)}
              aria-label='Pick a custom accent color'
              title='Pick a custom color'
              className='absolute inset-0 h-full w-full cursor-pointer opacity-0'
            />
          </div>
        </div>
        {isAccentHexInvalid && (
          <p id={validationId} className='text-xs leading-relaxed text-zinc-400'>
            Use a 6-digit hex like #22d3ee.
          </p>
        )}
      </div>

      <div className='space-y-3'>
        <div className='flex items-center justify-between'>
          <div className='text-[10px] font-semibold uppercase tracking-widest text-zinc-400'>
            Glow
          </div>
          <span
            className='text-xs font-medium tabular-nums text-zinc-400 transition-colors motion-reduce:transition-none'
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
        <p className='text-xs leading-relaxed text-zinc-400'>
          {previewIntensity === 0
            ? 'Pure black background.'
            : 'Tints the background with your accent.'}
        </p>
      </div>
    </>
  );
}
