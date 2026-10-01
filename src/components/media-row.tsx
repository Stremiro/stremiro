import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { MediaItem } from '@/lib/api';
import { MEDIA_ROW_STALE_TIME_MS } from '@/lib/query-invalidation';
import { cn } from '@/lib/utils';
import { HorizontalMediaRail, HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS } from './horizontal-media-rail';
import { mediaCardRailKey, renderMediaCardRailItem } from './media-card';

// Shared empty list so an unloaded query keeps one array identity — a fresh
// `[]` per render would defeat the rail's items-identity scroll reset.
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
  /** Freshness for this row's catalog entry. A parent sharing the same
      query key (e.g. the home hero) must pass its own value so the pair
      can't drift into two refetch cadences for one entry. */
  staleTime?: number;
  genreFilter?: GenreFilterConfig;
}

export function MediaRow({
  title,
  titleHref,
  queryKey,
  queryFn,
  staleTime = MEDIA_ROW_STALE_TIME_MS,
  genreFilter,
}: MediaRowProps) {
  const {
    data = EMPTY_ITEMS,
    isLoading,
    isPlaceholderData,
    error,
    refetch,
  } = useQuery({
    queryKey,
    queryFn,
    staleTime,
    // Genre switches swap the query key — keep the previous rail visible
    // while the new catalog fetches instead of flashing a skeleton row.
    placeholderData: keepPreviousData,
  });

  const genreTabs = genreFilter ? (
    <div className='flex items-center gap-5 overflow-x-auto border-b border-white/[0.06] pr-2 scrollbar-hide'>
      {genreFilter.options.map((genre) => {
        const isActive = genreFilter.active === genre;
        return (
          <button
            key={genre}
            type='button'
            onClick={() => genreFilter.onChange(genre)}
            aria-pressed={isActive}
            className={cn(
              'relative flex-none whitespace-nowrap rounded-xs pb-2.5 pt-1 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30',
              isActive ? 'text-white' : 'text-zinc-500 hover:text-zinc-200',
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
          'pt-4 flex items-center gap-3 text-[13px] text-zinc-600',
        )}
      >
        {notice}
      </div>
    </section>
  );

  // A failed refetch can still hold placeholder data — keep the stale rail
  // (and the genre tabs, the user's way back to working content) instead of
  // deleting the row. Only a failure with nothing to show gets a retry row.
  if (error && data.length === 0) {
    return renderNotice(
      <>
        <p>Couldn't load this row.</p>
        <button
          type='button'
          className='rounded-xs text-xs font-medium text-zinc-500 hover:text-zinc-200 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30'
          onClick={() => void refetch()}
        >
          Retry →
        </button>
      </>,
    );
  }

  // An empty catalog row is dead space — hide it. Rows carrying a genre
  // filter keep their tabs mounted (they're the way back to a non-empty
  // result) and show a compact hint instead of a blank scroller.
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
            className='group/rail-title inline-flex items-center gap-0.5 rounded-xs transition-colors hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30'
          >
            {title}
            <ChevronRight className='h-4 w-4 text-zinc-600 transition-all duration-150 group-hover/rail-title:translate-x-0.5 group-hover/rail-title:text-zinc-400' />
          </Link>
        ) : (
          title
        )
      }
      // Scroll memory keyed by the catalog query: stable across remounts, and
      // genre switches land in their own slot instead of inheriting a foreign
      // position.
      railId={`media-row:${queryKey.join(':')}`}
      items={data}
      isLoading={isLoading}
      getItemKey={mediaCardRailKey}
      renderItem={renderMediaCardRailItem}
      headerContent={genreTabs}
      viewportClassName={cn('transition-opacity duration-200', isPlaceholderData && 'opacity-60')}
    />
  );
}
