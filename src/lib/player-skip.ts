const SKIPPABLE_SEGMENT_TYPES = new Set(['intro', 'outro', 'recap', 'preview']);

function segmentLabel(type: string): string {
  if (!SKIPPABLE_SEGMENT_TYPES.has(type)) return '';
  return ` ${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

export function getSkipLabel(type: string): string {
  return `Skip${segmentLabel(type)}`;
}

/** Past-tense variant for the post-jump OSD confirmation. */
export function getSkippedLabel(type: string): string {
  return `Skipped${segmentLabel(type)}`;
}
