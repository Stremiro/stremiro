// Shared "does this element own its keys/pointer" predicates for the hotkey layers and drag/context-menu guards.

/** Elements that own text input — a focused one consumes keys itself. */
const EDITABLE_TARGET_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

/** Radix popper content mounts under this wrapper attribute — a focused layer owns its keys. */
export const RADIX_POPPER_CONTENT_SELECTOR = '[data-radix-popper-content-wrapper]';

/** An open Radix dialog/popover — the docked mini player is a persistent `[role="dialog"]` without `data-state`, so it never matches. */
export const OPEN_DIALOG_SELECTOR = '[role="dialog"][data-state="open"]';

/** Focus + select the Search page box (`data-search-input`); no-op off it. */
export function focusSearchInput(): void {
  const input = document.querySelector<HTMLInputElement>('[data-search-input]');
  input?.focus();
  input?.select();
}

/** Editable-text check; `extraSelector` folds in site-specific interactive targets (popper layers, mini-player controls). */
export function isEditableTarget(target: EventTarget | null, extraSelector?: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    !!target.closest(
      extraSelector ? `${EDITABLE_TARGET_SELECTOR}, ${extraSelector}` : EDITABLE_TARGET_SELECTOR,
    )
  );
}

export function isKeyCaptureTarget(target: EventTarget | null, key?: string): boolean {
  return (
    [target, document.activeElement].some(
      (element) => element instanceof Element && !!element.closest('[data-key-capture]'),
    ) ||
    (key === 'Escape' && document.querySelector('[data-escape-capture]') !== null)
  );
}

/** Run `onMounted` with the first `selector` match, retrying one frame for virtual rows. */
export function whenRowMounted(
  getContainer: () => ParentNode | null,
  selector: string,
  onMounted: (row: HTMLElement) => void,
): void {
  let retried = false;
  const attempt = () => {
    const row = getContainer()?.querySelector<HTMLElement>(selector);
    if (row) onMounted(row);
    else if (!retried) {
      retried = true;
      requestAnimationFrame(attempt);
    }
  };
  requestAnimationFrame(attempt);
}
