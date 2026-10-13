import { addDays, startOfDay } from 'date-fns';
import { useSyncExternalStore } from 'react';

// Single shared midnight-rollover clock; consumers subscribe rather than arming their own timers.
let currentDay = startOfDay(new Date());
const listeners = new Set<() => void>();
let timer = 0;

function updateDay() {
  const next = startOfDay(new Date());
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
    startOfDay(addDays(new Date(), 1)).getTime() - Date.now(),
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
