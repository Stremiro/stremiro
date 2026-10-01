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

// Blank addon IDs count as missing — mirrors Rust `non_empty`, which
// rejects whitespace-only values but keeps the raw string otherwise.
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

/** Canonical `season`+`episode` match — one predicate owner so find/findIndex/
    boolean sites across pages can't drift on which fields compare. Undefined
    coordinates never match (episode numbers collide across seasons). */
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

/** Stream-target equality on all four coordinates — absolute (user-facing)
    and stream-space (addon remap) alike. One owner so "is this the playing
    episode?" checks across the player can't drift on which fields compare. */
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

/** `episodes.find` by canonical coordinates — undefined coordinates return
    undefined instead of scanning. */
export function findEpisodeByCoordinates(
  episodes: readonly Episode[] | undefined,
  season: number | undefined,
  episode: number | undefined,
): Episode | undefined {
  return episodes?.find((candidate) => episodeMatchesCoordinates(candidate, season, episode));
}
