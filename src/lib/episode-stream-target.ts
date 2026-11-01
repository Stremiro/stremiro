import type { Episode, TitleWatchProgress, WatchProgress } from '@/lib/api';
import { nonBlank } from '@/lib/utils';

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

export function buildEpisodeStreamTarget(
  fallbackStreamId: string,
  episode: EpisodeCoordinates,
): NextEpisodeStreamCoordinates {
  return {
    streamLookupId: nonBlank(episode.streamLookupId) ?? fallbackStreamId,
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
  a: Partial<Omit<NextEpisodeStreamCoordinates, 'streamLookupId'>>,
  b: Partial<Omit<NextEpisodeStreamCoordinates, 'streamLookupId'>>,
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
  if (season === undefined || episode === undefined) return undefined;
  return episodes?.find((candidate) => episodeMatchesCoordinates(candidate, season, episode));
}

/** Spoiler predicate: episodes past the watched ceiling hide their metadata, unless in progress or current. */
export function isEpisodeSpoiler(
  episode: Episode,
  spoilerProtection: boolean,
  watchedEpisodeCeiling: TitleWatchProgress['watchedEpisodeCeiling'] | undefined,
  progress: WatchProgress | undefined,
  isCurrent = false,
): boolean {
  const ceiling = watchedEpisodeCeiling?.[episode.season];
  return (
    spoilerProtection &&
    !isCurrent &&
    !progress?.has_started_watching &&
    (ceiling === undefined || episode.episode > ceiling)
  );
}
