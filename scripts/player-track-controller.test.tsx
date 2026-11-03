import { expect, spyOn, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';

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
  const player = Promise.withResolvers<ReturnType<typeof usePlayerTrackController>>();
  function Fixture() {
    player.resolve(
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
    return null;
  }
  try {
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Fixture />
      </QueryClientProvider>,
    );
    // The controller's final effect resets native-load ownership; running its cleanup
    // and setup models a stream replacement without depending on a DOM renderer.
    const resetEffect = effects.at(-1);
    if (!resetEffect) throw new Error('Missing track ownership effect');
    let cleanup = resetEffect();
    try {
      await run(await player.promise, () => {
        if (typeof cleanup === 'function') cleanup();
        cleanup = resetEffect();
      });
    } finally {
      if (typeof cleanup === 'function') cleanup();
    }
  } finally {
    await flushPendingAppWrites();
    captureEffects.mockRestore();
    save.mockRestore();
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
