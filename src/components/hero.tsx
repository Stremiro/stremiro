import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, Loader2, Play, Plus, Star } from 'lucide-react';
import { memo, useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Link } from 'react-router';
import { RemoteImage } from '@/components/remote-image';
import { Button } from '@/components/ui/button';
import {
  useIsItemInLibrary,
  useLatestWatchHistoryEntry,
  useToggleLibraryItem,
} from '@/hooks/use-media-library';
import { useMediaPrimaryPlayback } from '@/hooks/use-media-primary-playback';
import { api, type MediaItem } from '@/lib/api';
import {
  DETAILS_GC_TIME_MS,
  DETAILS_STALE_TIME_MS,
  detailsCardQueryKey,
} from '@/lib/query-invalidation';
import { prefetchDetailsRouteData } from '@/lib/details-prefetch';
import { currentPathWithSearch } from '@/lib/navigation';
import { resolvePlayerRouteMediaType } from '@/lib/player-navigation';
import { searchGenrePath } from '@/lib/search-page-state';
import {
  cn,
  isHttpUrl,
  mediaTypeLabel,
  pad2,
  prefersReducedMotion,
  primaryGenrePills,
} from '@/lib/utils';

interface HeroCarouselStateOptions {
  isPaused?: boolean;
  itemCount: number;
}

const HERO_ROTATION_INTERVAL_MS = 10_000;
const HERO_TRANSITION_DURATION_MS = 300;

interface HeroCarouselIndicatorsProps {
  activeIndex: number;
  itemCount: number;
  onSelect: (index: number) => void;
}

function HeroCarouselIndicators({ activeIndex, itemCount, onSelect }: HeroCarouselIndicatorsProps) {
  if (itemCount <= 1) {
    return null;
  }

  const goToPrevious = () => onSelect((activeIndex - 1 + itemCount) % itemCount);
  const goToNext = () => onSelect((activeIndex + 1) % itemCount);
  const progressPercent = ((activeIndex + 1) / itemCount) * 100;
  const arrowButtonClassName =
    'flex h-6 w-6 items-center justify-center rounded-full text-white/45 transition-colors duration-200 hover:bg-white/10 hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40';

  return (
    <div
      className='absolute bottom-28 md:bottom-32 left-[calc(50%+30px)] z-20 flex -translate-x-1/2 items-center gap-3 transition-opacity duration-300'
      style={{ opacity: 'calc(1 - var(--hero-scroll-opacity, 0) * 2)' }}
    >
      <button
        type='button'
        aria-label='Previous feature'
        onClick={goToPrevious}
        className={arrowButtonClassName}
      >
        <ChevronLeft className='h-3.5 w-3.5' />
      </button>
      <span className='text-[11px] font-medium tabular-nums tracking-[0.2em] text-white/65'>
        {pad2(activeIndex + 1)} / {pad2(itemCount)}
      </span>
      <span className='relative h-px w-24 overflow-hidden rounded bg-white/20'>
        <span
          className='absolute inset-y-0 left-0 rounded bg-(--accent-art) transition-[width] duration-500 ease-out'
          style={{ width: `${progressPercent}%` }}
        />
      </span>
      <button
        type='button'
        aria-label='Next feature'
        onClick={goToNext}
        className={arrowButtonClassName}
      >
        <ChevronRight className='h-3.5 w-3.5' />
      </button>
    </div>
  );
}

