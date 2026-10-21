import type {
  AddonStream,
  AddonStreamRecommendationReason,
  AddonStreamResolution,
  StreamMatchBadgeKind,
  StreamSelectorPreferences,
} from '@/lib/api';

export const DEFAULT_FILTERS: StreamSelectorPreferences = {
  quality: 'all',
  source: 'all',
  addon: 'all',
  sort: 'smart',
  batch: 'all',
};

interface TechBadge {
  label: string;
  cls: string;
  description?: string;
}

interface StreamMatchBadge {
  kind: StreamMatchBadgeKind;
  label: string;
  /** Only the exact-episode badge carries the profile accent; weaker tiers stay neutral. */
  cls: string;
}

const MATCH_BADGE_NEUTRAL_CLASS = 'border-white/[0.1] bg-white/[0.04] text-zinc-200';
const AMBER_BADGE_CLASS = 'bg-amber-400/[0.12] text-amber-100 border-amber-300/20';

export const MATCH_BADGES: Record<StreamMatchBadgeKind, StreamMatchBadge> = {
  episode: { kind: 'episode', label: 'Exact episode', cls: 'accent-lattice-soft' },
  range: { kind: 'range', label: 'Includes episode', cls: MATCH_BADGE_NEUTRAL_CLASS },
  season: { kind: 'season', label: 'Season pack', cls: MATCH_BADGE_NEUTRAL_CLASS },
  multi_season: {
    kind: 'multi_season',
    label: 'Multi-season pack',
    cls: MATCH_BADGE_NEUTRAL_CLASS,
  },
  title: { kind: 'title', label: 'Title match', cls: MATCH_BADGE_NEUTRAL_CLASS },
  title_partial: {
    kind: 'title_partial',
    label: 'Similar title',
    cls: 'border-white/[0.08] bg-transparent text-zinc-400',
  },
};

export interface StreamReasonChip {
  kind: AddonStreamRecommendationReason;
  label: string;
  /** Positive reasons take the action accent and caution reasons amber, so "why it ranks" reads at a glance. */
  tone: 'positive' | 'caution' | 'neutral';
}

const REASON_CHIPS: { [K in AddonStreamRecommendationReason]: StreamReasonChip & { kind: K } } = {
  verified_source: { kind: 'verified_source', label: 'Verified source', tone: 'positive' },
  source_issues: { kind: 'source_issues', label: 'Recent source issues', tone: 'caution' },
  source_cooling: { kind: 'source_cooling', label: 'Source cooling down', tone: 'caution' },
  proven_release_group: {
    kind: 'proven_release_group',
    label: 'Proven release group',
    tone: 'positive',
  },
  release_group_issues: {
    kind: 'release_group_issues',
    label: 'Release group had issues',
    tone: 'caution',
  },
  release_group_cooling: {
    kind: 'release_group_cooling',
    label: 'Release group cooling down',
    tone: 'caution',
  },
  title_affinity: {
    kind: 'title_affinity',
    label: 'Previously worked on this title',
    tone: 'positive',
  },
  language_match: { kind: 'language_match', label: 'Matches language prefs', tone: 'positive' },
  language_flexible: { kind: 'language_flexible', label: 'Flexible audio/subs', tone: 'positive' },
  top_quality: { kind: 'top_quality', label: 'Top quality', tone: 'positive' },
  good_quality: { kind: 'good_quality', label: 'Good quality', tone: 'positive' },
  preferred_source: { kind: 'preferred_source', label: 'Preferred source', tone: 'positive' },
  fallback: { kind: 'fallback', label: 'Fallback', tone: 'neutral' },
};

export function buildStreamReasonChips(stream: AddonStream): StreamReasonChip[] {
  // Wire may carry a reason newer than this build's map — drop unknowns.
  return (stream.recommendationReasons ?? []).flatMap((kind) => REASON_CHIPS[kind] ?? []);
}

/** One owner for the resolution vocabulary: tech badges, quality filter options and resolve feedback. */
export const RESOLUTION_LABELS: Record<AddonStreamResolution, string> = {
  '4k': '4K',
  '1080p': '1080p',
  '720p': '720p',
  sd: 'SD',
};

const RESOLUTION_BADGE_CLASSES: Record<AddonStreamResolution, string> = {
  '4k': 'bg-violet-400/[0.12] text-violet-100 border-violet-300/20',
  '1080p': 'bg-white/[0.07] text-zinc-100 border-white/[0.1]',
  '720p': 'bg-white/[0.04] text-zinc-300 border-white/[0.07]',
  sd: 'bg-white/[0.03] text-zinc-400 border-white/[0.06]',
};

// Only decision-grade facts earn a badge; codec/audio details live in the meta line.
export function buildStreamTechBadges(stream: AddonStream): TechBadge[] {
  const resolution = stream.presentation.resolution;
  const hdrLabel = stream.presentation.hdrLabel ?? null;

  const techBadges: TechBadge[] = [
    { label: RESOLUTION_LABELS[resolution], cls: RESOLUTION_BADGE_CLASSES[resolution] },
  ];

  if (hdrLabel) {
    techBadges.push({
      label: hdrLabel,
      description: `${hdrLabel} source. This label does not indicate your display's HDR mode.`,
      cls:
        hdrLabel === 'Dolby Vision'
          ? 'bg-fuchsia-400/[0.12] text-fuchsia-100 border-fuchsia-300/20'
          : AMBER_BADGE_CLASS,
    });
  }
  if (stream.showPackBadge) {
    techBadges.push({
      label: 'Pack',
      cls: AMBER_BADGE_CLASS,
    });
  }

  return techBadges;
}
