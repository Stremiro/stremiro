import { memo, type RefObject, useCallback } from 'react';
import { StreamSelector } from '@/components/stream-selector';
import { playableResumePosition } from '@/lib/history-playback';
import type { PlaybackClock } from '@/lib/player-clock';
import type { StreamSelectorTarget } from '@/lib/stream-selector-target';

interface PlayerStreamSelectorProps {
  clock: PlaybackClock;
  observedPositionRef: RefObject<number | null>;
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
  onBeforePlayerNavigation: () => void;
  target: StreamSelectorTarget;
  /** True when the picker targets the episode currently playing. */
  isCurrentEpisode: boolean;
  /** Resume position carried by the route — used until the first playback observation. */
  routeStartTime?: number;
  /** Resume position of a non-current episode target. */
  targetStartTime: number;
  currentStreamKey?: string;
}

// `startTime` is a lazy getter read at pick time — subscribing to the clock
// would re-render the selector subtree on every tick, open or closed.
export const PlayerStreamSelector = memo(function PlayerStreamSelector({
  clock,
  observedPositionRef,
  open,
  onClose,
  onClosed,
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
    return playableResumePosition(
      observedPositionRef.current === null ? undefined : clock.getSnapshot(),
      routeStartTime,
    );
  }, [clock, isCurrentEpisode, observedPositionRef, routeStartTime, targetStartTime]);

  return (
    <StreamSelector
      open={open}
      onClose={onClose}
      onClosed={onClosed}
      onBeforePlayerNavigation={onBeforePlayerNavigation}
      target={target}
      getStartTime={getStartTime}
      currentStreamKey={currentStreamKey}
    />
  );
});
