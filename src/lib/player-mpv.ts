import { invoke } from '@tauri-apps/api/core';
import type { VideoMarginRatio } from 'tauri-plugin-libmpv-api';
import type { Track } from '@/lib/player-track-utils';

// mpv IPC goes through the allowlisted `player_mpv_*` commands, not the
// plugin's raw permissions — the webview only reaches the verbs and
// properties the backend admits.
export function mpvCommand(
  name: string,
  args: readonly (string | number | boolean)[] = [],
): Promise<void> {
  return invoke('player_mpv_command', { name, args: [...args] });
}

/** Rust appends the `alang`/`slang`/selection options for these languages
    from the canonical language table. */
interface MpvInitOptions {
  initialVolume: number;
  initialMuted: boolean;
  startPaused: boolean;
  preferredAudioLanguage?: string;
  preferredSubtitleLanguage?: string;
}

export function mpvInit(options: MpvInitOptions): Promise<string> {
  return invoke('player_mpv_init', { ...options });
}

export function mpvDestroy(): Promise<void> {
  return invoke('player_mpv_destroy');
}

export function setVideoMarginRatio(ratio: VideoMarginRatio): Promise<void> {
  return invoke('player_mpv_set_video_margin_ratio', { ratio });
}

function mpvGetProperty<T>(
  name: string,
  format: 'int64' | 'string' | 'flag' | 'double',
): Promise<T | null> {
  return invoke<T | null>('player_mpv_get_property', { name, format });
}

export function isPlayerTrackRefreshProperty(name: string): boolean {
  return name === 'current-tracks/audio/id' || name === 'current-tracks/sub/id';
}

export function setMpvProperty(name: string, value: string | number | boolean): Promise<void> {
  return invoke('player_mpv_set_property', { name, value });
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
export async function readPlaybackPositionProbe(durationSecs: number): Promise<{
  timePos: number | null;
  bufferedAhead: number | null;
  nearCompletion: boolean;
}> {
  try {
    return await invoke('player_mpv_get_playback_position', { durationSecs });
  } catch {
    return { timePos: null, bufferedAhead: null, nearCompletion: false };
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
