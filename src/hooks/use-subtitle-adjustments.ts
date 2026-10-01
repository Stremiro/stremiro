import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import { useDebouncedPrefsPersist } from '@/hooks/use-debounced-prefs-persist';
import type { AppUiPreferences, AppUiPreferencesPatch } from '@/lib/api';
import { clamp } from '@/lib/utils';

type MpvSetScheduler = (property: string, value: number) => void;
type SubtitlePreferenceValues = Pick<
  AppUiPreferences,
  'subtitleDelay' | 'subtitlePos' | 'subtitleScale'
>;

/** The triple mpv receives at stream load — lifecycle reads the ref at apply
    time so a mid-init pref hydration can never bind stale defaults. */
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

// Subtitle fine-tuning state + mpv pushes for the player subtitle popover.
// Values are clamped/quantized here so every entry point (sliders, hotkeys,
// reset) converges on the same mpv-safe numbers; `scheduleMpvSet` is the
// shared rAF coalescer so drags don't storm the IPC. Settings persist via
// app-UI prefs so tuning survives the per-episode remount.
export function useSubtitleAdjustments({
  preferences,
  updatePreferences,
  scheduleMpvSet,
}: UseSubtitleAdjustmentsArgs) {
  const [subtitleDelay, setSubtitleDelay] = useState(preferences.subtitleDelay);
  const [subtitlePos, setSubtitlePos] = useState(preferences.subtitlePos);
  const [subtitleScale, setSubtitleScale] = useState(preferences.subtitleScale);

  // What mpv should be running: doubles as the lifecycle's load-time read and
  // the echo guard — a pref equal to this was our own write coming back.
  const settingsRef: RefObject<SubtitleAdjustmentSettings> = useRef({
    delay: preferences.subtitleDelay,
    pos: preferences.subtitlePos,
    scale: preferences.subtitleScale,
  });

  // External pref writes (initial hydration) apply only when
  // they differ from our last write — the same echo guard volume uses.
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

  // Slider ticks fire per pointermove; `updatePreferences` writes the RQ
  // cache synchronously, so a direct call re-renders every pref subscriber
  // (the whole player tree) per tick.
  const schedulePrefsPersist = useDebouncedPrefsPersist(updatePreferences);

  // Returns the applied (clamped/quantized) value so callers echoing it —
  // e.g. the `z`/`x` hotkey OSD — never drift from what mpv received.
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
