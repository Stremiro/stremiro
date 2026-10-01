import { useQuery } from '@tanstack/react-query';
import { WifiOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Hero } from '@/components/hero';
import { MediaRow } from '@/components/media-row';
import { ResumeSection } from '@/components/resume-section';
import { useAddonConfigs } from '@/hooks/use-addon-configs';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { api } from '@/lib/api';
import { MEDIA_ROW_STALE_TIME_MS, trendingRowQueryKey } from '@/lib/query-invalidation';
import {
  collectSearchGenreOptions,
  sameSearchGenre,
  searchGenrePath,
  type SearchMediaType,
} from '@/lib/search-page-state';

const ALL_GENRES = 'All';

// Home rails use the shared browse pipeline and render only the first page.
function fetchCatalogItems(options: {
  mediaType: SearchMediaType;
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

export function Home() {
  const isOnline = useOnlineStatus();
  const [genre, setGenre] = useState(ALL_GENRES);

  // Same manifest-driven genre list as the search filter: one source of
  // truth, and the rail follows whatever the metadata addon declares.
  const { data: addonConfigs = [] } = useAddonConfigs({ enabled: isOnline });
  const genreOptions = useMemo(
    // A manifest genre literally named "All" would render a second,
    // differently-styled tab for the same unfiltered state — drop it.
    () => [
      ALL_GENRES,
      ...collectSearchGenreOptions(addonConfigs, 'movie').filter(
        (option) => !sameSearchGenre(option, ALL_GENRES),
      ),
    ],
    [addonConfigs],
  );

  // Same key/queryFn/staleTime as the `All` movie row, so hero and row share
  // one fetch.
  const { data: heroItems, isPending: isHeroPending } = useQuery({
    queryKey: trendingRowQueryKey('movies', 'All'),
    queryFn: () => fetchCatalogItems({ mediaType: 'movie' }),
    staleTime: MEDIA_ROW_STALE_TIME_MS,
    enabled: isOnline,
  });

  // Stable slice so Hero's memo holds across unrelated home re-renders.
  const heroSlice = useMemo(() => (heroItems ?? []).slice(0, 5), [heroItems]);

  if (!isOnline) {
    return (
      <div className='flex flex-col items-center justify-center min-h-[80vh] space-y-6 text-center page-enter'>
        <div className='rounded-full bg-zinc-800/50 p-6'>
          <WifiOff className='h-12 w-12 text-zinc-500' />
        </div>
        <div className='space-y-2'>
          <h1 className='text-[22px] font-medium tracking-[-0.02em] text-white'>You are offline</h1>
          <p className='text-muted-foreground max-w-sm mx-auto'>
            Connect to the internet to browse content.
          </p>
        </div>
      </div>
    );
  }

  const activeGenre = genre === ALL_GENRES ? undefined : genre;

  return (
    <div className='flex flex-col min-h-screen pb-20 relative page-enter'>
      {(isHeroPending || heroSlice.length > 0) && <Hero items={heroSlice} />}

      {/* Rails overlap the hero's bottom dissolve; the wash ramps across the
          overlap, then stays solid. Mid-stops keep the ramp smooth enough
          that it can't band on 8-bit panels (see the ambient layer). */}
      <div
        className='relative z-10 -mt-32 md:-mt-40 pt-32 md:pt-40 space-y-2'
        style={{
          background:
            'linear-gradient(to bottom, transparent 0, rgb(0 0 0 / 0.18) 36px, rgb(0 0 0 / 0.45) 80px, rgb(0 0 0 / 0.78) 112px, black 140px)',
        }}
      >
        <ResumeSection />

        <MediaRow
          title='Trending Movies'
          titleHref={activeGenre ? searchGenrePath('movie', activeGenre) : '/search?type=movie'}
          queryKey={trendingRowQueryKey('movies', genre)}
          queryFn={() => fetchCatalogItems({ mediaType: 'movie', genre: activeGenre })}
          staleTime={MEDIA_ROW_STALE_TIME_MS}
          genreFilter={{
            options: genreOptions,
            allOption: ALL_GENRES,
            active: genre,
            onChange: setGenre,
          }}
        />

        <MediaRow
          title='Trending Series'
          titleHref='/search?type=series'
          queryKey={trendingRowQueryKey('series', 'All')}
          queryFn={() => fetchCatalogItems({ mediaType: 'series' })}
        />

        {/* The anime catalog is provider "Animation" series, which also
            carries western cartoons — the title says what it holds. */}
        <MediaRow
          title='Trending Animation'
          titleHref='/search?type=anime'
          queryKey={trendingRowQueryKey('anime', 'All')}
          queryFn={() => fetchCatalogItems({ mediaType: 'anime' })}
        />

        <MediaRow
          title='Top Rated'
          titleHref='/search?type=movie&feed=featured'
          // Under the `trending` prefix so invalidateDiscoveryQueries covers it.
          queryKey={trendingRowQueryKey('top-rated', 'movies')}
          queryFn={() => fetchCatalogItems({ mediaType: 'movie', feed: 'featured' })}
        />
      </div>
    </div>
  );
}
