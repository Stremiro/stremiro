import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import type { PlayerOsdAction } from '@/components/player-osd-overlay';
import { useDebouncedPrefsPersist } from '@/hooks/use-debounced-prefs-persist';
import type { MpvSetScheduler } from '@/hooks/use-mpv-set-scheduler';
import type { AppUiPreferencesPatch } from '@/lib/api';
import { clamp } from '@/lib/utils';

interface UsePlayerVolumeControlsArgs {
  playerVolume: number;
  updatePreferences: (patch: AppUiPreferencesPatch) => void;
  mpvInitializedRef: RefObject<boolean>;
  scheduleMpvSet: MpvSetScheduler;
  triggerOsd: (action: PlayerOsdAction) => void;
}

export function usePlayerVolumeControls({
  playerVolume,
  updatePreferences,
  mpvInitializedRef,
  scheduleMpvSet,
  triggerOsd,
}: UsePlayerVolumeControlsArgs) {
  const [volume, setVolume] = useState(() => playerVolume);
  const [isMuted, setIsMutedState] = useState(false);
  const volumeRef = useRef(volume);
  const nativeVolumeRef = useRef(playerVolume);
  const nativeMutedRef = useRef(false);
  const wheelDeltaAccumulatorRef = useRef(0);
  const lastWheelEventAtRef = useRef(0);
  // mpv re-inits (stream swap, recovery) read this so a muted session stays muted.
  const isMutedRef = useRef(false);
  const setIsMuted = (muted: boolean) => {
    isMutedRef.current = muted;
    setIsMutedState(muted);
  };

  const applyNativeVolume = (value: number) => {
    nativeVolumeRef.current = value;
    // Muted chrome shows 0; the ref keeps the level to restore.
    if (!isMutedRef.current) setVolume(value);
    volumeRef.current = value;
  };
  const applyNativeMute = (muted: boolean) => {
    nativeMutedRef.current = muted;
    setIsMuted(muted);
    setVolume(muted ? 0 : volumeRef.current);
  };

  // Coalesce preference writes and flush the last input on unmount.
  const scheduleVolumePersist = useDebouncedPrefsPersist(updatePreferences);
  const rollbackVolume = useCallback(() => {
    const restored = nativeVolumeRef.current;
    volumeRef.current = restored;
    setVolume(isMutedRef.current ? 0 : restored);
    scheduleVolumePersist({ playerVolume: restored });
  }, [scheduleVolumePersist]);
  const rollbackMute = () => {
    const restored = nativeMutedRef.current;
    setIsMuted(restored);
    setVolume(restored ? 0 : volumeRef.current);
  };

  useEffect(() => {
    const nextVolume = playerVolume;
    // Locally persisted volume already matches the live ref; apply only external changes.
    const volumeChanged = volumeRef.current !== nextVolume;
    const displayedVolume = isMutedRef.current ? 0 : nextVolume;
    setVolume(displayedVolume);
    volumeRef.current = nextVolume;

    if (mpvInitializedRef.current && volumeChanged) {
      void scheduleMpvSet('volume', nextVolume, rollbackVolume);
    }
  }, [playerVolume, mpvInitializedRef, scheduleMpvSet, rollbackVolume]);

  const handleVolumeChange = async (newVol: number) => {
    newVol = clamp(newVol, 0, 100);
    if (newVol === volumeRef.current && !(newVol > 0 && isMutedRef.current)) {
      triggerOsd({ kind: 'volume', level: newVol });
      return;
    }
    setVolume(newVol);
    volumeRef.current = newVol;
    scheduleVolumePersist({ playerVolume: newVol });
    void scheduleMpvSet('volume', newVol, rollbackVolume);
    triggerOsd({ kind: 'volume', level: newVol });
    if (newVol > 0 && isMutedRef.current) {
      setIsMuted(false);
      await scheduleMpvSet('mute', false, rollbackMute);
    }
  };

  // Relative changes use the live ref so rapid inputs accumulate.
  const stepVolume = async (delta: number) => {
    // Stepping down while muted must not unmute to a louder level.
    if (isMutedRef.current && delta < 0) {
      triggerOsd({ kind: 'volume', level: 0 });
      return;
    }
    await handleVolumeChange(volumeRef.current + delta);
  };

  const handleVolumeWheel = async (event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>) => {
    const normalizedDelta =
      event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? 100 : 1);
    if (!Number.isFinite(normalizedDelta) || normalizedDelta === 0) return;

    const now = performance.now();
    if (
      now - lastWheelEventAtRef.current > 250 ||
      Math.sign(normalizedDelta) !== Math.sign(wheelDeltaAccumulatorRef.current)
    ) {
      wheelDeltaAccumulatorRef.current = 0;
    }
    lastWheelEventAtRef.current = now;
    wheelDeltaAccumulatorRef.current += normalizedDelta;

    // Notched wheels retain 5% steps; fine trackpad input needs 4px for each 1%.
    const notched = Math.abs(normalizedDelta) >= 20;
    const threshold = notched ? 20 : 4;
    const steps = Math.trunc(wheelDeltaAccumulatorRef.current / threshold);
    if (steps === 0) return;
    wheelDeltaAccumulatorRef.current -= steps * threshold;
    await stepVolume(-steps * (notched ? 5 : 1));
  };

  const toggleMute = async () => {
    // At 0% the button already shows muted; pressing it means "sound back".
    if (!isMutedRef.current && volumeRef.current === 0) {
      await handleVolumeChange(50);
      return;
    }
    const newMute = !isMutedRef.current;
    setIsMuted(newMute);
    if (newMute) {
      setVolume(0);
      triggerOsd({ kind: 'volume', level: 0 });
    } else {
      const restored = volumeRef.current > 0 ? volumeRef.current : 50;
      setVolume(restored);
      volumeRef.current = restored;
      scheduleVolumePersist({ playerVolume: restored });
      // Replace any pending volume write with the restored value.
      void scheduleMpvSet('volume', restored, rollbackVolume);
      triggerOsd({ kind: 'volume', level: restored });
    }
    await scheduleMpvSet('mute', newMute, rollbackMute);
  };

  return {
    volume,
    applyNativeVolume,
    isMuted,
    applyNativeMute,
    isMutedRef,
    volumeRef,
    handleVolumeChange,
    handleVolumeWheel,
    stepVolume,
    toggleMute,
  };
}
