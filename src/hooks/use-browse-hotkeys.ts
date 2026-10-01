import { useEffect, useEffectEvent } from 'react';

import { isEditableTarget, OPEN_DIALOG_SELECTOR, RADIX_POPPER_CONTENT_SELECTOR } from '@/lib/dom';
import { navigateApp, navigateAppBack } from '@/lib/navigation';

// A focused floating layer owns its keys: dialogs, mounted Radix popper
// content, and the expanded media card (which swallows Esc to collapse).
// The docked mini player is a persistent [role="dialog"] — focus inside it
// belongs to the player's own keymap.
const OWNED_LAYER_SELECTOR = `[role="dialog"], ${RADIX_POPPER_CONTENT_SELECTOR}, [data-media-card-expanded]`;
// Document-level yield: an *open* dialog or mounted popper is a top layer
// regardless of where focus sits — never navigate out from under it.
const OPEN_LAYER_SELECTOR = `${OPEN_DIALOG_SELECTOR}, ${RADIX_POPPER_CONTENT_SELECTOR}`;

function isInsideOwnedLayer(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest(OWNED_LAYER_SELECTOR);
}

function hasOpenLayer(): boolean {
  return document.querySelector(OPEN_LAYER_SELECTOR) !== null;
}

function focusSearchInput(): void {
  const input = document.querySelector<HTMLInputElement>('[data-search-input]');
  input?.focus();
  input?.select();
}

/**
 * Global keyboard layer for browse pages — `/`/`Ctrl+K` jump to search and
 * `Esc`/`Backspace`/`Alt+←` are the app's back gesture (the player owns its
 * own hotkey map). Capture phase runs before Radix's document-level
 * listeners, so an open dialog/popper still shows in the DOM and we yield.
 */
export function useBrowseHotkeys() {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;

    const key = event.key.toLowerCase();
    const openSearch = () => {
      if (window.location.pathname === '/search') {
        // Already there: reflect-nav is a no-op, so re-focus the box.
        focusSearchInput();
        return;
      }
      navigateApp('/search');
    };

    // Cmd/Ctrl+K is the one owned chord — it jumps to search even from an
    // input. Everything else requires an unmodified non-editable keypress.
    if (key === 'k' && (event.ctrlKey || event.metaKey)) {
      if (event.altKey || event.shiftKey || hasOpenLayer()) return;
      event.preventDefault();
      if (!event.repeat) openSearch();
      return;
    }
    if ((key === 'arrowleft' || key === 'arrowright') && event.altKey) {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isEditableTarget(event.target) ||
        isInsideOwnedLayer(event.target) ||
        hasOpenLayer()
      ) {
        return;
      }
      event.preventDefault();
      if (!event.repeat) {
        if (key === 'arrowleft') navigateAppBack();
        else navigateApp(1);
      }
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
    if (isEditableTarget(event.target) || isInsideOwnedLayer(event.target)) return;

    switch (key) {
      case '/':
        if (hasOpenLayer()) return;
        event.preventDefault();
        openSearch();
        break;
      case 'backspace':
      case 'escape':
        if (hasOpenLayer()) return;
        event.preventDefault();
        navigateAppBack();
        break;
    }
  });

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
    // Effect event: the listener binds once and always reads fresh state.
  }, []);
}
