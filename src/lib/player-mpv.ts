import { invoke } from '@tauri-apps/api/core';
import type { MpvConfig, MpvObservableProperty } from 'tauri-plugin-libmpv-api';

import type { Track } from '@/lib/player-track-utils';

// `time-pos` and `demuxer-cache-time` are deliberately NOT observed: mpv emits
// a property-change per rendered frame — every emission is a spawn + parse +
// dispatch on the Rust side. The lifecycle polls both on a ~300ms interval
// instead, trading ~100+ IPC dispatches/s for two small reads.
const BASE_PLAYER_OBSERVED_PROPERTIES = [
  ['pause', 'flag'],
  ['duration', 'double', 'none'],
  ['volume', 'double'],
  ['mute', 'flag'],
  ['eof-reached', 'flag'],
  ['idle-active', 'flag'],
  ['speed', 'double'],
  ['core-idle', 'flag'],
  ['paused-for-cache', 'flag'],
] as const satisfies MpvObservableProperty[];

const TRACK_REFRESH_OBSERVED_PROPERTIES = [
  ['current-tracks/audio/id', 'int64', 'none'],
  ['current-tracks/sub/id', 'int64', 'none'],
] as const satisfies MpvObservableProperty[];

// mpv IPC goes through the allowlisted `player_mpv_*` commands, not the
// plugin's raw permissions — the webview only reaches the verbs and
// properties the backend admits.
export function mpvCommand(
  name: string,
  args: readonly (string | number | boolean)[] = [],
): Promise<void> {
  return invoke('player_mpv_command', { name, args: [...args] });
}

export function mpvInit(config: MpvConfig): Promise<string> {
  return invoke('player_mpv_init', {
    mpvConfig: {
      ...config,
      observedProperties: config.observedProperties
        ? Object.fromEntries(config.observedProperties)
        : {},
    },
  });
}

function mpvGetProperty<T>(
  name: string,
  format: 'int64' | 'string' | 'flag' | 'double',
): Promise<T | null> {
  return invoke<T | null>('player_mpv_get_property', { name, format });
}

const PLAYER_MPV_OBSERVED_PROPERTIES = [
  ...BASE_PLAYER_OBSERVED_PROPERTIES,
  ...TRACK_REFRESH_OBSERVED_PROPERTIES,
] as const satisfies MpvObservableProperty[];

const TRACK_REFRESH_PROPERTY_NAMES = new Set<string>(
  TRACK_REFRESH_OBSERVED_PROPERTIES.map(([name]) => name),
);

const NETWORK_CACHE_OPTIONS = {
  cache: 'auto',
  'cache-secs': 12,
  'demuxer-max-bytes': '96MiB',
  'demuxer-max-back-bytes': '24MiB',
} as const;

interface BuildPlayerMpvConfigOptions {
  initialVolume: number;
  startPaused: boolean;
  /** Prebuilt `alang`/`slang`/selection options from
      `api.getMpvLanguageSelectionOptions` — Rust owns the language table. */
  languageSelectionOptions?: Record<string, string>;
}

export function buildPlayerMpvConfig({
  initialVolume,
  startPaused,
  languageSelectionOptions,
}: BuildPlayerMpvConfigOptions): MpvConfig {
  return {
    initialOptions: {
      vo: 'gpu-next',
      hwdec: 'auto-safe',
      'gpu-api': 'd3d11',
      'gpu-context': 'd3d11',
      'keep-open': 'yes',
      volume: initialVolume.toString(),
      pause: startPaused ? 'yes' : 'no',
      osc: 'no',
      'osd-level': '0',
      'input-default-bindings': 'no',
      'input-builtin-bindings': 'no',
      'load-scripts': 'no',
      'load-stats-overlay': 'no',
      'load-console': 'no',
      'load-commands': 'no',
      'load-select': 'no',
      'load-positioning': 'no',
      'load-context-menu': 'no',
      'load-auto-profiles': 'no',
      'resume-playback': 'no',
      'save-position-on-quit': 'no',
      ytdl: 'no',
      'msg-level': 'all=warn',
      ...NETWORK_CACHE_OPTIONS,
      ...languageSelectionOptions,
    },
    observedProperties: PLAYER_MPV_OBSERVED_PROPERTIES,
  };
}

