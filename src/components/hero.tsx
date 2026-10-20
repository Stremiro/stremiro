import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, Loader2, Pause, Play, Plus, Star } from 'lucide-react';
import { memo, useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Link } from 'react-router';
import { RemoteImage } from '@/components/remote-image';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useIsItemInLibrary,
  useMediaResumeEntry,
  useToggleLibraryItem,
} from '@/hooks/use-media-library';
import { useFailedSrc } from '@/hooks/use-failed-src';
import { useMediaPrimaryPlayback } from '@/hooks/use-media-primary-playback';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { useRafScrollListener } from '@/hooks/use-raf-scroll-listener';
import { api, type MediaItem } from '@/lib/api';
import { prefetchDetailsRouteData } from '@/lib/details-prefetch';
import { currentPathWithSearch } from '@/lib/navigation';
import { buildDetailsRoute, resolvePlayerRouteMediaType } from '@/lib/player-navigation';
import { searchGenrePath } from '@/lib/search-page-state';
import {
  clearTimer,
  cn,
  GENRE_LINK_CLASS,
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
const HERO_CONTAINER_CLASS =
  'relative w-full h-[78vh] min-h-[560px] max-h-[860px] -mt-8 overflow-hidden';

const ARROW_BUTTON_CLASS_NAME =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-white/60 transition-colors duration-150 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40';

interface HeroCarouselIndicatorsProps {
  activeIndex: number;
  itemCount: number;
  isRotationPaused: boolean;
  onStep: (delta: number) => void;
  onToggleRotation: () => void;
}

function HeroCarouselIndicators({
  activeIndex,
  itemCount,
  isRotationPaused,
  onStep,
  onToggleRotation,
}: HeroCarouselIndicatorsProps) {
  if (itemCount <= 1) {
    return null;
  }

  const progressPercent = ((activeIndex + 1) / itemCount) * 100;

  return (
    <div
      role='group'
      aria-label='Featured title controls'
      className='absolute bottom-28 md:bottom-32 left-[calc(50%+30px)] z-20 flex w-max max-w-[calc(100vw-76px)] -translate-x-1/2 items-center gap-2 sm:gap-3 transition-opacity duration-300 motion-reduce:transition-none focus-within:opacity-100! group-data-[indicators-hidden]:not-focus-within:pointer-events-none'
      style={{ opacity: 'calc(1 - var(--hero-scroll-opacity, 0) * 2)' }}
    >
      <button
        type='button'
        aria-label='Previous feature'
        onClick={() => onStep(-1)}
        className={ARROW_BUTTON_CLASS_NAME}
      >
        <ChevronLeft aria-hidden='true' className='h-3.5 w-3.5' />
      </button>
      <span className='whitespace-nowrap text-[11px] font-medium tabular-nums tracking-[0.2em] text-white/65'>
        {pad2(activeIndex + 1)} / {pad2(itemCount)}
      </span>
      <span
        aria-hidden='true'
        className='relative h-px w-12 sm:w-24 overflow-hidden rounded bg-white/20'
      >
        <span
          className='absolute inset-y-0 left-0 rounded bg-(--accent-art) transition-[width] duration-500 ease-out motion-reduce:transition-none'
          style={{ width: `${progressPercent}%` }}
        />
      </span>
      <button
        type='button'
        aria-label='Next feature'
        onClick={() => onStep(1)}
        className={ARROW_BUTTON_CLASS_NAME}
      >
        <ChevronRight aria-hidden='true' className='h-3.5 w-3.5' />
      </button>
      <button
        type='button'
        aria-label={isRotationPaused ? 'Resume automatic rotation' : 'Pause automatic rotation'}
        aria-pressed={isRotationPaused}
        title={isRotationPaused ? 'Resume automatic rotation' : 'Pause automatic rotation'}
        onClick={onToggleRotation}
        className={cn(ARROW_BUTTON_CLASS_NAME, 'motion-reduce:hidden')}
      >
        {isRotationPaused ? <Play className='h-3.5 w-3.5' /> : <Pause className='h-3.5 w-3.5' />}
      </button>
    </div>
  );
}

function useHeroCarouselState({ isPaused = false, itemCount }: HeroCarouselStateOptions) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const transitionTimeoutRef = useRef<number | null>(null);
  const pendingIndexRef = useRef<number | null>(null);
  const activeIndex = itemCount > 0 ? currentIndex % itemCount : 0;

  const cancelTransition = useCallback(() => {
    clearTimer(transitionTimeoutRef);
    pendingIndexRef.current = null;
  }, []);

  const goTo = useCallback(
    (nextIndex: number) => {
      cancelTransition();
      if (prefersReducedMotion()) {
        setCurrentIndex(nextIndex);
        setIsTransitioning(false);
        return;
      }
      pendingIndexRef.current = nextIndex;
      setIsTransitioning(true);
      transitionTimeoutRef.current = window.setTimeout(() => {
        setCurrentIndex(nextIndex);
        setIsTransitioning(false);
        transitionTimeoutRef.current = null;
        pendingIndexRef.current = null;
      }, HERO_TRANSITION_DURATION_MS);
    },
    [cancelTransition],
  );

  // Rapid steps retarget the in-flight transition instead of being dropped.
  const handleStep = useCallback(
    (delta: number) => {
      if (itemCount <= 1) return;
      const index = ((pendingIndexRef.current ?? activeIndex) + delta + itemCount) % itemCount;
      if (index === activeIndex) {
        cancelTransition();
        setIsTransitioning(false);
        return;
      }
      goTo(index);
    },
    [activeIndex, cancelTransition, goTo, itemCount],
  );

  const advanceSlide = useEffectEvent(() => {
    if (pendingIndexRef.current === null) goTo((activeIndex + 1) % itemCount);
  });

  useEffect(() => cancelTransition, [cancelTransition]);

  // One timer per slide: a manual step or resume restarts the full dwell time.
  useEffect(() => {
    if (isPaused || itemCount <= 1) return;

    let timer: number | undefined;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncRotation = () => {
      window.clearTimeout(timer);
      timer =
        document.hidden || reducedMotion.matches
          ? undefined
          : window.setTimeout(advanceSlide, HERO_ROTATION_INTERVAL_MS);
    };
    syncRotation();
    document.addEventListener('visibilitychange', syncRotation);
    reducedMotion.addEventListener('change', syncRotation);

    return () => {
      document.removeEventListener('visibilitychange', syncRotation);
      reducedMotion.removeEventListener('change', syncRotation);
      window.clearTimeout(timer);
    };
  }, [activeIndex, isPaused, itemCount]);

  return {
    activeIndex,
    handleStep,
    isTransitioning,
  };
}

