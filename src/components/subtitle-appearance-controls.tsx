import { Check, ChevronDown } from 'lucide-react';
import { type CSSProperties, useRef, useState } from 'react';
import type { SubtitleColor, SubtitleEdge, SubtitleFont } from '@/lib/api';
import {
  SUBTITLE_COLOR_OPTIONS,
  SUBTITLE_EDGE_OPTIONS,
  SUBTITLE_FONT_OPTIONS,
} from '@/lib/player-track-utils';
import { cn } from '@/lib/utils';

interface SubtitleAppearancePatch {
  subtitleFont?: SubtitleFont;
  subtitleColor?: SubtitleColor;
  subtitleEdge?: SubtitleEdge;
  subtitleBold?: boolean;
  subtitleItalic?: boolean;
}

// One geometry for the two pickers and the B/I toggles — the row reads as a single strip.
const CONTROL_CLASS =
  'flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/[0.05] text-zinc-400 transition-colors duration-150 hover:bg-white/[0.08] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-nav) disabled:cursor-wait disabled:opacity-35 motion-reduce:transition-none';
const FIELD_LABEL_CLASS = 'mb-1.5 text-[12px] font-medium text-zinc-400';
const CONTROL_OPEN_CLASS = 'bg-white/[0.09] text-white hover:bg-white/[0.09]';
const CONTROL_PRESSED_CLASS = 'bg-white/[0.14] text-white hover:bg-white/[0.16] hover:text-white';
const LIST_ITEM_CLASS =
  'flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left transition-colors duration-150 hover:bg-white/[0.07] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-nav) motion-reduce:transition-none';

function previewStyle(
  font: SubtitleFont,
  color: SubtitleColor,
  edge: SubtitleEdge,
  bold: boolean,
  italic: boolean,
): CSSProperties {
  const style: CSSProperties = {
    color: SUBTITLE_COLOR_OPTIONS.find((option) => option.value === color)?.hex ?? '#ffffff',
  };
  const fontFamily = SUBTITLE_FONT_OPTIONS.find((option) => option.value === font)?.fontFamily;
  if (fontFamily) style.fontFamily = fontFamily;
  if (bold) style.fontWeight = 700;
  if (italic) style.fontStyle = 'italic';
  if (edge === 'outline') {
    style.textShadow =
      '1px 0 0 rgba(0,0,0,0.9), -1px 0 0 rgba(0,0,0,0.9), 0 1px 0 rgba(0,0,0,0.9), 0 -1px 0 rgba(0,0,0,0.9)';
  } else if (edge === 'thick') {
    style.textShadow =
      '2px 0 0 #000, -2px 0 0 #000, 0 2px 0 #000, 0 -2px 0 #000, 1.4px 1.4px 0 #000, -1.4px 1.4px 0 #000, 1.4px -1.4px 0 #000, -1.4px -1.4px 0 #000';
  } else if (edge === 'shadow') {
    style.textShadow = '2px 2px 4px rgba(0,0,0,0.9)';
  } else if (edge === 'box') {
    style.backgroundColor = 'rgba(0,0,0,0.7)';
    style.borderRadius = 4;
    style.padding = '0.08em 0.4em';
    style.boxDecorationBreak = 'clone';
    style.WebkitBoxDecorationBreak = 'clone';
  }
  return style;
}

/**
 * Inline drill-down instead of a native `<select>` (WebView2 paints its popup white and
 * unstyleable) or a nested popper (which would dismiss the player popover it sits in).
 */
