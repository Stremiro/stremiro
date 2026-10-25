import { useQuery } from '@tanstack/react-query';
import { Puzzle, WifiOff, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { Hero } from '@/components/hero';
import {
  HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS,
  HorizontalMediaRail,
} from '@/components/horizontal-media-rail';
import { mediaCardRailKey, renderMediaCardRailItem } from '@/components/media-card';
import { MediaRow } from '@/components/media-row';
import { ResumeSection } from '@/components/resume-section';
import { RetryBanner } from '@/components/retry-banner';
import { ScrollToTop } from '@/components/scroll-to-top';
import { Skeleton } from '@/components/ui/skeleton';
import { useAddonConfigs, useBrowseGenres } from '@/hooks/use-addon-configs';
import { useNearViewport } from '@/hooks/use-near-viewport';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { api, type MediaItem } from '@/lib/api';
import { similarTitlesQueryKey } from '@/lib/api-discovery';
import { handleRadioGroupKeyDown } from '@/lib/dom';
import {
  MEDIA_ROW_STALE_TIME_MS,
  RECENT_WATCH_SEED_QUERY_KEY,
  WATCH_HISTORY_STALE_TIME_MS,
  trendingRowQueryKey,
} from '@/lib/query-invalidation';
import { sameSearchGenre, searchGenrePath, type SearchMediaType } from '@/lib/search-page-state';
import { cn, queryNeedsRetry } from '@/lib/utils';

const ALL_GENRES = 'All';
const TRENDING_TYPES = [
  { type: 'movie', label: 'Movies' },
  { type: 'series', label: 'Series' },
  { type: 'anime', label: 'Animation' },
] as const;

// Home rails use the shared browse pipeline and render only the first page.
function fetchCatalogItems(options: {
  mediaType: Exclude<SearchMediaType, 'all'>;
  genre?: string;
}) {
  return api
    .querySearchCatalogPage({
      mediaType: options.mediaType,
      genres: options.genre ? [options.genre] : undefined,
    })
    .then((page) => page.items);
}

export const homeTrendingMoviesQueryOptions = {
  queryKey: trendingRowQueryKey('movies', ALL_GENRES),
  queryFn: () => fetchCatalogItems({ mediaType: 'movie' }),
  staleTime: MEDIA_ROW_STALE_TIME_MS,
};

function similarRowQuery(seed: MediaItem) {
  return { queryKey: similarTitlesQueryKey(seed), queryFn: () => api.querySimilarTitles(seed) };
}

const recentWatchSeedQueryOptions = {
  queryKey: RECENT_WATCH_SEED_QUERY_KEY,
  queryFn: api.getRecentWatchSeed,
  staleTime: WATCH_HISTORY_STALE_TIME_MS,
  retry: false,
};

const HOME_NOTICE_CLASS =
  'mb-4 flex items-center gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.025] px-4 py-3 text-sm leading-relaxed text-zinc-300';

// Session-scoped: the hint returns on next launch until a stream addon is installed.
let streamAddonHintDismissed = false;

function StreamAddonHint() {
  const [dismissed, setDismissed] = useState(streamAddonHintDismissed);
  const { data: addons, isSuccess } = useAddonConfigs();
  // Unclassified addons (no resources yet) might serve streams; only a known gap shows the hint.
  const hasStreamAddon = addons?.some(
    (addon) =>
      addon.enabled && (addon.resources === undefined || addon.resources.includes('stream')),
  );
  if (dismissed || !isSuccess || hasStreamAddon) return null;

  return (
    <div className={HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS}>
      <div role='status' className={HOME_NOTICE_CLASS}>
        <Puzzle aria-hidden='true' className='h-4 w-4 shrink-0 text-zinc-500' />
        <p className='min-w-0 flex-1'>
          Add a stream addon to start watching.{' '}
          <Link
            to='/settings?section=addons'
            className='rounded-xs text-zinc-200 underline underline-offset-4 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
          >
            Manage addons
          </Link>
        </p>
        <button
          type='button'
          aria-label='Dismiss'
          onClick={() => {
            streamAddonHintDismissed = true;
            setDismissed(true);
          }}
          className='-mr-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
        >
          <X aria-hidden='true' className='h-3.5 w-3.5' />
        </button>
      </div>
    </div>
  );
}

function HomeRowPlaceholder() {
  return (
    <div aria-hidden='true'>
      <HorizontalMediaRail
        title={<Skeleton className='h-7 w-52 bg-white/[0.06]' />}
        items={[]}
        getItemKey={mediaCardRailKey}
        renderItem={renderMediaCardRailItem}
        isLoading
      />
    </div>
  );
}

function DeferredHomeRow({ children }: { children: ReactNode }) {
  const { anchorRef, nearViewport } = useNearViewport();

  return <div ref={anchorRef}>{nearViewport ? children : <HomeRowPlaceholder />}</div>;
}

function RecentWatchRecommendations() {
  const isOnline = useOnlineStatus();
  const recentWatchSeedQuery = useQuery({
    ...recentWatchSeedQueryOptions,
    enabled: isOnline,
  });
  const { data: recentWatchSeed, isSuccess: isRecentSeedReady } = recentWatchSeedQuery;

  if (isOnline && queryNeedsRetry(recentWatchSeedQuery)) {
    return (
      <div className={HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS}>
        <RetryBanner
          className='px-2.5 py-2'
          message="Couldn't load recommendations."
          isRetrying={recentWatchSeedQuery.isFetching}
          onRetry={() => void recentWatchSeedQuery.refetch()}
        />
      </div>
    );
  }
  if (!isRecentSeedReady || !recentWatchSeed) return null;

  return (
    <DeferredHomeRow>
      <MediaRow
        key={`${recentWatchSeed.type}:${recentWatchSeed.id}`}
        title={`Because you watched ${recentWatchSeed.title}`}
        {...similarRowQuery(recentWatchSeed)}
        enabled={isOnline}
        minItems={4}
      />
    </DeferredHomeRow>
  );
}

export function Home() {
  const isOnline = useOnlineStatus();
  const [selectedGenre, setSelectedGenre] = useState(ALL_GENRES);
  const [trendingType, setTrendingType] = useState<Exclude<SearchMediaType, 'all'>>('movie');

  // Same manifest-driven genre list as the search filter.
  const browseGenresQuery = useBrowseGenres({ enabled: isOnline });
  const { data: browseGenres } = browseGenresQuery;
  // A manifest genre literally named "All" would render a second tab for the
  // same unfiltered state — drop it.
  const genreOptions = [
    ALL_GENRES,
    ...(browseGenres?.[trendingType] ?? []).filter(
      (option) => !sameSearchGenre(option, ALL_GENRES),
    ),
  ];

  // Same key/queryFn/staleTime as the `All` movie row — hero and row share one fetch.
  const { data: heroItems, isPending: isHeroPending } = useQuery({
    ...homeTrendingMoviesQueryOptions,
    enabled: isOnline,
  });

  const heroSlice = (heroItems ?? []).slice(0, 5);

  const genre = genreOptions.find((option) => sameSearchGenre(option, selectedGenre)) ?? ALL_GENRES;
  const activeGenre = genre === ALL_GENRES ? undefined : genre;
  const showHero = heroSlice.length > 0 || (isOnline && isHeroPending);

  return (
    <div className='relative flex min-h-[calc(100vh-2rem)] flex-col page-enter'>
      <ScrollToTop />
      {showHero && <Hero items={heroSlice} />}

      {/* Rails overlap the hero's bottom dissolve; the wash ramps across the
          overlap then stays solid to the page end, so the ambient tint never
          shows as a band below the last rail. Mid-stops keep the ramp from
          banding on 8-bit panels (see the ambient layer). */}
      <div
        className={cn(
          'relative z-10 flex-1 space-y-3 pb-20 md:space-y-5',
          showHero ? '-mt-32 md:-mt-40 pt-32 md:pt-40' : 'pt-6',
        )}
        style={
          showHero
            ? {
                background:
                  'linear-gradient(to bottom, transparent 0, rgb(0 0 0 / 0.18) 36px, rgb(0 0 0 / 0.45) 80px, rgb(0 0 0 / 0.78) 112px, black 140px)',
              }
            : undefined
        }
      >
        {!isOnline && (
          <div className={HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS}>
            <div role='status' className={HOME_NOTICE_CLASS}>
              <WifiOff aria-hidden='true' className='h-4 w-4 shrink-0 text-zinc-500' />
              <p>You're offline. Reconnect to refresh titles or find streams.</p>
            </div>
          </div>
        )}
        <StreamAddonHint />
        <ResumeSection />

        <RecentWatchRecommendations />

        {isOnline && queryNeedsRetry(browseGenresQuery) && (
          <div className={HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS}>
            <RetryBanner
              className='px-2.5 py-2'
              message="Couldn't load genres."
              isRetrying={browseGenresQuery.isFetching}
              onRetry={() => void browseGenresQuery.refetch()}
            />
          </div>
        )}
        <MediaRow
          title='Trending'
          titleHref={
            activeGenre
              ? searchGenrePath(trendingType, activeGenre)
              : `/search?type=${trendingType}`
          }
          queryKey={trendingRowQueryKey(trendingType === 'movie' ? 'movies' : trendingType, genre)}
          queryFn={() => fetchCatalogItems({ mediaType: trendingType, genre: activeGenre })}
          enabled={isOnline}
          headerActions={
            <div
              role='radiogroup'
              aria-label='Trending category'
              className='flex shrink-0 items-center gap-5'
            >
              {TRENDING_TYPES.map(({ type, label }) => (
                <button
                  key={type}
                  type='button'
                  role='radio'
                  aria-checked={trendingType === type}
                  tabIndex={trendingType === type ? 0 : -1}
                  onKeyDown={handleRadioGroupKeyDown}
                  onClick={() => setTrendingType(type)}
                  className={cn(
                    'inline-flex min-h-10 items-center border-b-2 px-0.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--accent-nav) motion-reduce:transition-none',
                    trendingType === type
                      ? 'border-(--accent-nav) text-white'
                      : 'border-transparent text-zinc-400 hover:border-white/20 hover:text-zinc-100',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          }
          genreFilter={{
            options: genreOptions,
            allOption: ALL_GENRES,
            active: genre,
            onChange: setSelectedGenre,
          }}
        />
      </div>
    </div>
  );
}
