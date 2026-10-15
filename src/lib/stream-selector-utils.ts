import type {
  AddonStream,
  AddonStreamRecommendationReason,
  AddonStreamResolution,
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
}

export type StreamMatchBadgeKind = 'episode' | 'range' | 'season' | 'title' | 'title_partial';

export interface StreamMatchBadge {
  kind: StreamMatchBadgeKind;
  label: string;
  /** Only the exact-episode badge carries the profile accent; weaker tiers stay neutral. */
  cls: string;
}

const MATCH_BADGE_NEUTRAL_CLASS = 'border-white/[0.1] bg-white/[0.04] text-zinc-200';

// Match tiers come from the Rust coordinator; the UI styles, never re-derives.
export function buildStreamMatchBadges(stream: AddonStream): StreamMatchBadge[] {
  const summary = stream.matchSummary;
  if (!summary) return [];

  const badges: StreamMatchBadge[] = [];
  switch (summary.episode) {
    case 'exact':
      badges.push({
        kind: 'episode',
        label: 'Exact episode',
        cls: 'accent-lattice-soft',
      });
      break;
    case 'episode_range':
      badges.push({ kind: 'range', label: 'Includes episode', cls: MATCH_BADGE_NEUTRAL_CLASS });
      break;
    case 'season_pack':
      badges.push({ kind: 'season', label: 'Season pack', cls: MATCH_BADGE_NEUTRAL_CLASS });
      break;
  }

  if (summary.title === 'close') {
    badges.push({ kind: 'title', label: 'Title match', cls: MATCH_BADGE_NEUTRAL_CLASS });
  } else if (summary.title === 'partial') {
    badges.push({
      kind: 'title_partial',
      label: 'Similar title',
      cls: 'border-white/[0.08] bg-transparent text-zinc-400',
    });
  }

  return badges;
}

// Tier that earns the card's corner accent: episode tiers win, else a close
// title match (the strongest fact a movie row can have). Partial stays unaccented.
export type StreamMatchTier = 'exact' | 'episode_range' | 'season_pack' | 'title';

export function streamMatchTier(stream: AddonStream): StreamMatchTier | null {
  const summary = stream.matchSummary;
  switch (summary?.episode) {
    case 'exact':
    case 'episode_range':
    case 'season_pack':
      return summary.episode;
    default:
      return summary?.title === 'close' ? 'title' : null;
  }
}

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

// Sync filter only; Rust owns smart order.
const SELECTOR_RES_RANK: Record<AddonStreamResolution, number> = {
  '4k': 4,
  '1080p': 3,
  '720p': 2,
  sd: 1,
};

const searchTextCache = new WeakMap<AddonStream, string>();

function getStreamSearchText(stream: AddonStream): string {
  const cached = searchTextCache.get(stream);
  if (cached !== undefined) return cached;
  const presentation = stream.presentation;
  const text = [
    stream.sourceName,
    presentation.streamTitle,
    presentation.sourceName,
    presentation.codecLabel,
    presentation.hdrLabel,
    presentation.audioLabel,
    presentation.multiAudioLabel,
    presentation.sizeLabel,
    presentation.resolution,
  ]
    .join(' ')
    .toLowerCase();
  searchTextCache.set(stream, text);
  return text;
}

export function filterSelectorStreams(
  streams: readonly AddonStream[],
  filters: StreamSelectorPreferences,
  searchQuery = '',
): AddonStream[] {
  const { quality, source, addon, sort, batch } = filters;
  // `addon` is the addon config id (`StreamSourceSummary.id` / `stream.sourceId`),
  // so filtering can't drift from the displayed name.
  const filterByAddon = addon !== 'all';
  const filterByQuality = quality !== 'all';
  const filterCachedOnly = source === 'cached';
  const filterEpisodesOnly = batch === 'episodes';
  const filterPacksOnly = batch === 'packs';
  const searchTerms = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);

  // P2P rows can't be resolved but stay listed (hiding them empties rich
  // addons) — partitioned below playable rows.
  const playable: AddonStream[] = [];
  const p2p: AddonStream[] = [];
  for (const stream of streams) {
    if (filterByQuality && stream.presentation.resolution !== quality) continue;
    if (filterCachedOnly && stream.presentation.deliveryKind !== 'cached') continue;
    if (filterByAddon && stream.sourceId !== addon) continue;
    if (filterEpisodesOnly && stream.presentation.isBatch) continue;
    if (filterPacksOnly && !stream.presentation.isBatch) continue;
    if (searchTerms.length > 0) {
      const text = getStreamSearchText(stream);
      if (!searchTerms.every((term) => text.includes(term))) continue;
    }
    (stream.presentation.isInstantlyPlayable ? playable : p2p).push(stream);
  }

  if (sort === 'smart') {
    // Backend order is authoritative within each partition.
    return [...playable, ...p2p];
  }

  const sortPartition = (partition: AddonStream[]) => {
    partition.sort((left, right) => {
      if (sort === 'quality') {
        const resDiff =
          SELECTOR_RES_RANK[right.presentation.resolution] -
          SELECTOR_RES_RANK[left.presentation.resolution];
        if (resDiff !== 0) return resDiff;
        return (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0);
      }

      if (sort === 'seeds') {
        return (right.seeders ?? 0) - (left.seeders ?? 0);
      }

      return 0;
    });
  };
  sortPartition(playable);
  sortPartition(p2p);
  return [...playable, ...p2p];
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
      cls:
        hdrLabel === 'DV'
          ? 'bg-fuchsia-400/[0.12] text-fuchsia-100 border-fuchsia-300/20'
          : 'bg-amber-400/[0.12] text-amber-100 border-amber-300/20',
    });
  }
  // An episode match badge already carries the pack fact; only batch rows
  // without one need this badge.
  if (stream.presentation.isBatch && !stream.matchSummary?.episode) {
    techBadges.push({
      label: 'Pack',
      cls: 'bg-amber-400/[0.12] text-amber-100 border-amber-300/20',
    });
  }

  return techBadges;
}