function useHeroCarouselState({ isPaused = false, itemCount }: HeroCarouselStateOptions) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const transitionTimeoutRef = useRef<number | null>(null);
  const activeIndex = itemCount > 0 ? currentIndex % itemCount : 0;

  const clearTransitionTimeout = useCallback(() => {
    if (transitionTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(transitionTimeoutRef.current);
    transitionTimeoutRef.current = null;
  }, []);

  const queueTransition = useCallback(
    (nextIndex: number) => {
      if (itemCount <= 0) {
        return;
      }

      clearTransitionTimeout();
      setIsTransitioning(true);
      transitionTimeoutRef.current = window.setTimeout(() => {
        setCurrentIndex(nextIndex);
        setIsTransitioning(false);
        transitionTimeoutRef.current = null;
      }, HERO_TRANSITION_DURATION_MS);
    },
    [clearTransitionTimeout, itemCount],
  );

  const syncIndexBounds = useEffectEvent((nextItemCount: number) => {
    if (nextItemCount === 0) {
      clearTransitionTimeout();
      setCurrentIndex(0);
      setIsTransitioning(false);
      return;
    }

    if (currentIndex >= nextItemCount) {
      setCurrentIndex((previousIndex) => previousIndex % nextItemCount);
    }
  });

  const advanceSlide = useEffectEvent(() => {
    if (isTransitioning || itemCount <= 1) {
      return;
    }

    queueTransition((activeIndex + 1) % itemCount);
  });

  const handleSelect = useCallback(
    (index: number) => {
      if (isTransitioning || index === activeIndex || index < 0 || index >= itemCount) {
        return;
      }

      queueTransition(index);
    },
    [activeIndex, isTransitioning, itemCount, queueTransition],
  );

  useEffect(() => {
    return () => {
      clearTransitionTimeout();
    };
  }, [clearTransitionTimeout]);

  useEffect(() => {
    syncIndexBounds(itemCount);
  }, [itemCount]);

  useEffect(() => {
    if (itemCount <= 1 || isPaused) {
      return;
    }

    const interval = window.setInterval(() => {
      // Skip ticks while the window is hidden/minimized — no visible slide
      // change is missed, and the next visible tick resumes rotation.
      if (!document.hidden) {
        advanceSlide();
      }
    }, HERO_ROTATION_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [isPaused, itemCount]);

  return {
    activeIndex,
    handleSelect,
    isTransitioning,
  };
}

interface HeroProps {
  items: MediaItem[];
}

export const Hero = memo(function Hero({ items }: HeroProps) {
  const queryClient = useQueryClient();
  const [isPaused, setIsPaused] = useState(false);
  const [isOffscreen, setIsOffscreen] = useState(false);
  const from = currentPathWithSearch();
  const sectionRef = useRef<HTMLElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const { activeIndex, handleSelect, isTransitioning } = useHeroCarouselState({
    itemCount: items.length,
    // Offscreen slides rotate state nobody can see; reduced-motion users get
    // manual control only. Both hold the rotation without touching arrows.
    isPaused: isPaused || isOffscreen || prefersReducedMotion(),
  });

  // The hero scrolls off under the rails — don't keep advancing (and
  // repainting the crossfade) while nothing is watching it. The section only
  // mounts once items exist, so a cold load re-runs this when they land.
  const hasItems = items.length > 0;
  useEffect(() => {
    const node = sectionRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => setIsOffscreen(!entries[0]?.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasItems]);

  const item = items[activeIndex];
  const activeHeroItemId = item?.id;
  const activeHeroDetailsType = resolvePlayerRouteMediaType(item?.type);

  const { data: heroDetails } = useQuery({
    // Card payload (rating/backdrop, no episodes): the hero never renders
    // episode data, so it must not pay for up to 2000 episode objects.
    queryKey: detailsCardQueryKey(activeHeroDetailsType, activeHeroItemId),
    queryFn: () =>
      activeHeroItemId
        ? api.getMediaCardDetails(activeHeroDetailsType, activeHeroItemId)
        : Promise.reject(new Error('Media ID is required for hero details lookup.')),
    enabled: !!activeHeroItemId,
    staleTime: DETAILS_STALE_TIME_MS,
    gcTime: DETAILS_GC_TIME_MS,
  });

  useEffect(() => {
    const handleScroll = () => {
      if (scrollFrameRef.current !== null) {
        return;
      }

      scrollFrameRef.current = window.requestAnimationFrame(() => {
        // Direct style write keeps React out of the scroll path — a setState
        // here would re-render the whole hero on every scroll frame.
        sectionRef.current?.style.setProperty(
          '--hero-scroll-opacity',
          String(Math.min(window.scrollY / 600, 0.9)),
        );
        scrollFrameRef.current = null;
      });
    };

    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll);

      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (items.length <= 1) {
      return;
    }

    const nextItem = items[(activeIndex + 1) % items.length];
    const previousItem = items[(activeIndex - 1 + items.length) % items.length];
    // Two slides share one neighbor on both sides.
    const candidateItems = nextItem === previousItem ? [nextItem] : [nextItem, previousItem];

    for (const candidate of candidateItems) {
      // Also warms the title's watch-progress snapshot so the next slide's
      // primary button lands with its Resume label already settled.
      prefetchDetailsRouteData(queryClient, {
        mediaId: candidate.id,
        mediaType: candidate.type,
      });
      // Warm the adjacent backdrops so rotation never flashes an empty frame
      // while the next image decodes — a plain Image probe, no React state.
      const backdrop = candidate.backdrop || candidate.poster;
      if (backdrop && isHttpUrl(backdrop)) {
        const probe = new Image();
        probe.decoding = 'async';
        probe.referrerPolicy = 'no-referrer';
        probe.src = backdrop;
      }
    }
  }, [activeIndex, items, queryClient]);

  const heroRating = heroDetails?.rating ?? null;
  const { data: isInLibrary = false } = useIsItemInLibrary(item?.id);
  const toggleLibrary = useToggleLibraryItem({ item, isInLibrary });
  const { data: historyEntry } = useLatestWatchHistoryEntry(activeHeroItemId);
  // Same primary-action pipeline as MediaCard: resume history, resolve+play a
  // movie outright, or land on details for a series with no watch context.
  const primaryPlayback = useMediaPrimaryPlayback({
    from,
    historyEntry,
    item,
    surface: 'card',
  });

  if (!item) {
    return (
      <div className='relative w-full h-[78vh] min-h-[560px] max-h-[860px] -mt-8 overflow-hidden bg-zinc-950'>
        <div className='absolute inset-0 bg-linear-to-t from-black via-black/50 to-transparent' />
      </div>
    );
  }

  const backdropUrl = item.backdrop || item.poster;
  const typeLabel = mediaTypeLabel(item.type);
  const genrePills = primaryGenrePills(item.genres, heroDetails?.genres);

  return (
    <section
      ref={sectionRef}
      className='relative w-full h-[78vh] min-h-[560px] max-h-[860px] -mt-8 overflow-hidden group'
      aria-label='Featured titles'
      onPointerEnter={() => setIsPaused(true)}
      onPointerLeave={() => setIsPaused(false)}
      onFocusCapture={() => setIsPaused(true)}
      onBlurCapture={(e) => {
        // Stay paused while focus moves between controls inside the hero.
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) {
          setIsPaused(false);
        }
      }}
    >
      {/* Scroll dim — opacity-only, no backdrop blur: a fullscreen
          backdrop-filter repaints on every scroll frame even at opacity 0.
          The accent wash below reuses the same var. */}
      <div
        className='absolute inset-0 bg-black/60 pointer-events-none transition-opacity duration-300 ease-out z-[5]'
        style={{ opacity: 'var(--hero-scroll-opacity, 0)' }}
      />
      <div
        aria-hidden='true'
        className='absolute inset-0 pointer-events-none z-[5]'
        style={{
          opacity: 'var(--hero-scroll-opacity, 0)',
          background:
            'radial-gradient(55% 38% at 50% 0%, rgb(var(--accent-art-rgb) / 0.10) 0%, transparent 70%)',
        }}
      />

      {/* Background image with crossfade */}
      <div
        className={cn(
          'absolute inset-0 transition-opacity duration-300 ease-in-out',
          isTransitioning ? 'opacity-0' : 'opacity-100',
        )}
      >
        {backdropUrl && isHttpUrl(backdropUrl) && (
          <>
            <RemoteImage
              key={item.id}
              src={backdropUrl}
              alt=''
              className='w-full h-full object-cover object-center'
              loading='eager'
              fetchPriority='high'
            />
            {/* Grade: left readability, full-height lift, top titlebar fade. */}
            <div className='absolute inset-0 bg-linear-to-r from-black/80 via-black/25 to-transparent' />
            <div className='absolute inset-0 bg-linear-to-t from-black via-black/35 to-transparent' />
            <div className='absolute inset-x-0 top-0 h-36 bg-linear-to-b from-black/70 to-transparent' />
            {/* Bottom dissolve: multi-stop fade, a masked frost lip that
                blurs only the last ~80px (small region, fades upward so no
                hard blur line), and a faint accent haze. */}
            <div
              aria-hidden='true'
              className='absolute inset-x-0 bottom-0 h-56 pointer-events-none'
              style={{
                background:
                  'linear-gradient(to top, black 0%, rgb(0 0 0 / 0.72) 32%, rgb(0 0 0 / 0.26) 62%, transparent 100%)',
              }}
            />
            <div
              aria-hidden='true'
              className='absolute inset-x-0 bottom-0 h-20 pointer-events-none backdrop-blur-[3px]'
              style={{
                maskImage: 'linear-gradient(to top, black 10%, transparent 92%)',
                WebkitMaskImage: 'linear-gradient(to top, black 10%, transparent 92%)',
              }}
            />
            <div
              aria-hidden='true'
              className='absolute inset-x-0 bottom-0 h-48 pointer-events-none'
              style={{
                background:
                  'radial-gradient(62% 95% at 50% 118%, rgb(var(--accent-art-rgb) / 0.05) 0%, transparent 70%)',
              }}
            />
          </>
        )}
      </div>

      {/* Visible area wrapper — content offset past sidebar, image bleeds behind it */}
      <div className='absolute inset-0 z-10'>
        <div className='relative w-full h-full'>
          {/* Content — bottom-padded past the rail overlap (-mt-* on the home
              rails) so actions/indicators never sit under the first cards. */}
          <div
            className={cn(
              'absolute inset-0 flex items-end transition-[opacity,translate] duration-300 ease-in-out px-6 pl-[84px] pb-36 md:pl-24 md:pr-12 md:pb-44 lg:pl-28 lg:pr-16',
              isTransitioning ? 'opacity-0 translate-y-3' : 'opacity-100 translate-y-0',
            )}
          >
            <div
              className='flex w-full items-end justify-between gap-10'
              style={{ opacity: 'calc(1 - var(--hero-scroll-opacity, 0))' }}
            >
              {/* Left: logo, meta pills, actions */}
              <div className='flex min-w-0 max-w-2xl flex-col items-start text-left'>
                {isHttpUrl(item.logo) ? (
                  <RemoteImage
                    src={item.logo}
                    alt={item.title}
                    className='mb-5 max-h-[150px] max-w-[min(90%,440px)] object-contain object-left drop-shadow-[0_16px_40px_rgba(0,0,0,0.65)] animate-in fade-in duration-700 md:max-h-[185px]'
                  />
                ) : (
                  <h1 className='mb-4 max-w-2xl text-4xl font-bold leading-[1.02] tracking-[-0.03em] text-white drop-shadow-[0_10px_30px_rgba(0,0,0,0.6)] animate-in fade-in duration-700 md:text-6xl'>
                    {item.title}
                  </h1>
                )}

                <div className='flex items-center flex-wrap gap-1.5 animate-in fade-in duration-700 delay-100'>
                  {item.displayYear && (
                    <span className='accent-lattice-soft rounded-md border px-2.5 py-1 text-[12px] font-medium backdrop-blur-md'>
                      {item.displayYear}
                    </span>
                  )}
                  <span className='accent-lattice-soft rounded-md border px-2.5 py-1 text-[12px] font-medium backdrop-blur-md'>
                    {typeLabel}
                  </span>
                  {/* Rating arrives over IPC after the slide has painted —
                      keeping it last means a late resolve fades a pill in at
                      the row's edge instead of shoving year/type sideways. */}
                  {heroRating && (
                    <span className='flex items-center gap-1.5 rounded-md border border-white/10 bg-black/45 px-2.5 py-1 text-[12px] font-semibold text-white backdrop-blur-md animate-in fade-in duration-300'>
                      <Star className='rating-star h-3 w-3 fill-amber-400 text-amber-400 drop-shadow-[0_0_6px_rgba(251,191,36,0.35)]' />
                      {heroRating}
                    </span>
                  )}
                </div>

                {/* Mobile / tablet synopsis */}
                {item.description && (
                  <p className='mt-4 max-w-xl text-[13.5px] leading-[1.65] text-zinc-200/85 line-clamp-2 animate-in fade-in duration-700 delay-150 lg:hidden'>
                    {item.description}
                  </p>
                )}

                <div className='mt-6 flex items-center gap-2.5 animate-in fade-in duration-700 delay-200'>
                  <Button
                    size='sm'
                    onClick={() => void primaryPlayback.handlePrimaryAction()}
                    aria-disabled={primaryPlayback.isResolvingPrimaryAction || undefined}
                    className='h-11 gap-2 rounded-full bg-white px-7 text-[14px] font-semibold text-black transition-all duration-200 hover:bg-zinc-200 active:scale-[0.98] aria-disabled:cursor-wait aria-disabled:opacity-80'
                  >
                    {primaryPlayback.isResolvingPrimaryAction ? (
                      <Loader2 className='h-4 w-4 animate-spin' />
                    ) : (
                      <Play className='h-4 w-4 fill-current' />
                    )}
                    {primaryPlayback.primaryActionLabel}
                  </Button>
                  <Button
                    size='icon'
                    variant='ghost'
                    aria-label={isInLibrary ? 'Remove from library' : 'Add to library'}
                    title={isInLibrary ? 'Remove from library' : 'Add to library'}
                    className={cn(
                      'h-11 w-11 rounded-full border backdrop-blur-md transition-all duration-200 active:scale-95',
                      isInLibrary
                        ? 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-200/80 hover:bg-emerald-500/[0.10] hover:text-emerald-200'
                        : 'border-white/20 bg-white/10 text-white hover:bg-white/20',
                    )}
                    // Guard, not `disabled`: disabling the focused button
                    // blurs it, which unpauses the carousel mid-click.
                    aria-disabled={toggleLibrary.isPending || undefined}
                    onClick={() => {
                      if (!toggleLibrary.isPending) toggleLibrary.mutate();
                    }}
                  >
                    {isInLibrary ? <Check className='h-4 w-4' /> : <Plus className='h-4 w-4' />}
                  </Button>
                </div>
              </div>

              {/* Right: synopsis + genres (desktop) */}
              <div className='hidden w-full max-w-md shrink-0 flex-col items-end text-right animate-in fade-in duration-700 delay-150 lg:flex'>
                {item.description && (
                  <p className='text-[13.5px] leading-[1.7] text-zinc-100/80 line-clamp-4 [text-shadow:0_2px_16px_rgba(0,0,0,0.8)]'>
                    {item.description}
                  </p>
                )}
                {genrePills.length > 0 && (
                  <div className='mt-4 flex items-center justify-end gap-1.5'>
                    {genrePills.map((genre) => (
                      <Link
                        key={genre}
                        to={searchGenrePath(item.type, genre)}
                        title={`Browse ${genre}`}
                        className='rounded-md border border-white/10 bg-white/[0.08] px-2.5 py-1 text-[12px] font-medium text-white/75 backdrop-blur-md transition-colors duration-150 hover:border-white/25 hover:bg-white/[0.14] hover:text-white'
                      >
                        {genre}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <HeroCarouselIndicators
        activeIndex={activeIndex}
        itemCount={items.length}
        onSelect={handleSelect}
      />
    </section>
  );
});
