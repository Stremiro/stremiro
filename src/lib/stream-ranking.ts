import { foldAsciiCase } from '@/lib/api-cache';
import { nonBlank } from '@/lib/utils';

export interface StreamRankingOptions {
  rankingMediaId?: string;
  rankingMediaType?: string;
  rankingSeason?: number;
  rankingEpisode?: number;
  rankingTitle?: string;
}

interface StreamRankingTarget {
  mediaId: string;
  mediaType?: string;
  season?: number;
  episode?: number;
  title?: string;
}

export function buildStreamRankingOptions(
  target?: StreamRankingTarget,
): StreamRankingOptions | undefined {
  const rankingMediaId = nonBlank(target?.mediaId);
  if (!target || !rankingMediaId) return undefined;

  return {
    rankingMediaId,
    rankingMediaType: nonBlank(target.mediaType),
    rankingSeason: target.season,
    rankingEpisode: target.episode,
    rankingTitle: nonBlank(target.title),
  };
}

export function buildStreamRankingCacheKey(options?: StreamRankingOptions): string {
  return JSON.stringify([
    options?.rankingMediaType ?? null,
    options?.rankingMediaId ?? null,
    options?.rankingSeason ?? null,
    options?.rankingEpisode ?? null,
    // ASCII fold only: Rust title tokens keep non-ASCII case distinct.
    options?.rankingTitle ? foldAsciiCase(options.rankingTitle.trim()) : null,
  ]);
}
