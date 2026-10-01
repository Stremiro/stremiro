import type { AddonStream, AddonStreamResolution, StreamSelectorPreferences } from '@/lib/api';
import { matchesAnyMarker } from '@/lib/utils';

export const DEFAULT_FILTERS: StreamSelectorPreferences = {
  quality: 'all',
  source: 'all',
  addon: 'all',
  sort: 'smart',
  batch: 'all',
};

export interface StreamSelectorStats {
  resCounts: Record<AddonStreamResolution, number>;
  playableCount: number;
  p2pCount: number;
  cachedCount: number;
  batchCount: number;
  episodeLikeCount: number;
}

export function buildStreamSelectorStats(streams: readonly AddonStream[]): StreamSelectorStats {
  const stats: StreamSelectorStats = {
    resCounts: { '4k': 0, '1080p': 0, '720p': 0, sd: 0 },
    playableCount: 0,
    p2pCount: 0,
    cachedCount: 0,
    batchCount: 0,
    episodeLikeCount: 0,
  };

  for (const stream of streams) {
    if (!stream.presentation.isInstantlyPlayable) {
      stats.p2pCount += 1;
      continue;
    }
    stats.playableCount += 1;
    stats.resCounts[stream.presentation.resolution] += 1;
    if (stream.presentation.deliveryKind === 'cached') stats.cachedCount += 1;
    if (stream.presentation.isBatch) stats.batchCount += 1;
  }

  stats.episodeLikeCount = stats.playableCount - stats.batchCount;
  return stats;
}

interface TechBadge {
  label: string;
  cls: string;
}

type StreamMatchBadgeKind = 'episode' | 'range' | 'season' | 'title';

export interface StreamMatchBadge {
  kind: StreamMatchBadgeKind;
  label: string;
  /** Slim dot+label vocabulary — the tier color lives on the dot and text,
      no chip chrome, so a row of signals reads as one quiet line. */
  textCls: string;
  dotCls: string;
}

// Structured match tiers computed once in the Rust coordinator — the UI only
// styles them, never re-derives match facts from stream text.
export function buildStreamMatchBadges(stream: AddonStream): StreamMatchBadge[] {
  const summary = stream.matchSummary;
  if (!summary) return [];

  const badges: StreamMatchBadge[] = [];
  switch (summary.episode) {
    case 'exact':
      badges.push({
        kind: 'episode',
        label: 'Episode match',
        textCls: 'text-emerald-300/90',
        dotCls: 'bg-emerald-400',
      });
      break;
    case 'episode_range':
      badges.push({
        kind: 'range',
        label: 'Ep. in range',
        textCls: 'text-sky-300/90',
        dotCls: 'bg-sky-400',
      });
      break;
    case 'season_pack':
      badges.push({
        kind: 'season',
        label: 'Season pack',
        textCls: 'text-amber-300/90',
        dotCls: 'bg-amber-400',
      });
      break;
  }

  if (summary.title === 'close') {
    badges.push({
      kind: 'title',
      label: 'Title match',
      textCls: 'text-violet-300/90',
      dotCls: 'bg-violet-400',
    });
  } else if (summary.title === 'partial') {
    badges.push({
      kind: 'title',
      label: 'Title match',
      textCls: 'text-zinc-400',
      dotCls: 'bg-zinc-500',
    });
  }

  return badges;
}

// Episode-match tier that earns the card's corner dot-field accent.
// Title-only matches get the badge but no accent so the signal stays meaningful.
export type StreamMatchTier = 'exact' | 'episode_range' | 'season_pack';

export function streamMatchTier(stream: AddonStream): StreamMatchTier | null {
  switch (stream.matchSummary?.episode) {
    case 'exact':
    case 'episode_range':
    case 'season_pack':
      return stream.matchSummary.episode;
    default:
      return null;
  }
}

// Recommendation reasons that carry a caution signal rather than a positive
// one — they render amber-muted so "why it ranks" reads at a glance.
const CAUTION_REASON_MARKERS = ['issues', 'cooling'] as const;

export function isCautionReason(reason: string): boolean {
  return matchesAnyMarker(reason, CAUTION_REASON_MARKERS);
}

// Sync filter only; Rust owns smart order.
const SELECTOR_RES_RANK: Record<AddonStreamResolution, number> = {
  '4k': 4,
  '1080p': 3,
  '720p': 2,
  sd: 1,
};

export function filterSelectorStreams(
  streams: readonly AddonStream[],
  filters: StreamSelectorPreferences,
): AddonStream[] {
  const { quality, source, addon, sort, batch } = filters;
  // `addon` carries the addon config id (same value as `StreamSourceSummary.id`
  // on the chips and `stream.sourceId` on each row) — identity filtering can
  // never drift from the name the UI happens to display.
  const filterByAddon = addon !== 'all';
  const filterByQuality = quality !== 'all';
  const filterCachedOnly = source === 'cached';
  const filterEpisodesOnly = batch === 'episodes';
  const filterPacksOnly = batch === 'packs';

  // P2P-capable rows can't be resolved by this build, but hiding them made
  // rich addons look nearly empty versus Stremio. They stay in the list —
  // partitioned below playable rows so dead entries never bury live ones.
  const playable: AddonStream[] = [];
  const p2p: AddonStream[] = [];
  for (const stream of streams) {
    if (filterByQuality && stream.presentation.resolution !== quality) continue;
    if (filterCachedOnly && stream.presentation.deliveryKind !== 'cached') continue;
    if (filterByAddon && stream.sourceId !== addon) continue;
    if (filterEpisodesOnly && stream.presentation.isBatch) continue;
    if (filterPacksOnly && !stream.presentation.isBatch) continue;
    (stream.presentation.isInstantlyPlayable ? playable : p2p).push(stream);
  }

  if (sort === 'smart') {
    // Backend order is already authoritative within each partition — a
    // subsequence of a sorted list stays sorted.
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

// Only decision-grade facts earn a badge; codec/audio details live in the
// meta line where they read as text instead of competing as chips.
export function buildStreamTechBadges(stream: AddonStream): TechBadge[] {
  const resolution = stream.presentation.resolution;
  const hdrLabel = stream.presentation.hdrLabel ?? null;

  const techBadges: TechBadge[] = [
    resolution === '4k'
      ? { label: '4K', cls: 'bg-violet-400/15 text-violet-200 border-violet-300/25' }
      : resolution === '1080p'
        ? { label: '1080p', cls: 'bg-white/[0.08] text-white/85 border-white/[0.12]' }
        : resolution === '720p'
          ? { label: '720p', cls: 'bg-white/[0.05] text-zinc-300 border-white/[0.08]' }
          : { label: 'SD', cls: 'bg-white/[0.04] text-zinc-500 border-white/[0.06]' },
  ];

  if (hdrLabel) {
    techBadges.push({
      label: hdrLabel,
      cls:
        hdrLabel === 'DV'
          ? 'bg-fuchsia-400/15 text-fuchsia-200 border-fuchsia-300/25'
          : 'bg-amber-400/15 text-amber-200 border-amber-300/25',
    });
  }
  // A `matchSummary.episode` badge already carries the pack fact in a
  // styled chip — only batch rows with no episode claim need the tech badge.
  if (stream.presentation.isBatch && !stream.matchSummary?.episode) {
    techBadges.push({
      label: 'PACK',
      cls: 'bg-amber-400/15 text-amber-200 border-amber-300/25',
    });
  }

  return techBadges;
}
