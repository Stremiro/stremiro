import type { SubtitleColor, SubtitleEdge, SubtitleFont, TrackLanguageCandidate } from '@/lib/api';

// Labels/buttons preview with the same family Rust hands to mpv. The stacks list
// a modern Windows face first and fall back to what ships with the OS, so the
// preview never lies about the result.
export const SUBTITLE_FONT_OPTIONS: readonly {
  value: SubtitleFont;
  label: string;
  fontFamily?: string;
}[] = [
  { value: 'default', label: 'Default' },
  {
    value: 'modern',
    label: 'Modern',
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
  },
  { value: 'grotesk', label: 'Grotesk', fontFamily: "'Segoe UI Variable Display', 'Segoe UI'" },
  { value: 'humanist', label: 'Humanist', fontFamily: "'Corbel', 'Calibri', sans-serif" },
  { value: 'classic', label: 'Classic', fontFamily: "'Trebuchet MS', 'Segoe UI', sans-serif" },
  {
    value: 'screen',
    label: 'Screen',
    fontFamily: "'Franklin Gothic Medium', 'Franklin Gothic', 'Segoe UI', sans-serif",
  },
  { value: 'serif', label: 'Serif', fontFamily: "'Cambria', Georgia, serif" },
  { value: 'book', label: 'Book', fontFamily: "'Palatino Linotype', Palatino, serif" },
  { value: 'rounded', label: 'Rounded', fontFamily: "'Candara', 'Segoe UI', sans-serif" },
  { value: 'mono', label: 'Mono', fontFamily: "'Cascadia Mono', Consolas, monospace" },
];

// hex mirrors the sub-color Rust sets, for swatches and previews.
export const SUBTITLE_COLOR_OPTIONS: readonly {
  value: SubtitleColor;
  label: string;
  hex: string;
}[] = [
  { value: 'white', label: 'White', hex: '#ffffff' },
  { value: 'ivory', label: 'Ivory', hex: '#fff4d6' },
  { value: 'lavender', label: 'Lavender', hex: '#e3d5ff' },
  { value: 'mint', label: 'Mint', hex: '#c4f0d9' },
  { value: 'amber', label: 'Amber', hex: '#ffd89b' },
  { value: 'gray', label: 'Gray', hex: '#d4d4d4' },
  { value: 'yellow', label: 'Yellow', hex: '#ffe000' },
  { value: 'cyan', label: 'Cyan', hex: '#00e5ff' },
  { value: 'green', label: 'Green', hex: '#66ff66' },
  { value: 'red', label: 'Red', hex: '#ff5147' },
  { value: 'orange', label: 'Orange', hex: '#ffa14d' },
  { value: 'blue', label: 'Blue', hex: '#57a8ff' },
  { value: 'pink', label: 'Pink', hex: '#ff7ac6' },
];

export const SUBTITLE_EDGE_OPTIONS: readonly { value: SubtitleEdge; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'outline', label: 'Outline' },
  { value: 'thick', label: 'Thick' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'box', label: 'Box' },
];

export interface Track {
  id: number;
  type: 'video' | 'audio' | 'sub';
  displayLabel: string;
  lang?: string;
  title?: string;
  selected?: boolean;
  defaultTrack?: boolean;
  forced?: boolean;
  hearingImpaired?: boolean;
  /** True for `sub-add`-loaded tracks; `externalFilename` carries the URL. */
  external?: boolean;
  externalFilename?: string;
}

export function toTrackLanguageCandidate(track: Track): TrackLanguageCandidate {
  return {
    id: track.id,
    lang: track.lang,
    title: track.title,
    defaultTrack: track.defaultTrack,
    forced: track.forced,
    hearingImpaired: track.hearingImpaired,
  };
}

function trackFingerprintFields(track: Track, includeSelected: boolean): Array<number | string> {
  const fields: Array<number | string> = [
    track.id,
    track.displayLabel,
    (track.lang ?? '').trim().toLowerCase(),
    track.title?.trim().toLowerCase() ?? '',
  ];
  if (includeSelected) fields.push(track.selected ? '1' : '0');
  fields.push(
    track.defaultTrack ? '1' : '0',
    track.forced ? '1' : '0',
    track.hearingImpaired ? '1' : '0',
  );
  return fields;
}

export function buildTrackLanguageCandidateFingerprint(track: Track | null): string {
  return track ? JSON.stringify(trackFingerprintFields(track, false)) : '';
}

export function buildTrackAutoApplyFingerprint(preferredLanguage: string, tracks: Track[]): string {
  return JSON.stringify([
    preferredLanguage,
    tracks.map((track) => trackFingerprintFields(track, true)),
  ]);
}

/** Prefer mpv's external filename; fall back to the submitted title when unavailable. */
export function isExternalSubtitleTrack(
  track: Track,
  subtitle: { mpvTitle: string; url: string },
): boolean {
  return (
    track.type === 'sub' &&
    !!track.external &&
    (track.externalFilename === subtitle.url ||
      (!track.externalFilename && track.title === subtitle.mpvTitle))
  );
}

export function trackDisplayLabel(tracks: readonly Track[], id: number): string {
  return tracks.find((track) => track.id === id)?.displayLabel ?? `Track ${id}`;
}

export function findExternalSubtitleTrack(
  tracks: readonly Track[],
  subtitle: { mpvTitle: string; url: string },
): Track | undefined {
  return (
    tracks.find((track) => track.selected && isExternalSubtitleTrack(track, subtitle)) ??
    tracks.find((track) => isExternalSubtitleTrack(track, subtitle))
  );
}

export function doesTrackSelectionMatch(
  tracks: Track[],
  type: 'audio' | 'sub',
  id: number | 'no',
): boolean {
  if (id === 'no') {
    return type === 'sub' && !tracks.some((track) => track.type === type && !!track.selected);
  }

  return tracks.some((track) => track.type === type && track.id === id && !!track.selected);
}
