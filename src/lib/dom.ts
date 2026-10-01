// Shared DOM-target predicates — one owner for the "does this element own
// its keys/pointer" checks the hotkey layers and app-level context-menu/drag
// guards all implement.

/** Elements that own text input — a focused one consumes keys itself. */
const EDITABLE_TARGET_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

/** Radix popper content (menus, dropdowns, popovers, tooltips) mounts under
    this wrapper attribute — a focused layer owns its own keys. */
export const RADIX_POPPER_CONTENT_SELECTOR = '[data-radix-popper-content-wrapper]';

/** An open Radix dialog or popover. The docked mini player is a persistent
    `[role="dialog"]` without `data-state`, so its presence alone never matches. */
export const OPEN_DIALOG_SELECTOR = '[role="dialog"][data-state="open"]';

/** True when the event target is editable text. `extraSelector` folds in
    site-specific interactive targets (popper layers, selectable regions,
    mini-player controls) without each caller re-listing the editable set. */
export function isEditableTarget(target: EventTarget | null, extraSelector?: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    !!target.closest(
      extraSelector ? `${EDITABLE_TARGET_SELECTOR}, ${extraSelector}` : EDITABLE_TARGET_SELECTOR,
    )
  );
}
