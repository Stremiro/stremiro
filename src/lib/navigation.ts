import type { MouseEvent as ReactMouseEvent } from 'react';
import type { NavigateFunction, NavigateOptions, NavigationType, To } from 'react-router';

// Root binding avoids per-card router subscriptions during search URL updates.
let navigateFn: NavigateFunction | null = null;

export function bindAppNavigate(navigate: NavigateFunction | null): void {
  navigateFn = navigate;
}

// Read at gesture time without subscribing to location.
export function currentPathWithSearch(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function navigateTo(to: To | number, options?: NavigateOptions): boolean {
  if (navigateFn === null) return false;
  if (typeof to === 'number') {
    navigateFn(to);
  } else {
    navigateFn(to, options);
  }
  return true;
}

export function navigateApp(to: To | number, options?: NavigateOptions): boolean {
  return navigateTo(to, options);
}

// Deep links fall back to home when there is no previous app entry.
export function navigateAppBack(): boolean {
  const index = window.history.state?.idx;
  if (typeof index !== 'number') return false;
  if (index === 0) {
    return window.location.pathname !== '/' && navigateTo('/', { replace: true });
  }
  return navigateTo(-1);
}

// The root location effect feeds this bounded mirror, including forward entries.
const entryStack: { key: string; path: string }[] = [];
const ENTRY_MEMORY_MAX = 128;
let entryIndex = -1;

export function recordLocationEntry(key: string, path: string, action: NavigationType): void {
  if (action === 'POP') {
    const index = entryStack.findIndex((entry) => entry.key === key);
    // Unseen entries have no provable predecessor.
    if (index >= 0) {
      entryIndex = index;
    } else {
      entryStack.length = 0;
      entryStack.push({ key, path });
      entryIndex = 0;
    }
  } else if (action === 'REPLACE' && entryIndex >= 0) {
    entryStack[entryIndex] = { key, path };
  } else {
    entryStack.length = entryIndex + 1;
    entryStack.push({ key, path });
    entryIndex = entryStack.length - 1;
  }

  if (entryStack.length > ENTRY_MEMORY_MAX) {
    const removed = entryStack.length - ENTRY_MEMORY_MAX;
    entryStack.splice(0, removed);
    entryIndex -= removed;
  }

  // Discard a return payload that missed its landing.
  if (pendingDetailsReturn && pendingDetailsReturn.path !== path) {
    pendingDetailsReturn = null;
  }
}

// Undefined means the caller needs an explicit fallback.
export function pathBelowTop(): string | undefined {
  return entryIndex > 0 ? entryStack[entryIndex - 1].path : undefined;
}

// POP cannot carry state; the player hands its details return payload through this slot.
let pendingDetailsReturn: { path: string; state: unknown } | null = null;

export function stashDetailsReturnState(path: string, state: unknown): void {
  pendingDetailsReturn = { path, state };
}

export function takeDetailsReturnState(path: string): unknown {
  if (pendingDetailsReturn?.path !== path) return undefined;
  const { state } = pendingDetailsReturn;
  pendingDetailsReturn = null;
  return state;
}

// Preserve native modified clicks; false leaves navigation to the caller/browser.
export function navigateOnAnchorClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
  to: To,
  options?: NavigateOptions,
): boolean {
  if (
    navigateFn === null ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey
  ) {
    return false;
  }

  event.preventDefault();
  return navigateTo(to, options);
}
