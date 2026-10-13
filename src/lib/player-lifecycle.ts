import { createSerialTaskQueue } from '@/lib/utils';

// mpv belongs to the window, not a mount — setup/teardown must serialize or a late teardown can destroy a fresh instance.
const playerLifecycle = createSerialTaskQueue();

export const enqueuePlayerLifecycle = playerLifecycle.enqueue;
