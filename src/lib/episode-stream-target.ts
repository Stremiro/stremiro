import type { Episode } from '@/lib/api';

type EpisodeCoordinates = Pick<
  Episode,
  'season' | 'episode' | 'streamLookupId' | 'streamSeason' | 'streamEpisode'
>;

export interface NextEpisodeStreamCoordinates {
  streamLookupId: string;
  streamSeason: number;
  streamEpisode: number;
  absoluteSeason: number;
  absoluteEpisode: number;
}

// Blank addon IDs count as missing — mirrors Rust `non_blank_opt`.
const nonEmpty = (value?: string) => (value && value.trim() ? value : undefined);

export function buildEpisodeStreamTarget(
  fallbackStreamId: string,
  episode: EpisodeCoordinates,
): NextEpisodeStreamCoordinates {
  return {
    streamLookupId: nonEmpty(episode.streamLookupId) ?? fallbackStreamId,
    streamSeason: episode.streamSeason ?? episode.season,
    streamEpisode: episode.streamEpisode ?? episode.episode,
    absoluteSeason: episode.season,
    absoluteEpisode: episode.episode,
  };
}

/** Canonical `season`+`episode` match; undefined coordinates never match (episode numbers collide across seasons). */
export function episodeMatchesCoordinates(
  candidate: Pick<Episode, 'season' | 'episode'>,
  season: number | undefined,
  episode: number | undefined,
): boolean {
  return (
    season !== undefined &&
    episode !== undefined &&
    candidate.season === season &&
    candidate.episode === episode
  );
}

/** Stream-target equality on all four coordinates (absolute user-facing + stream-space addon remap). */
export function sameEpisodeCoordinates(
  a: Partial<
    Pick<
      NextEpisodeStreamCoordinates,
      'absoluteSeason' | 'absoluteEpisode' | 'streamSeason' | 'streamEpisode'
    >
  >,
  b: Partial<
    Pick<
      NextEpisodeStreamCoordinates,
      'absoluteSeason' | 'absoluteEpisode' | 'streamSeason' | 'streamEpisode'
    >
  >,
): boolean {
  return (
    a.absoluteSeason === b.absoluteSeason &&
    a.absoluteEpisode === b.absoluteEpisode &&
    a.streamSeason === b.streamSeason &&
    a.streamEpisode === b.streamEpisode
  );
}

/** `episodes.find` by canonical coordinates — undefined returns undefined without scanning. */
export function findEpisodeByCoordinates(
  episodes: readonly Episode[] | undefined,
  season: number | undefined,
  episode: number | undefined,
): Episode | undefined {
  return episodes?.find((candidate) => episodeMatchesCoordinates(candidate, season, episode));
}
