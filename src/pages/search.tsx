import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowUp,
  Check,
  ChevronDown,
  Loader2,
  RotateCcw,
  Search as SearchIcon,
  SearchX,
  Shapes,
  TrendingUp,
  WifiOff,
  X,
} from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigationType } from 'react-router';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  MEDIA_CARD_TEXT_BLOCK_HEIGHT_PX,
  MediaCard,
  MediaCardSkeleton,
  mediaCardRailKey,
} from '@/components/media-card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { WindowVirtualizedGrid } from '@/components/window-virtualized-grid';
import { useBrowseGenres } from '@/hooks/use-addon-configs';
import { useAmbientActivity } from '@/hooks/use-ambient-activity';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { useRafScrollListener } from '@/hooks/use-raf-scroll-listener';
import { useSearchPageState } from '@/hooks/use-search-page-state';
import { useSearchResults } from '@/hooks/use-search-results';
import { SLIDING_ACCENT_PILL_CLASS, useSlidingIndicator } from '@/hooks/use-sliding-indicator';
import { getErrorMessage, type MediaItem } from '@/lib/api';
import { whenRowMounted } from '@/lib/dom';
import { navigateAppBack } from '@/lib/navigation';
import { prefetchSearchCatalog } from '@/lib/search-catalog';
import {
  sameSearchGenre,
  searchGenreOptions,
  type SearchFeed,
  type SearchMediaType,
} from '@/lib/search-page-state';
import { cn, queryNeedsRetry, scrollBehavior, SIDEBAR_PAGE_COLUMN_INSETS } from '@/lib/utils';

// Results fill every row edge to edge: auto-fill columns grow from the 170px
// home minimum so wide screens fit a full row with no trailing empty slot.
const SEARCH_RESULTS_CLASS_NAME =
  'grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-4 gap-y-8 sm:grid-cols-[repeat(auto-fill,minmax(170px,1fr))]';
const SEARCH_RESULT_ITEM_CLASS_NAME = 'min-w-0';

// Mirrors the auto-fill minmax() rules above so the virtualizer's column count
// matches the CSS grid exactly.
const SEARCH_GRID_GAP_PX = 16;
const SEARCH_GRID_ROW_GAP_PX = 32;
const SEARCH_GRID_SM_BREAKPOINT_PX = 640;
const SEARCH_GRID_MIN_ITEM_WIDTH_PX = 170;
const SEARCH_GRID_MIN_ITEM_WIDTH_NARROW_PX = 150;

function getSearchGridColumnCount(viewportWidth: number, containerWidth: number) {
  const minItemWidth =
    viewportWidth >= SEARCH_GRID_SM_BREAKPOINT_PX
      ? SEARCH_GRID_MIN_ITEM_WIDTH_PX
      : SEARCH_GRID_MIN_ITEM_WIDTH_NARROW_PX;
  const width = containerWidth > 0 ? containerWidth : viewportWidth;
  return Math.max(
    1,
    Math.floor((width + SEARCH_GRID_GAP_PX) / (minItemWidth + SEARCH_GRID_GAP_PX)),
  );
}

const SEARCH_TYPE_OPTIONS: ReadonlyArray<{ id: SearchMediaType; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'movie', label: 'Movies' },
  { id: 'series', label: 'Series' },
  { id: 'anime', label: 'Anime' },
];

const SEARCH_FEED_OPTIONS: ReadonlyArray<{ id: SearchFeed; label: string }> = [
  { id: 'popular', label: 'Trending' },
  { id: 'featured', label: 'Featured' },
  { id: 'new', label: 'New' },
];

const SEARCH_SKELETON_COUNT = 21;
const SEARCH_SKELETON_KEYS = Array.from(
  { length: SEARCH_SKELETON_COUNT },
  (_, index) => `search-skeleton-${index}`,
);
const renderSearchResult = (item: MediaItem, index: number) => (
  <div data-search-result-index={index} className={SEARCH_RESULT_ITEM_CLASS_NAME}>
    <MediaCard item={item} />
  </div>
);
const estimateSearchItemHeight = (itemWidth: number) =>
  itemWidth * 1.5 + MEDIA_CARD_TEXT_BLOCK_HEIGHT_PX;
