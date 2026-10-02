// Single owner for the external-store shape `useSyncExternalStore` consumes:
// a snapshot plus a listener set. `publish` only notifies on real change, so
// high-frequency producers (clock ticks, PiP state) never re-render on echoes.
export interface SubscribableStore<T> {
  getSnapshot: () => T;
  publish: (value: T) => void;
  subscribe: (onChange: () => void) => () => void;
}

export function createSubscribableStore<T>(initial: T): SubscribableStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    publish: (next) => {
      if (Object.is(value, next)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}
