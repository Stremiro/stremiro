import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

import { createSubscribableStore } from '@/lib/subscribable-store';

let viewportTransitionTail: Promise<void> = Promise.resolve();
let pipReadGeneration = 0;
const pipStore = createSubscribableStore(false);

export function enqueueViewportTransition(operation: () => Promise<void>): Promise<void> {
  const result = viewportTransitionTail.then(operation);
  viewportTransitionTail = result.catch(() => undefined);
  return result;
}

export function waitForViewportTransition(): Promise<void> {
  return viewportTransitionTail;
}

export const isPlayerPip = pipStore.getSnapshot;
export const subscribePlayerPip = pipStore.subscribe;

export async function setPlayerPip(enabled: boolean): Promise<void> {
  const generation = ++pipReadGeneration;
  let active: boolean;
  try {
    active = await invoke<boolean>('set_player_pip', { enabled });
  } catch (error) {
    await syncPlayerPip().catch(() => undefined);
    throw error;
  }
  if (generation === pipReadGeneration) pipStore.publish(active);
}

export async function syncPlayerPip(): Promise<void> {
  const generation = ++pipReadGeneration;
  const active = await invoke<boolean>('get_player_pip');
  if (generation === pipReadGeneration) pipStore.publish(active);
}

export function returnFromPlayerPip(): Promise<void> {
  return enqueueViewportTransition(() => setPlayerPip(false)).catch((error) => {
    toast.error('Could not restore the app window. Please try again.');
    throw error;
  });
}

export function snapPlayerPip(): Promise<void> {
  return enqueueViewportTransition(async () => {
    if (isPlayerPip()) await invoke('snap_player_pip');
  }).catch((error) => {
    toast.error('Could not position picture in picture. Please try again.');
    throw error;
  });
}
