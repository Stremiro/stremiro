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

  useEffect(() => {
    if (active) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    const timer = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(timer);
  }, [active, exitMs, mounted]);

  return { mounted: active || mounted, exiting: !active && mounted };
}