const SEARCH_PILL_BUTTON_CLASS =
  'h-9 rounded-md border border-white/[0.08] bg-white/[0.04] px-3.5 text-[13px] font-medium text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 aria-disabled:cursor-default aria-disabled:opacity-50';
const SEARCH_FACET_BUTTON_CLASS =
  'nav-switch-item group flex h-[38px] items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25';
const SEARCH_FACET_IDLE_CLASS =
  'border-white/[0.08] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 data-[state=open]:bg-white/[0.07] data-[state=open]:text-zinc-100';

function SearchPanel({
  action,
  description,
  icon,
  role,
  title,
  titleRole,
}: {
  action?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  role?: string;
  title: ReactNode;
  titleRole?: string;
}) {
  return (
    <div
      role={role}
      className='mx-auto mt-10 flex max-w-sm flex-col items-center justify-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.015] px-6 py-12 text-center'
    >
      {icon ? <span className='flex h-10 w-10 items-center justify-center'>{icon}</span> : null}
      <p
        role={titleRole}
        className='max-w-full [overflow-wrap:anywhere] text-[15px] font-semibold text-zinc-200'
      >
        {title}
      </p>
      {description ? (
        <p className='w-full max-w-xs [overflow-wrap:anywhere] text-[13px] leading-relaxed text-zinc-500'>
          {description}
        </p>
      ) : null}
      {action}
    </div>
  );
}

interface SearchResultsProps {
  activeGenre?: string;
  errorObj: unknown;
  fetchNextPage: () => void;
  hasActiveFilters: boolean;
  hasNextPage: boolean;
  isError: boolean;
  isFetchNextPageError: boolean;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  isOnline: boolean;
  isPlaceholderData: boolean;
  isRefining: boolean;
  isRetryingInitialLoad: boolean;
  onResetFilters: () => void;
  onClearSearch: () => void;
  refetch: () => void;
  results: MediaItem[];
  showSkeleton: boolean;
  trimmedDebouncedQuery: string;
}

