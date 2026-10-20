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
  // Echoes of superseded writes must not rebase rapid relative steps.
  const pendingVolumeRef = useRef<number | null>(null);
  const wheelDeltaAccumulatorRef = useRef(0);
  const lastWheelEventAtRef = useRef(0);
  // mpv re-inits (stream swap, recovery) read this so a muted session stays muted.
  const isMutedRef = useRef(false);
  const setIsMuted = (muted: boolean) => {
    isMutedRef.current = muted;
    setIsMutedState(muted);
    if (!muted) setVolume(volumeRef.current);
  };

  const applyNativeVolume = (value: number) => {
    nativeVolumeRef.current = value;
    if (pendingVolumeRef.current !== null) {
      if (value !== pendingVolumeRef.current) return;
      pendingVolumeRef.current = null;
    }
    if (!isMutedRef.current) setVolume(value);
    volumeRef.current = value;
  };
  const applyNativeMute = (muted: boolean) => {
    nativeMutedRef.current = muted;
    setIsMuted(muted);
  };

  // Coalesce preference writes and flush the last input on unmount.
  const scheduleVolumePersist = useDebouncedPrefsPersist(updatePreferences);
  const rollbackVolume = useCallback(() => {
    pendingVolumeRef.current = null;
    const restored = nativeVolumeRef.current;
    volumeRef.current = restored;
    setVolume(restored);
    scheduleVolumePersist({ playerVolume: restored });
  }, [scheduleVolumePersist]);
  const rollbackMute = () => setIsMuted(nativeMutedRef.current);

  useEffect(() => {
    // Locally persisted volume already matches the live ref; apply only external changes.
    const volumeChanged = volumeRef.current !== playerVolume;
    setVolume(playerVolume);
    volumeRef.current = playerVolume;

    if (mpvInitializedRef.current && volumeChanged) {
      pendingVolumeRef.current = playerVolume;
      void scheduleMpvSet('volume', playerVolume, rollbackVolume);
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
    pendingVolumeRef.current = newVol;
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

    // One notch is one 5% step whatever its pixel delta; fine trackpad input needs 4px for each 1%.
    if (Math.abs(normalizedDelta) >= 20) {
      wheelDeltaAccumulatorRef.current = 0;
      return stepVolume(-Math.sign(normalizedDelta) * 5);
    }
    const steps = Math.trunc(wheelDeltaAccumulatorRef.current / 4);
    if (steps === 0) return;
    wheelDeltaAccumulatorRef.current -= steps * 4;
    await stepVolume(-steps);
  };

  const toggleMute = async () => {
    // At 0% the button already shows muted; pressing it means "sound back".
    if (isMutedRef.current || volumeRef.current === 0) {
      return handleVolumeChange(volumeRef.current > 0 ? volumeRef.current : 50);
    }
    setIsMuted(true);
    triggerOsd({ kind: 'volume', level: 0 });
    await scheduleMpvSet('mute', true, rollbackMute);
  };

  return {
    volume: isMuted ? 0 : volume,
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
