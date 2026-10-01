import { type RefObject, useCallback, useEffect, useRef } from 'react';
import { mpvCommand } from '@/lib/player-mpv';

import type { PlayerOsdAction } from '@/components/player-osd-overlay';
import type { PlaybackClock } from '@/lib/player-clock';

// Optimistic-seek protocol: `seek`/`seekRelative` publish the target into the
// clock immediately so the playhead snaps without waiting on mpv's throttled
// time-pos. Ticks still reporting the pre-seek position are swallowed until
// settle or the hold window lapses.
const OPTIMISTIC_SEEK_HOLD_MS = 450;
const OPTIMISTIC_SEEK_SETTLED_DELTA_SECS = 1.1;
// Same-direction relative seeks inside this window report one running offset
// ("+30s" after three taps) — matches the seek OSD's visible window.
const SEEK_STREAK_WINDOW_MS = 900;

interface SeekStreak {
  direction: number;
  origin: number;
  at: number;
}

interface UseOptimisticSeekArgs {
  clock: PlaybackClock;
  /** Mirrors every `setDuration` write, so the seek chain keeps one identity
      for the whole session instead of re-forming when duration lands. */
  durationRef: RefObject<number>;
  /** Stream-scoped reset (activeStreamUrl): a swap abandons any in-flight
      seek, so the pending target must not swallow the new stream's ticks. */
  resetKey?: string;
  triggerOsd: (action: PlayerOsdAction) => void;
}

export function useOptimisticSeek({
  clock,
  durationRef,
  resetKey,
  triggerOsd,
}: UseOptimisticSeekArgs) {
  const pendingSeekTargetRef = useRef<number | null>(null);
  const pendingSeekDeadlineRef = useRef(0);
  // Bumped on every prime and every clear: a command that rejects after a
  // newer seek primed (or the gate already cleared) must not roll the clock
  // back over the fresher position.
  const seekGenerationRef = useRef(0);
  // Separate announcement epoch, bumped on prime and stream swap only: a seek
  // resolving out of order must not announce an older target, but a settle
  // tick must NOT bump it — a late ack still earned the announcement.
  const seekAnnounceEpochRef = useRef(0);
  const seekStreakRef = useRef<SeekStreak | null>(null);
  const currentTimeRef = clock.ref;

  const clearOptimisticSeek = useCallback(() => {
    pendingSeekTargetRef.current = null;
    pendingSeekDeadlineRef.current = 0;
    seekGenerationRef.current += 1;
  }, []);

  useEffect(() => {
    clearOptimisticSeek();
    seekAnnounceEpochRef.current += 1;
    seekStreakRef.current = null;
  }, [resetKey, clearOptimisticSeek]);

  /** time-pos gate for the mpv property observer: returns true while the tick
      should be swallowed in favor of the pending optimistic target. */
  const observeTimeUpdate = useCallback(
    (timePos: number, now: number): boolean => {
      const pendingSeekTarget = pendingSeekTargetRef.current;
      if (pendingSeekTarget === null) return false;

      const seekSettled =
        Math.abs(timePos - pendingSeekTarget) <= OPTIMISTIC_SEEK_SETTLED_DELTA_SECS;
      if (!seekSettled && now < pendingSeekDeadlineRef.current) {
        return true;
      }

      clearOptimisticSeek();
      return false;
    },
    [clearOptimisticSeek],
  );

  const primeOptimisticSeek = useCallback(
    (targetTime: number) => {
      const now = performance.now();
      const effectiveDuration = durationRef.current;
      const boundedTarget = Math.max(
        0,
        effectiveDuration > 0 ? Math.min(effectiveDuration, targetTime) : targetTime,
      );

      pendingSeekTargetRef.current = boundedTarget;
      pendingSeekDeadlineRef.current = now + OPTIMISTIC_SEEK_HOLD_MS;
      seekGenerationRef.current += 1;
      seekAnnounceEpochRef.current += 1;
      clock.publish(boundedTarget);

      return boundedTarget;
    },
    [clock, durationRef],
  );

  const runSeek = useCallback(
    async (
      targetTime: number,
      commandArgs: (boundedTarget: number) => [string, string],
      osd: (boundedTarget: number) => PlayerOsdAction,
    ) => {
      const previousTime = currentTimeRef.current;
      const boundedTarget = primeOptimisticSeek(targetTime);
      const generation = seekGenerationRef.current;
      const announceEpoch = seekAnnounceEpochRef.current;

      try {
        await mpvCommand('seek', commandArgs(boundedTarget));
      } catch (seekError) {
        // Roll back only while this seek still owns the pending slot —
        // otherwise the display already tracks a newer prime or the settled
        // position, and publishing the pre-seek time would stomp it.
        if (seekGenerationRef.current === generation) {
          clearOptimisticSeek();
          clock.publish(previousTime);
        }
        throw seekError;
      }

      // Announce only while this seek still owns the announcement epoch —
      // an out-of-order ack from an older seek (or a stream swap) must not
      // flash a stale target over the newer position.
      if (seekAnnounceEpochRef.current === announceEpoch) {
        triggerOsd(osd(boundedTarget));
      }
    },
    [clearOptimisticSeek, clock, currentTimeRef, primeOptimisticSeek, triggerOsd],
  );

  const seek = useCallback(
    (seconds: number) => {
      seekStreakRef.current = null;
      return runSeek(
        seconds,
        (boundedTarget) => [boundedTarget.toString(), 'absolute'],
        // Absolute jumps (percent keys, bar release, segment skips) had no
        // feedback — show where playback landed.
        (boundedTarget) => ({ kind: 'seek', target: boundedTarget }),
      );
    },
    [runSeek],
  );

  const seekRelative = useCallback(
    (seconds: number) => {
      const baseTime = pendingSeekTargetRef.current ?? currentTimeRef.current;
      const now = performance.now();
      const direction = Math.sign(seconds);
      const previousStreak = seekStreakRef.current;
      const streak: SeekStreak =
        previousStreak?.direction === direction && now - previousStreak.at < SEEK_STREAK_WINDOW_MS
          ? { ...previousStreak, at: now }
          : { direction, origin: baseTime, at: now };
      seekStreakRef.current = streak;
      return runSeek(
        baseTime + seconds,
        (boundedTarget) => [(boundedTarget - baseTime).toString(), 'relative'],
        (boundedTarget) => ({
          kind: 'seek',
          direction: seconds > 0 ? 'forward' : 'backward',
          // Offset actually travelled since the streak began, so clamping at
          // either end never reports seconds that didn't happen.
          seconds: Math.round(Math.abs(boundedTarget - streak.origin)),
          target: boundedTarget,
        }),
      );
    },
    [runSeek, currentTimeRef],
  );

  // Position-probe gate: a pending seek means the stream position is about
  // to move — the paused-state poll idle-out must keep ticking until the
  // settle tick lands (or the hold window lapses).
  const isSeekPending = useCallback(() => pendingSeekTargetRef.current !== null, []);

  return { isSeekPending, observeTimeUpdate, seek, seekRelative };
}
