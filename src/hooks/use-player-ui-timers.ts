import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import type {
  PlayerOsdAction,
  PlayerOsdMessageIcon,
  PlayerOsdState,
} from '@/components/player-osd-overlay';
import { createSubscribableStore } from '@/lib/subscribable-store';
import { clearTimer, type TimerHandle } from '@/lib/utils';

const OSD_CLEAR_DELAY_MS = 120;
const CONTROLS_HOLD_RECHECK_MS = 250;
const OSD_HIDDEN: PlayerOsdState = { action: null, visible: false };

interface UsePlayerUiTimersArgs {
  controlsHideDelayMs: number;
  isPlayingRef: RefObject<boolean>;
  mountedRef: RefObject<boolean>;
  /** OSD overlay only mounts in the expanded player — docked gestures must not churn its state. */
  osdEnabled: boolean;
  setShowControls: Dispatch<SetStateAction<boolean>>;
  /** While true, re-arms auto-hide instead of hiding (pointer on chrome, popover open). */
  shouldHoldControls?: () => boolean;
}

export function usePlayerUiTimers({
  controlsHideDelayMs,
  isPlayingRef,
  mountedRef,
  osdEnabled,
  setShowControls,
  shouldHoldControls,
}: UsePlayerUiTimersArgs) {
  const controlsTimeoutRef = useRef<TimerHandle | null>(null);
  // The OSD renders from its own store so each event re-renders only the overlay, not the player.
  const [osdStore] = useState(() => createSubscribableStore(OSD_HIDDEN));
  // Refs, not effect events: an effect event gets a new identity every render, and so would every
  // returned helper closing over it, re-firing any effect that depends on one (hide → render → show).
  const shouldHoldControlsRef = useRef(shouldHoldControls);
  const osdEnabledRef = useRef(osdEnabled);
  useLayoutEffect(() => {
    shouldHoldControlsRef.current = shouldHoldControls;
    osdEnabledRef.current = osdEnabled;
  }, [shouldHoldControls, osdEnabled]);
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
    osdStore.publish(OSD_HIDDEN);
  }, [clearOsdTimers, osdStore]);

  useEffect(() => {
    if (!osdEnabled) clearOsd();
    return clearOsdTimers;
  }, [clearOsd, clearOsdTimers, osdEnabled]);

  const scheduleControlsAutoHide = (delayMs = controlsHideDelayMs) => {
    clearControlsAutoHide();

    if (!mountedRef.current || !isPlayingRef.current) {
      return;
    }

    const arm = (waitMs: number) => {
      controlsTimeoutRef.current = window.setTimeout(() => {
        controlsTimeoutRef.current = null;
        if (!mountedRef.current || !isPlayingRef.current) return;
        if (shouldHoldControlsRef.current?.()) {
          arm(CONTROLS_HOLD_RECHECK_MS);
          return;
        }
        setShowControls(false);
      }, waitMs);
    };
    arm(delayMs);
  };

  const showControlsWithAutoHide = (delayMs = controlsHideDelayMs) => {
    setShowControls(true);
    scheduleControlsAutoHide(delayMs);
  };

  const triggerOsd = (action: PlayerOsdAction) => {
    // A seek/track acknowledgement can arrive after docking or opening a panel.
    if (!osdEnabledRef.current || !mountedRef.current) {
      return;
    }

    // Swap content in place while still visible — a hide/show cycle per wheel tick reads as flicker.
    const alreadyVisible = osdTimerRef.current !== null;
    clearOsdTimers();

    osdStore.publish({ action, visible: alreadyVisible });
    if (!alreadyVisible) {
      osdAnimationFrameRef.current = window.requestAnimationFrame(() => {
        osdAnimationFrameRef.current = null;
        osdStore.publish({ action, visible: true });
      });
    }

    const visibleMs = action.kind === 'message' ? 2800 : 900;

    osdTimerRef.current = window.setTimeout(() => {
      osdStore.publish({ action, visible: false });
      osdTimerRef.current = null;
      osdClearTimerRef.current = window.setTimeout(() => {
        osdClearTimerRef.current = null;
        osdStore.publish(OSD_HIDDEN);
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
    osdStore,
    scheduleControlsAutoHide,
    showControlsWithAutoHide,
    triggerOsd,
  };
}
