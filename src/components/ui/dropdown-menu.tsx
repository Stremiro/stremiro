import { Check, ChevronRight } from 'lucide-react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as React from 'react';

import { cn, POPOVER_MOTION_CLASS } from '@/lib/utils';

const DropdownMenu = DropdownMenuPrimitive.Root;

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border border-white/5 bg-zinc-950/80 backdrop-blur-xl p-1 text-zinc-100 shadow-2xl',
          POPOVER_MOTION_CLASS,
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        'relative flex cursor-default select-none items-center rounded-lg px-2 py-1.5 text-sm outline-hidden transition-colors focus:bg-white/10 focus:text-white data-disabled:pointer-events-none data-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

const DropdownMenuSub = DropdownMenuPrimitive.Sub;

/** Row that opens a nested submenu; opens on hover and ArrowRight per Radix defaults. */
function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={cn(
        'relative flex cursor-default select-none items-center rounded-lg px-2 py-1.5 text-sm outline-hidden transition-colors focus:bg-white/10 focus:text-white data-[state=open]:bg-white/10 data-[state=open]:text-white data-disabled:pointer-events-none data-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight aria-hidden='true' className='ml-auto h-3.5 w-3.5 shrink-0 opacity-60' />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        className={cn(
          'z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border border-white/5 bg-zinc-950/80 backdrop-blur-xl p-1 text-zinc-100 shadow-2xl',
          'data-[state=open]:animate-submenu-in data-[state=closed]:animate-surface-out motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

/** Single-choice menu row — the check doubles as its leading spacer so labels stay aligned. */
function RadioDropdownItem({
  checked,
  checkClassName,
  checkPosition = 'leading',
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuItem> & {
  checked: boolean;
  /** Tint/size overrides for the check glyph and its leading spacer. */
  checkClassName?: string;
  checkPosition?: 'leading' | 'trailing';
}) {
  const indicator = checked ? (
    <Check aria-hidden='true' className={cn('h-3.5 w-3.5 shrink-0', checkClassName)} />
  ) : checkPosition === 'leading' ? (
    <span aria-hidden='true' className={cn('w-3.5 shrink-0', checkClassName)} />
  ) : null;
  return (
    <DropdownMenuItem role='menuitemradio' aria-checked={checked} {...props}>
      {checkPosition === 'leading' && indicator}
      {children}
      {checkPosition === 'trailing' && indicator}
    </DropdownMenuItem>
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  RadioDropdownItem,
};
