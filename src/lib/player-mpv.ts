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

/** Rust changes and confirms selection under one native gate. */
export function changePlayerTrack(
  type: 'audio' | 'sub',
  target: number | 'no' | 'cycle',
): Promise<Track[]> {
  return invoke('player_mpv_change_track', { kind: type, target });
}

/** Rust downloads, fences playback changes, and returns the confirmed native track list. */
export function addSubtitleTrack(url: string, title: string, lang?: string): Promise<Track[]> {
  return invoke('player_mpv_add_subtitle', { url, title, lang });
}

export function seekAbsoluteSeconds(seconds: number): Promise<void> {
  return mpvCommand('seek', [seconds.toString(), 'absolute']);
}

export interface PlayerSeekTarget {
  seconds: number;
  startedAt: number;
  failed?: boolean;
}

interface PlaybackPositionProbe {
  timePos: number | null;
  bufferedAhead: number | null;
  nearCompletion: boolean;
  nextEpisodePrefetchDue: boolean;
  seekFailed: boolean;
  prematureEof: boolean;
}

/** One IPC reads playhead seconds + demuxer cache ahead; IPC failure is a silent no-op during teardown. */
export async function readPlaybackPositionProbe(
  durationSecs: number,
  seekTarget: PlayerSeekTarget | null,
  checkEof = false,
): Promise<PlaybackPositionProbe> {
  try {
    const { seekFailureWindowSecs, ...probe } = await invoke<
      Omit<PlaybackPositionProbe, 'seekFailed'> & { seekFailureWindowSecs: number | null }
    >('player_mpv_get_playback_position', {
      durationSecs,
      seekTargetSecs: seekTarget?.seconds ?? null,
      checkEof,
    });
    const seekFailed =
      seekTarget !== null &&
      seekFailureWindowSecs !== null &&
      (seekTarget.failed === true ||
        performance.now() - seekTarget.startedAt < seekFailureWindowSecs * 1000);
    return {
      ...probe,
      seekFailed,
      nearCompletion: !seekFailed && probe.nearCompletion,
      nextEpisodePrefetchDue: !seekFailed && probe.nextEpisodePrefetchDue,
    };
  } catch {
    return {
      timePos: null,
      bufferedAhead: null,
      nearCompletion: false,
      nextEpisodePrefetchDue: false,
      seekFailed: false,
      prematureEof: false,
    };
  }
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
