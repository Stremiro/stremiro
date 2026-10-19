import { type RefObject, useCallback, useEffect, useRef } from 'react';
import { mpvCommand, seekAbsoluteSeconds } from '@/lib/player-mpv';

import type { PlayerOsdAction } from '@/components/player-osd-overlay';
import type { PlaybackClock } from '@/lib/player-clock';

// Optimistic-seek protocol: publish the target into the clock immediately; ticks still
// reporting the pre-seek position are swallowed until settle or hold lapse.
const OPTIMISTIC_SEEK_HOLD_MS = 450;
const OPTIMISTIC_SEEK_SETTLED_DELTA_SECS = 1.1;
// Same-direction relative seeks in this window report one running offset — matches the seek OSD's visible window.
const SEEK_STREAK_WINDOW_MS = 900;

interface SeekStreak {
  direction: number;
  origin: number;
  at: number;
}

interface UseOptimisticSeekArgs {
  clock: PlaybackClock;
  /** Mirrors every `setDuration` write so the seek chain keeps one identity all session. */
  durationRef: RefObject<number>;
  /** Stream-scoped reset — a swap abandons in-flight seeks, so pending targets must not swallow new-stream ticks. */
  resetKey?: string;
  onUserSeek: () => void;
  triggerOsd: (action: PlayerOsdAction) => void;
}

export function useOptimisticSeek({
  clock,
  durationRef,
  resetKey,
  onUserSeek,
  triggerOsd,
}: UseOptimisticSeekArgs) {
  const pendingSeekTargetRef = useRef<number | null>(null);
  const pendingSeekDeadlineRef = useRef(0);
  // Bumped on prime and clear — a late rejection must not roll the clock back over a fresher position.
  const seekGenerationRef = useRef(0);
  // Announcement epoch, bumped on prime/reset only — a late ack still earned its announcement, so a settle tick must NOT bump it.
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
    return () => {
      clearOptimisticSeek();
      seekAnnounceEpochRef.current += 1;
    };
  }, [resetKey, clearOptimisticSeek]);

  /** time-pos gate: true while the tick should be swallowed in favor of the pending target. */
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
      command: (boundedTarget: number) => Promise<void>,
      osd: (boundedTarget: number) => PlayerOsdAction,
      source: 'user' | 'automatic' = 'user',
      onComplete?: () => void,
    ) => {
      if (source !== 'automatic') onUserSeek();
      const previousTime = currentTimeRef.current;
      const boundedTarget = primeOptimisticSeek(targetTime);
      const generation = seekGenerationRef.current;
      const announceEpoch = seekAnnounceEpochRef.current;

      try {
        await command(boundedTarget);
      } catch (seekError) {
        // Roll back only while this seek still owns the pending slot — publishing the pre-seek time would stomp a newer prime.
        if (seekGenerationRef.current === generation) {
          clearOptimisticSeek();
          clock.publish(previousTime);
        }
        throw seekError;
      }

      // Announce only while this seek owns the epoch — an out-of-order ack must not flash a stale target.
      if (seekAnnounceEpochRef.current === announceEpoch) {
        triggerOsd(osd(boundedTarget));
        onComplete?.();
      }
    },
    [clearOptimisticSeek, clock, currentTimeRef, onUserSeek, primeOptimisticSeek, triggerOsd],
  );

  const seek = useCallback(
    (seconds: number, source: 'user' | 'automatic' = 'user', onComplete?: () => void) => {
      seekStreakRef.current = null;
      return runSeek(
        seconds,
        seekAbsoluteSeconds,
        // Absolute jumps (percent keys, bar release, skips) had no feedback — show the landing point.
        (boundedTarget) => ({ kind: 'seek', target: boundedTarget }),
        source,
        onComplete,
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
        (boundedTarget) => mpvCommand('seek', [(boundedTarget - baseTime).toString(), 'relative']),
        (boundedTarget) => ({
          kind: 'seek',
          direction: seconds > 0 ? 'forward' : 'backward',
          // Offset travelled since the streak began so end-clamping never reports seconds that didn't happen.
          seconds: Math.round(Math.abs(boundedTarget - streak.origin)),
          target: boundedTarget,
        }),
      );
    },
    [runSeek, currentTimeRef],
  );

  // Position-probe gate: a pending seek means position is about to move — the paused poll must keep ticking until settle or hold lapse.
  const isSeekPending = useCallback(() => pendingSeekTargetRef.current !== null, []);

  return { isSeekPending, observeTimeUpdate, seek, seekRelative };
}
