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

export function navigateApp(to: To | number, options?: NavigateOptions): boolean {
  if (navigateFn === null) return false;
  if (typeof to === 'number') {
    navigateFn(to);
  } else {
    navigateFn(to, options);
  }
  return true;
}

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
export function navigateBack(): boolean {
  if (!canNavigateAppBack()) return false;
  return window.history.state?.idx === 0 ? navigateApp('/', { replace: true }) : navigateApp(-1);
}

export function navigateForward(): boolean {
  return entryIndex < entryStack.length - 1 && navigateApp(1);
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

function isAppAnchorClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return (
    navigateFn !== null &&
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

// Preserve native modified clicks; false leaves navigation to the caller/browser.
export function navigateOnAnchorClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
  to: To,
  options?: NavigateOptions,
): boolean {
  if (!isAppAnchorClick(event)) return false;
  event.preventDefault();
  return navigateApp(to, options);
}

const DETAILS_SOURCE_TRANSITION = 'details-source';
const DETAILS_HERO_TRANSITION = 'details-hero';
// Warm opens claim the hero within a frame or two; cold opens skip the effect after this.
const DETAILS_HERO_WAIT_MS = 150;
let releaseDetailsHero: (() => void) | null = null;
let detailsHeroTarget: HTMLElement | null = null;
let activeDetailsTransition: ViewTransition | null = null;

// The docked mini player's native surface sits under the webview, so no snapshot crossfades over it.
function canMorphToDetails(): boolean {
  return (
    typeof document.startViewTransition === 'function' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
    !document.querySelector('[data-mini-video]')
  );
}

/** Opens details while the clicked artwork zooms through and the details hero settles in. */
export function navigateToDetails(
  event: ReactMouseEvent<HTMLAnchorElement>,
  to: To,
  options: NavigateOptions,
  artwork: HTMLElement | null | undefined,
): boolean {
  if (!artwork || !canMorphToDetails()) return navigateOnAnchorClick(event, to, options);
  if (!isAppAnchorClick(event)) return false;
  event.preventDefault();
  artwork.style.viewTransitionName = DETAILS_SOURCE_TRANSITION;
  const transition = document.startViewTransition(() => {
    artwork.style.viewTransitionName = '';
    // Shell chrome is named only in the new state so its groups paint above the hero.
    document.documentElement.toggleAttribute('data-vt-pin', true);
    navigateApp(to, options);
    return new Promise<void>((resolve) => {
      const release = () => {
        window.clearTimeout(timer);
        releaseDetailsHero = null;
        resolve();
      };
      // A stale new-state capture would play the effect over the old page and then pop the details
      // page in; skipping hands the entrance to the page's own fade instead.
      const timer = window.setTimeout(() => {
        transition.skipTransition();
        release();
      }, DETAILS_HERO_WAIT_MS);
      releaseDetailsHero = release;
    });
  });
  activeDetailsTransition = transition;
  transition.ready.catch(() => undefined);
  void transition.finished.finally(() => {
    if (activeDetailsTransition !== transition) return;
    activeDetailsTransition = null;
    document.documentElement.removeAttribute('data-vt-pin');
    if (detailsHeroTarget) detailsHeroTarget.style.viewTransitionName = '';
    detailsHeroTarget = null;
  });
  return true;
}

// Named only while a morph is pending, so a details-to-details click never captures two heroes.
export function claimDetailsHero(node: HTMLElement | null): void {
  if (!node || !releaseDetailsHero) return;
  node.style.viewTransitionName = DETAILS_HERO_TRANSITION;
  detailsHeroTarget = node;
  releaseDetailsHero();
}
