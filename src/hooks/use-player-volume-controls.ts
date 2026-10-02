import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import type { PlayerOsdAction } from '@/components/player-osd-overlay';
import { useDebouncedPrefsPersist } from '@/hooks/use-debounced-prefs-persist';
import type { AppUiPreferencesPatch } from '@/lib/api';
import { setMpvProperty } from '@/lib/player-mpv';
import { clamp } from '@/lib/utils';

type MpvSetScheduler = (property: string, value: number) => void;

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
  // mpv re-inits (stream swap, recovery) read this so a muted session stays muted.
  const isMutedRef = useRef(false);
  const setIsMuted = useCallback((muted: boolean) => {
    isMutedRef.current = muted;
    setIsMutedState(muted);
  }, []);

  useEffect(() => {
    const nextVolume = playerVolume;
    // Locally persisted volume already matches the live ref; apply only external changes.
    const volumeChanged = volumeRef.current !== nextVolume;
    setVolume((current) => (current === nextVolume ? current : nextVolume));
    volumeRef.current = nextVolume;

    if (mpvInitializedRef.current && volumeChanged) {
      void setMpvProperty('volume', nextVolume).catch(() => undefined);
    }
  }, [playerVolume, mpvInitializedRef]);

  // Coalesce preference writes and flush the last input on unmount.
  const scheduleVolumePersist = useDebouncedPrefsPersist(updatePreferences);

  const handleVolumeChange = useCallback(
    async (newVol: number) => {
      setVolume(newVol);
      volumeRef.current = newVol;
      scheduleVolumePersist({ playerVolume: newVol });
      scheduleMpvSet('volume', newVol);
      triggerOsd({ kind: 'volume', level: newVol });
      if (newVol > 0 && isMuted) {
        setIsMuted(false);
        await setMpvProperty('mute', false);
      }
    },
    [isMuted, scheduleMpvSet, scheduleVolumePersist, setIsMuted, triggerOsd],
  );

  // Relative changes use the live ref so rapid inputs accumulate.
  const stepVolume = useCallback(
    async (delta: number) => {
      // Stepping down while muted must not unmute to a louder level.
      if (isMuted && delta < 0) {
        triggerOsd({ kind: 'volume', level: 0 });
        return;
      }
      await handleVolumeChange(clamp(volumeRef.current + delta, 0, 100));
    },
    [handleVolumeChange, isMuted, triggerOsd],
  );

  const toggleMute = useCallback(async () => {
    // At 0% the button already shows muted; pressing it means "sound back".
    if (!isMuted && volumeRef.current === 0) {
      await handleVolumeChange(50);
      return;
    }
    const newMute = !isMuted;
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
      scheduleMpvSet('volume', restored);
      triggerOsd({ kind: 'volume', level: restored });
    }
    await setMpvProperty('mute', newMute);
  }, [handleVolumeChange, isMuted, scheduleMpvSet, scheduleVolumePersist, setIsMuted, triggerOsd]);

  return {
    volume,
    setVolume,
    isMuted,
    setIsMuted,
    isMutedRef,
    volumeRef,
    handleVolumeChange,
    stepVolume,
    toggleMute,
  };
}
