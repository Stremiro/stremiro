import { type RefObject, useCallback, useEffect, useEffectEvent, useRef } from 'react';
import type { PlayerOsdMessageIcon } from '@/components/player-osd-overlay';
import { partyApi, partyMediaKey, type PartyMedia, type PartyNotice } from '@/lib/party-api';
import { playerMatchesMedia, useParty } from '@/lib/party-session';
import type { PlaybackClock } from '@/lib/player-clock';
import { usePlayerSession } from '@/lib/player-session';
import { setMpvProperty } from '@/lib/player-mpv';
import { formatTime } from '@/lib/utils';

function describeNotice(notice: PartyNotice): string {
  switch (notice.kind) {
    case 'synced':
      return 'In sync with the room';
    case 'paused':
      return `${notice.by} paused`;
    case 'resumed':
      return `${notice.by} resumed`;
    case 'jumped':
      return `${notice.by} jumped to ${formatTime(notice.toMs / 1000)}`;
    case 'speedLimited':
      return 'Party speed is limited to 0.5–2x';
    case 'sourcesDiffer':
      return 'Party sources have different durations';
    default: {
      const unhandled: never = notice;
      return unhandled;
    }
  }
}

interface PartySyncOptions {
  media: PartyMedia;
  clock: PlaybackClock;
  duration: number;
  playing: boolean;
  rate: number;
  soloRate: number;
  buffering: boolean;
  ready: boolean;
  resetKey: string | undefined;
  streamKeyRef: RefObject<string | undefined>;
  seek: (seconds: number) => Promise<void>;
  isSeekPending: () => boolean;
  announce: (text: string, icon?: PlayerOsdMessageIcon) => void;
}

export function usePartySync(options: PartySyncOptions) {
  const { room, controlEpoch, isControlPending } = useParty();
  const token = useRef('');
  const ownsSpeed = useRef(false);
  const reportInFlight = useRef(false);
  const active = room.active && room.syncing;

  const tick = useEffectEvent(async (isCurrent: () => boolean) => {
    if (!options.ready || options.isSeekPending() || isControlPending()) return;
    const result = await partyApi.report(
      room.session,
      {
        media: options.media,
        posMs: Math.max(0, Math.round(options.clock.ref.current * 1000)),
        paused: !options.playing,
        rate: options.rate,
        durMs: Math.max(0, Math.round(options.duration * 1000)),
        buffering: options.buffering,
      },
      options.streamKeyRef.current || null,
      token.current,
    );
    if (!isCurrent() || !options.ready || options.isSeekPending()) return;
    if (result.paused === true) {
      await setMpvProperty('pause', true);
      if (!isCurrent()) return;
    }
    if (result.seekMs !== null) {
      await options.seek(result.seekMs / 1000);
      if (!isCurrent()) return;
    }
    if (result.paused === false) {
      await setMpvProperty('pause', false);
      if (!isCurrent()) return;
    }
    if (result.rate !== null) {
      ownsSpeed.current = true;
      await setMpvProperty('speed', result.rate);
      if (!isCurrent()) return;
    }
    token.current = result.token;
    for (const notice of result.notices) options.announce(describeNotice(notice), 'party');
  });

  const reportFailure = useEffectEvent(() =>
    options.announce('Party sync interrupted. Your playback continues.', 'party'),
  );
  const mediaKey = partyMediaKey(options.media);
  useEffect(() => {
    token.current = '';
    if (!active || !options.ready) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const run = async () => {
      if (reportInFlight.current) {
        timer = setTimeout(() => void run(), 500);
        return;
      }
      reportInFlight.current = true;
      try {
        const epoch = controlEpoch.current;
        await tick(() => !disposed && controlEpoch.current === epoch);
        failures = 0;
      } catch {
        if (!disposed && ++failures === 3) reportFailure();
      } finally {
        reportInFlight.current = false;
      }
      if (!disposed) timer = setTimeout(() => void run(), failures ? 2500 : 500);
    };
    void run();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [active, room.session, mediaKey, options.resetKey, options.ready, controlEpoch]);

  const restoreRate = useEffectEvent((isCurrent: () => boolean) => {
    if (ownsSpeed.current && options.ready) {
      void setMpvProperty('speed', options.soloRate)
        .then(() => {
          if (isCurrent()) ownsSpeed.current = false;
        })
        .catch(() => undefined);
    }
  });
  useEffect(() => {
    let disposed = false;
    if (!active) restoreRate(() => !disposed);
    return () => {
      disposed = true;
    };
  }, [active, options.ready, room.session, options.resetKey]);
  const onRoomMedia = active && partyMediaKey(room.playback?.media) === mediaKey;
  return {
    displayedRate: onRoomMedia ? (room.playback?.rate ?? options.rate) : options.rate,
    /** Synced to someone else's playback of this media. */
    following: onRoomMedia && !room.playbackIsLocal,
  };
}

export function usePartyControls(
  seek: (seconds: number) => Promise<void>,
  seekRelative: (seconds: number) => Promise<void>,
) {
  const { room, beginControl, controlEpoch } = useParty();
  const { session: playerSession } = usePlayerSession();
  // A local control only takes the room while the player is on its media —
  // pausing a different title must not retitle everyone's playback. The
  // explicit "Share what I'm watching" action in the panel stays a
  // deliberate takeover and bypasses this.
  const matchesRoomMedia = playerMatchesMedia(playerSession, room.playback?.media);
  const runControl = useCallback(
    async (operation: () => Promise<void>) => {
      const finishControl = beginControl();
      const epoch = controlEpoch.current;
      try {
        await operation();
        if (controlEpoch.current === epoch && room.active && room.syncing && matchesRoomMedia)
          await partyApi.follow(room.session, true).catch(() => undefined);
      } finally {
        finishControl();
      }
    },
    [room.active, room.syncing, room.session, matchesRoomMedia, beginControl, controlEpoch],
  );
  return {
    runControl,
    seek: useCallback((seconds: number) => runControl(() => seek(seconds)), [seek, runControl]),
    seekRelative: useCallback(
      (seconds: number) => runControl(() => seekRelative(seconds)),
      [seekRelative, runControl],
    ),
  };
}
