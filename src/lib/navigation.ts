import { type MouseEvent as ReactMouseEvent, useSyncExternalStore } from 'react';
import type { NavigateFunction, NavigateOptions, NavigationType, To } from 'react-router';
import { createSubscribableStore } from '@/lib/subscribable-store';

// Root binding avoids per-card router subscriptions during search URL updates.
let navigateFn: NavigateFunction | null = null;

export function bindAppNavigate(navigate: NavigateFunction | null): void {
  navigateFn = navigate;
  notifyHistoryListeners();
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

export const navigateApp = navigateTo;

export const boundNavigate: NavigateFunction = (to: To | number, options?: NavigateOptions) => {
  navigateApp(to, options);
};

function canNavigateAppBack(): boolean {
  const index = window.history.state?.idx;
  return (
    navigateFn !== null &&
    typeof index === 'number' &&
    (index !== 0 || window.location.pathname !== '/')
  );
}

// Deep links fall back to home when there is no previous app entry.
export function navigateAppBack(): boolean {
  if (!canNavigateAppBack()) return false;
  return window.history.state?.idx === 0 ? navigateTo('/', { replace: true }) : navigateTo(-1);
}

export const navigateBack = navigateAppBack;

export function navigateForward(): boolean {
  return entryIndex < entryStack.length - 1 && navigateTo(1);
}

// The root location effect feeds this bounded mirror, including forward entries.
const entryStack: { key: string; path: string }[] = [];
const ENTRY_MEMORY_MAX = 128;
let entryIndex = -1;
const EMPTY_HISTORY_STATE = { canGoBack: false, canGoForward: false };
const historyStore = createSubscribableStore(EMPTY_HISTORY_STATE);

function notifyHistoryListeners(): void {
  const canGoBack = canNavigateAppBack();
  const canGoForward = entryIndex >= 0 && entryIndex < entryStack.length - 1;
  const historyState = historyStore.getSnapshot();
  if (historyState.canGoBack === canGoBack && historyState.canGoForward === canGoForward) return;
  historyStore.publish({ canGoBack, canGoForward });
}

export function useNavigationHistoryState(): {
  canGoBack: boolean;
  canGoForward: boolean;
} {
  return useSyncExternalStore(
    historyStore.subscribe,
    historyStore.getSnapshot,
    () => EMPTY_HISTORY_STATE,
  );
}

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
  notifyHistoryListeners();
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
