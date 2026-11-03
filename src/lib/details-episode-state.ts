import type { Episode, TitleWatchProgress } from '@/lib/api';
import { episodeMatchesCoordinates } from '@/lib/episode-stream-target';
import { episodeProgressKey } from '@/lib/history-playback';

export type SeasonEpisodeState = 'watched' | 'started' | 'next' | 'unwatched' | 'unaired';

interface DetailsEpisodeStateArgs {
  mediaId: string;
  episodes?: readonly Episode[];
  selectedSeason: number | null;
  titleProgress?: TitleWatchProgress;
  pendingWatchedMutation?: { episodes: readonly Episode[]; watched: boolean };
  unairedEpisodeKeys?: ReadonlySet<string>;
  nextUpEpisode: Pick<Episode, 'season' | 'episode'> | null;
}

/** One progress lookup per episode feeds the season tabs, rail and bulk actions. */
export function getDetailsEpisodeState({
  mediaId,
  episodes = [],
  selectedSeason,
  titleProgress,
  pendingWatchedMutation,
  unairedEpisodeKeys,
  nextUpEpisode,
}: DetailsEpisodeStateArgs) {
  const pendingEpisodeKeys = new Set(
    pendingWatchedMutation?.episodes.map((ep) =>
      episodeProgressKey(mediaId, ep.season, ep.episode),
    ),
  );
  const seasonWatchedCounts = new Map<number, number>();
  const seasonWatchTargets: Episode[] = [];
  const seasonUnwatchTargets: Episode[] = [];
  const seasonRail: { key: string; state: SeasonEpisodeState }[] = [];
  let seasonHasStarted = false;
  let firstUnwatchedEpisode = Infinity;

  for (const ep of episodes) {
    const isSelectedSeason = ep.season === selectedSeason;
    if (!titleProgress && !isSelectedSeason) continue;
    const key = episodeProgressKey(mediaId, ep.season, ep.episode);
    const progress = titleProgress?.episodeProgress[key];
    const watched =
      (pendingEpisodeKeys.has(key) ? pendingWatchedMutation?.watched : undefined) ??
      !!progress?.is_watched;
    if (titleProgress && watched) {
      seasonWatchedCounts.set(ep.season, (seasonWatchedCounts.get(ep.season) ?? 0) + 1);
    }
    if (!isSelectedSeason) continue;
    if (watched) {
      seasonUnwatchTargets.push(ep);
      seasonRail.push({ key, state: 'watched' });
      continue;
    }
    const started = !!progress?.has_started_watching;
    const unaired = unairedEpisodeKeys?.has(key);
    seasonHasStarted = seasonHasStarted || started;
    seasonRail.push({
      key,
      state:
        nextUpEpisode && episodeMatchesCoordinates(ep, nextUpEpisode.season, nextUpEpisode.episode)
          ? 'next'
          : started
            ? 'started'
            : unaired
              ? 'unaired'
              : 'unwatched',
    });
    // Unavailable air states must not enable a bulk watched write.
    if (unairedEpisodeKeys && !unaired) {
      seasonWatchTargets.push(ep);
      firstUnwatchedEpisode = Math.min(firstUnwatchedEpisode, ep.episode);
    }
  }

  return {
    pendingEpisodeKeys,
    seasonWatchedCounts,
    seasonWatchTargets,
    seasonUnwatchTargets,
    seasonRail,
    seasonWatchedCount: seasonUnwatchTargets.length,
    seasonHasStarted,
    firstUnwatchedEpisode,
  };
}
