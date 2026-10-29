import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { INLINE_MENU_EXIT_MS } from '@/components/inline-menu';
import { useDelayedUnmount } from '@/hooks/use-delayed-unmount';

const FIRST_ITEM_SELECTOR = '[data-inline-menu] [role="menuitem"]:not([aria-disabled="true"])';

interface InlineMenuOptions {
  rootRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
  /** Focus home when the menu closes over its own focus. */
  returnFocus: () => HTMLElement | null | undefined;
}

/** Right-click / menu-key toggle for an `InlineMenu` rendered inside `rootRef`. */
export function useInlineMenu({ rootRef, enabled = true, returnFocus }: InlineMenuOptions) {
  const [open, setOpen] = useState(false);
  const presence = useDelayedUnmount(open && enabled, INLINE_MENU_EXIT_MS);
  const openedByKeyboardRef = useRef(false);

  const close = useCallback(() => {
    const menu = rootRef.current?.querySelector('[data-inline-menu]');
    if (menu?.contains(document.activeElement)) {
      const target = returnFocus();
      if (target?.isConnected) target.focus({ preventScroll: true });
    }
    setOpen(false);
  }, [returnFocus, rootRef]);

  const toggle = (byKeyboard: boolean) => {
    if (open) {
      close();
      return;
    }
    openedByKeyboardRef.current = byKeyboard;
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!enabled) setOpen(false);
    if (!open || !enabled) return;
    // Pointer opens focus the panel so no row reads as preselected.
    const target = rootRef.current?.querySelector<HTMLElement>(
      openedByKeyboardRef.current ? FIRST_ITEM_SELECTOR : '[data-inline-menu]',
    );
    target?.focus({ preventScroll: true });
  }, [enabled, open, rootRef]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: Event) => {
      const boundary =
        event.type === 'focusin'
          ? rootRef.current?.querySelector('[data-inline-menu]')
          : rootRef.current;
      if (event.target instanceof Node && !boundary?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside);
    };
  }, [open, rootRef]);

  const rootProps = {
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      // Portaled descendants keep their own context menu.
      if (!enabled || !event.currentTarget.contains(event.target as Node)) return;
      event.preventDefault();
      // Keyboard-raised context menus already toggled on keydown.
      if (event.button === 2) toggle(false);
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!enabled) return;
      // Escape runs first: a host dialog may already have prevented it on our behalf.
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (
        !event.defaultPrevented &&
        (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) toggle(true);
      }
    },
    onPointerLeave: () => {
      if (open && !openedByKeyboardRef.current) close();
    },
  };

  return { presence, close, rootProps };
}