// Memoized so a keystroke only re-renders the header — the virtualized grid
// is untouched until a results-describing prop changes.
const SearchResults = memo(function SearchResults({
  activeGenre,
  errorObj,
  fetchNextPage,
  hasActiveFilters,
  hasNextPage,
  isError,
  isFetchNextPageError,
  isFetching,
  isFetchingNextPage,
  isOnline,
  isPlaceholderData,
  isRefining,
  isRetryingInitialLoad,
  onResetFilters,
  onClearSearch,
  refetch,
  results,
  showSkeleton,
  trimmedDebouncedQuery,
}: SearchResultsProps) {
  // Sentinel observer; view-state deps re-attach it after offline/error/loading remounts.
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [pagingFocused, setPagingFocused] = useState(false);
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    // `isError` must gate observation: a failed next-page leaves the sentinel
    // in view and re-observing would refire `fetchNextPage` in a loop.
    if (!sentinel || !isOnline || !hasNextPage || isError || isFetching || isRefining) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void fetchNextPage();
        }
      },
      { rootMargin: '600px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isError, isFetching, isOnline, isRefining, showSkeleton]);

  const loadMoreOrRetry = () => {
    if (!isFetching && !isRefining && (hasNextPage || isError)) {
      void (isError && !isFetchNextPageError ? refetch() : fetchNextPage());
    }
  };

  if (!isOnline && results.length === 0) {
    return (
      <SearchPanel
        icon={<WifiOff className='h-5 w-5 text-zinc-400' />}
        title="You're offline"
        description='Connect to the internet to browse and search.'
      />
    );
  }

  if (results.length === 0 && hasNextPage && !isPlaceholderData) {
    return (
      <SearchPanel
        title={isError ? 'Failed to load content' : 'No matching titles yet'}
        description={
          isError
            ? getErrorMessage(errorObj)
            : 'No matches in the pages searched so far. Load more to keep looking.'
        }
        titleRole={isError ? 'alert' : 'status'}
        action={
          <button
            type='button'
            aria-disabled={isFetching || isRefining || undefined}
            aria-busy={isFetching || undefined}
            onClick={loadMoreOrRetry}
            className={cn(SEARCH_PILL_BUTTON_CLASS, 'mt-1 inline-flex items-center gap-2')}
          >
            {isError ? 'Retry' : 'Load more'}
          </button>
        }
      />
    );
  }

  if (showSkeleton) {
    return (
      <>
        <span role='status' className='sr-only'>
          Loading results
        </span>
        <div aria-hidden='true' className={SEARCH_RESULTS_CLASS_NAME}>
          {SEARCH_SKELETON_KEYS.map((key) => (
            <div key={key} className={SEARCH_RESULT_ITEM_CLASS_NAME}>
              <MediaCardSkeleton />
            </div>
          ))}
        </div>
      </>
    );
  }

  // A failed next-page keeps the loaded grid; the full panel is only for a
  // query that produced nothing.
  if ((isError || isRetryingInitialLoad) && results.length === 0) {
    return (
      <SearchPanel
        role={isRetryingInitialLoad ? 'status' : 'alert'}
        title={isRetryingInitialLoad ? 'Loading content…' : 'Failed to load content'}
        description={
          isRetryingInitialLoad ? 'Trying the request again.' : getErrorMessage(errorObj)
        }
        action={
          <button
            type='button'
            // Keep the recovery button mounted and focusable while it retries.
            aria-disabled={isFetching || isRefining || undefined}
            aria-busy={isFetching || undefined}
            onClick={() => {
              if (!isFetching && !isRefining) void refetch();
            }}
            className={cn(SEARCH_PILL_BUTTON_CLASS, 'mt-1 inline-flex items-center gap-2')}
          >
            Retry
          </button>
        }
      />
    );
  }

  if (results.length === 0) {
    return (
      <SearchPanel
        icon={<SearchX className='h-5 w-5 text-zinc-400' />}
        title={
          trimmedDebouncedQuery
            ? `No results for \u201c${trimmedDebouncedQuery}\u201d`
            : activeGenre
              ? `No ${activeGenre} titles found`
              : 'No content available'
        }
        titleRole='status'
        description={
          trimmedDebouncedQuery
            ? 'Try a different term or another category.'
            : activeGenre
              ? 'Try another genre or feed.'
              : 'Try changing the category.'
        }
        action={
          hasActiveFilters ? (
            <button
              type='button'
              onClick={onResetFilters}
              className={cn(SEARCH_PILL_BUTTON_CLASS, 'mt-1')}
            >
              Reset filters
            </button>
          ) : trimmedDebouncedQuery ? (
            <button
              type='button'
              onClick={onClearSearch}
              className={cn(SEARCH_PILL_BUTTON_CLASS, 'mt-1')}
            >
              Clear search
            </button>
          ) : undefined
        }
      />
    );
  }

  return (
    // keepPreviousData leaves the old grid mounted; dim + aria-busy signal the
    // refresh. It dims only while the previous facet's results stand in;
    // background refreshes of the current facet stay full-opacity.
    <div
      aria-busy={isFetching || undefined}
      className={cn(
        'transition-opacity duration-200 motion-reduce:transition-none',
        isPlaceholderData && 'opacity-60',
      )}
    >
      {!isOnline && (
        <div
          role='status'
          className='mb-5 flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.025] px-4 py-3 text-[12.5px] text-zinc-400'
        >
          <WifiOff aria-hidden='true' className='h-4 w-4 shrink-0 text-zinc-500' />
          You&apos;re offline. Showing cached titles until you reconnect.
        </div>
      )}
      <WindowVirtualizedGrid
        items={results}
        getItemKey={mediaCardRailKey}
        renderItem={renderSearchResult}
        estimateItemHeight={estimateSearchItemHeight}
        getColumnCount={getSearchGridColumnCount}
        gap={SEARCH_GRID_GAP_PX}
        rowGap={SEARCH_GRID_ROW_GAP_PX}
      />
      <div ref={loadMoreRef} aria-hidden='true' className='h-1' />
      {isOnline && (hasNextPage || isError || isFetchingNextPage || pagingFocused) && (
        <div className='flex flex-col items-center gap-1.5 pt-6'>
          {isError && (
            <p role='alert' className='text-[12px] text-zinc-500'>
              {getErrorMessage(errorObj)}
            </p>
          )}
          <button
            type='button'
            aria-disabled={isFetching || isRefining || (!hasNextPage && !isError) || undefined}
            aria-busy={isFetching || undefined}
            onFocus={() => setPagingFocused(true)}
            onBlur={() => setPagingFocused(false)}
            onClick={loadMoreOrRetry}
            className={cn(SEARCH_PILL_BUTTON_CLASS, 'inline-flex items-center gap-2')}
          >
            <span aria-live='polite'>
              {isFetchingNextPage
                ? 'Loading more titles'
                : isError
                  ? 'Retry'
                  : hasNextPage
                    ? 'Load more'
                    : 'All titles loaded'}
            </span>
          </button>
        </div>
      )}
    </div>
  );
});

