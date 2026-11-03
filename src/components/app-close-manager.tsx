import { type CloseRequestedEvent, getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useEffectEvent } from 'react';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import { isTauriDesktopRuntime } from '@/lib/app-updater';
import { flushPendingAppWrites } from '@/lib/pending-app-writes';
import { mpvDestroy, setMpvProperty } from '@/lib/player-mpv';
import { isPlayerPip, returnFromPlayerPip, waitForViewportTransition } from '@/lib/player-pip';
import { usePlayerSession } from '@/lib/player-session';
import { withTimeout } from '@/lib/utils';

// Close barrier: every awaited step is bounded — a wedged native op or viewport
// transition must not trap the window open (the OS reclaims mpv at exit).
const CLOSE_BARRIER_STEP_TIMEOUT_MS = 8_000;
const CLOSE_MPV_TEARDOWN_TIMEOUT_MS = 2_000;

export function AppCloseManager() {
  const isDesktopRuntime = isTauriDesktopRuntime();
  const { session, trayPause } = usePlayerSession();
  const hasSession = useEffectEvent(() => !!session);

  useEffect(() => {
    if (!isDesktopRuntime) return;
    const preventPlaybackReload = (event: KeyboardEvent) => {
      if (
        hasSession() &&
        !event.altKey &&
        (event.key === 'F5' ||
          ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r'))
      ) {
        // mpv outlives the document; reloading would discard its controls.
        event.preventDefault();
      }
    };
    // Media keys run on document first, including a user's custom F5 binding.
    window.addEventListener('keydown', preventPlaybackReload);
    return () => window.removeEventListener('keydown', preventPlaybackReload);
  }, [isDesktopRuntime]);

  useEffect(() => {
    if (!isDesktopRuntime) return;

    let isActive = true;
    let closing = false;
    let saveFailureVetoed = false;
    let quitRequested = false;
    const appWindow = getCurrentWindow();

    const settleCloseStep = <T,>(step: Promise<T>) =>
      withTimeout(
        step.then(
          () => true,
          () => true,
        ),
        CLOSE_BARRIER_STEP_TIMEOUT_MS,
        () => false,
      );

    const closeWindow = async (event: CloseRequestedEvent) => {
      const transitionSettled = await settleCloseStep(waitForViewportTransition());
      if (transitionSettled && isPlayerPip()) {
        await settleCloseStep(returnFromPlayerPip());
        if (!quitRequested) {
          event.preventDefault();
          return;
        }
      }
      if (!quitRequested) {
        try {
          const hidden = await withTimeout(
            api.closeMainWindowToTray(),
            CLOSE_BARRIER_STEP_TIMEOUT_MS,
            () => {
              throw new Error('Hiding the window timed out.');
            },
          );
          if (hidden) {
            event.preventDefault();
            if (hasSession()) {
              trayPause.publish(true);
              await settleCloseStep(setMpvProperty('pause', true));
            }
            await settleCloseStep(flushPendingAppWrites());
            return;
          }
        } catch {
          // Without a working tray the window must stay closable.
          event.preventDefault();
          quitRequested = true;
          toast.error('Could not minimize to the system tray.', {
            description: 'Close again to quit.',
          });
          void settleCloseStep(flushPendingAppWrites());
          return;
        }
      }
      await withTimeout(flushPendingAppWrites(), CLOSE_BARRIER_STEP_TIMEOUT_MS, () => {
        throw new Error('Pending writes did not settle.');
      });
      // A failed or slow native teardown still closes — vetoing would wedge
      // the window behind an unkillable mpv call; exit reclaims it.
      await withTimeout(
        mpvDestroy().catch(() => undefined),
        CLOSE_MPV_TEARDOWN_TIMEOUT_MS,
        () => undefined,
      );
    };

    // onCloseRequested destroys the window unless vetoed: keep core:window:allow-destroy.
    const closeListener = appWindow.onCloseRequested((event) => {
      if (closing) {
        event.preventDefault();
        return;
      }
      closing = true;
      return closeWindow(event)
        .catch(() => {
          // Veto once so the save retries; the next close quits anyway.
          if (!saveFailureVetoed) {
            saveFailureVetoed = true;
            event.preventDefault();
            toast.error('Could not save playback progress.', {
              description: 'Close again to quit anyway.',
            });
          }
        })
        .finally(() => {
          closing = false;
        });
    });
    const quitListener = appWindow.listen('app://quit-requested', () => {
      quitRequested = true;
      void appWindow.close().catch((error) => {
        toast.error('Could not quit Stremiro.', { description: getErrorMessage(error) });
      });
    });
    const listeners = [closeListener, quitListener];
    void Promise.all(listeners)
      .then(() => {
        if (isActive) return api.markFrontendQuitReady();
      })
      .catch(() => {
        if (import.meta.env.DEV) {
          console.warn('[app] window lifecycle listeners failed to register');
        }
      });

    return () => {
      isActive = false;
      for (const listener of listeners) {
        void listener.then(
          (unlisten) => unlisten(),
          () => undefined,
        );
      }
    };
  }, [isDesktopRuntime, trayPause]);

  return null;
}