interface HeroProps {
  items: MediaItem[];
}

function HeroTitle({
  title,
  logo,
  pending,
}: {
  title: string;
  logo: string | undefined;
  pending: boolean;
}) {
  // The presentation is chosen once metadata settles; later responses never swap it.
  const [settledLogo, setSettledLogo] = useState<string | null | undefined>(() =>
    pending ? undefined : isHttpUrl(logo) ? logo : null,
  );
  if (settledLogo === undefined && !pending) setSettledLogo(isHttpUrl(logo) ? logo : null);
  const [logoUrl, onLogoError] = useFailedSrc(settledLogo);
  const [loadedLogoUrl, setLoadedLogoUrl] = useState<string | null>(null);
  const showText = settledLogo !== undefined && !logoUrl;

  return (
    <>
      <h1
        className={
          showText
            ? 'line-clamp-3 text-4xl font-bold leading-[1.02] tracking-[-0.03em] text-white drop-shadow-[0_10px_30px_rgba(0,0,0,0.6)] animate-in fade-in duration-300 motion-reduce:animate-none md:text-6xl'
            : 'sr-only'
        }
      >
        {title}
      </h1>
      {!showText && loadedLogoUrl !== logoUrl && (
        <Skeleton aria-hidden='true' className='h-12 w-80 max-w-full bg-white/[0.08] md:h-16' />
      )}
      {logoUrl && (
        <RemoteImage
          src={logoUrl}
          alt=''
          fadeIn
          loading='eager'
          fetchPriority='high'
          onLoad={() => setLoadedLogoUrl(logoUrl)}
          onError={onLogoError}
          className='absolute inset-0 h-full w-full object-contain object-[left_bottom] drop-shadow-[0_16px_40px_rgba(0,0,0,0.65)]'
        />
      )}
    </>
  );
}

