import { expect, spyOn, test } from 'bun:test';
import * as React from 'react';
import { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { captureWithClient, restoreSpies } from './render-helpers';

import { usePlayerTrackController } from '../src/hooks/use-player-track-controller';
import { api } from '../src/lib/api';
import { flushPendingAppWrites } from '../src/lib/pending-app-writes';
import * as playerMpv from '../src/lib/player-mpv';
import type { Track } from '../src/lib/player-track-utils';

type Operation = 'select' | 'cycle' | 'addon';
const OPERATIONS: Operation[] = ['select', 'cycle', 'addon'];
const subtitle = {
  id: 'external',
  selectionKey: 'external',
  url: 'https://example.com/sub.srt',
  lang: 'en',
  label: 'English',
  mpvTitle: 'English',
  sourceId: 'addon',
  sourceName: 'Addon',
};
const selectedSubtitle: Track = {
  id: 3,
  type: 'sub',
  displayLabel: 'English',
  selected: true,
  external: true,
  externalFilename: subtitle.url,
};

function startChange(player: ReturnType<typeof usePlayerTrackController>, operation: Operation) {
  switch (operation) {
    case 'select':
      return player.setTrack('sub', 3);
    case 'cycle':
      return player.cycleTrack('sub');
    case 'addon':
      return player.selectAddonSubtitle(subtitle);
  }
}

async function withController(
  run: (
    player: ReturnType<typeof usePlayerTrackController>,
    resetLoad: () => void,
    savedTrack: () => unknown,
  ) => Promise<void>,
) {
  const client = new QueryClient();
  const effects: React.EffectCallback[] = [];
  const captureEffects = spyOn(React, 'useEffect').mockImplementation((effect) => {
    effects.push(effect);
  });
  const save = spyOn(api, 'saveSelectedPlaybackLanguagePreference').mockResolvedValue({
    preferences: { preferredSubtitleLanguage: 'en' },
  });
  try {
    const player = captureWithClient(client, () =>
      usePlayerTrackController({
        mediaId: 'local',
        mediaType: 'movie',
        activeStreamUrl: 'https://example.com/video',
        hasPlaybackStarted: true,
        isLoading: false,
        isResolving: false,
        resetKey: 'track-transaction',
      }),
    );
    // The controller's final effect resets native-load ownership; running its cleanup
    // and setup models a stream replacement without depending on a DOM renderer.
    const resetEffect = effects.at(-1);
    if (!resetEffect) throw new Error('Missing track ownership effect');
    let cleanup = resetEffect();
    try {
      await run(
        player,
        () => {
          if (typeof cleanup === 'function') cleanup();
          cleanup = resetEffect();
        },
        () => save.mock.calls.at(-1)?.[1],
      );
    } finally {
      if (typeof cleanup === 'function') cleanup();
    }
  } finally {
    await flushPendingAppWrites();
    restoreSpies(captureEffects, save);
    client.clear();
  }
}

test.each(OPERATIONS)(
  '%s keeps its gate until confirmation and merges the other kind',
  async (kind) => {
    const pending = Promise.withResolvers<Track[]>();
    const audio: Track = { id: 2, type: 'audio', displayLabel: 'French', selected: true };
    const change = spyOn(playerMpv, 'changePlayerTrack').mockImplementation((type) =>
      type === 'audio' ? Promise.resolve([audio]) : pending.promise,
    );
    const add = spyOn(playerMpv, 'addSubtitleTrack').mockImplementation(() => pending.promise);
    const read = spyOn(playerMpv, 'readPlayerTrackList').mockRejectedValue(
      new Error('Read unavailable'),
    );
    try {
      await withController(async (player) => {
        const result = startChange(player, kind);
        expect(player.notifyObservedTrackSelection('sub', 3)).toBe(true);
        expect(await player.setTrack('sub', 1)).toBe(false);
        expect(await player.cycleTrack('sub')).toBeNull();
        expect(await player.selectAddonSubtitle(subtitle)).toBe(false);

        // Native audio and subtitle confirmations may arrive in either order.
        expect(await player.setTrack('audio', 2)).toBe(true);
        pending.resolve([selectedSubtitle]);
        expect(await result).toBe(kind === 'cycle' ? 3 : true);
        expect(player.notifyObservedTrackSelection('sub', 3)).toBe(false);
        expect(await player.refreshTracks()).toEqual([selectedSubtitle, audio]);
        expect(change).toHaveBeenCalledTimes(kind === 'addon' ? 1 : 2);
        expect(add).toHaveBeenCalledTimes(kind === 'addon' ? 1 : 0);
      });
    } finally {
      for (const spy of [change, add, read]) spy.mockRestore();
    }
  },
);

test.each(OPERATIONS)('%s cannot release a replacement load gate', async (kind) => {
  const old = Promise.withResolvers<Track[]>();
  const current = Promise.withResolvers<Track[]>();
  const change = spyOn(playerMpv, 'changePlayerTrack')
    .mockImplementationOnce(() => old.promise)
    .mockImplementationOnce(() => current.promise);
  const add = spyOn(playerMpv, 'addSubtitleTrack')
    .mockImplementationOnce(() => old.promise)
    .mockImplementationOnce(() => current.promise);
  try {
    await withController(async (player, resetLoad) => {
      const obsolete = startChange(player, kind);
      resetLoad();
      const replacement = startChange(player, kind);
      old.resolve([selectedSubtitle]);
      expect(await obsolete).toBe(kind === 'cycle' ? null : false);
      expect(player.notifyObservedTrackSelection('sub', 3)).toBe(true);
      expect(await player.setTrack('sub', 1)).toBe(false);
      current.resolve([selectedSubtitle]);
      expect(await replacement).toBe(kind === 'cycle' ? 3 : true);
      expect(player.notifyObservedTrackSelection('sub', 3)).toBe(false);
    });
  } finally {
    for (const spy of [change, add]) spy.mockRestore();
  }
});

test.each(OPERATIONS)('%s preserves failure reporting and releases its gate', async (kind) => {
  const failure = new Error('Native selection failed');
  const change = spyOn(playerMpv, 'changePlayerTrack').mockRejectedValue(failure);
  const add = spyOn(playerMpv, 'addSubtitleTrack').mockRejectedValue(failure);
  const notice = spyOn(toast, 'error').mockReturnValue('track-error');
  try {
    await withController(async (player) => {
      const result = startChange(player, kind);
      if (kind === 'addon') await expect(result).rejects.toBe(failure);
      else expect(await result).toBe(kind === 'cycle' ? null : false);
      expect(player.notifyObservedTrackSelection('sub', null)).toBe(false);
      if (kind === 'select') expect(notice).toHaveBeenCalledWith('Failed to switch track');
      else expect(notice).not.toHaveBeenCalled();
    });
  } finally {
    for (const spy of [change, add, notice]) spy.mockRestore();
  }
});

test('Manual subtitles Off wins, and stale refreshes cannot erase a confirmed addon track', async () => {
  const embedded = { id: 1, type: 'sub' as const, displayLabel: 'English' };
  const tracks = spyOn(playerMpv, 'readPlayerTrackList').mockResolvedValue([embedded]);
  const confirmed = [
    embedded,
    { ...embedded, id: 2, external: true, externalFilename: subtitle.url },
    { ...embedded, id: 3, selected: true, external: true, externalFilename: subtitle.url },
  ];
  const add = spyOn(playerMpv, 'addSubtitleTrack').mockResolvedValue(confirmed);
  const staleTracks =
    Promise.withResolvers<Awaited<ReturnType<typeof playerMpv.readPlayerTrackList>>>();
  const write = spyOn(playerMpv, 'setMpvProperty').mockResolvedValue([]);
  const change = spyOn(playerMpv, 'changePlayerTrack').mockResolvedValue([embedded]);
  const notice = spyOn(toast, 'error').mockReturnValue('track-error');
  try {
    await withController(async (player, _resetLoad, savedTrack) => {
      await player.refreshTracks();
      expect(await player.setTrack('sub', 'no', { persistPreference: true })).toBe(true);
      expect(change).toHaveBeenCalledWith('sub', 'no');
      expect(await player.selectAddonSubtitle(subtitle, { automatic: true })).toBe(false);
      expect(add).not.toHaveBeenCalled();
      tracks.mockImplementationOnce(() => staleTracks.promise);
      const refresh = player.refreshTracks();
      expect(await player.selectAddonSubtitle(subtitle)).toBe(true);
      await flushPendingAppWrites();
      expect(savedTrack()).toMatchObject({ id: 3 });
      staleTracks.resolve([embedded]);
      await refresh;
      const repeatedSnapshot =
        Promise.withResolvers<Awaited<ReturnType<typeof playerMpv.readPlayerTrackList>>>();
      tracks.mockImplementationOnce(() => repeatedSnapshot.promise);
      const repeatedRefresh = player.refreshTracks();
      change.mockResolvedValue(confirmed);
      expect(await player.setTrack('sub', 3)).toBe(true);
      repeatedSnapshot.resolve([embedded]);
      expect(await repeatedRefresh).toEqual(confirmed);
      player.notifyObservedTrackSelection('audio', null);
      player.notifyObservedTrackSelection('sub', 1);
      const observedSnapshot =
        Promise.withResolvers<Awaited<ReturnType<typeof playerMpv.readPlayerTrackList>>>();
      tracks.mockImplementationOnce(() => observedSnapshot.promise);
      const observedRefresh = player.refreshTracks();
      expect(tracks).toHaveBeenLastCalledWith({ audio: null, sub: 1 });
      player.notifyObservedTrackSelection('sub', 3);
      observedSnapshot.resolve([{ ...embedded, selected: true }]);
      expect(await observedRefresh).toEqual(confirmed);
      tracks.mockResolvedValueOnce(confirmed);
      expect(await player.refreshTracks()).toEqual(confirmed);
      expect(tracks).toHaveBeenLastCalledWith({ audio: null, sub: 3 });
      expect(await player.selectAddonSubtitle(subtitle)).toBe(true);
      expect(change).toHaveBeenLastCalledWith('sub', 3);
      tracks.mockRejectedValueOnce(new Error('Native read unavailable'));
      expect(await player.refreshTracks()).toEqual(confirmed);
      expect(add).toHaveBeenCalledTimes(1);
      expect(await player.cycleTrack('sub')).toBe(3);
      expect(change).toHaveBeenLastCalledWith('sub', 'cycle');
      change.mockRejectedValueOnce(new Error('Track unavailable'));
      expect(await player.setTrack('sub', 2)).toBe(false);
      expect(notice).toHaveBeenLastCalledWith('Failed to switch track');
      expect(await player.selectAddonSubtitle(subtitle)).toBe(true);
      expect(change).toHaveBeenLastCalledWith('sub', 3);
    });
  } finally {
    await flushPendingAppWrites();
    for (const spy of [tracks, add, write, change, notice]) spy.mockRestore();
  }
});
