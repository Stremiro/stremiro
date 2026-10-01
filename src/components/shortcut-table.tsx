import type { ShortcutRow } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';

interface ShortcutTableProps {
  shortcuts: ShortcutRow[];
  className?: string;
}

// The shared label+kbd grid: settings sections pad it themselves, the
// player overlay drops it straight into a card.
export function ShortcutTable({ shortcuts, className }: ShortcutTableProps) {
  return (
    <div className={cn('grid gap-2 sm:grid-cols-2', className)}>
      {shortcuts.map(({ label, keys }) => (
        <div
          key={label}
          className='flex items-center justify-between gap-4 rounded-xl border border-white/[0.05] bg-white/[0.02] px-4 py-3'
        >
          <span className='text-[13.5px] font-medium text-zinc-200'>{label}</span>
          <div className='flex items-center gap-1.5'>
            {keys.map((key, i) => (
              <span key={`${label}-${key}`} className='flex items-center gap-1.5'>
                <kbd className='inline-flex h-7 min-w-[1.85rem] items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] px-2 font-mono text-[11px] font-medium text-zinc-200'>
                  {key}
                </kbd>
                {i < keys.length - 1 ? <span className='text-[11px] text-zinc-600'>/</span> : null}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
