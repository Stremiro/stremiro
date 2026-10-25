import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import * as React from 'react';
import { cn, POPOVER_MOTION_CLASS } from '@/lib/utils';

const ContextMenu = ContextMenuPrimitive.Root;

function ContextMenuTrigger({
  onKeyDown,
  disabled,
  ref,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return (
    <ContextMenuPrimitive.Trigger
      ref={ref}
      disabled={disabled}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          disabled ||
          event.defaultPrevented ||
          !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        // Radix anchors on contextmenu coordinates; keyboard invocation needs a row-local anchor.
        const rect = event.currentTarget.getBoundingClientRect();
        event.currentTarget.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          }),
        );
      }}
      {...props}
    />
  );
}

function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-player-interactive
        className={cn(
          'z-80 min-w-[8rem] cursor-auto origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-xl border border-white/5 bg-zinc-950/80 backdrop-blur-xl p-1 text-zinc-100 shadow-2xl',
          POPOVER_MOTION_CLASS,
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item>) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-hidden transition-colors focus:bg-white/10 focus:text-white data-disabled:pointer-events-none data-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger };
