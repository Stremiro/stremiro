// Player bindings are user-configurable and live in `player-keybindings.ts`;
// these tables are the fixed browse/calendar keys.
export interface ShortcutRow {
  label: string;
  keys: string[];
}

// Global bindings from `use-browse-hotkeys` — active outside the player.
export const BROWSE_SHORTCUTS: ShortcutRow[] = [
  { label: 'Search', keys: ['/', 'Ctrl+K'] },
  { label: 'Switch section', keys: ['Alt+1–5'] },
  { label: 'Back', keys: ['Esc', 'Alt+←'] },
  { label: 'Forward', keys: ['Alt+→'] },
];

// Page-local bindings from the Calendar page's keydown handler.
export const CALENDAR_SHORTCUTS: ShortcutRow[] = [
  { label: 'Previous / next month', keys: ['←', '→'] },
  { label: 'This month', keys: ['T'] },
];
