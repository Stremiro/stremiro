import { ArrowUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn, scrollBehavior } from '@/lib/utils';

/**
 * Floating back-to-top pill, pinned to the bottom center. That is the one edge
 * the mini player never docks to, so it can't collide with a playback surface.
 * Mounted per route, so the sentinel marks that route's own scroll origin.
 */
export function ScrollToTop() {
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const controlRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const next = !entry.isIntersecting && entry.boundingClientRect.bottom < 0;
        // Hiding the control must not strand focus inside it.
        if (!next && document.activeElement === controlRef.current) {
          document.getElementById('app-main')?.focus({ preventScroll: true });
        }
        setVisible(next);
      },
      { rootMargin: '800px 0px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <span ref={sentinelRef} aria-hidden='true' className='absolute left-0 top-0 size-px' />
      <button
        ref={controlRef}
        type='button'
        inert={!visible || undefined}
        aria-hidden={!visible || undefined}
        aria-label='Back to top'
        title='Back to top'
        onClick={() => {
          document.getElementById('app-main')?.focus({ preventScroll: true });
          window.scrollTo({ top: 0, behavior: scrollBehavior() });
        }}
        className={cn(
          'group fixed bottom-4 left-1/2 z-30 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-white/[0.08] bg-zinc-950/70 text-zinc-400 shadow-[0_14px_34px_-18px_rgb(0_0_0/0.95),inset_0_1px_0_rgb(255_255_255/0.05)] backdrop-blur-md transition-[opacity,translate,color,border-color,background-color] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:border-white/15 hover:bg-zinc-900/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35 motion-reduce:transition-none',
          visible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2.5 opacity-0',
        )}
      >
        <ArrowUp
          aria-hidden='true'
          strokeWidth={2.25}
          className='size-4 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:-translate-y-px motion-reduce:transition-none'
        />
      </button>
    </>
  );
}
