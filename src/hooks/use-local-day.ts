import { useSyncExternalStore } from 'react';
import { toLocalMidnight } from '@/lib/schedule-dates';

// Single shared midnight-rollover clock; consumers subscribe rather than arming their own timers.
let currentDay = toLocalMidnight(Temporal.Now.plainDateISO());
const listeners = new Set<() => void>();
let timer = 0;

function updateDay() {
  const next = toLocalMidnight(Temporal.Now.plainDateISO());
  if (next.getTime() !== currentDay.getTime()) {
    currentDay = next;
    listeners.forEach((listener) => listener());
  }
}

function scheduleMidnight() {
  timer = window.setTimeout(
    () => {
      updateDay();
      scheduleMidnight();
    },
    toLocalMidnight(Temporal.Now.plainDateISO().add({ days: 1 })).getTime() - Date.now(),
  );
}

function onReturnToView() {
  if (document.visibilityState !== 'visible') return;
  window.clearTimeout(timer);
  updateDay();
  scheduleMidnight();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    // Catch up a missed rollover, then arm.
    updateDay();
    scheduleMidnight();
    document.addEventListener('visibilitychange', onReturnToView);
    window.addEventListener('focus', onReturnToView);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onReturnToView);
      window.removeEventListener('focus', onReturnToView);
    }
  };
}

export function useLocalDay(): Date {
  return useSyncExternalStore(subscribe, () => currentDay);
}
