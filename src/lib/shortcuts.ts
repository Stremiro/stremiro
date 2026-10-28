// Player bindings are user-configurable and live in `player-keybindings.ts`;
// these tables are the fixed browse/calendar keys.
export interface ShortcutRow {
  label: string;
  keys: string[];
}

// Outside the player: global keys from `use-browse-hotkeys`, then the Home hero and collection selection.
export const BROWSE_SHORTCUTS: ShortcutRow[] = [
  { label: 'Search', keys: ['/', 'Ctrl+K'] },
  { label: 'Switch section', keys: ['Alt+1–5'] },
  { label: 'Back', keys: ['Esc', 'Alt+←'] },
  { label: 'Forward', keys: ['Alt+→'] },
  { label: 'Previous / next featured title', keys: ['←', '→'] },
  { label: 'Select all while selecting', keys: ['Ctrl+A'] },
];

// Page-local bindings from the Calendar page's keydown handler.
export const CALENDAR_SHORTCUTS: ShortcutRow[] = [
  { label: 'Previous / next month', keys: ['←', '→'] },
  { label: 'This month', keys: ['T'] },
];
