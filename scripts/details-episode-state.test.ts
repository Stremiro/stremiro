import { expect, test } from 'bun:test';
import { getDetailsEpisodeState } from '../src/lib/details-episode-state';
import { isEpisodeSpoiler } from '../src/lib/episode-stream-target';
import type { Episode, TitleWatchProgress, WatchProgress } from '../src/lib/api';
import { episodeProgressKey } from '../src/lib/history-playback';

const mediaId = 'kitsu:42';
const episode = (season: number, number: number): Episode => ({
  id: `${mediaId}:${season}:${number}`,
  season,
  episode: number,
});
const key = (ep: Episode) => episodeProgressKey(mediaId, ep.season, ep.episode);
const progress = (
  entries: [Episode, Pick<WatchProgress, 'is_watched' | 'has_started_watching'>][],
): TitleWatchProgress => ({
  episodeProgress: Object.fromEntries(
    entries.map(([ep, state]) => [
      key(ep),
      {
        id: mediaId,
        type_: 'series',
        title: 'Example',
        position: 0,
        duration: 1200,
        last_watched: 1,
        ...state,
      },
    ]),
  ),
  watchedEpisodeCeiling: {},
});

test('Details episode derivation preserves season counts, order and display precedence', () => {
  const episodes = [episode(0, 1), ...Array.from({ length: 5 }, (_, n) => episode(1, n + 1))];
  const [special, watched, next, started, unaired, untouched] = episodes;
  const state = getDetailsEpisodeState({
    mediaId,
    episodes,
    selectedSeason: 1,
    titleProgress: progress([
      [special, { is_watched: true }],
      [watched, { is_watched: true, has_started_watching: true }],
      [next, { has_started_watching: true }],
      [started, { has_started_watching: true }],
    ]),
    unairedEpisodeKeys: new Set([key(next), key(started), key(unaired)]),
    nextUpEpisode: next,
  });

  expect([...state.seasonWatchedCounts]).toEqual([
    [0, 1],
    [1, 1],
  ]);
  expect(state.seasonRail).toEqual(
    ['watched', 'next', 'started', 'unaired', 'unwatched'].map((status, index) => ({
      key: key(episodes[index + 1]),
      state: status,
    })),
  );
  expect(state.seasonUnwatchTargets).toEqual([watched]);
  expect(state.seasonWatchTargets).toEqual([untouched]);
  expect(state.seasonWatchedCount).toBe(1);
  expect(state.seasonHasStarted).toBe(true);
  expect(state.firstUnwatchedEpisode).toBe(5);
});

test.each([false, true])('Details episode derivation shares optimistic watched=%s', (watched) => {
  const episodes = [episode(0, 1), episode(1, 1), episode(1, 3), episode(2, 1)];
  const titleProgress = progress(episodes.map((ep) => [ep, { is_watched: !watched }]));
  const state = getDetailsEpisodeState({
    mediaId,
    episodes,
    selectedSeason: 1,
    titleProgress,
    pendingWatchedMutation: { episodes: episodes.slice(0, 3), watched },
    unairedEpisodeKeys: new Set(),
    nextUpEpisode: episodes[1],
  });
  expect([...state.pendingEpisodeKeys]).toEqual(episodes.slice(0, 3).map(key));
  expect([...state.seasonWatchedCounts]).toEqual(
    watched
      ? [
          [0, 1],
          [1, 2],
        ]
      : [[2, 1]],
  );
  expect(state.seasonWatchedCount).toBe(watched ? 2 : 0);
  expect(state.seasonUnwatchTargets).toEqual(watched ? episodes.slice(1, 3) : []);
  expect(state.seasonWatchTargets).toEqual(watched ? [] : episodes.slice(1, 3));
  expect(state.seasonRail.map((segment) => segment.state)).toEqual(
    watched ? ['watched', 'watched'] : ['next', 'unwatched'],
  );
  expect(state.firstUnwatchedEpisode).toBe(watched ? Infinity : 1);
  expect(titleProgress.episodeProgress[key(episodes[1])].is_watched).toBe(!watched);
});

test('Details episode derivation leaves unavailable history and air states provisional', () => {
  const episodes = [episode(0, 1), episode(1, 1)];
  const state = getDetailsEpisodeState({
    mediaId,
    episodes,
    selectedSeason: 0,
    nextUpEpisode: episodes[1],
  });
  expect(state.seasonWatchedCounts.size).toBe(0);
  expect(state.seasonWatchedCount).toBe(0);
  expect(state.seasonHasStarted).toBe(false);
  expect(state.seasonRail).toEqual([{ key: key(episodes[0]), state: 'unwatched' }]);
  expect(state.seasonWatchTargets).toEqual([]);
  expect(state.firstUnwatchedEpisode).toBe(Infinity);
  expect(
    getDetailsEpisodeState({ mediaId, selectedSeason: null, nextUpEpisode: null }).seasonRail,
  ).toEqual([]);
});

test('isEpisodeSpoiler shows S1E1 by default while protecting later unwatched episodes and specials', () => {
  const s1e1 = episode(1, 1);
  const s1e2 = episode(1, 2);
  const s1e3 = episode(1, 3);
  const s2e1 = episode(2, 1);
  const special = episode(0, 1);
  const started: WatchProgress = {
    id: mediaId,
    type_: 'series',
    title: 'Example',
    position: 120,
    duration: 1200,
    last_watched: 1,
    has_started_watching: true,
  };

  expect(isEpisodeSpoiler(s1e1, true, undefined, undefined)).toBe(false);
  expect(isEpisodeSpoiler(s1e1, true, {}, undefined)).toBe(false);

  expect(isEpisodeSpoiler(s1e2, true, undefined, undefined)).toBe(true);
  expect(isEpisodeSpoiler(s2e1, true, { 1: 10 }, undefined)).toBe(true);
  expect(isEpisodeSpoiler(special, true, { 1: 10 }, undefined)).toBe(true);

  expect(isEpisodeSpoiler(s1e2, true, { 1: 2 }, undefined)).toBe(false);
  expect(isEpisodeSpoiler(s1e3, true, { 1: 2 }, undefined)).toBe(true);
  expect(isEpisodeSpoiler(s1e3, true, { 1: 2 }, started)).toBe(false);
  expect(isEpisodeSpoiler(s1e3, true, { 1: 2 }, undefined, true)).toBe(false);
  expect(isEpisodeSpoiler(s1e3, false, undefined, undefined)).toBe(false);
});
