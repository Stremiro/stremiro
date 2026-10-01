// One owner for the key tables: the settings page and the player's `?`
// overlay render from the same rows so docs can't drift from the bindings.
export interface ShortcutRow {
  label: string;
  keys: string[];
}

export const PLAYER_SHORTCUTS: ShortcutRow[] = [
  { label: 'Play / Pause', keys: ['Space', 'K'] },
  { label: 'Seek backward 10 s', keys: ['←', 'J'] },
  { label: 'Seek forward 10 s', keys: ['→', 'L'] },
  { label: 'Seek 5 s', keys: ['Shift+←', 'Shift+→', 'Shift+Scroll'] },
  { label: 'Seek to % of duration', keys: ['0–9'] },
  { label: 'Frame step back / forward', keys: [',', '.'] },
  { label: 'Playback speed', keys: ['[', ']'] },
  { label: 'Reset playback speed to 1×', keys: ['\\'] },
  { label: 'Volume', keys: ['↑', '↓', 'Scroll'] },
  { label: 'Mute / Unmute', keys: ['M'] },
  { label: 'Cycle subtitles', keys: ['C'] },
  { label: 'Cycle audio track', keys: ['A'] },
  { label: 'Subtitle sync earlier / later', keys: ['Z', 'X'] },
  { label: 'Skip segment (when shown)', keys: ['S', 'Enter'] },
  { label: 'Episodes panel', keys: ['E'] },
  { label: 'Next episode', keys: ['N'] },
  { label: 'Choose stream / quality', keys: ['Q'] },
  { label: 'Dock to mini player', keys: ['I'] },
  { label: 'Toggle fullscreen', keys: ['F', 'Double-click'] },
  { label: 'Keyboard shortcuts', keys: ['?'] },
  { label: 'Back / close panel', keys: ['Esc'] },
];

// Global bindings from `use-browse-hotkeys` — active on every page outside
// the player.
export const BROWSE_SHORTCUTS: ShortcutRow[] = [
  { label: 'Jump to search', keys: ['/', 'Ctrl+K'] },
  { label: 'Back', keys: ['Esc', 'Backspace', 'Alt+←'] },
  { label: 'Forward', keys: ['Alt+→'] },
];
