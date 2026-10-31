import { useEffect, useRef, useState } from 'react';

export function useNearViewport(enabled = true) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || nearViewport || !enabled) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: '600px' },
    );
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [nearViewport, enabled]);

  return { anchorRef, nearViewport };
}
