import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import { useDebouncedPrefsPersist } from '@/hooks/use-debounced-prefs-persist';
import type { AppUiPreferences, AppUiPreferencesPatch } from '@/lib/api';
import { clamp } from '@/lib/utils';

type MpvSetScheduler = (property: string, value: number) => void;
type SubtitlePreferenceValues = Pick<
  AppUiPreferences,
  'subtitleDelay' | 'subtitlePos' | 'subtitleScale'
>;

/** The triple mpv receives at stream load — read at apply time so mid-init hydration can't bind stale values. */
export interface SubtitleAdjustmentSettings {
  delay: number;
  pos: number;
  scale: number;
}

interface UseSubtitleAdjustmentsArgs {
  preferences: SubtitlePreferenceValues;
  updatePreferences: (patch: AppUiPreferencesPatch) => void;
  scheduleMpvSet: MpvSetScheduler;
}

// Subtitle fine-tuning for the player popover: all entry points clamp/quantize here so they
// converge on mpv-safe numbers; `scheduleMpvSet` coalesces drags; prefs persist via app-UI prefs.
export function useSubtitleAdjustments({
  preferences,
  updatePreferences,
  scheduleMpvSet,
}: UseSubtitleAdjustmentsArgs) {
  const [subtitleDelay, setSubtitleDelay] = useState(preferences.subtitleDelay);
  const [subtitlePos, setSubtitlePos] = useState(preferences.subtitlePos);
  const [subtitleScale, setSubtitleScale] = useState(preferences.subtitleScale);

  // What mpv should run: lifecycle load-time read + echo guard — a pref equal to this was our own write.
  const settingsRef: RefObject<SubtitleAdjustmentSettings> = useRef({
    delay: preferences.subtitleDelay,
    pos: preferences.subtitlePos,
    scale: preferences.subtitleScale,
  });

  // External writes (hydration) apply only when they differ from our last write — same echo guard as volume.
  useEffect(() => {
    const current = settingsRef.current;
    if (
      current.delay === preferences.subtitleDelay &&
      current.pos === preferences.subtitlePos &&
      current.scale === preferences.subtitleScale
    ) {
      return;
    }
    settingsRef.current = {
      delay: preferences.subtitleDelay,
      pos: preferences.subtitlePos,
      scale: preferences.subtitleScale,
    };
    setSubtitleDelay(preferences.subtitleDelay);
    setSubtitlePos(preferences.subtitlePos);
    setSubtitleScale(preferences.subtitleScale);
    scheduleMpvSet('sub-delay', preferences.subtitleDelay);
    scheduleMpvSet('sub-pos', preferences.subtitlePos);
    scheduleMpvSet('sub-scale', preferences.subtitleScale);
  }, [
    preferences.subtitleDelay,
    preferences.subtitlePos,
    preferences.subtitleScale,
    scheduleMpvSet,
  ]);

  // Slider ticks fire per pointermove — `updatePreferences` re-renders the whole player tree, so debounce it.
  const schedulePrefsPersist = useDebouncedPrefsPersist(updatePreferences);

  // Returns the applied value so echoing callers (z/x hotkey OSD) never drift from what mpv got.
  const applySubtitleDelay = useCallback(
    (value: number): number => {
      const next = Math.round(clamp(value, -5, 5) * 10) / 10;
      settingsRef.current = { ...settingsRef.current, delay: next };
      setSubtitleDelay(next);
      scheduleMpvSet('sub-delay', next);
      schedulePrefsPersist({ subtitleDelay: next });
      return next;
    },
    [scheduleMpvSet, schedulePrefsPersist],
  );

  const applySubtitlePos = useCallback(
    (value: number) => {
      const next = clamp(value, 0, 100);
      settingsRef.current = { ...settingsRef.current, pos: next };
      setSubtitlePos(next);
      scheduleMpvSet('sub-pos', next);
      schedulePrefsPersist({ subtitlePos: next });
    },
    [scheduleMpvSet, schedulePrefsPersist],
  );

  const applySubtitleScale = useCallback(
    (value: number) => {
      const next = Math.round(clamp(value, 0.25, 3.0) * 20) / 20; // round to 0.05
      settingsRef.current = { ...settingsRef.current, scale: next };
      setSubtitleScale(next);
      scheduleMpvSet('sub-scale', next);
      schedulePrefsPersist({ subtitleScale: next });
    },
    [scheduleMpvSet, schedulePrefsPersist],
  );

  const resetSubtitleSettings = useCallback(() => {
    applySubtitleDelay(0);
    applySubtitlePos(100);
    applySubtitleScale(1.0);
  }, [applySubtitleDelay, applySubtitlePos, applySubtitleScale]);

  return {
    subtitleDelay,
    subtitlePos,
    subtitleScale,
    subtitleSettingsRef: settingsRef,
    applySubtitleDelay,
    applySubtitlePos,
    applySubtitleScale,
    resetSubtitleSettings,
  };
}
