import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { emit } from '@tauri-apps/api/event';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { listenMpvEvents } from '../src/lib/player-mpv';

let windowDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { crypto: globalThis.crypto },
  });
  // Keep the real Tauri event API; only replace its native IPC endpoint.
  let nextId = 0;
  const listeners = new Map<number, { event: string; handler: number }>();
  mockIPC((command, args) => {
    switch (command) {
      case 'plugin:event|listen': {
        const listener = args as { event: string; handler: number };
        const id = ++nextId;
        listeners.set(id, listener);
        return id;
      }
      case 'plugin:event|unlisten': {
        const { event, eventId } = args as { event: string; eventId: number };
        expect(listeners.get(eventId)?.event).toBe(event);
        listeners.delete(eventId);
        return;
      }
      case 'plugin:event|emit': {
        const { event, payload } = args as { event: string; payload: unknown };
        const { __TAURI_INTERNALS__: internals } = window as unknown as {
          __TAURI_INTERNALS__: {
            runCallback: (
              id: number,
              value: { event: string; id: number; payload: unknown },
            ) => void;
          };
        };
        for (const [id, listener] of listeners) {
          if (listener.event === event) {
            internals.runCallback(listener.handler, { event, id, payload });
          }
        }
        return;
      }
      default:
        throw new Error(`Unexpected IPC: ${command}`);
    }
  });
});

afterEach(() => {
  clearMocks();
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
  else Reflect.deleteProperty(globalThis, 'window');
});

test.each(['main', 'secondary-player'])(
  'mpv events use the current window (%s), unwrap payloads, and unsubscribe',
  async (label) => {
    mockWindows(label);
    const callback = mock(() => {});
    const unlisten = await listenMpvEvents(callback);
    const payload = { event: 'property-change', name: 'pause', data: false, id: 1 };

    await emit('mpv-event-another-window', payload);
    expect(callback).not.toHaveBeenCalled();
    await emit(`mpv-event-${label}`, payload);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(payload);

    unlisten();
    await emit(`mpv-event-${label}`, { event: 'playback-restart' });
    expect(callback).toHaveBeenCalledTimes(1);

    const nextCallback = mock(() => {});
    const nextUnlisten = await listenMpvEvents(nextCallback);
    await emit(`mpv-event-${label}`, { event: 'start-file', playlist_entry_id: 2 });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(nextCallback).toHaveBeenCalledWith({ event: 'start-file', playlist_entry_id: 2 });
    nextUnlisten();
  },
);

test('mpv subscriptions independently retain their window label and cleanup', async () => {
  mockWindows('main');
  const main = mock(() => {});
  const unlistenMain = await listenMpvEvents(main);
  mockWindows('secondary-player');
  const secondary = mock(() => {});
  const unlistenSecondary = await listenMpvEvents(secondary);

  await emit('mpv-event-main', { event: 'seek' });
  expect(main).toHaveBeenCalledTimes(1);
  expect(secondary).not.toHaveBeenCalled();
  unlistenMain();
  await emit('mpv-event-main', { event: 'seek' });
  await emit('mpv-event-secondary-player', { event: 'playback-restart' });
  expect(main).toHaveBeenCalledTimes(1);
  expect(secondary).toHaveBeenCalledWith({ event: 'playback-restart' });
  unlistenSecondary();
});

test('mpv subscription failures reach the caller', async () => {
  mockWindows('main');
  const failure = new Error('Listener registration failed');
  mockIPC(() => {
    throw failure;
  });

  await expect(listenMpvEvents(mock(() => {}))).rejects.toBe(failure);
});
