import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import { useDebouncedPrefsPersist } from '@/hooks/use-debounced-prefs-persist';
import type { MpvSetScheduler } from '@/hooks/use-mpv-set-scheduler';
import type { AppUiPreferences, AppUiPreferencesPatch } from '@/lib/api';

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

const SUBTITLE_FIELDS = {
  delay: { property: 'sub-delay', preference: 'subtitleDelay' },
  pos: { property: 'sub-pos', preference: 'subtitlePos' },
  scale: { property: 'sub-scale', preference: 'subtitleScale' },
} as const;

type SubtitleSetting = keyof SubtitleAdjustmentSettings;

export function useSubtitleAdjustments({
  preferences,
  updatePreferences,
  scheduleMpvSet,
}: UseSubtitleAdjustmentsArgs) {
  const [settings, setSettings] = useState<SubtitleAdjustmentSettings>({
    delay: preferences.subtitleDelay,
    pos: preferences.subtitlePos,
    scale: preferences.subtitleScale,
  });
  const settingsRef: RefObject<SubtitleAdjustmentSettings> = useRef(settings);
  const canonicalDelayRef = useRef(settings.delay);
  const delayNudgeGenerationRef = useRef(0);
  const delayNudgeChainRef = useRef<Promise<number | undefined>>(Promise.resolve(undefined));
  const sequenceRef = useRef({ delay: 0, pos: 0, scale: 0 });
  const pendingRef = useRef(new Set<SubtitleSetting>());
  const preferencesRef = useRef(preferences);
  const schedulePrefsPersist = useDebouncedPrefsPersist(updatePreferences);

  const applySubtitleSetting = useCallback(
    (key: SubtitleSetting, value: number, persist = true): Promise<number | undefined> => {
      const sequence = ++sequenceRef.current[key];
      const { property, preference } = SUBTITLE_FIELDS[key];
      pendingRef.current.add(key);
      settingsRef.current = { ...settingsRef.current, [key]: value };
      setSettings((current) => (current[key] === value ? current : { ...current, [key]: value }));
      // Preserve write-barrier/unmount flushes while native replies are pending; preference saves normalize in Rust too.
      if (persist) schedulePrefsPersist({ [preference]: value });
      return scheduleMpvSet(property, value).then((normalized) => {
        if (sequenceRef.current[key] !== sequence) return undefined;
        pendingRef.current.delete(key);
        if (normalized === undefined) return undefined;
        if (key === 'delay') canonicalDelayRef.current = normalized;
        settingsRef.current = { ...settingsRef.current, [key]: normalized };
        setSettings((current) =>
          current[key] === normalized ? current : { ...current, [key]: normalized },
        );
        if (persist) schedulePrefsPersist({ [preference]: normalized });
        return normalized;
      });
    },
    [scheduleMpvSet, schedulePrefsPersist],
  );

  const applySubtitleDelay = useCallback(
    (value: number, persist = true) => {
      delayNudgeGenerationRef.current += 1;
      const pending = applySubtitleSetting('delay', value, persist);
      delayNudgeChainRef.current = pending.catch(() => undefined);
      return pending;
    },
    [applySubtitleSetting],
  );

  useEffect(() => {
    const previous = preferencesRef.current;
    preferencesRef.current = preferences;
    for (const key of Object.keys(SUBTITLE_FIELDS) as SubtitleSetting[]) {
      const { preference } = SUBTITLE_FIELDS[key];
      const value = preferences[preference];
      if (
        value !== previous[preference] &&
        value !== settingsRef.current[key] &&
        !pendingRef.current.has(key)
      ) {
        if (key === 'delay') void applySubtitleDelay(value, false);
        else void applySubtitleSetting(key, value, false);
      }
    }
  }, [preferences, applySubtitleDelay, applySubtitleSetting]);

  useEffect(
    () => () => {
      delayNudgeGenerationRef.current += 1;
      for (const key of Object.keys(SUBTITLE_FIELDS) as SubtitleSetting[]) {
        sequenceRef.current[key] += 1;
      }
      pendingRef.current.clear();
    },
    [],
  );

  const applySubtitlePos = useCallback(
    (value: number) => applySubtitleSetting('pos', value),
    [applySubtitleSetting],
  );

  const applySubtitleScale = useCallback(
    (value: number) => applySubtitleSetting('scale', value),
    [applySubtitleSetting],
  );

  const stepSubtitleDelay = useCallback(
    (direction: 1 | -1) => {
      const generation = delayNudgeGenerationRef.current;
      delayNudgeChainRef.current = delayNudgeChainRef.current
        .then(() => {
          if (delayNudgeGenerationRef.current !== generation) return undefined;
          return applySubtitleSetting('delay', canonicalDelayRef.current + direction * 0.1);
        })
        .catch(() => undefined);
      return delayNudgeChainRef.current;
    },
    [applySubtitleSetting],
  );

  const resetSubtitleSettings = useCallback(() => {
    void applySubtitleDelay(0);
    void applySubtitlePos(100);
    void applySubtitleScale(1.0);
  }, [applySubtitleDelay, applySubtitlePos, applySubtitleScale]);

  return {
    subtitleDelay: settings.delay,
    subtitlePos: settings.pos,
    subtitleScale: settings.scale,
    subtitleSettingsRef: settingsRef,
    applySubtitleDelay,
    applySubtitlePos,
    applySubtitleScale,
    stepSubtitleDelay,
    resetSubtitleSettings,
  };
}
