import { invoke } from '@tauri-apps/api/core';
import type { VideoMarginRatio } from 'tauri-plugin-libmpv-api';
import type { SubtitleColor, SubtitleEdge, SubtitleFont } from '@/lib/api';
import type { Track } from '@/lib/player-track-utils';

// mpv IPC goes through the allowlisted `player_mpv_*` commands — the webview only reaches backend-admitted verbs/properties.
export function mpvCommand(
  name: string,
  args: readonly (string | number | boolean)[] = [],
): Promise<void> {
  return invoke('player_mpv_command', { name, args });
}

/** Rust appends `alang`/`slang`/selection options from the canonical language table. */
type MpvInitOptions = {
  initialVolume: number;
  initialMuted: boolean;
  startPaused: boolean;
  preferredAudioLanguage?: string;
  preferredSubtitleLanguage?: string;
};

export function mpvInit(options: MpvInitOptions): Promise<string> {
  return invoke('player_mpv_init', options);
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

export type MpvSubtitleProperties = readonly (readonly [string, number])[];

export function setMpvProperty(
  name: string,
  value: string | number | boolean,
): Promise<MpvSubtitleProperties> {
  return setMpvProperties([[name, value]]);
}

export function setMpvProperties(
  properties: readonly (readonly [string, string | number | boolean])[],
): Promise<MpvSubtitleProperties> {
  return invoke('player_mpv_set_properties', { properties });
}

/** Rust owns delay bounds and the fixed Night mode normalization filter. */
export function setMpvAudioSettings(settings: {
  audioDelay?: number;
  nightMode?: boolean;
}): Promise<void> {
  return invoke('player_mpv_set_audio_settings', settings);
}

/** Rust maps the choices to fixed subtitle properties outside the generic allowlist. */
export function setMpvSubtitleAppearance(appearance: {
  font: SubtitleFont;
  color: SubtitleColor;
  edge: SubtitleEdge;
  bold: boolean;
  italic: boolean;
}): Promise<void> {
  return invoke('player_mpv_set_subtitle_appearance', appearance);
}

/** `cycle` steps aid/sid — resolves after mpv applies, so a follow-up read reports the landed id. */
export function cycleMpvTrack(type: 'audio' | 'sub'): Promise<void> {
  return mpvCommand('cycle', [type === 'audio' ? 'aid' : 'sub']);
}

/** mpv `sub-add <url> [flags [title [lang]]]` — resolves at command accept; the track lands in `track-list` only after mpv fetches it. */
export async function addSubtitleTrack(url: string, title: string, lang?: string): Promise<void> {
  const args = [url, 'select', title];
  const normalizedLang = lang?.trim();
  if (normalizedLang) args.push(normalizedLang);
  await mpvCommand('sub-add', args);
}

export function seekAbsoluteSeconds(seconds: number): Promise<void> {
  return mpvCommand('seek', [seconds.toString(), 'absolute']);
}

/** One IPC reads playhead seconds + demuxer cache ahead; IPC failure is a silent no-op during teardown. */
export async function readPlaybackPositionProbe(durationSecs: number): Promise<{
  timePos: number | null;
  bufferedAhead: number | null;
  nearCompletion: boolean;
  nextEpisodePrefetchDue: boolean;
}> {
  try {
    return await invoke('player_mpv_get_playback_position', { durationSecs });
  } catch {
    return {
      timePos: null,
      bufferedAhead: null,
      nearCompletion: false,
      nextEpisodePrefetchDue: false,
    };
  }
}

// Single-id poll (1 IPC vs full list); throws on IPC failure so callers retry — genuine "off" is null.
export function readSelectedTrackId(type: 'audio' | 'sub'): Promise<number | null> {
  return mpvGetProperty<number | null>(`current-tracks/${type}/id`, 'int64');
}

/** Poll the count alone — 1 IPC — for callers waiting on track-list growth. */
export function readPlayerTrackCount(): Promise<number | null> {
  return mpvGetProperty<number>('track-list/count', 'int64').catch(() => null);
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
