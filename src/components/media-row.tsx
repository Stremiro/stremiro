import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { GenreIcon } from '@/components/genre-icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getErrorMessage, isNoCapableAddonError, type MediaItem } from '@/lib/api';
import { MEDIA_ROW_STALE_TIME_MS } from '@/lib/query-invalidation';
import { cn } from '@/lib/utils';
import { HorizontalMediaRail } from './horizontal-media-rail';
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
  headerActions?: ReactNode;
  queryKey: string[];
  queryFn: () => Promise<MediaItem[]>;
  enabled?: boolean;
  minItems?: number;
  genreFilter?: GenreFilterConfig;
}

export function RailTitleLink({ to, title }: { to: string; title: string }) {
  return (
    <Link
      to={to}
      aria-label={`Browse ${title}`}
      className='group/rail-title inline-flex max-w-full items-center gap-1.5 rounded-xs transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/60 motion-reduce:transition-none'
    >
      {title}
      <ChevronRight
        aria-hidden='true'
        className='h-4 w-4 shrink-0 text-zinc-400 transition-[color,translate] duration-150 motion-reduce:transition-none group-hover/rail-title:translate-x-0.5 group-hover/rail-title:text-zinc-100'
      />
    </Link>
  );
}

export function MediaRow({
  title,
  titleHref,
  headerActions,
  queryKey,
  queryFn,
  enabled = true,
  minItems = 1,
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
    staleTime: MEDIA_ROW_STALE_TIME_MS,
    enabled,
    // Genre switches swap the query key — keep the previous rail visible instead of flashing skeletons.
    placeholderData: enabled ? keepPreviousData : undefined,
  });

  const retryBanner = (
    <RetryBanner
      className='w-full max-w-xl'
      message={data.length > 0 ? "Couldn't refresh this row." : "Couldn't load this row."}
      isRetrying={isFetching}
      onRetry={() => void refetch()}
    />
  );

  const manageAddonsLink = (
    <Link
      to='/settings?section=addons'
      className='rounded-xs text-zinc-200 underline underline-offset-4 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
    >
      Manage addons
    </Link>
  );

  let notice: ReactNode;
  if (!enabled && data.length === 0) {
    if (!genreFilter) return null;
    notice = <p>Reconnect to browse this catalog.</p>;
  } else if (isNoCapableAddonError(error) && data.length === 0) {
    // One explanation per page: secondary rails would repeat the same capability gap.
    if (!genreFilter) return null;
    notice = (
      <>
        <p>{getErrorMessage(error)}</p>
        {manageAddonsLink}
      </>
    );
  } else if ((error || (isFetched && isLoading)) && data.length === 0) {
    notice = retryBanner;
  } else if (!isLoading && data.length === 0) {
    if (!genreFilter) return null;
    notice =
      genreFilter.active === genreFilter.allOption ? (
        <>
          <p>No titles available. Check your catalog addons or try again later.</p>
          {manageAddonsLink}
        </>
      ) : (
        <p>Nothing in {genreFilter.active} right now — try another genre.</p>
      );
  } else if (!isLoading && data.length < minItems) {
    return null;
  }

  return (
    <HorizontalMediaRail
      headerActions={
        headerActions || genreFilter ? (
          <div className='flex min-w-0 flex-wrap items-center gap-x-6 gap-y-3'>
            {headerActions}
            {genreFilter && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type='button'
                    aria-label={`${title} genre: ${genreFilter.active}`}
                    className='ml-auto inline-flex min-h-9 max-w-full items-center gap-2 rounded-md border border-white/10 bg-white/[0.025] px-3 text-[13px] font-medium text-zinc-300 transition-colors hover:border-white/20 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/60 motion-reduce:transition-none'
                  >
                    <GenreIcon genre={genreFilter.active} />
                    <span className='max-w-44 truncate'>
                      {genreFilter.active === genreFilter.allOption
                        ? 'All genres'
                        : genreFilter.active}
                    </span>
                    <ChevronDown aria-hidden='true' className='size-3.5 shrink-0 text-zinc-400' />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align='end'
                  aria-label={`${title} genres`}
                  className='max-h-80 w-56 overflow-y-auto rounded-lg border-white/10 bg-zinc-950 p-1.5'
                >
                  {genreFilter.options.map((genre) => (
                    <DropdownMenuItem
                      key={genre}
                      role='menuitemradio'
                      aria-checked={genreFilter.active === genre}
                      onSelect={() => {
                        if (genreFilter.active !== genre) genreFilter.onChange(genre);
                      }}
                      className='min-h-9 justify-between gap-3 rounded-md px-3 text-sm text-zinc-300 aria-checked:bg-white/[0.06] aria-checked:text-white'
                    >
                      <span className='flex min-w-0 items-center gap-2.5'>
                        <GenreIcon genre={genre} />
                        <span className='truncate'>
                          {genre === genreFilter.allOption ? 'All genres' : genre}
                        </span>
                      </span>
                      {genreFilter.active === genre && (
                        <Check aria-hidden='true' className='size-4 shrink-0 text-(--accent-nav)' />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ) : undefined
      }
      title={titleHref ? <RailTitleLink to={titleHref} title={title} /> : title}
      // Scroll memory keyed by the query — stable across remounts, genre switches land in their own slot.
      railId={`media-row:${queryKey.join(':')}`}
      items={data}
      isLoading={isLoading}
      isPlaceholderData={isPlaceholderData}
      notice={notice}
      getItemKey={mediaCardRailKey}
      renderItem={renderMediaCardRailItem}
      headerContent={error && !notice && <div className='mt-3'>{retryBanner}</div>}
      viewportClassName={cn(
        'transition-opacity duration-200 motion-reduce:transition-none',
        // Delayed so a cache-fast genre switch never flickers the dim.
        isPlaceholderData && 'opacity-60 delay-150',
      )}
    />
  );
}
