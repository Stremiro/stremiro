import type { TrackLanguageCandidate } from '@/lib/api';

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

export function normalizeLanguageToken(value?: string | null): string {
  return (value ?? '').trim().toLowerCase();
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
    normalizeLanguageToken(track.lang),
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

export function findExternalSubtitleTrack(
  tracks: readonly Track[],
  subtitle: { mpvTitle: string; url: string },
): Track | undefined {
  return tracks.find((track) => isExternalSubtitleTrack(track, subtitle));
}

export function areTrackListsEqual(left: readonly Track[], right: readonly Track[]): boolean {
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    const leftTrack = left[index];
    const rightTrack = right[index];

    if (
      leftTrack.id !== rightTrack.id ||
      leftTrack.type !== rightTrack.type ||
      leftTrack.displayLabel !== rightTrack.displayLabel ||
      leftTrack.lang !== rightTrack.lang ||
      leftTrack.title !== rightTrack.title ||
      !!leftTrack.selected !== !!rightTrack.selected ||
      !!leftTrack.defaultTrack !== !!rightTrack.defaultTrack ||
      !!leftTrack.forced !== !!rightTrack.forced ||
      !!leftTrack.hearingImpaired !== !!rightTrack.hearingImpaired ||
      !!leftTrack.external !== !!rightTrack.external ||
      leftTrack.externalFilename !== rightTrack.externalFilename
    ) {
      return false;
    }
  }

  return true;
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
