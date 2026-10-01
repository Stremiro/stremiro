import { memo, useCallback } from 'react';
import { StreamSelector } from '@/components/stream-selector';
import { playableResumePosition } from '@/lib/history-playback';
import type { PlaybackClock } from '@/lib/player-clock';
import type { StreamSelectorTarget } from '@/lib/stream-selector-target';

interface PlayerStreamSelectorProps {
  clock: PlaybackClock;
  open: boolean;
  onClose: () => void;
  onBeforePlayerNavigation: () => void;
  target: StreamSelectorTarget;
  /** True when the picker targets the episode currently playing. */
  isCurrentEpisode: boolean;
  /** Resume position carried by the route — used until playback passes 5s. */
  routeStartTime?: number;
  /** Resume position of a non-current episode target. */
  targetStartTime: number;
  currentStreamKey?: string;
}

// `startTime` is a lazy getter read at pick time — subscribing to the clock
// would re-render the selector subtree on every tick, open or closed.
// Memoized: every prop is a primitive or stable callback so unrelated player
// renders don't re-render the mounted selector.
export const PlayerStreamSelector = memo(function PlayerStreamSelector({
  clock,
  open,
  onClose,
  onBeforePlayerNavigation,
  target,
  isCurrentEpisode,
  routeStartTime,
  targetStartTime,
  currentStreamKey,
}: PlayerStreamSelectorProps) {
  const getStartTime = useCallback(() => {
    if (!isCurrentEpisode) {
      return targetStartTime;
    }
    // Live position wins; the route's carried startTime is the fallback.
    return playableResumePosition(clock.getSnapshot(), routeStartTime) ?? 0;
  }, [clock, isCurrentEpisode, routeStartTime, targetStartTime]);

  // `StreamSelector` renders through a `DialogPortal`, so it escapes into
  // `body` and needs no positioning wrapper here — this component only
  // provides the clock-derived `getStartTime`.
  return (
    <StreamSelector
      open={open}
      onClose={onClose}
      onBeforePlayerNavigation={onBeforePlayerNavigation}
      target={target}
      getStartTime={getStartTime}
      currentStreamKey={currentStreamKey}
    />
  );
});
