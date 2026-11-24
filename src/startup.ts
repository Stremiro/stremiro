import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

async function waitForTrayStartup() {
  if (!isTauri() || !(await invoke<boolean>('is_start_hidden'))) return;
  let reveal: () => void;
  const revealed = new Promise<void>((resolve) => {
    reveal = resolve;
  });
  // Subscribe before checking in case the tray reveals the window during startup.
  const unlisten = await listen('app://startup-revealed', () => reveal());
  try {
    if (await invoke<boolean>('is_start_hidden')) await revealed;
  } finally {
    unlisten();
  }
}

// Keep the app bundle unloaded when Windows launches directly into the tray.
void waitForTrayStartup()
  .catch(() => undefined)
  .then(() => import('./main'))
  .catch(() => {
    const reload = document.querySelector<HTMLButtonElement>('#startup-reload');
    if (reload) {
      reload.hidden = false;
      // Packaged assets only serve the root document.
      reload.addEventListener('click', () => window.location.assign('/'), { once: true });
    }
    if (isTauri()) void invoke('frontend_first_frame_ready').catch(() => undefined);
  });
