import { LayoutGrid, List, type LucideIcon } from 'lucide-react';
import { handleRadioGroupKeyDown } from '@/lib/dom';
import { cn } from '@/lib/utils';

const SEGMENTED_FOCUS_RING_CLASS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30';

export function SegmentPill({
  index,
  count,
  inset,
  className,
}: {
  index: number;
  count: number;
  inset: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden='true'
      className={cn(
        'nav-sliding-pill pointer-events-none absolute rounded-sm bg-(--accent-nav)',
        className,
      )}
      style={{
        top: inset,
        bottom: inset,
        left: inset,
        width: `calc((100% - ${inset * 2}px) / ${count})`,
        transform: `translateX(${index * 100}%)`,
      }}
    />
  );
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  compact = false,
}: {
  label: string;
  value: T;
  options: readonly {
    value: T;
    label: string;
    icon?: LucideIcon;
    /** Replaces the default unselected styling (e.g. a highlighted "new" option). */
    unselectedClassName?: string;
  }[];
  onChange: (value: T) => void;
  compact?: boolean;
}) {
  return (
    <div
      role='radiogroup'
      aria-label={label}
      className='relative isolate grid auto-cols-fr grid-flow-col p-0.5 rounded-md bg-white/[0.03] border border-white/[0.07] shrink-0'
    >
      <SegmentPill
        index={options.findIndex((option) => option.value === value)}
        count={options.length}
        inset={2}
      />
      {options.map((option) => {
        const Icon = option.icon;
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type='button'
            role='radio'
            aria-checked={selected}
            aria-label={Icon ? option.label : undefined}
            title={Icon ? option.label : undefined}
            tabIndex={selected ? 0 : -1}
            onKeyDown={handleRadioGroupKeyDown}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
            className={cn(
              'nav-switch-item relative z-10 flex items-center justify-center rounded-sm font-medium',
              compact ? 'h-7 text-[11px] tabular-nums' : 'h-8 text-[12px]',
              Icon ? 'w-8' : compact ? 'px-2.5' : 'px-3',
              SEGMENTED_FOCUS_RING_CLASS,
              selected
                ? 'text-(--on-accent-nav)'
                : (option.unselectedClassName ?? 'text-zinc-400 hover:text-zinc-100'),
            )}
          >
            {Icon ? <Icon className='w-3.5 h-3.5' /> : option.label}
          </button>
        );
      })}
    </div>
  );
}

const VIEW_MODES: { value: 'grid' | 'list'; label: string; icon: LucideIcon }[] = [
  { value: 'grid', label: 'Grid view', icon: LayoutGrid },
  { value: 'list', label: 'List view', icon: List },
];

export function ViewToggle({
  viewMode,
  onChange,
}: {
  viewMode: 'grid' | 'list';
  onChange: (v: 'grid' | 'list') => void;
}) {
  return (
    <SegmentedControl
      label='Collection view'
      value={viewMode}
      options={VIEW_MODES}
      onChange={onChange}
    />
  );
}