// Facet switches swap the whole grid; land on the first row, not mid-list.
const resetScroll = () => window.scrollTo({ top: 0 });

// Re-picking the checked option is a no-op, so the scroll position stays put.
function FacetMenuItem({
  checked,
  children,
  onSelect,
  title,
}: {
  checked: boolean;
  children: ReactNode;
  onSelect: () => void;
  title?: string;
}) {
  return (
    <DropdownMenuItem
      role='menuitemradio'
      aria-checked={checked}
      title={title}
      onSelect={() => {
        if (checked) return;
        onSelect();
        resetScroll();
      }}
      className='flex h-8 items-center justify-between gap-2 px-2.5 text-[12.5px]'
    >
      {children}
      {checked ? <Check className='h-3.5 w-3.5 shrink-0 text-(--accent-nav)' /> : null}
    </DropdownMenuItem>
  );
}

function includesGenre(options: readonly string[], genre: string) {
  return options.some((option) => sameSearchGenre(option, genre));
}

export function Search() {
  const isOnline = useOnlineStatus();
  const queryClient = useQueryClient();
  const navigationType = useNavigationType();
  useDocumentTitle('Search');
  const {
    activeFeed,
    activeGenre,
    activeType,
    clearGenre,
    flushQuery,
    handleFeedChange,
    handleGenreChange,
    handleTypeChange,
    hasActiveFilters,
    isComposing,
    query,
    resetFilters,
    setQuery,
    setIsComposing,
    trimmedDebouncedQuery,
    trimmedQuery,
  } = useSearchPageState();
  const typeGroupRef = useRef<HTMLDivElement>(null);
  const genreTriggerRef = useRef<HTMLButtonElement>(null);
  const typeButtons = useRef(new Map<SearchMediaType, HTMLButtonElement>());
  const typeIndicator = useSlidingIndicator(activeType, typeGroupRef, typeButtons);
  const {
    errorObj,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetched,
    isFetchNextPageError,
    isFetching,
    isFetchingNextPage,
    isLoading,
    isPlaceholderData,
    refetch,
    results,
  } = useSearchResults({
    query: trimmedDebouncedQuery,
    activeType,
    activeFeed,
    activeGenre,
    isOnline,
  });

  // Manifest-driven union of `genre` extra options the enabled addons declare
  // for the active catalog type (Cinemeta first), computed in Rust.
  const browseGenresQuery = useBrowseGenres({ enabled: isOnline });
  const { data: browseGenres } = browseGenresQuery;
  const hasGenreError = queryNeedsRetry(browseGenresQuery);
  // `all` unions the movie and series genre sets.
  const genreOptions = searchGenreOptions(browseGenres, activeType);
  // A deep-linked genre the manifests don't enumerate still gets an entry.
  const menuGenres =
    activeGenre && !includesGenre(genreOptions, activeGenre)
      ? [activeGenre, ...genreOptions]
      : genreOptions;

  // A genre the next type's catalogs don't offer would strand an empty grid.
  const isGenreCompatible = (nextType: SearchMediaType) =>
    !activeGenre ||
    !browseGenres ||
    nextType === activeType ||
    includesGenre(searchGenreOptions(browseGenres, nextType), activeGenre);

  const selectType = (nextType: SearchMediaType) => {
    handleTypeChange(nextType, !isGenreCompatible(nextType));
    // A no-op re-click changes nothing — don't bounce the scroll position.
    if (nextType !== activeType) resetScroll();
  };

  // Hover/focus intent warms the next tab's catalog so the switch lands fast.
  const prefetchType = (nextType: SearchMediaType) => {
    if (
      !isOnline ||
      isComposing ||
      trimmedQuery !== trimmedDebouncedQuery ||
      nextType === activeType
    )
      return;
    void prefetchSearchCatalog(queryClient, {
      query: trimmedDebouncedQuery,
      type: nextType,
      feed: activeFeed,
      genre: isGenreCompatible(nextType) ? activeGenre : undefined,
    });
  };

  const searchInputRef = useRef<HTMLInputElement>(null);
  const [autoFocusSearch] = useState(
    () => navigationType !== 'POP' || (!trimmedQuery && results.length === 0),
  );
  useEffect(() => {
    const input = searchInputRef.current;
    if (autoFocusSearch && input?.value) input.select();
  }, [autoFocusSearch]);
  const handleClearSearch = useCallback(() => {
    setQuery('');
    searchInputRef.current?.focus({ preventScroll: true });
    resetScroll();
  }, [setQuery]);

  const handleResetFilters = useCallback(() => {
    if (!hasActiveFilters) return;
    resetFilters();
    searchInputRef.current?.focus({ preventScroll: true });
    resetScroll();
  }, [hasActiveFilters, resetFilters]);

  const isRetryingInitialLoad = isFetched && isLoading;
  const showSkeleton = isLoading && !isRetryingInitialLoad && results.length === 0;
  const isBrowsing = !trimmedQuery;
  const isRefining = isComposing || trimmedQuery !== trimmedDebouncedQuery || isPlaceholderData;
  const isUpdating = isOnline && isFetching && !isFetchingNextPage;
  const [updatingRevealed, setUpdatingRevealed] = useState(false);
  useEffect(() => {
    if (!isUpdating) {
      setUpdatingRevealed(false);
      return;
    }
    const timer = window.setTimeout(() => setUpdatingRevealed(true), 150);
    return () => window.clearTimeout(timer);
  }, [isUpdating]);
  const showUpdating = isUpdating && updatingRevealed;
  const activeFeedLabel =
    SEARCH_FEED_OPTIONS.find((option) => option.id === activeFeed)?.label ?? 'Trending';

  const resultsRef = useRef<HTMLDivElement>(null);
  const focusFirstResult = () => {
    if (isRefining || showSkeleton || results.length === 0) return;
    resetScroll();
    whenRowMounted(
      () => resultsRef.current,
      '[data-search-result-index="0"] [data-media-card-poster]',
      (element) => element.focus({ preventScroll: true }),
    );
  };
  // Ambient "working" cue: any catalog fetch drifts the accent dot fields.
  useAmbientActivity(isFetching);

  // Long catalogs deserve a quick way back to the filters.
  const [showBackToTop, setShowBackToTop] = useState(false);
  useRafScrollListener(() => setShowBackToTop(window.scrollY > 700));

  return (
    <div className='page-enter'>
      <div className={`mx-auto w-full max-w-[1800px] ${SIDEBAR_PAGE_COLUMN_INSETS} pb-16 pt-8`}>
        <div className='mx-auto w-full max-w-4xl'>
          <div className='mb-5 flex items-end justify-between gap-3'>
            <h1 className='min-w-0 text-[24px] font-semibold leading-none tracking-[-0.03em] text-white'>
              {isBrowsing ? 'Discover' : 'Search'}
            </h1>
            {results.length > 0 || showUpdating ? (
              // <output> is an implicit live region — silence it during page
              // appends so fetches don't announce the growing count.
              <output
                aria-live={isRefining || isUpdating || isFetchingNextPage ? 'off' : 'polite'}
                className='shrink-0 text-[13px] tabular-nums text-zinc-500'
              >
                {showUpdating
                  ? 'Updating…'
                  : `${results.length} ${isBrowsing ? 'title' : 'result'}${results.length === 1 ? '' : 's'}`}
              </output>
            ) : null}
          </div>

          <div className='relative w-full'>
            {/* eslint-disable jsx-a11y/no-autofocus -- the field is this
                page's purpose; focusing it on land is the intended UX. */}
            <Input
              type='text'
              autoFocus={autoFocusSearch}
              autoComplete='off'
              autoCorrect='off'
              spellCheck={false}
              enterKeyHint='search'
              placeholder='Search movies, shows, anime...'
              aria-label='Search movies, shows, and anime'
              aria-controls='search-results'
              aria-describedby='search-keyboard-hint'
              data-search-input
              ref={searchInputRef}
              className='h-11 w-full rounded-lg border-white/[0.08] bg-white/[0.04] pl-11 pr-20 text-[14px] text-zinc-100 placeholder:text-zinc-500 hover:bg-white/[0.06] focus-visible:border-(--accent-nav) focus-visible:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-(--accent-nav)/15'
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={(event) => {
                setQuery(event.currentTarget.value);
                setIsComposing(false);
              }}
              onKeyDown={(event) => {
                if (
                  event.defaultPrevented ||
                  event.nativeEvent.isComposing ||
                  isComposing ||
                  event.ctrlKey ||
                  event.altKey ||
                  event.metaKey
                )
                  return;
                if (event.key === 'Enter' || event.key === 'ArrowDown') {
                  event.preventDefault();
                  if (event.repeat) return;
                  if (event.key === 'Enter') {
                    flushQuery();
                    resetScroll();
                  }
                  focusFirstResult();
                  return;
                }
                // Progressive dismissal: Esc clears text, then becomes back.
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                if (event.repeat) return;
                if (query) {
                  handleClearSearch();
                } else {
                  navigateAppBack();
                }
              }}
            />
            {/* eslint-enable jsx-a11y/no-autofocus */}
            <SearchIcon className='pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-zinc-500' />
            <div className='absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5'>
              <span aria-hidden='true' className='h-4 w-4'>
                {showUpdating && (
                  <Loader2 className='h-4 w-4 animate-spin text-(--accent-nav) motion-reduce:animate-none' />
                )}
              </span>
              {query ? (
                <button
                  type='button'
                  aria-label='Clear search'
                  title='Clear search (Esc)'
                  className='flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors duration-150 hover:bg-white/[0.08] hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25'
                  onClick={handleClearSearch}
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              ) : null}
            </div>
          </div>
          <p id='search-keyboard-hint' className='sr-only'>
            Enter to search. Down arrow to focus the first result. Escape to clear.
          </p>

          <div className='mt-3 flex flex-wrap items-center justify-center gap-2 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]'>
            <div className='flex min-w-0 items-center gap-1.5 justify-self-start'>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button
                    ref={genreTriggerRef}
                    type='button'
                    title={activeGenre ? `Filter by genre: ${activeGenre}` : 'Filter by genre'}
                    className={cn(
                      SEARCH_FACET_BUTTON_CLASS,
                      activeGenre ? 'accent-lattice-soft' : SEARCH_FACET_IDLE_CLASS,
                    )}
                  >
                    <Shapes className='h-3.5 w-3.5 opacity-70' />
                    <span className='max-w-[120px] truncate'>{activeGenre ?? 'Genre'}</span>
                    <ChevronDown className='h-3.5 w-3.5 opacity-60 transition-transform duration-150 group-data-[state=open]:rotate-180' />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align='start'
                  sideOffset={6}
                  className='max-h-72 w-52 overflow-y-auto scrollbar-hide'
                >
                  <FacetMenuItem checked={!activeGenre} onSelect={clearGenre}>
                    All genres
                  </FacetMenuItem>
                  <div aria-hidden='true' className='mx-1 my-1 h-px bg-white/[0.06]' />
                  {!isOnline && !browseGenres ? (
                    <p role='status' className='px-2.5 py-2 text-[12px] text-zinc-400'>
                      Connect to the internet to load genres.
                    </p>
                  ) : hasGenreError ? (
                    <>
                      <p role='alert' className='px-2.5 pt-1 text-[12px] text-zinc-400'>
                        Couldn't load genres.
                      </p>
                      <DropdownMenuItem
                        aria-disabled={browseGenresQuery.isFetching || !isOnline || undefined}
                        onSelect={(event) => {
                          event.preventDefault();
                          if (!browseGenresQuery.isFetching && isOnline) {
                            void browseGenresQuery.refetch();
                          }
                        }}
                        className='h-8 px-2.5 text-[12.5px] aria-disabled:opacity-50'
                      >
                        {browseGenresQuery.isFetching ? 'Retrying…' : 'Retry'}
                      </DropdownMenuItem>
                    </>
                  ) : browseGenresQuery.isPending && !browseGenres ? (
                    <div role='status' className='space-y-3 px-2.5 py-2'>
                      <span className='sr-only'>Loading genres</span>
                      <div aria-hidden='true' className='space-y-3'>
                        <Skeleton className='h-4 w-24 bg-white/[0.06]' />
                        <Skeleton className='h-4 w-32 bg-white/[0.06]' />
                        <Skeleton className='h-4 w-20 bg-white/[0.06]' />
                      </div>
                    </div>
                  ) : null}
                  {menuGenres.map((genre) => (
                    <FacetMenuItem
                      key={genre}
                      checked={sameSearchGenre(genre, activeGenre)}
                      title={genre}
                      onSelect={() => handleGenreChange(genre)}
                    >
                      <span className='truncate'>{genre}</span>
                    </FacetMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {activeGenre && (
                <button
                  type='button'
                  aria-label={`Clear ${activeGenre} genre filter`}
                  title='Clear genre filter'
                  onClick={() => {
                    clearGenre();
                    genreTriggerRef.current?.focus({ preventScroll: true });
                    resetScroll();
                  }}
                  className={cn(
                    SEARCH_FACET_BUTTON_CLASS,
                    SEARCH_FACET_IDLE_CLASS,
                    'w-[38px] justify-center px-0',
                  )}
                >
                  <X aria-hidden='true' className='h-3.5 w-3.5' />
                </button>
              )}
            </div>

            <div
              ref={typeGroupRef}
              role='group'
              aria-label='Content type'
              className='relative isolate inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-white/[0.08] bg-white/[0.03] p-1 scrollbar-hide justify-self-center'
            >
              {typeIndicator && (
                <span
                  aria-hidden='true'
                  className={SLIDING_ACCENT_PILL_CLASS}
                  style={{
                    width: typeIndicator.width,
                    height: typeIndicator.height,
                    transform: `translate3d(${typeIndicator.left}px, ${typeIndicator.top}px, 0)`,
                  }}
                />
              )}
              {SEARCH_TYPE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  ref={(node) => {
                    if (node) typeButtons.current.set(option.id, node);
                    else typeButtons.current.delete(option.id);
                  }}
                  type='button'
                  aria-pressed={activeType === option.id}
                  onClick={() => selectType(option.id)}
                  onPointerEnter={() => prefetchType(option.id)}
                  onFocus={() => prefetchType(option.id)}
                  className={cn(
                    'nav-switch-item relative inline-flex h-7 shrink-0 items-center justify-center rounded-md px-3 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25',
                    activeType === option.id
                      ? 'text-(--on-accent-nav)'
                      : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className='flex flex-wrap items-center justify-center gap-2 justify-self-end lg:justify-end'>
              <DropdownMenu modal={false}>
                {/* aria-disabled + guards, not `disabled`: native-disabled swallows
                  pointer events (tooltip would never show); Radix respects
                  defaultPrevented, so the guards keep it closed. */}
                <DropdownMenuTrigger asChild>
                  <button
                    type='button'
                    title={isBrowsing ? 'Select catalog feed' : 'Feeds apply when browsing'}
                    aria-disabled={!isBrowsing || undefined}
                    onPointerDown={(event) => {
                      if (!isBrowsing) event.preventDefault();
                    }}
                    onKeyDown={(event) => {
                      if (
                        !isBrowsing &&
                        (event.key === 'Enter' ||
                          event.key === ' ' ||
                          event.key === 'ArrowDown' ||
                          event.key === 'ArrowUp')
                      ) {
                        event.preventDefault();
                      }
                    }}
                    className={cn(
                      SEARCH_FACET_BUTTON_CLASS,
                      'aria-disabled:cursor-default aria-disabled:opacity-40',
                      activeFeed !== 'popular' ? 'accent-lattice-soft' : SEARCH_FACET_IDLE_CLASS,
                    )}
                  >
                    <TrendingUp className='h-3.5 w-3.5 opacity-70' />
                    <span className='min-w-[52px] text-left'>{activeFeedLabel}</span>
                    <ChevronDown className='h-3.5 w-3.5 opacity-60 transition-transform duration-150 group-data-[state=open]:rotate-180' />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align='end' sideOffset={6} className='w-44'>
                  {SEARCH_FEED_OPTIONS.map((option) => (
                    <FacetMenuItem
                      key={option.id}
                      checked={activeFeed === option.id}
                      onSelect={() => handleFeedChange(option.id)}
                    >
                      {option.label}
                    </FacetMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Always rendered so appearing can't shove the facet controls. */}
              <button
                type='button'
                onClick={handleResetFilters}
                aria-disabled={!hasActiveFilters || undefined}
                title='Reset all filters'
                className={cn(
                  SEARCH_FACET_BUTTON_CLASS,
                  'border-white/[0.08] bg-white/[0.04] text-zinc-300',
                  hasActiveFilters
                    ? 'hover:bg-white/[0.07] hover:text-white'
                    : 'cursor-default opacity-40',
                )}
              >
                <RotateCcw className='h-3.5 w-3.5' />
                Reset
              </button>
            </div>
          </div>
        </div>

        <div
          id='search-results'
          ref={resultsRef}
          aria-busy={(isOnline && (isRefining || isFetching)) || undefined}
          className='pt-5'
          onClickCapture={flushQuery}
          onKeyDownCapture={(event) => {
            if ((event.key === 'Enter' || event.key === ' ') && !event.nativeEvent.isComposing)
              flushQuery();
            if (
              event.key === 'ArrowUp' &&
              !event.defaultPrevented &&
              !event.nativeEvent.isComposing &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.metaKey &&
              event.target instanceof HTMLElement &&
              event.target.matches('[data-media-card-poster]') &&
              event.target.closest('[data-search-result-index="0"]')
            ) {
              event.preventDefault();
              searchInputRef.current?.focus({ preventScroll: true });
              resetScroll();
            }
          }}
        >
          <SearchResults
            activeGenre={activeGenre}
            errorObj={errorObj}
            fetchNextPage={fetchNextPage}
            hasActiveFilters={hasActiveFilters}
            hasNextPage={hasNextPage}
            isError={isError}
            isFetchNextPageError={isFetchNextPageError}
            isFetching={isFetching}
            isFetchingNextPage={isFetchingNextPage}
            isOnline={isOnline}
            isPlaceholderData={isPlaceholderData}
            isRefining={isRefining}
            isRetryingInitialLoad={isRetryingInitialLoad}
            onResetFilters={handleResetFilters}
            onClearSearch={handleClearSearch}
            refetch={refetch}
            results={results}
            showSkeleton={showSkeleton}
            trimmedDebouncedQuery={trimmedDebouncedQuery}
          />
        </div>
      </div>

      <button
        type='button'
        aria-label='Back to top'
        title='Back to top'
        aria-hidden={!showBackToTop || undefined}
        tabIndex={showBackToTop ? undefined : -1}
        onClick={() => {
          searchInputRef.current?.focus({ preventScroll: true });
          window.scrollTo({ top: 0, behavior: scrollBehavior() });
        }}
        className={cn(
          'fixed bottom-6 left-[calc(50%+30px)] z-40 -translate-x-1/2 flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.1] bg-zinc-950/90 text-zinc-400 shadow-md transition-[opacity,translate,background-color,border-color,color] duration-200 hover:border-white/[0.16] hover:bg-zinc-900/90 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25',
          showBackToTop
            ? 'translate-y-0 opacity-100'
            : 'pointer-events-none translate-y-2 opacity-0',
        )}
      >
        <ArrowUp className='h-4 w-4' />
      </button>
    </div>
  );
}