export function isPlayerTrackRefreshProperty(name: string): boolean {
  return TRACK_REFRESH_PROPERTY_NAMES.has(name);
}

// `set_property` rejects on some mpv builds; the `set` command is the fallback.
export async function setMpvProperty(
  name: string,
  value: string | number | boolean,
): Promise<void> {
  try {
    await invoke('player_mpv_set_property', { name, value });
  } catch {
    await mpvCommand('set', [name, String(value)]);
  }
}

/** `cycle` steps aid/sid to the next track — the hotkey path's switch write.
    Resolves after mpv applies the selection, so a follow-up read reports the
    landed id. */
export async function cycleMpvTrack(type: 'audio' | 'sub'): Promise<void> {
  await mpvCommand('cycle', [type === 'audio' ? 'aid' : 'sub']);
}

/** mpv `sub-add <url> [flags [title [lang]]]` — `lang` is appended only when
    present. Resolves when mpv accepts the command; the track lands in
    `track-list` only after mpv fetches it. */
export async function addSubtitleTrack(url: string, title: string, lang?: string): Promise<void> {
  const args = [url, 'select', title];
  const normalizedLang = lang?.trim();
  if (normalizedLang) args.push(normalizedLang);
  await mpvCommand('sub-add', args);
}

/** Max addon header entries forwarded to mpv. Mirrors the backend bound. */
const MAX_PLAYER_HTTP_HEADER_FIELDS = 8;

function escapeMpvHeaderFieldListValue(value: string): string {
  // mpv string-list: `,` separates, `\` escapes. Backslashes first.
  return value.replace(/\\/g, '\\\\').replace(/,/g, '\\,');
}

/** Bounded addon headers for mpv `http-header-fields`. Secrets: never log. */
export function formatPlayerHttpHeaderFields(
  headers?: readonly (readonly [string, string])[] | null,
): string | undefined {
  if (!headers || headers.length === 0) return undefined;

  const fields: string[] = [];
  for (const entry of headers) {
    if (fields.length >= MAX_PLAYER_HTTP_HEADER_FIELDS) break;
    const [rawName, rawValue] = entry;
    const name = rawName?.trim();
    const value = rawValue?.trim();
    // Re-check CR/LF here so a malformed IPC payload cannot split the list.
    if (!name || !value) continue;
    if (name.includes('\r') || name.includes('\n')) continue;
    if (value.includes('\r') || value.includes('\n')) continue;
    fields.push(`${escapeMpvHeaderFieldListValue(name)}: ${escapeMpvHeaderFieldListValue(value)}`);
  }

  return fields.length > 0 ? fields.join(',') : undefined;
}

async function readMpvProperty<T>(
  name: string,
  format: 'int64' | 'string' | 'flag' | 'double',
): Promise<T | null> {
  try {
    return await mpvGetProperty<T | null>(name, format);
  } catch {
    return null;
  }
}

/** One IPC reads both playhead seconds and demuxer cache ahead. Individual
    unavailable properties remain null; IPC failure is a silent no-op during
    teardown. */
export async function readPlaybackPositionProbe(): Promise<{
  timePos: number | null;
  bufferedAhead: number | null;
}> {
  try {
    return await invoke('player_mpv_get_playback_position');
  } catch {
    return { timePos: null, bufferedAhead: null };
  }
}

// Single-id poll for switch confirmation: 1 IPC vs a full list read.
// Throws on IPC failure so callers retry; genuine "off" resolves to null.
export async function readSelectedTrackId(type: 'audio' | 'sub'): Promise<number | null> {
  return mpvGetProperty<number | null>(`current-tracks/${type}/id`, 'int64');
}

/** Poll the count alone — 1 IPC — for callers waiting on track-list growth. */
export function readPlayerTrackCount(): Promise<number | null> {
  return readMpvProperty<number>('track-list/count', 'int64');
}

export function readPlayerTrackList(
  // Observed ids skip two native property reads.
  observedIds?: {
    audio: number | null;
    sub: number | null;
  },
): Promise<Track[]> {
  // Let the controller preserve its last list on IPC failure.
  return invoke<Track[]>('read_player_track_list', {
    observedIds: observedIds ?? null,
  });
}
