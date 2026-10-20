import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useEffectEvent,
  useRef,
} from 'react';

import type { PlayerOsdAction, PlayerOsdMessageIcon } from '@/components/player-osd-overlay';
import { clearTimer, type TimerHandle } from '@/lib/utils';

const OSD_CLEAR_DELAY_MS = 120;

interface UsePlayerUiTimersArgs {
  controlsHideDelayMs: number;
  isPlayingRef: RefObject<boolean>;
  mountedRef: RefObject<boolean>;
  /** OSD overlay only mounts in the expanded player — docked gestures must not churn its state. */
  osdEnabled: boolean;
  setOsdAction: Dispatch<SetStateAction<PlayerOsdAction | null>>;
  setOsdVisible: Dispatch<SetStateAction<boolean>>;
  setShowControls: Dispatch<SetStateAction<boolean>>;
  /** While true, re-arms auto-hide instead of hiding (pointer on chrome, popover open). */
  shouldHoldControls?: () => boolean;
}

export function usePlayerUiTimers({
  controlsHideDelayMs,
  isPlayingRef,
  mountedRef,
  osdEnabled,
  setOsdAction,
  setOsdVisible,
  setShowControls,
  shouldHoldControls,
}: UsePlayerUiTimersArgs) {
  const controlsTimeoutRef = useRef<TimerHandle | null>(null);
  const shouldHoldControlsNow = useEffectEvent(() => shouldHoldControls?.());
  const canShowOsdNow = useEffectEvent(() => osdEnabled && mountedRef.current);
  const osdTimerRef = useRef<TimerHandle | null>(null);
  const osdClearTimerRef = useRef<TimerHandle | null>(null);
  const osdAnimationFrameRef = useRef<number | null>(null);

  const clearControlsAutoHide = () => {
    clearTimer(controlsTimeoutRef);
  };

  const clearOsdTimers = useCallback(() => {
    clearTimer(osdTimerRef);
    clearTimer(osdClearTimerRef);

    if (osdAnimationFrameRef.current !== null) {
      cancelAnimationFrame(osdAnimationFrameRef.current);
      osdAnimationFrameRef.current = null;
    }
  }, []);

  const clearOsd = useCallback(() => {
    clearOsdTimers();
    setOsdVisible(false);
    setOsdAction(null);
  }, [clearOsdTimers, setOsdAction, setOsdVisible]);

  useEffect(() => {
    if (!osdEnabled) clearOsd();
    return clearOsdTimers;
  }, [clearOsd, clearOsdTimers, osdEnabled]);

  const showControlsWithAutoHide = (delayMs = controlsHideDelayMs) => {
    setShowControls(true);
    clearControlsAutoHide();

    if (!isPlayingRef.current) {
      return;
    }

    const arm = () => {
      controlsTimeoutRef.current = window.setTimeout(() => {
        controlsTimeoutRef.current = null;
        if (!mountedRef.current || !isPlayingRef.current) return;
        if (shouldHoldControlsNow()) {
          arm();
          return;
        }
        setShowControls(false);
      }, delayMs);
    };
    arm();
  };

  const triggerOsd = (action: PlayerOsdAction) => {
    // A seek/track acknowledgement can arrive after docking or opening a panel.
    if (!canShowOsdNow()) {
      return;
    }

    // Swap content in place while still visible — a hide/show cycle per wheel tick reads as flicker.
    const alreadyVisible = osdTimerRef.current !== null;
    clearOsdTimers();

    setOsdAction(action);
    if (alreadyVisible) {
      setOsdVisible(true);
    } else {
      setOsdVisible(false);
      osdAnimationFrameRef.current = window.requestAnimationFrame(() => {
        osdAnimationFrameRef.current = null;
        setOsdVisible(true);
      });
    }

    const visibleMs = action.kind === 'message' ? 2800 : 900;

    osdTimerRef.current = window.setTimeout(() => {
      setOsdVisible(false);
      osdTimerRef.current = null;
      osdClearTimerRef.current = window.setTimeout(() => {
        osdClearTimerRef.current = null;
        setOsdAction(null);
      }, OSD_CLEAR_DELAY_MS);
    }, visibleMs);
  };

  // Every announcement is the same { kind: 'message', text, icon } literal.
  const announce = (text: string, icon?: PlayerOsdMessageIcon) => {
    triggerOsd({ kind: 'message', text, icon });
  };

  const clearUiTimers = () => {
    clearControlsAutoHide();
    clearOsd();
  };

  return {
    announce,
    clearControlsAutoHide,
    clearUiTimers,
    showControlsWithAutoHide,
    triggerOsd,
  };
}
