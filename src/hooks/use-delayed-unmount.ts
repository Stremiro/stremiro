import { useEffect, useState } from 'react';

// Keeps a subtree mounted for `exitMs` after `active` goes false so a CSS exit animation plays; re-activating mid-exit cancels the unmount.
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
