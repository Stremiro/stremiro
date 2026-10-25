import { foldAsciiCase } from '@/lib/api-cache';

export interface StreamRankingOptions {
  rankingMediaId?: string;
  rankingMediaType?: string;
  rankingSeason?: number;
  rankingEpisode?: number;
  rankingTitle?: string;
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
