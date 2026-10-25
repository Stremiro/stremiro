import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

import { createSubscribableStore } from '@/lib/subscribable-store';
import { createSerialTaskQueue } from '@/lib/utils';

const viewportTransition = createSerialTaskQueue();
let pipReadGeneration = 0;
const pipStore = createSubscribableStore(false);

export const enqueueViewportTransition = viewportTransition.enqueue;

export function waitForViewportTransition(): Promise<void> {
  return viewportTransition.pending();
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

export function returnFromPlayerPip(withinTransition = false): Promise<void> {
  return (
    withinTransition ? setPlayerPip(false) : enqueueViewportTransition(() => setPlayerPip(false))
  ).catch((error) => {
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
