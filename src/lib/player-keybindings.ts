import type { ShortcutRow } from '@/lib/shortcuts';

// Display order; ids mirror
// `PLAYER_KEYBINDING_ACTIONS` in `src-tauri/src/commands/config_store/keybindings.rs`.
export const PLAYER_ACTION_GROUPS = ['Playback', 'Sound & subtitles', 'Window & panels'] as const;

export const PLAYER_ACTIONS = [
  { id: 'togglePlay', label: 'Play / Pause', group: 'Playback' },
  { id: 'seekBackward', label: 'Back 10 s', group: 'Playback', repeat: true },
  { id: 'seekForward', label: 'Forward 10 s', group: 'Playback', repeat: true },
  { id: 'skipSegment', label: 'Skip intro / recap', group: 'Playback' },
  { id: 'previousEpisode', label: 'Previous episode', group: 'Playback' },
  { id: 'nextEpisode', label: 'Next episode', group: 'Playback' },
  { id: 'speedDown', label: 'Slower', group: 'Playback', repeat: true },
  { id: 'speedUp', label: 'Faster', group: 'Playback', repeat: true },
  { id: 'speedReset', label: 'Normal speed', group: 'Playback' },
  { id: 'volumeUp', label: 'Volume up', group: 'Sound & subtitles', repeat: true },
  { id: 'volumeDown', label: 'Volume down', group: 'Sound & subtitles', repeat: true },
  { id: 'toggleMute', label: 'Mute', group: 'Sound & subtitles' },
  { id: 'cycleAudio', label: 'Next audio track', group: 'Sound & subtitles' },
  { id: 'cycleSubtitles', label: 'Next subtitles', group: 'Sound & subtitles' },
  { id: 'subtitleEarlier', label: 'Subtitles earlier', group: 'Sound & subtitles', repeat: true },
  { id: 'subtitleLater', label: 'Subtitles later', group: 'Sound & subtitles', repeat: true },
  { id: 'toggleFullscreen', label: 'Fullscreen', group: 'Window & panels' },
  { id: 'episodes', label: 'Episodes', group: 'Window & panels' },
  { id: 'streamSelector', label: 'Streams', group: 'Window & panels' },
  { id: 'dock', label: 'Mini player', group: 'Window & panels' },
  { id: 'shortcuts', label: 'Shortcuts', group: 'Window & panels' },
] as const satisfies readonly {
  id: string;
  label: string;
  group: (typeof PLAYER_ACTION_GROUPS)[number];
  repeat?: boolean;
}[];

export type PlayerActionId = (typeof PLAYER_ACTIONS)[number]['id'];
export const MAX_KEYS_PER_PLAYER_ACTION = 2;

const REPEATABLE_ACTIONS = new Set<PlayerActionId>(
  PLAYER_ACTIONS.filter((action) => 'repeat' in action && action.repeat).map((action) => action.id),
);

export interface PlayerKeymap {
  /** Lowercased `KeyboardEvent.key` → action. */
  byKey: ReadonlyMap<string, PlayerActionId>;
  keys: Readonly<Record<PlayerActionId, readonly string[]>>;
  overrides: Readonly<Record<string, string[]>>;
}

export function createPlayerKeymap(
  bindings: Readonly<Record<string, string[]>>,
  overrides: Readonly<Record<string, string[]>>,
): PlayerKeymap {
  const byKey = new Map<string, PlayerActionId>();
  const keys = {} as Record<PlayerActionId, string[]>;
  for (const action of PLAYER_ACTIONS) {
    keys[action.id] = bindings[action.id] ?? [];
    for (const key of keys[action.id]) byKey.set(key, action.id);
  }
  return { byKey, keys, overrides };
}

export function isRepeatablePlayerAction(action: PlayerActionId): boolean {
  return REPEATABLE_ACTIONS.has(action);
}

const KEY_LABELS: Record<string, string> = {
  ' ': 'Space',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  pageup: 'Page Up',
  pagedown: 'Page Down',
};

const ARIA_KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  '+': 'plus',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  pageup: 'PageUp',
  pagedown: 'PageDown',
};

export function formatBindingKey(key: string): string {
  const known = KEY_LABELS[key];
  if (known) return known;
  if ([...key].length === 1 || /^f\d{1,2}$/.test(key)) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Primary key label for a control tooltip, e.g. `Mute (M)`; unbound actions get no hint. */
export function withShortcutHint(text: string, keymap: PlayerKeymap, action: PlayerActionId) {
  const primary = keymap.keys[action][0];
  return primary === undefined ? text : `${text} (${formatBindingKey(primary)})`;
}

export function ariaKeyShortcuts(keymap: PlayerKeymap, action: PlayerActionId) {
  const keys = keymap.keys[action];
  if (keys.length === 0) return undefined;
  return keys
    .map((key) => ARIA_KEY_NAMES[key] ?? (key.length === 1 ? key : formatBindingKey(key)))
    .join(' ');
}

export const FIXED_PLAYER_SHORTCUTS: ShortcutRow[] = [
  { label: 'Seek 5 s', keys: ['Shift+seek'] },
  { label: 'Jump to 0–90%', keys: ['0–9'] },
  { label: 'Volume', keys: ['Scroll'] },
  { label: 'Wheel seek', keys: ['Shift+Scroll'] },
  { label: 'Close panel / back', keys: ['Esc'] },
];

/** The live table for the `?` overlay — reflects the user's bindings. */
export function buildPlayerShortcutRows(keymap: PlayerKeymap): ShortcutRow[] {
  const rows: ShortcutRow[] = [];
  for (const action of PLAYER_ACTIONS) {
    const keys = keymap.keys[action.id];
    if (keys.length > 0) rows.push({ label: action.label, keys: keys.map(formatBindingKey) });
  }
  return [...rows, ...FIXED_PLAYER_SHORTCUTS];
}