function OptionList<Value extends string>({
  compact,
  label,
  onChange,
  options,
  value,
}: {
  compact: boolean;
  label: string;
  onChange: (value: Value) => void;
  options: readonly { value: Value; label: string; fontFamily?: string }[];
  value: Value;
}) {
  return (
    <div
      role='group'
      aria-label={label}
      className={cn(
        'player-menu-swap scrollbar-hide grid gap-0.5 rounded-lg border border-white/[0.07] bg-black/25 p-1',
        compact ? 'max-h-32 grid-cols-2 overflow-y-auto' : 'max-h-44 grid-cols-3 overflow-y-auto',
      )}
    >
      {options.map((option) => {
        const isSelected = option.value === value;
        return (
          <button
            key={option.value}
            type='button'
            aria-pressed={isSelected}
            style={{ fontFamily: option.fontFamily }}
            onClick={() => onChange(option.value)}
            className={cn(
              LIST_ITEM_CLASS,
              compact ? 'h-8 text-[13px]' : 'h-9 text-[14px]',
              isSelected ? 'bg-white/[0.1] text-white' : 'text-zinc-300',
            )}
          >
            <Check
              aria-hidden='true'
              strokeWidth={2.5}
              className={cn('h-3 w-3 shrink-0 text-(--accent-nav)', !isSelected && 'invisible')}
            />
            <span className='truncate'>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SubtitleAppearanceControls({
  subtitleFont,
  subtitleColor,
  subtitleEdge,
  subtitleBold,
  subtitleItalic,
  disabled = false,
  compact = false,
  onPatch,
}: {
  subtitleFont: SubtitleFont;
  subtitleColor: SubtitleColor;
  subtitleEdge: SubtitleEdge;
  subtitleBold: boolean;
  subtitleItalic: boolean;
  disabled?: boolean;
  compact?: boolean;
  onPatch: (patch: SubtitleAppearancePatch) => void;
}) {
  const [menu, setMenu] = useState<'font' | 'edge'>('font');
  const [menuOpen, setMenuOpen] = useState(false);
  const pickerRef = useRef<HTMLButtonElement>(null);
  const selectedFont = SUBTITLE_FONT_OPTIONS.find((option) => option.value === subtitleFont);
  const selectedEdge = SUBTITLE_EDGE_OPTIONS.find((option) => option.value === subtitleEdge);
  // The panel keeps its last menu mounted so collapsing animates instead of popping.
  const toggle = (next: 'font' | 'edge') => {
    if (menuOpen && menu === next) {
      setMenuOpen(false);
      return;
    }
    setMenu(next);
    setMenuOpen(true);
  };

  const picker = (target: 'font' | 'edge', label: string, valueLabel: string) => (
    <button
      type='button'
      ref={menu === target ? pickerRef : undefined}
      aria-expanded={menuOpen && menu === target}
      aria-label={`${label}: ${valueLabel}`}
      disabled={disabled}
      onClick={() => toggle(target)}
      className={cn(
        CONTROL_CLASS,
        'min-w-0 justify-between pl-3 text-zinc-100',
        compact
          ? 'h-8 border-transparent bg-white/[0.06] pr-1.5 text-[13px]'
          : 'h-10 pr-2.5 text-[14px]',
        menuOpen && menu === target && CONTROL_OPEN_CLASS,
      )}
    >
      <span className='truncate'>{valueLabel}</span>
      <ChevronDown
        aria-hidden='true'
        className={cn(
          'h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform duration-200 motion-reduce:transition-none',
          menuOpen && menu === target && 'rotate-180',
        )}
      />
    </button>
  );

  const closeMenu = () => {
    pickerRef.current?.focus();
    setMenuOpen(false);
  };
  const emphasisOptions = [
    ['Bold subtitles', subtitleBold, { subtitleBold: !subtitleBold }, 'font-bold', 'B'],
    [
      'Italic subtitles',
      subtitleItalic,
      { subtitleItalic: !subtitleItalic },
      'font-serif italic',
      'I',
    ],
  ] as const;
  const emphasisButtons = emphasisOptions.map(([label, pressed, patch, glyphClass, glyph]) => (
    <button
      key={label}
      type='button'
      aria-pressed={pressed}
      aria-label={label}
      disabled={disabled}
      onClick={() => onPatch(patch)}
      className={cn(
        CONTROL_CLASS,
        compact
          ? 'h-8 w-8 border-transparent bg-white/[0.06] text-[13px]'
          : 'h-10 w-10 text-[14px]',
        pressed && CONTROL_PRESSED_CLASS,
      )}
    >
      <span aria-hidden='true' className={glyphClass}>
        {glyph}
      </span>
    </button>
  ));
  const fontPicker = picker('font', 'Subtitle font', selectedFont?.label ?? subtitleFont);
  const edgePicker = picker('edge', 'Subtitle edge style', selectedEdge?.label ?? subtitleEdge);

  return (
    <div className={compact ? 'space-y-2' : 'space-y-4'}>
      <div
        aria-hidden='true'
        className={cn(
          // A dim film frame, not a swatch: soft vignette + faint horizon so the
          // sample text reads the way it will over real video.
          'relative flex items-center justify-center overflow-hidden rounded-lg bg-[#0b0b0d] px-3',
          compact ? 'h-11' : 'h-14 border border-white/[0.06]',
        )}
      >
        <span className='pointer-events-none absolute inset-0 bg-[radial-gradient(120%_140%_at_50%_-20%,rgba(255,255,255,0.09),transparent_62%)]' />
        <span className='pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-[linear-gradient(to_top,rgba(0,0,0,0.55),transparent)]' />
        <span
          className={cn('relative', compact ? 'text-[15px]' : 'text-[17px]')}
          style={previewStyle(
            subtitleFont,
            subtitleColor,
            subtitleEdge,
            subtitleBold,
            subtitleItalic,
          )}
        >
          Subtitles look like this
        </span>
      </div>
      {compact ? (
        <div className='grid grid-cols-[minmax(0,1.25fr)_minmax(0,0.85fr)_auto_auto] items-center gap-1.5'>
          {fontPicker}
          {edgePicker}
          {emphasisButtons}
        </div>
      ) : (
        <div className='grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-3'>
          <div className='min-w-0'>
            <p className={FIELD_LABEL_CLASS}>Font</p>
            {fontPicker}
          </div>
          <div className='min-w-0'>
            <p className={FIELD_LABEL_CLASS}>Edge</p>
            {edgePicker}
          </div>
          <div>
            <p className={FIELD_LABEL_CLASS}>Style</p>
            <div className='flex gap-2'>{emphasisButtons}</div>
          </div>
        </div>
      )}
      <div
        className={cn(
          'grid transition-[grid-template-rows,margin-top] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          menuOpen
            ? compact
              ? 'mt-2 grid-rows-[1fr]'
              : 'mt-2.5 grid-rows-[1fr]'
            : 'mt-0 grid-rows-[0fr]',
        )}
      >
        <div className='min-h-0 overflow-hidden' inert={!menuOpen || disabled}>
          {menu === 'font' ? (
            <OptionList
              compact={compact}
              label='Subtitle font'
              value={subtitleFont}
              options={SUBTITLE_FONT_OPTIONS}
              onChange={(value) => {
                onPatch({ subtitleFont: value });
                closeMenu();
              }}
            />
          ) : (
            <OptionList
              compact={compact}
              label='Subtitle edge style'
              value={subtitleEdge}
              options={SUBTITLE_EDGE_OPTIONS}
              onChange={(value) => {
                onPatch({ subtitleEdge: value });
                closeMenu();
              }}
            />
          )}
        </div>
      </div>
      <div>
        {!compact && <p className={FIELD_LABEL_CLASS}>Color</p>}
        <div
          role='group'
          aria-label='Subtitle color'
          className={cn('flex flex-wrap items-center', compact ? 'gap-1.5' : 'gap-2.5')}
        >
          {SUBTITLE_COLOR_OPTIONS.map((option) => {
            const isSelected = subtitleColor === option.value;
            return (
              <button
                key={option.value}
                type='button'
                aria-label={`Subtitle color: ${option.label}`}
                title={option.label}
                aria-pressed={isSelected}
                disabled={disabled}
                onClick={() => onPatch({ subtitleColor: option.value })}
                className={cn(
                  'cursor-pointer rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.35)] transition-[filter,box-shadow] duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-nav) disabled:cursor-wait disabled:opacity-35 motion-reduce:transition-none',
                  compact ? 'size-4' : 'size-6',
                  isSelected
                    ? 'ring-2 ring-white/85 ring-offset-2 ring-offset-zinc-950'
                    : 'hover:brightness-125',
                )}
                style={{ backgroundColor: option.hex }}
              />
            );
          })}
        </div>
      </div>
      <p
        className={cn(
          'leading-snug',
          compact
            ? 'text-[11px] text-zinc-500'
            : 'border-t border-white/[0.06] pt-3 text-[12px] text-zinc-400',
        )}
      >
        Plain-text subtitles only. Styled (ASS) subtitles keep their own look.
      </p>
    </div>
  );
}
