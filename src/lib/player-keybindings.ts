import type { ShortcutRow } from '@/lib/shortcuts';

// Order is conflict priority and display order; ids mirror
// `PLAYER_KEYBINDING_ACTIONS` in `src-tauri/src/commands/config_store.rs`.
// Keys are lowercased `KeyboardEvent.key` values (`' '` is Space).
export const PLAYER_ACTIONS = [
  { id: 'togglePlay', label: 'Play / Pause', defaultKeys: [' ', 'k'] },
  {
    id: 'seekBackward',
    label: 'Seek backward 10 s',
    defaultKeys: ['arrowleft', 'j'],
    repeat: true,
  },
  { id: 'seekForward', label: 'Seek forward 10 s', defaultKeys: ['arrowright', 'l'], repeat: true },
  { id: 'volumeUp', label: 'Volume up', defaultKeys: ['arrowup'], repeat: true },
  { id: 'volumeDown', label: 'Volume down', defaultKeys: ['arrowdown'], repeat: true },
  { id: 'toggleMute', label: 'Mute / Unmute', defaultKeys: ['m'] },
  { id: 'toggleFullscreen', label: 'Toggle fullscreen', defaultKeys: ['f'] },
  { id: 'frameBackward', label: 'Frame step back', defaultKeys: [','], repeat: true },
  { id: 'frameForward', label: 'Frame step forward', defaultKeys: ['.'], repeat: true },
  { id: 'speedDown', label: 'Slower playback', defaultKeys: ['['], repeat: true },
  { id: 'speedUp', label: 'Faster playback', defaultKeys: [']'], repeat: true },
  { id: 'speedReset', label: 'Reset speed to 1×', defaultKeys: ['\\'] },
  { id: 'cycleSubtitles', label: 'Cycle subtitles', defaultKeys: ['c'] },
  { id: 'cycleAudio', label: 'Cycle audio track', defaultKeys: ['a'] },
  { id: 'subtitleEarlier', label: 'Subtitle sync earlier', defaultKeys: ['z'], repeat: true },
  { id: 'subtitleLater', label: 'Subtitle sync later', defaultKeys: ['x'], repeat: true },
  { id: 'skipSegment', label: 'Skip intro / recap (when shown)', defaultKeys: ['s', 'enter'] },
  { id: 'nextEpisode', label: 'Next episode', defaultKeys: ['n'] },
  { id: 'episodes', label: 'Episodes panel', defaultKeys: ['e'] },
  { id: 'streamSelector', label: 'Choose stream / quality', defaultKeys: ['q'] },
  { id: 'dock', label: 'Dock to mini player', defaultKeys: ['i'] },
  { id: 'shortcuts', label: 'Keyboard shortcuts', defaultKeys: ['?'] },
] as const satisfies readonly {
  id: string;
  label: string;
  defaultKeys: readonly string[];
  repeat?: boolean;
}[];

export type PlayerActionId = (typeof PLAYER_ACTIONS)[number]['id'];
export const MAX_KEYS_PER_PLAYER_ACTION = 2;

const REPEATABLE_ACTIONS = new Set<PlayerActionId>(
  PLAYER_ACTIONS.filter((action) => 'repeat' in action && action.repeat).map((action) => action.id),
);

// Fixed meanings outside the rebindable table: Esc closes/backs out, digits seek by percent.
const RESERVED_KEYS = new Set([
  'escape',
  'tab',
  'shift',
  'control',
  'alt',
  'altgraph',
  'meta',
  'os',
  'capslock',
  'numlock',
  'dead',
  'process',
  'unidentified',
]);

export interface PlayerKeymap {
  /** Lowercased `KeyboardEvent.key` → action. */
  byKey: ReadonlyMap<string, PlayerActionId>;
  keys: Readonly<Record<PlayerActionId, readonly string[]>>;
  overrides: Readonly<Record<string, string[]>>;
}

/** Same rules as the Rust store; `null` = this key can't be bound. */
export function normalizeBindingKey(eventKey: string): string | null {
  if (eventKey === ' ') return eventKey;
  const key = eventKey.toLowerCase();
  const length = [...key].length;
  if (
    length === 0 ||
    length > 16 ||
    /[\s\p{Cc}]/u.test(key) ||
    /^[0-9]$/.test(key) ||
    RESERVED_KEYS.has(key)
  ) {
    return null;
  }
  return key;
}

// Overrides claim their keys first, so a default never steals a key the user moved.
export function resolvePlayerKeymap(overrides: Readonly<Record<string, string[]>>): PlayerKeymap {
  const byKey = new Map<string, PlayerActionId>();
  const keys = {} as Record<PlayerActionId, string[]>;
  const claim = (id: PlayerActionId, candidates: readonly string[]) => {
    keys[id] = candidates.filter((key) => !byKey.has(key));
    for (const key of keys[id]) byKey.set(key, id);
  };
  for (const action of PLAYER_ACTIONS) {
    const override = overrides[action.id];
    if (override) claim(action.id, override);
  }
  for (const action of PLAYER_ACTIONS) {
    if (!overrides[action.id]) claim(action.id, action.defaultKeys);
  }
  return { byKey, keys, overrides };
}

export function isRepeatablePlayerAction(action: PlayerActionId): boolean {
  return REPEATABLE_ACTIONS.has(action);
}

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((key, index) => key === b[index]);

/** Next override map after setting (or clearing, `key = null`) one slot of an action. */
export function bindPlayerKey(
  keymap: PlayerKeymap,
  action: PlayerActionId,
  slot: number,
  key: string | null,
): Record<string, string[]> {
  const updated = [...keymap.keys[action]];
  if (key === null) updated.splice(slot, 1);
  else if (slot < updated.length) updated[slot] = key;
  else updated.push(key);
  const nextKeys = [...new Set(updated)].slice(0, MAX_KEYS_PER_PLAYER_ACTION);

  const next: Record<string, string[]> = {};
  for (const [id, keys] of Object.entries(keymap.overrides)) {
    // A key moves, it isn't shared — strip it from any other override holding it.
    next[id] = key === null ? keys : keys.filter((existing) => existing !== key);
  }
  const definition = PLAYER_ACTIONS.find((candidate) => candidate.id === action);
  if (definition && sameKeys(nextKeys, definition.defaultKeys)) delete next[action];
  else next[action] = nextKeys;
  return next;
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
  { label: 'Fine seek 5 s', keys: ['Shift + seek key', 'Shift+Scroll'] },
  { label: 'Seek to % of duration', keys: ['0–9'] },
  { label: 'Volume', keys: ['Scroll'] },
  { label: 'Fullscreen', keys: ['Double-click'] },
  { label: 'Back / close panel', keys: ['Esc'] },
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
