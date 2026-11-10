import { useQuery } from '@tanstack/react-query';
import { Bookmark, Flame, Puzzle, Sparkles, WifiOff, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Hero } from '@/components/hero';
import {
  HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS,
  HorizontalMediaRail,
  RailSkeleton,
} from '@/components/horizontal-media-rail';
import { mediaCardRailKey, renderMediaCardRailItem } from '@/components/media-card';
import { MediaRow, RailTitleLink } from '@/components/media-row';
import { ResumeSection } from '@/components/resume-section';
import { RetryBanner } from '@/components/retry-banner';
import { ScrollToTop } from '@/components/scroll-to-top';
import { Skeleton } from '@/components/ui/skeleton';
import { useAddonConfigs } from '@/hooks/use-addon-configs';
import { useNearViewport } from '@/hooks/use-near-viewport';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { api } from '@/lib/api';
import { similarTitlesQueryKey } from '@/lib/api-discovery';
import {
  MEDIA_ROW_STALE_TIME_MS,
  RECENT_WATCH_SEED_QUERY_KEY,
  WATCH_HISTORY_STALE_TIME_MS,
  WATCHLIST_QUERY_KEY,
  trendingRowQueryKey,
} from '@/lib/query-invalidation';
import { cn, PAGE_NOTICE_CLASS, queryNeedsRetry } from '@/lib/utils';

const ALL_GENRES = 'All';

// The 'all' catalog unions every type server-side — one mixed Trending feed.
export const homeTrendingQueryOptions = {
  queryKey: trendingRowQueryKey('all', ALL_GENRES),
  queryFn: () => api.querySearchCatalogPage({}).then((page) => page.items),
  staleTime: MEDIA_ROW_STALE_TIME_MS,
};

const recentWatchSeedQueryOptions = {
  queryKey: RECENT_WATCH_SEED_QUERY_KEY,
  queryFn: api.getRecentWatchSeed,
  staleTime: WATCH_HISTORY_STALE_TIME_MS,
  retry: false,
};

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
      <div role='status' className={cn(PAGE_NOTICE_CLASS, 'mb-4')}>
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
    <div aria-hidden='true' className='relative py-5 md:py-6'>
      <div className={`${HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS} mb-4`}>
        <div className='flex min-h-10 items-center'>
          <Skeleton className='h-7 w-52 bg-white/[0.06]' />
        </div>
      </div>
      <div className={`${HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS} overflow-hidden`}>
        <div className='flex gap-4 px-1 pt-1 pb-8'>
          <RailSkeleton />
        </div>
      </div>
    </div>
  );
}

// Local-only rail: no skeleton or error surface, so it never appears for an empty watchlist.
function WatchlistRail() {
  const { data: watchlist } = useQuery({
    queryKey: WATCHLIST_QUERY_KEY,
    queryFn: api.getWatchlist,
    staleTime: WATCH_HISTORY_STALE_TIME_MS,
  });
  if (!watchlist?.length) return null;

  return (
    <HorizontalMediaRail
      icon={Bookmark}
      title={<RailTitleLink to='/profile?status=plan_to_watch' title='Watchlist' />}
      railId='watchlist'
      items={watchlist}
      isLoading={false}
      getItemKey={mediaCardRailKey}
      renderItem={renderMediaCardRailItem}
    />
  );
}

function RecentWatchRecommendations() {
  const isOnline = useOnlineStatus();
  const recentWatchSeedQuery = useQuery({
    ...recentWatchSeedQueryOptions,
    enabled: isOnline,
  });
  const { data: recentWatchSeed } = recentWatchSeedQuery;
  const { anchorRef, nearViewport } = useNearViewport(Boolean(recentWatchSeed));

  return (
    <>
      {isOnline && queryNeedsRetry(recentWatchSeedQuery) && (
        <div className={HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS}>
          <RetryBanner
            className='px-2.5 py-2'
            message="Couldn't load recommendations."
            isRetrying={recentWatchSeedQuery.isFetching}
            onRetry={() => void recentWatchSeedQuery.refetch()}
          />
        </div>
      )}
      {recentWatchSeed && (
        <div ref={anchorRef}>
          {nearViewport ? (
            <MediaRow
              key={`${recentWatchSeed.type}:${recentWatchSeed.id}`}
              icon={Sparkles}
              title={`Because you watched ${recentWatchSeed.title}`}
              queryKey={similarTitlesQueryKey(recentWatchSeed)}
              queryFn={() => api.querySimilarTitles(recentWatchSeed)}
              enabled={isOnline}
              minItems={4}
            />
          ) : (
            <HomeRowPlaceholder />
          )}
        </div>
      )}
    </>
  );
}

export function Home() {
  const isOnline = useOnlineStatus();

  // Same key/queryFn/staleTime as the Trending rail — hero and row share one fetch.
  const { data: heroItems, isPending: isHeroPending } = useQuery({
    ...homeTrendingQueryOptions,
    enabled: isOnline,
  });

  const heroSlice = (heroItems ?? []).slice(0, 5);
  const showHero = heroSlice.length > 0 || (isOnline && isHeroPending);

  return (
    <div className='relative flex min-h-[calc(100vh-2rem)] flex-col page-enter'>
      <ScrollToTop />
      {showHero && <Hero items={heroSlice} />}

      {/* An opaque ramp across the hero overlap prevents an ambient band below the rails.
          Intermediate stops reduce banding on 8-bit panels. */}
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
            <div role='status' className={cn(PAGE_NOTICE_CLASS, 'mb-4')}>
              <WifiOff aria-hidden='true' className='h-4 w-4 shrink-0 text-zinc-500' />
              <p>You're offline. Reconnect to refresh titles or find streams.</p>
            </div>
          </div>
        )}
        <StreamAddonHint />
        <ResumeSection />
        <WatchlistRail />

        <RecentWatchRecommendations />

        <MediaRow
          icon={Flame}
          title='Trending'
          titleHref='/search'
          primary
          queryKey={homeTrendingQueryOptions.queryKey}
          queryFn={homeTrendingQueryOptions.queryFn}
          enabled={isOnline}
        />
      </div>
    </div>
  );
}
