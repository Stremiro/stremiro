import { useState } from 'react';

// Tracks which src failed (not a boolean) so a corrected URL un-fails without a remount.
export function useFailedSrc(src: string | null | undefined) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const onError = () => {
    if (src != null) setFailedSrc(src);
  };
  return [src == null || src === failedSrc ? null : src, onError] as const;
}
