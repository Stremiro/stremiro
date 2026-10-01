import { useEffect, useState } from 'react';

// Keeps a subtree mounted briefly after `active` goes false so a CSS exit
// animation can play. `mounted` gates the render; `exiting` tells the
// subtree to swap enter classes for exit classes. Re-activating mid-exit
// cancels the unmount and returns to the visible phase.
export function useDelayedUnmount(
  active: boolean,
  exitMs = 280,
): { mounted: boolean; exiting: boolean } {
  const [mounted, setMounted] = useState(active);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (active) {
      setMounted(true);
      setExiting(false);
      return;
    }
    if (!mounted) return;
    setExiting(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setExiting(false);
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [active, exitMs, mounted]);

  return { mounted, exiting };
}
