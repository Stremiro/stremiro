import { useEffect, useEffectEvent } from 'react';

import {
  focusSearchInput,
  isEditableTarget,
  isKeyCaptureTarget,
  OPEN_DIALOG_SELECTOR,
  RADIX_POPPER_CONTENT_SELECTOR,
} from '@/lib/dom';
import { navigateApp, navigateBack, navigateForward } from '@/lib/navigation';
import { lastSearchPath } from '@/lib/search-page-state';

// A focused floating layer owns its keys — includes the docked mini player's [role="dialog"], whose keys belong to the player keymap.
const OWNED_LAYER_SELECTOR = `[role="dialog"], ${RADIX_POPPER_CONTENT_SELECTOR}, [data-media-card-expanded]`;
// Document-level yield: an open dialog/popper is a top layer regardless of focus — never navigate out from under it.
const OPEN_LAYER_SELECTOR = `${OPEN_DIALOG_SELECTOR}, ${RADIX_POPPER_CONTENT_SELECTOR}`;
const QUICK_SECTION_PATHS = ['/', '/search', '/calendar', '/library', '/settings'] as const;

function isInsideOwnedLayer(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest(OWNED_LAYER_SELECTOR);
}

function hasOpenLayer(): boolean {
  return document.querySelector(OPEN_LAYER_SELECTOR) !== null;
}

/** Browse shortcuts yield to editable targets and open layers; player routes own their controls. */
export function useBrowseHotkeys() {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      isKeyCaptureTarget(event.target, event.key) ||
      window.location.pathname.startsWith('/player')
    ) {
      return;
    }

    const key = event.key.toLowerCase();
    const openSearch = () => {
      if (window.location.pathname === '/search') {
        // Reflect-nav would be a no-op — re-focus the box instead.
        focusSearchInput();
        return;
      }
      navigateApp(lastSearchPath());
    };

    // Cmd/Ctrl+K works even from an input; everything else requires an unmodified non-editable keypress.
    if (key === 'k' && (event.ctrlKey || event.metaKey)) {
      if (event.altKey || event.shiftKey || hasOpenLayer()) return;
      event.preventDefault();
      if (!event.repeat) openSearch();
      return;
    }
    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      /^[1-5]$/.test(key)
    ) {
      if (isEditableTarget(event.target) || isInsideOwnedLayer(event.target) || hasOpenLayer()) {
        return;
      }
      event.preventDefault();
      const path = QUICK_SECTION_PATHS[Number(key) - 1];
      if (event.repeat) return;
      if (path === '/search') openSearch();
      else if (window.location.pathname !== path) navigateApp(path);
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
        if (key === 'arrowleft') navigateBack();
        else void navigateForward();
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
        navigateBack();
        break;
    }
  });

  const handleMouseNavigation = useEffectEvent((event: MouseEvent) => {
    if (
      window.location.pathname.startsWith('/player') ||
      (event.button !== 3 && event.button !== 4)
    ) {
      return;
    }
    event.preventDefault();
    if (event.type !== 'mouseup' || hasOpenLayer()) return;
    if (event.button === 3) navigateBack();
    else void navigateForward();
  });

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('mouseup', handleMouseNavigation, true);
    window.addEventListener('auxclick', handleMouseNavigation, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('mouseup', handleMouseNavigation, true);
      window.removeEventListener('auxclick', handleMouseNavigation, true);
    };
    // Effect event binds once and always reads fresh state.
  }, []);
}