export const Hero = memo(function Hero({ items }: HeroProps) {
  const queryClient = useQueryClient();
  const isOnline = useOnlineStatus();
  const [isHovered, setIsHovered] = useState(false);
  const [hasFocus, setHasFocus] = useState(false);
  const [isWindowFocused, setIsWindowFocused] = useState(() => document.hasFocus());
  const [isOffscreen, setIsOffscreen] = useState(false);
  const [isRotationPaused, setIsRotationPaused] = useState(false);
  const from = currentPathWithSearch();
  const sectionRef = useRef<HTMLElement | null>(null);
  const { activeIndex, handleStep, isTransitioning } = useHeroCarouselState({
    itemCount: items.length,
    // Offscreen slides rotate state nobody can see; reduced-motion users get manual control only.
    isPaused: isRotationPaused || isHovered || hasFocus || !isWindowFocused || isOffscreen,
  });

  useEffect(() => {
    const syncWindowFocus = () => setIsWindowFocused(document.hasFocus());
    window.addEventListener('focus', syncWindowFocus);
    window.addEventListener('blur', syncWindowFocus);
    return () => {
      window.removeEventListener('focus', syncWindowFocus);
      window.removeEventListener('blur', syncWindowFocus);
    };
  }, []);

  // Don't advance or repaint the crossfade while the hero is scrolled off under the rails. The section mounts
  // only once items exist, so a cold load re-runs this when they land.
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
  const {
    data: heroDetails,
    isFetched: isHeroDetailsFetched,
    isLoading: isHeroDetailsLoading,
  } = useQuery({
    // Card payload only (no episodes) — the hero never renders episode data and must not pay for it.
    ...api.cardDetailsQueryOptions(
      activeHeroDetailsType,
      activeHeroItemId,
      'Media ID is required for hero details lookup.',
    ),
    enabled: isOnline && !!activeHeroItemId,
  });

  useRafScrollListener(() => {
    // Direct style write — a setState here would re-render the whole hero on every scroll frame.
    const scrollOpacity = Math.min(window.scrollY / 600, 0.9);
    sectionRef.current?.style.setProperty('--hero-scroll-opacity', String(scrollOpacity));
    sectionRef.current?.toggleAttribute('data-indicators-hidden', scrollOpacity >= 0.5);
  });

  useEffect(() => {
    if (!isOnline || items.length <= 1 || !isHeroDetailsFetched || isOffscreen || document.hidden) {
      return;
    }

    const nextItem = items[(activeIndex + 1) % items.length];
    const previousItem = items[(activeIndex - 1 + items.length) % items.length];
    // Two slides share one neighbor on both sides.
    const candidateItems = nextItem === previousItem ? [nextItem] : [nextItem, previousItem];

    const timer = window.setTimeout(() => {
      if (document.hidden) return;
      for (const candidate of candidateItems) {
        // Also warms watch-progress so the next slide's primary button lands with its Resume label settled.
        prefetchDetailsRouteData(queryClient, {
          mediaId: candidate.id,
          mediaType: candidate.type,
          warmChunk: false,
        });
        // Warm adjacent backdrops so rotation never flashes an empty frame — a plain Image probe, no React state.
        const backdrop = candidate.backdrop || candidate.poster;
        if (backdrop && isHttpUrl(backdrop)) {
          const probe = new Image();
          probe.decoding = 'async';
          probe.referrerPolicy = 'no-referrer';
          probe.src = backdrop;
        }
      }
    }, 750);
    return () => window.clearTimeout(timer);
  }, [activeIndex, isHeroDetailsFetched, isOffscreen, isOnline, items, queryClient]);

  const heroRating = heroDetails?.rating ?? null;
  const heroLogo = item?.logo || heroDetails?.logo;
  const libraryQuery = useIsItemInLibrary(item?.id);
  const libraryReady = libraryQuery.data !== undefined;
  const isInLibrary = libraryQuery.data === true;
  const libraryActionLabel = libraryReady
    ? isInLibrary
      ? 'Remove from Library'
      : 'Add to Library'
    : libraryQuery.isError
      ? 'Library unavailable'
      : 'Loading Library…';
  const toggleLibrary = useToggleLibraryItem({ item, isInLibrary });
  const { data: historyEntry } = useMediaResumeEntry(activeHeroItemId, item?.type, {
    staleTime: 1000 * 60 * 5,
  });
  // Same primary-action pipeline as MediaCard: resume, resolve+play a movie, or land on details for a series.
  const primaryPlayback = useMediaPrimaryPlayback({
    from,
    historyEntry,
    item,
    surface: 'card',
  });

  if (!item) {
    return (
      <div className={cn(HERO_CONTAINER_CLASS, 'bg-zinc-950')} aria-busy='true'>
        <span role='status' className='sr-only'>
          Loading featured titles…
        </span>
        <div className='absolute inset-0 bg-linear-to-t from-black via-black/50 to-transparent' />
        <div
          aria-hidden='true'
          className='absolute inset-x-0 bottom-0 space-y-5 px-6 pl-[84px] pb-36 md:pl-24 md:pr-12 md:pb-44 lg:pl-28 lg:pr-16'
        >
          <Skeleton className='h-12 w-80 max-w-full bg-white/[0.08] md:h-16 motion-reduce:animate-none' />
          <Skeleton className='h-4 w-40 max-w-full bg-white/[0.06] motion-reduce:animate-none' />
          <div className='max-w-md space-y-2.5'>
            <Skeleton className='h-3.5 w-full bg-white/[0.05] motion-reduce:animate-none' />
            <Skeleton className='h-3.5 w-4/5 bg-white/[0.05] motion-reduce:animate-none' />
          </div>
          <div className='flex gap-2'>
            <Skeleton className='h-11 w-28 rounded-lg bg-white/[0.08] motion-reduce:animate-none' />
            <Skeleton className='h-11 w-11 rounded-lg bg-white/[0.06] motion-reduce:animate-none' />
          </div>
        </div>
      </div>
    );
  }

  const backdropUrl = item.backdrop || heroDetails?.backdrop || item.poster;
  const description = item.description || heroDetails?.description;
  const typeLabel = mediaTypeLabel(item.type);
  const genrePills = primaryGenrePills(item.genres, heroDetails?.genres);
  const detailsPath = buildDetailsRoute(item.type, item.id);
  const prefetchActiveDetails = () =>
    isOnline && prefetchDetailsRouteData(queryClient, { mediaId: item.id, mediaType: item.type });

  return (
    <section
      ref={sectionRef}
      className={cn(HERO_CONTAINER_CLASS, 'group')}
      aria-label='Featured titles'
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      onFocusCapture={() => setHasFocus(true)}
      onBlurCapture={(e) => {
        setHasFocus(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget));
      }}
    >
      {/* Scroll dim is opacity-only — a fullscreen backdrop-filter repaints every scroll frame even at
          opacity 0. The accent wash below reuses the same var. */}
      <div
        className='absolute inset-0 bg-black/60 pointer-events-none transition-opacity duration-300 ease-out z-[5] motion-reduce:transition-none'
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

      <div
        className={cn(
          'absolute inset-0 transition-opacity duration-300 ease-in-out motion-reduce:transition-none',
          isTransitioning ? 'opacity-0' : 'opacity-100',
        )}
      >
        {backdropUrl && isHttpUrl(backdropUrl) && (
          <>
            <RemoteImage
              key={item.id}
              src={backdropUrl}
              fallbackSrc={isHttpUrl(item.poster) ? item.poster : undefined}
              fadeIn
              alt=''
              className='w-full h-full object-cover object-center'
              loading='eager'
              fetchPriority='high'
            />
            {/* Grade: left readability, full-height lift, top titlebar fade. */}
            <div className='absolute inset-0 bg-linear-to-r from-black/80 via-black/25 to-transparent' />
            <div className='absolute inset-0 bg-linear-to-t from-black via-black/35 to-transparent' />
            <div className='absolute inset-x-0 top-0 h-36 bg-linear-to-b from-black/70 to-transparent' />
            {/* Bottom dissolve: multi-stop fade plus a faint accent haze. */}
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
          {/* Bottom-padded past the rail overlap (-mt-* on home rails) so actions never sit under the first cards. */}
          <div
            className={cn(
              'absolute inset-0 flex items-end transition-opacity duration-300 ease-in-out px-6 pl-[84px] pb-36 md:pl-24 md:pr-12 md:pb-44 lg:pl-28 lg:pr-16 motion-reduce:transition-none',
              isTransitioning ? 'opacity-0' : 'opacity-100',
            )}
          >
            <div
              className='flex w-full items-end justify-between gap-10 focus-within:opacity-100!'
              style={{ opacity: 'calc(1 - var(--hero-scroll-opacity, 0))' }}
            >
              <div className='flex min-w-0 max-w-2xl flex-col items-start text-left'>
                <Link
                  to={detailsPath}
                  state={{ from }}
                  onFocus={prefetchActiveDetails}
                  onPointerEnter={prefetchActiveDetails}
                  className='relative mb-5 flex h-[150px] w-[440px] max-w-full items-end rounded-md transition-opacity duration-150 hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-offset-4 focus-visible:ring-offset-black/40 motion-reduce:transition-none md:h-[185px]'
                >
                  <HeroTitle
                    key={`${item.type}:${item.id}`}
                    title={item.title}
                    logo={heroLogo}
                    pending={!isHttpUrl(item.logo) && isHeroDetailsLoading}
                  />
                </Link>

                <div className='flex items-center flex-wrap gap-x-3 gap-y-1.5 text-[12px] font-medium text-white/75'>
                  {item.displayYear && <span>{item.displayYear}</span>}
                  <span>{typeLabel}</span>
                  {/* A late rating stays at the row's edge without shifting year/type. */}
                  {heroRating && (
                    <span className='flex items-center gap-1.5 font-semibold text-white'>
                      <Star className='h-3 w-3 fill-amber-400 text-amber-400' />
                      {heroRating}
                    </span>
                  )}
                </div>

                {description && (
                  <p className='mt-4 max-w-xl text-[13.5px] leading-[1.65] text-zinc-200/85 line-clamp-2 lg:hidden'>
                    {description}
                  </p>
                )}

                <div className='mt-5 flex items-center gap-2'>
                  <Button
                    size='sm'
                    onClick={() => {
                      if (isOnline) void primaryPlayback.handlePrimaryAction();
                    }}
                    aria-disabled={
                      !isOnline || primaryPlayback.isResolvingPrimaryAction || undefined
                    }
                    aria-busy={primaryPlayback.isResolvingPrimaryAction || undefined}
                    title={isOnline ? undefined : 'Reconnect to find streams'}
                    className='h-11 min-w-[108px] gap-2 rounded-lg bg-white px-4 text-[13px] font-semibold text-black shadow-none transition-colors duration-150 hover:bg-zinc-200 focus-visible:ring-white/60 aria-disabled:cursor-default aria-disabled:opacity-80'
                  >
                    {primaryPlayback.showResolvingFeedback ? (
                      <Loader2 className='h-4 w-4 animate-spin motion-reduce:animate-none' />
                    ) : (
                      <Play className='h-4 w-4 fill-current' />
                    )}
                    {primaryPlayback.primaryActionLabel}
                  </Button>
                  <Button
                    size='icon'
                    variant='ghost'
                    aria-label={libraryActionLabel}
                    title={libraryActionLabel}
                    aria-pressed={libraryReady ? isInLibrary : undefined}
                    aria-busy={
                      (!libraryReady && !libraryQuery.isError) ||
                      toggleLibrary.isPending ||
                      undefined
                    }
                    className={cn(
                      'h-11 w-11 shrink-0 rounded-lg border transition-colors duration-150 focus-visible:ring-white/60 aria-disabled:cursor-default',
                      isInLibrary
                        ? 'border-white/30 bg-white/15 text-white hover:bg-white/20 hover:text-white'
                        : 'border-white/20 bg-black/25 text-white/80 hover:border-white/35 hover:bg-white/10 hover:text-white',
                    )}
                    // Guard, not `disabled` — disabling the focused button blurs it, unpausing the carousel mid-click.
                    aria-disabled={!libraryReady || toggleLibrary.isPending || undefined}
                    onClick={() => {
                      if (libraryReady && !toggleLibrary.isPending) toggleLibrary.mutate();
                    }}
                  >
                    <span aria-hidden='true' className='relative size-4 shrink-0'>
                      <Plus
                        className={cn(
                          'absolute inset-0 size-4 transition-[opacity,transform] duration-150 motion-reduce:transition-none',
                          isInLibrary ? 'scale-75 opacity-0' : 'scale-100 opacity-100',
                        )}
                      />
                      <Check
                        className={cn(
                          'absolute inset-0 size-4 transition-[opacity,transform] duration-150 motion-reduce:transition-none',
                          isInLibrary ? 'scale-100 opacity-100' : 'scale-75 opacity-0',
                        )}
                      />
                    </span>
                  </Button>
                </div>
              </div>

              <div className='hidden w-[36%] max-w-md shrink-0 flex-col items-end text-right lg:flex'>
                {description && (
                  <p className='text-[13.5px] leading-[1.7] text-zinc-100/80 line-clamp-4 [text-shadow:0_2px_16px_rgba(0,0,0,0.8)]'>
                    {description}
                  </p>
                )}
                {genrePills.length > 0 && (
                  <div className='mt-4 flex flex-wrap items-center justify-end gap-1.5'>
                    {genrePills.map((genre) => (
                      <Link
                        key={genre}
                        to={searchGenrePath(item.type, genre)}
                        title={`Browse ${genre}`}
                        className={GENRE_LINK_CLASS}
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
        isRotationPaused={isRotationPaused}
        onStep={handleStep}
        onToggleRotation={() => setIsRotationPaused((paused) => !paused)}
      />
    </section>
  );
});
