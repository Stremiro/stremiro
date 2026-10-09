import { createSerialTaskQueue } from '@/lib/utils';

// mpv belongs to the window, not a React mount: setup and teardown must
// serialize across remounts or a late teardown can destroy a fresh instance.
const playerLifecycle = createSerialTaskQueue();

export const enqueuePlayerLifecycle = playerLifecycle.enqueue;
