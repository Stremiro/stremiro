import type { TrackLanguageCandidate } from '@/lib/api';
import { nonBlank } from '@/lib/utils';

export interface Track {
  id: number;
  type: 'video' | 'audio' | 'sub';
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

export function addonSubtitleKey(subtitle: {
  id: string;
  sourceId?: string;
  url: string;
  lang?: string;
}): string {
  return JSON.stringify([
    subtitle.sourceId ?? '',
    subtitle.id,
    subtitle.url,
    normalizeLanguageToken(subtitle.lang),
  ]);
}

export function addonSubtitleTitleArg(subtitle: { id: string; label?: string }): string {
  return nonBlank(subtitle.label) || subtitle.id;
}

/** Prefer mpv's external filename; fall back to the submitted title when unavailable. */
export function isExternalSubtitleTrack(
  track: Track,
  subtitle: { id: string; label?: string; url: string },
): boolean {
  return (
    track.type === 'sub' &&
    !!track.external &&
    (track.externalFilename === subtitle.url ||
      (!track.externalFilename && track.title === addonSubtitleTitleArg(subtitle)))
  );
}

export function findExternalSubtitleTrack(
  tracks: readonly Track[],
  subtitle: { id: string; label?: string; url: string },
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

function formatTrackLabel(track: Track): string {
  const lang = track.lang?.toUpperCase();
  const title = track.title;
  // Muxers write opaque titles ("Stereo 1", "Track 2") while mpv separately
  // reports the declared language — lead with `lang` when the title doesn't
  // already say it so same-titled tracks stay distinguishable.
  const base =
    title && lang
      ? title.toLowerCase().includes(lang.toLowerCase())
        ? title
        : `${lang} · ${title}`
      : title || lang || `Track ${track.id}`;
  const flags = [track.forced ? 'Forced' : null, track.hearingImpaired ? 'SDH' : null].filter(
    Boolean,
  );
  return flags.length > 0 ? `${base} · ${flags.join(' · ')}` : base;
}

export function buildTrackLabelMap(tracks: Track[]): Map<number, string> {
  const labels = tracks.map(formatTrackLabel);
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);

  return new Map(
    tracks.map((track, index) => {
      const label = labels[index] ?? `Track ${track.id}`;
      return [track.id, (counts.get(label) ?? 0) > 1 ? `${label} #${track.id}` : label] as const;
    }),
  );
}
