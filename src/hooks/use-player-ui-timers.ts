import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
} from 'react';

import type { PlayerOsdAction, PlayerOsdMessageIcon } from '@/components/player-osd-overlay';
import { clearTimer, type TimerHandle } from '@/lib/utils';

const CONTROLS_AUTO_HIDE_DELAY_MS = 3000;
const OSD_CLEAR_DELAY_MS = 120;

interface UsePlayerUiTimersArgs {
  isPlayingRef: RefObject<boolean>;
  mountedRef: RefObject<boolean>;
  /** The OSD overlay only mounts in the expanded player — while docked, every
   * seek/volume/track gesture would otherwise churn state for an overlay
   * that cannot paint. */
  osdEnabled: boolean;
  setOsdAction: Dispatch<SetStateAction<PlayerOsdAction | null>>;
  setOsdVisible: Dispatch<SetStateAction<boolean>>;
  setShowControls: Dispatch<SetStateAction<boolean>>;
  /** Re-arms the auto-hide instead of hiding while it returns true (pointer
      resting on the chrome, a popover open). */
  shouldHoldControls?: () => boolean;
}

export function usePlayerUiTimers({
  isPlayingRef,
  mountedRef,
  osdEnabled,
  setOsdAction,
  setOsdVisible,
  setShowControls,
  shouldHoldControls,
}: UsePlayerUiTimersArgs) {
  const controlsTimeoutRef = useRef<TimerHandle | null>(null);
  const holdRef = useRef(shouldHoldControls);
  useEffect(() => {
    holdRef.current = shouldHoldControls;
  });
  const osdTimerRef = useRef<TimerHandle | null>(null);
  const osdClearTimerRef = useRef<TimerHandle | null>(null);
  const osdAnimationFrameRef = useRef<number | null>(null);

  const clearControlsAutoHide = useCallback(() => {
    clearTimer(controlsTimeoutRef);
  }, []);

  const clearOsdTimers = useCallback(() => {
    clearTimer(osdTimerRef);
    clearTimer(osdClearTimerRef);

    if (osdAnimationFrameRef.current !== null) {
      cancelAnimationFrame(osdAnimationFrameRef.current);
      osdAnimationFrameRef.current = null;
    }
  }, []);

  const scheduleControlsAutoHide = useCallback(
    (delayMs = CONTROLS_AUTO_HIDE_DELAY_MS) => {
      clearControlsAutoHide();

      if (!isPlayingRef.current) {
        return;
      }

      const arm = () => {
        controlsTimeoutRef.current = window.setTimeout(() => {
          controlsTimeoutRef.current = null;
          if (!mountedRef.current || !isPlayingRef.current) return;
          if (holdRef.current?.()) {
            arm();
            return;
          }
          setShowControls(false);
        }, delayMs);
      };
      arm();
    },
    [clearControlsAutoHide, isPlayingRef, mountedRef, setShowControls],
  );

  const showControlsWithAutoHide = useCallback(
    (delayMs = CONTROLS_AUTO_HIDE_DELAY_MS) => {
      setShowControls(true);

      if (!isPlayingRef.current) {
        clearControlsAutoHide();
        return;
      }

      scheduleControlsAutoHide(delayMs);
    },
    [clearControlsAutoHide, isPlayingRef, scheduleControlsAutoHide, setShowControls],
  );

  const triggerOsd = useCallback(
    (action: PlayerOsdAction) => {
      if (!osdEnabled) {
        return;
      }

      // Still inside the visible window: swap content in place. A hide/show
      // cycle per wheel tick or held arrow reads as flicker.
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
    },
    [clearOsdTimers, osdEnabled, setOsdAction, setOsdVisible],
  );

  // One owner for the message-OSD shape — every announcement is the same
  // { kind: 'message', text, icon } literal.
  const announce = useCallback(
    (text: string, icon?: PlayerOsdMessageIcon) => {
      triggerOsd({ kind: 'message', text, icon });
    },
    [triggerOsd],
  );

  const clearUiTimers = useCallback(() => {
    clearControlsAutoHide();
    clearOsdTimers();
  }, [clearControlsAutoHide, clearOsdTimers]);

  return {
    announce,
    clearControlsAutoHide,
    clearUiTimers,
    showControlsWithAutoHide,
    triggerOsd,
  };
}
