import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { MediaItem } from '@/lib/api';
import { MEDIA_ROW_STALE_TIME_MS } from '@/lib/query-invalidation';
import { cn } from '@/lib/utils';
import { HorizontalMediaRail, HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS } from './horizontal-media-rail';
import { mediaCardRailKey, renderMediaCardRailItem } from './media-card';
import { RetryBanner } from './retry-banner';

// One empty-list identity — a fresh `[]` per render would defeat the rail's items-identity scroll reset.
const EMPTY_ITEMS: MediaItem[] = [];

interface GenreFilterConfig {
  options: readonly string[];
  /** The unfiltered option (e.g. "All") — its empty state isn't a genre miss. */
  allOption: string;
  active: string;
  onChange: (genre: string) => void;
}

interface MediaRowProps {
  title: string;
  titleHref?: string;
  queryKey: string[];
  queryFn: () => Promise<MediaItem[]>;
  /** Freshness for this row's catalog entry — a parent sharing the query key (home hero) must pass its own so the pair can't drift. */
  staleTime?: number;
  enabled?: boolean;
  genreFilter?: GenreFilterConfig;
}

export function MediaRow({
  title,
  titleHref,
  queryKey,
  queryFn,
  staleTime = MEDIA_ROW_STALE_TIME_MS,
  enabled = true,
  genreFilter,
}: MediaRowProps) {
  const {
    data = EMPTY_ITEMS,
    isFetching,
    isLoading,
    isFetched,
    isPlaceholderData,
    error,
    refetch,
  } = useQuery({
    queryKey,
    queryFn,
    staleTime,
    enabled,
    // Genre switches swap the query key — keep the previous rail visible instead of flashing skeletons.
    placeholderData: enabled ? keepPreviousData : undefined,
  });

  const genreTabs = genreFilter ? (
    <div
      role='group'
      aria-label={`${title} genres`}
      className='flex items-center gap-5 overflow-x-auto border-b border-white/[0.06] pr-2 scrollbar-hide'
    >
      {genreFilter.options.map((genre) => {
        const isActive = genreFilter.active === genre;
        return (
          <button
            key={genre}
            type='button'
            onClick={() => {
              if (!isActive) genreFilter.onChange(genre);
            }}
            aria-pressed={isActive}
            className={cn(
              'relative min-h-9 flex-none whitespace-nowrap rounded-xs pb-2.5 pt-1 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-(--accent-nav)/60',
              isActive ? 'text-white' : 'text-zinc-400 hover:text-zinc-200',
            )}
          >
            {genre}
            <span
              className={cn(
                'absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-(--accent-nav) transition-opacity duration-200',
                isActive ? 'opacity-100' : 'opacity-0',
              )}
            />
          </button>
        );
      })}
    </div>
  ) : null;

  const renderNotice = (notice: ReactNode) => (
    <section className='py-4 relative'>
      <div className={cn(HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS, 'mb-1')}>
        <h2 className='text-[17px] font-semibold tracking-[-0.02em] text-white mb-3'>{title}</h2>
        {genreTabs}
      </div>
      <div
        className={cn(
          HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS,
          'pt-4 flex flex-wrap items-center gap-3 text-[13px] text-zinc-400',
        )}
      >
        {notice}
      </div>
    </section>
  );

  if (!enabled && data.length === 0) {
    return genreFilter ? renderNotice(<p>Reconnect to browse this catalog.</p>) : null;
  }

  // A failed refetch can still hold placeholder data — keep the stale rail + genre tabs; only a failure with nothing to show gets retry.
  if ((error || (isFetched && isLoading)) && data.length === 0) {
    return renderNotice(
      <RetryBanner
        className='w-full max-w-xl'
        message="Couldn't load this row."
        isRetrying={isFetching}
        onRetry={() => void refetch()}
      />,
    );
  }

  // An empty row is dead space — hide it. Genre-filtered rows keep their tabs (the way back) with a compact hint.
  if (!isLoading && data.length === 0) {
    if (!genreFilter) return null;
    return renderNotice(
      <p>
        {genreFilter.active === genreFilter.allOption
          ? 'Nothing to show right now.'
          : `Nothing in ${genreFilter.active} right now — try another genre.`}
      </p>,
    );
  }

  return (
    <HorizontalMediaRail
      title={
        titleHref ? (
          <Link
            to={titleHref}
            className='group/rail-title inline-flex items-center gap-0.5 rounded-xs transition-colors hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--accent-nav)/60'
          >
            {title}
            <ChevronRight className='h-4 w-4 text-zinc-600 transition-all duration-150 group-hover/rail-title:translate-x-0.5 group-hover/rail-title:text-zinc-400' />
          </Link>
        ) : (
          title
        )
      }
      // Scroll memory keyed by the query — stable across remounts, genre switches land in their own slot.
      railId={`media-row:${queryKey.join(':')}`}
      items={data}
      isLoading={isLoading}
      isPlaceholderData={isPlaceholderData}
      getItemKey={mediaCardRailKey}
      renderItem={renderMediaCardRailItem}
      headerContent={genreTabs}
      viewportClassName={cn('transition-opacity duration-200', isPlaceholderData && 'opacity-60')}
    />
  );
}
