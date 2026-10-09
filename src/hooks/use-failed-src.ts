import { useCallback, useState } from 'react';

// Remembers which src failed rather than a boolean: a new or corrected URL
// un-fails on its own, no remount needed.
export function useFailedSrc(src: string | null | undefined) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const onError = useCallback(() => {
    if (src != null) setFailedSrc(src);
  }, [src]);
  return [src == null || src === failedSrc ? null : src, onError] as const;
}
