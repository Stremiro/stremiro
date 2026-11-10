import type { ShortcutRow } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';

const SHORTCUT_KEY_CLASS =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-white/[0.09] bg-white/[0.04] px-2 font-mono text-[12px] font-medium text-zinc-200 shadow-[inset_0_-1px_0_rgba(255,255,255,0.04)]';

export function ShortcutTable({
  shortcuts,
  className,
  idPrefix,
}: {
  shortcuts: ShortcutRow[];
  className?: string;
  idPrefix?: string;
}) {
  return (
    <dl className={cn('grid gap-x-8 @xl:grid-cols-2', className)}>
      {shortcuts.map(({ label, keys }, index) => (
        <div
          key={label}
          id={idPrefix ? `${idPrefix}-${index}` : undefined}
          className='flex h-9 items-center justify-between gap-4'
        >
          <dt className='truncate text-[13px] text-zinc-300'>{label}</dt>
          <dd className='flex shrink-0 items-center gap-1'>
            {keys.map((key) => (
              <kbd key={key} className={SHORTCUT_KEY_CLASS}>
                {key}
              </kbd>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}
