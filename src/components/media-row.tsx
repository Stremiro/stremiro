import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { getErrorMessage, isNoCapableAddonError, type MediaItem } from '@/lib/api';
import { MEDIA_ROW_STALE_TIME_MS } from '@/lib/query-invalidation';
import { cn } from '@/lib/utils';
import { HorizontalMediaRail } from './horizontal-media-rail';
import { mediaCardRailKey, renderMediaCardRailItem } from './media-card';
import { RetryBanner } from './retry-banner';

const EMPTY_ITEMS: MediaItem[] = [];

interface MediaRowProps {
  title: string;
  titleHref?: string;
  icon?: LucideIcon;
  queryKey: string[];
  queryFn: () => Promise<MediaItem[]>;
  enabled?: boolean;
  minItems?: number;
  /** The page's primary rail owns error/empty notices; secondary rails stay silent. */
  primary?: boolean;
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
        className='size-3.5 shrink-0 text-zinc-500 transition-[color,translate] duration-150 motion-reduce:transition-none motion-safe:group-hover/rail-title:translate-x-0.5 motion-safe:group-focus-visible/rail-title:translate-x-0.5 group-hover/rail-title:text-zinc-100 group-focus-visible/rail-title:text-zinc-100'
      />
    </Link>
  );
}

export function MediaRow({
  title,
  titleHref,
  icon,
  queryKey,
  queryFn,
  enabled = true,
  minItems = 1,
  primary = false,
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
    // Key swaps keep the previous rail visible instead of flashing skeletons.
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
    if (!primary) return null;
    notice = <p>Reconnect to browse this catalog.</p>;
  } else if (isNoCapableAddonError(error) && data.length === 0) {
    // One explanation per page: secondary rails would repeat the same capability gap.
    if (!primary) return null;
    notice = (
      <>
        <p>{getErrorMessage(error)}</p>
        {manageAddonsLink}
      </>
    );
  } else if ((error || (isFetched && isLoading)) && data.length === 0) {
    notice = retryBanner;
  } else if (!isLoading && data.length === 0) {
    if (!primary) return null;
    notice = (
      <>
        <p>No titles available. Check your catalog addons or try again later.</p>
        {manageAddonsLink}
      </>
    );
  } else if (!isLoading && data.length < minItems) {
    return null;
  }

  return (
    <HorizontalMediaRail
      icon={icon}
      title={titleHref ? <RailTitleLink to={titleHref} title={title} /> : title}
      // Scroll memory keyed by the query — stable across remounts.
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
