import { useQuery, useQueryClient } from '@tanstack/react-query';
import { WifiOff } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Hero } from '@/components/hero';
import { HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS } from '@/components/horizontal-media-rail';
import { MediaRow } from '@/components/media-row';
import { ResumeSection } from '@/components/resume-section';
import { useBrowseGenres } from '@/hooks/use-addon-configs';
import { useNearViewport } from '@/hooks/use-near-viewport';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { api, type MediaItem } from '@/lib/api';
import { similarTitlesQueryKey } from '@/lib/api-discovery';
import {
  MEDIA_ROW_STALE_TIME_MS,
  RECENT_WATCH_SEED_QUERY_KEY,
  WATCH_HISTORY_STALE_TIME_MS,
  trendingRowQueryKey,
} from '@/lib/query-invalidation';
import { sameSearchGenre, searchGenrePath, type SearchMediaType } from '@/lib/search-page-state';
import { cn } from '@/lib/utils';

const ALL_GENRES = 'All';

// Home rails use the shared browse pipeline and render only the first page.
function fetchCatalogItems(options: {
  mediaType: Exclude<SearchMediaType, 'all'>;
  feed?: 'featured';
  genre?: string;
}) {
  return api
    .querySearchCatalogPage({
      mediaType: options.mediaType,
      feed: options.feed,
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

function HomeRowPlaceholder() {
  return <div aria-hidden='true' className='h-[453px] md:h-[483px]' />;
}

function DeferredHomeRow({ children }: { children: ReactNode }) {
  const { anchorRef, nearViewport } = useNearViewport();

  return <div ref={anchorRef}>{nearViewport ? children : <HomeRowPlaceholder />}</div>;
}

function RecentWatchRecommendations() {
  const isOnline = useOnlineStatus();
  const {
    data: recentWatchSeed,
    isLoading,
    isSuccess: isRecentSeedReady,
  } = useQuery({
    ...recentWatchSeedQueryOptions,
    enabled: isOnline,
  });

  if (isLoading) return <HomeRowPlaceholder />;
  if (!isRecentSeedReady || !recentWatchSeed) return null;

  return (
    <MediaRow
      key={`${recentWatchSeed.type}:${recentWatchSeed.id}`}
      title={`Because you watched ${recentWatchSeed.title}`}
      {...similarRowQuery(recentWatchSeed)}
      enabled={isOnline}
      minItems={4}
    />
  );
}

export function Home() {
  const isOnline = useOnlineStatus();
  const queryClient = useQueryClient();
  const [selectedGenre, setSelectedGenre] = useState(ALL_GENRES);

  useEffect(() => {
    if (!isOnline) return;
    // Resolve the seed's similar titles too, so the row is ready before it scrolls into view.
    const prefetch = () =>
      void queryClient
        .fetchQuery(recentWatchSeedQueryOptions)
        .then((seed) => {
          if (seed) {
            void queryClient.prefetchQuery({
              ...similarRowQuery(seed),
              staleTime: MEDIA_ROW_STALE_TIME_MS,
            });
          }
        })
        .catch(() => undefined);
    if (typeof window.requestIdleCallback === 'function') {
      const idle = window.requestIdleCallback(prefetch, { timeout: 1500 });
      return () => window.cancelIdleCallback(idle);
    }
    const timer = window.setTimeout(prefetch, 1000);
    return () => window.clearTimeout(timer);
  }, [isOnline, queryClient]);

  // Same manifest-driven genre list as the search filter.
  const { data: browseGenres } = useBrowseGenres({ enabled: isOnline });
  // A manifest genre literally named "All" would render a second tab for the
  // same unfiltered state — drop it.
  const genreOptions = [
    ALL_GENRES,
    ...(browseGenres?.movie ?? []).filter((option) => !sameSearchGenre(option, ALL_GENRES)),
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
    <div className='flex flex-col min-h-screen pb-20 relative page-enter'>
      {showHero && <Hero items={heroSlice} />}

      {/* Rails overlap the hero's bottom dissolve; the wash ramps across the
          overlap then stays solid. Mid-stops keep the ramp from banding on
          8-bit panels (see the ambient layer). */}
      <div
        className={cn(
          'relative z-10 space-y-2',
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
            <div
              role='status'
              className='mb-4 flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.025] px-4 py-3 text-[12.5px] text-zinc-400'
            >
              <WifiOff aria-hidden='true' className='h-4 w-4 shrink-0 text-zinc-500' />
              <p>You're offline. Reconnect to refresh titles or find streams.</p>
            </div>
          </div>
        )}
        <ResumeSection />

        <MediaRow
          title='Trending Movies'
          titleHref={activeGenre ? searchGenrePath('movie', activeGenre) : '/search?type=movie'}
          queryKey={trendingRowQueryKey('movies', genre)}
          queryFn={() => fetchCatalogItems({ mediaType: 'movie', genre: activeGenre })}
          enabled={isOnline}
          genreFilter={{
            options: genreOptions,
            allOption: ALL_GENRES,
            active: genre,
            onChange: setSelectedGenre,
          }}
        />

        <DeferredHomeRow>
          <MediaRow
            title='Trending Series'
            titleHref='/search?type=series'
            queryKey={trendingRowQueryKey('series', 'All')}
            queryFn={() => fetchCatalogItems({ mediaType: 'series' })}
            enabled={isOnline}
          />
        </DeferredHomeRow>

        <DeferredHomeRow>
          <RecentWatchRecommendations />
        </DeferredHomeRow>

        {/* Provider "Animation" series also carries western cartoons — hence the title. */}
        <DeferredHomeRow>
          <MediaRow
            title='Trending Animation'
            titleHref='/search?type=anime'
            queryKey={trendingRowQueryKey('anime', 'All')}
            queryFn={() => fetchCatalogItems({ mediaType: 'anime' })}
            enabled={isOnline}
          />
        </DeferredHomeRow>

        <DeferredHomeRow>
          <MediaRow
            title='Top Rated'
            titleHref='/search?type=movie&feed=featured'
            // Under the `trending` prefix so invalidateDiscoveryQueries covers it.
            queryKey={trendingRowQueryKey('top-rated', 'movies')}
            queryFn={() => fetchCatalogItems({ mediaType: 'movie', feed: 'featured' })}
            enabled={isOnline}
          />
        </DeferredHomeRow>
      </div>
    </div>
  );
}
