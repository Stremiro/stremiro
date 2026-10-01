import { useEffect } from 'react';

// Ambient activity signal: a page flags meaningful async work on `<html>` and
// the layout's accent dots animate off it — a silent "working" cue with zero
// per-page plumbing. A refcount keeps overlapping surfaces from clearing
// each other's flag.
const AMBIENT_ACTIVE_ATTR = 'data-ambient-active';
let ambientActiveCount = 0;

export function useAmbientActivity(active: boolean) {
  useEffect(() => {
    if (!active) return;

    ambientActiveCount += 1;
    document.documentElement.setAttribute(AMBIENT_ACTIVE_ATTR, '');
    return () => {
      ambientActiveCount = Math.max(0, ambientActiveCount - 1);
      if (ambientActiveCount === 0) {
        document.documentElement.removeAttribute(AMBIENT_ACTIVE_ATTR);
      }
    };
  }, [active]);
}
