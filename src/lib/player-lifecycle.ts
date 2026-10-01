// mpv belongs to the window, not a React mount: setup and teardown must
// serialize across remounts or a late teardown can destroy a fresh instance.
let lifecycleTail: Promise<void> = Promise.resolve();

export function enqueuePlayerLifecycle(operation: () => Promise<void>): Promise<void> {
  const result = lifecycleTail.then(operation);
  lifecycleTail = result.catch(() => undefined);
  return result;
}
