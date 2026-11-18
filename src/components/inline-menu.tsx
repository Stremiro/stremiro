import type { LucideIcon } from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { cn } from '@/lib/utils';

export const INLINE_MENU_EXIT_MS = 120;

type InlineMenuTarget =
  | { href: string; onSelect: (event: ReactMouseEvent<HTMLAnchorElement>) => void }
  | { href?: undefined; onSelect: (event: ReactMouseEvent<HTMLButtonElement>) => void };

type InlineMenuAction = InlineMenuTarget & {
  key: string;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  /** Back/cancel rows read quieter than the actions they return from. */
  muted?: boolean;
  destructive?: boolean;
  iconClassName?: string;
  onWarm?: () => void;
  /** Repeatable actions (reordering) leave the menu open. */
  keepOpen?: boolean;
};

interface InlineMenuProps {
  presence: { mounted: boolean; exiting: boolean };
  label: string;
  actions: readonly (InlineMenuAction | false | null | undefined)[];
  orientation?: 'vertical' | 'horizontal';
  layout?: 'overlay' | 'flow';
  className?: string;
  onAction?: () => void;
}

const ITEM_CLASS_NAME =
  'group/item flex items-center rounded-md font-medium text-zinc-300 transition-colors duration-150 hover:bg-white/[0.07] hover:text-white focus-visible:bg-white/[0.07] focus-visible:text-white focus-visible:outline-none aria-disabled:pointer-events-none aria-disabled:opacity-40 motion-reduce:transition-none';
const ORIENTATION_ITEM_CLASS_NAME = {
  vertical: 'min-h-0 w-full flex-1 gap-2.5 px-2.5 text-left text-[13px]',
  horizontal: 'h-8 shrink-0 gap-1.5 px-2.5 text-[12.5px]',
} as const;
const ICON_CLASS_NAME =
  'size-3.5 shrink-0 text-zinc-500 transition-colors duration-150 group-hover/item:text-zinc-200 group-focus-visible/item:text-zinc-200';

/** In-place action panel that fades over its host surface; hosts hide their own content while `presence.mounted`. */
export function InlineMenu({
  presence,
  label,
  actions,
  orientation = 'vertical',
  layout = 'overlay',
  className,
  onAction,
}: InlineMenuProps) {
  if (!presence.mounted) return null;
  const nextKey = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
  const previousKey = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const { key } = event;
    if (key !== nextKey && key !== previousKey && key !== 'Home' && key !== 'End') return;
    event.preventDefault();
    event.stopPropagation();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"])',
      ),
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      key === 'Home'
        ? items[0]
        : key === 'End'
          ? items.at(-1)
          : key === nextKey
            ? items[(index + 1) % items.length]
            : items.at(index < 0 ? -1 : index - 1);
    next?.focus();
  };

  return (
    <div
      data-inline-menu
      data-key-capture
      role='menu'
      tabIndex={-1}
      inert={presence.exiting}
      aria-label={label}
      aria-orientation={orientation}
      className={cn(
        'z-20 flex outline-none motion-reduce:animate-none',
        layout === 'flow' ? 'relative' : 'absolute inset-0',
        orientation === 'vertical'
          ? layout === 'flow'
            ? 'flex-col gap-0.5 p-1.5'
            : 'flex-col p-1'
          : 'items-center justify-center-safe gap-1 overflow-x-auto p-1.5',
        presence.exiting ? 'animate-surface-out' : 'animate-surface-in',
        className,
      )}
      onKeyDown={handleKeyDown}
    >
      {actions.map((action) => {
        if (!action) return null;
        const Icon = action.icon;
        const select = <T extends HTMLElement>(
          event: ReactMouseEvent<T>,
          onSelect: (event: ReactMouseEvent<T>) => void,
        ) => {
          if (action.disabled) {
            event.preventDefault();
            return;
          }
          onSelect(event);
          if (!action.keepOpen) onAction?.();
        };
        const itemProps = {
          role: 'menuitem',
          'aria-disabled': action.disabled || undefined,
          tabIndex: action.disabled ? -1 : undefined,
          className: cn(
            ITEM_CLASS_NAME,
            ORIENTATION_ITEM_CLASS_NAME[orientation],
            layout === 'flow' && 'min-h-9 flex-none gap-2.5 px-2.5 py-2 text-[13px] leading-5',
            action.muted && 'text-zinc-400',
            action.destructive && 'hover:text-red-300 focus-visible:text-red-300',
            layout === 'flow' && action.destructive && 'mt-1 text-red-300',
          ),
          onPointerEnter: action.onWarm,
          onFocus: action.onWarm,
        };
        const content = (
          <>
            <Icon
              aria-hidden='true'
              className={cn(
                ICON_CLASS_NAME,
                layout === 'flow' && 'size-4',
                action.destructive &&
                  'group-hover/item:text-red-300 group-focus-visible/item:text-red-300',
                action.iconClassName,
              )}
            />
            <span className={layout === 'flow' ? 'min-w-0 break-words' : 'truncate'}>
              {action.label}
            </span>
          </>
        );
        if (action.href !== undefined) {
          const { onSelect } = action;
          return (
            <a
              key={action.key}
              href={action.href}
              {...itemProps}
              onClick={(event) => select(event, onSelect)}
            >
              {content}
            </a>
          );
        }
        const { onSelect } = action;
        return (
          <button
            key={action.key}
            type='button'
            {...itemProps}
            onClick={(event) => select(event, onSelect)}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
