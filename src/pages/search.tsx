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
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
} from '@/components/media-card';
import { Input } from '@/components/ui/input';
import { WindowVirtualizedGrid } from '@/components/window-virtualized-grid';
import { useBrowseGenres } from '@/hooks/use-addon-configs';
import { useAmbientActivity } from '@/hooks/use-ambient-activity';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { useRafScrollListener } from '@/hooks/use-raf-scroll-listener';
import { useSearchPageState } from '@/hooks/use-search-page-state';
import { useSearchResults } from '@/hooks/use-search-results';
import { useSlidingIndicator } from '@/hooks/use-sliding-indicator';
import { getErrorMessage, type MediaItem } from '@/lib/api';
import { navigateAppBack } from '@/lib/navigation';
import { prefetchSearchCatalog, searchCatalogKey } from '@/lib/search-catalog';
import {
  sameSearchGenre,
  searchGenreOptions,
  type SearchFeed,
  type SearchMediaType,
} from '@/lib/search-page-state';
import { cn, scrollBehavior } from '@/lib/utils';

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
const renderSearchResult = (item: MediaItem) => (
  <div className={SEARCH_RESULT_ITEM_CLASS_NAME}>
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
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    // `isError` must gate observation: a failed next-page leaves the sentinel
    // in view and re-observing would refire `fetchNextPage` in a loop.
    if (!sentinel || !isOnline || !hasNextPage || isError || isFetching) {
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
  }, [fetchNextPage, hasNextPage, isError, isFetching, isOnline, showSkeleton]);

  if (!isOnline && results.length === 0) {
    return (
      <SearchPanel
        icon={<WifiOff className='h-5 w-5 text-zinc-400' />}
        title="You're offline"
        description='Connect to the internet to browse and search.'
      />
    );
  }

  if (showSkeleton) {
    return (
      <div aria-hidden='true' className={SEARCH_RESULTS_CLASS_NAME}>
        {SEARCH_SKELETON_KEYS.map((key) => (
          <div key={key} className={SEARCH_RESULT_ITEM_CLASS_NAME}>
            <MediaCardSkeleton />
          </div>
        ))}
      </div>
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
            aria-disabled={isFetching || undefined}
            aria-busy={isFetching || undefined}
            onClick={() => {
              if (!isFetching) void refetch();
            }}
            className={cn(SEARCH_PILL_BUTTON_CLASS, 'mt-1 inline-flex items-center gap-2')}
          >
            {isRetryingInitialLoad && (
              <Loader2 aria-hidden='true' className='h-3.5 w-3.5 animate-spin' />
            )}
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
      className={cn('transition-opacity duration-200', isPlaceholderData && 'opacity-60')}
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
        getItemKey={searchCatalogKey}
        renderItem={renderSearchResult}
        estimateItemHeight={estimateSearchItemHeight}
        getColumnCount={getSearchGridColumnCount}
        gap={SEARCH_GRID_GAP_PX}
        rowGap={SEARCH_GRID_ROW_GAP_PX}
      />
      <div ref={loadMoreRef} aria-hidden='true' className='h-1' />
      {isOnline && (hasNextPage || isError || isFetchingNextPage) && (
        <div className='flex flex-col items-center gap-1.5 pt-6'>
          {isError && (
            <p role='alert' className='text-[12px] text-zinc-500'>
              {getErrorMessage(errorObj)}
            </p>
          )}
          <button
            type='button'
            aria-disabled={isFetching || undefined}
            aria-busy={isFetchingNextPage || undefined}
            onClick={() => {
              if (!isFetching) {
                void (isError && !isFetchNextPageError ? refetch() : fetchNextPage());
              }
            }}
            className={cn(SEARCH_PILL_BUTTON_CLASS, 'inline-flex items-center gap-2')}
          >
            {isFetchingNextPage && (
              <Loader2 aria-hidden='true' className='h-3.5 w-3.5 animate-spin' />
            )}
            <span aria-live='polite'>
              {isFetchingNextPage ? 'Loading more titles' : isError ? 'Retry' : 'Load more'}
            </span>
          </button>
        </div>
      )}
    </div>
  );
});

// Facet switches swap the whole grid; land on the first row, not mid-list.
const resetScroll = () => window.scrollTo({ top: 0 });

function includesGenre(options: readonly string[], genre: string) {
  return options.some((option) => sameSearchGenre(option, genre));
}

export function Search() {
  const isOnline = useOnlineStatus();
  const queryClient = useQueryClient();
  useDocumentTitle('Search');
  const {
    activeFeed,
    activeGenre,
    activeType,
    clearGenre,
    debouncedQuery,
    handleFeedChange,
    handleGenreChange,
    handleTypeChange,
    hasActiveFilters,
    query,
    resetFilters,
    setQuery,
    trimmedDebouncedQuery,
  } = useSearchPageState();
  const typeGroupRef = useRef<HTMLDivElement>(null);
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
  } = useSearchResults({ query: debouncedQuery, activeType, activeFeed, activeGenre, isOnline });

  // Manifest-driven union of `genre` extra options the enabled addons declare
  // for the active catalog type (Cinemeta first), computed in Rust.
  const { data: browseGenres } = useBrowseGenres({ enabled: isOnline });
  // `all` unions the movie and series genre sets.
  const genreOptions = useMemo(
    () => searchGenreOptions(browseGenres, activeType),
    [browseGenres, activeType],
  );
  // A deep-linked genre the manifests don't enumerate still gets an entry.
  const menuGenres = useMemo(
    () =>
      activeGenre && !includesGenre(genreOptions, activeGenre)
        ? [activeGenre, ...genreOptions]
        : genreOptions,
    [activeGenre, genreOptions],
  );

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
    if (!isOnline || nextType === activeType) return;
    prefetchSearchCatalog(queryClient, {
      query: debouncedQuery,
      type: nextType,
      feed: activeFeed,
      genre: isGenreCompatible(nextType) ? activeGenre : undefined,
    });
  };

  const searchInputRef = useRef<HTMLInputElement>(null);
  // Restored text is selected on land so typing replaces it.
  useEffect(() => {
    const input = searchInputRef.current;
    if (input?.value) input.select();
  }, []);
  const handleClearSearch = useCallback(() => {
    setQuery('');
    searchInputRef.current?.focus({ preventScroll: true });
    resetScroll();
  }, [setQuery]);

  // Stable handler shared by the header Reset pill and the empty-state action.
  const handleResetFilters = useCallback(() => {
    if (!hasActiveFilters) return;
    resetFilters();
    searchInputRef.current?.focus({ preventScroll: true });
    resetScroll();
  }, [hasActiveFilters, resetFilters]);

  const isRetryingInitialLoad = isFetched && isLoading;
  const showSkeleton =
    !isRetryingInitialLoad &&
    !isError &&
    (isLoading || ((isFetching || isPlaceholderData) && results.length === 0));
  const isBrowsing = query.trim().length === 0;
  const isUpdating = isOnline && (query.trim() !== trimmedDebouncedQuery || isPlaceholderData);
  const activeFeedLabel =
    SEARCH_FEED_OPTIONS.find((option) => option.id === activeFeed)?.label ?? 'Trending';

  const resultsRef = useRef<HTMLDivElement>(null);
  const resultsMode = JSON.stringify([
    activeType,
    !!trimmedDebouncedQuery,
    activeGenre ?? null,
    trimmedDebouncedQuery ? null : activeFeed,
  ]);
  const previousResultsMode = useRef(resultsMode);
  const pendingResultsEntrance = useRef(false);
  const resultsReady = !isPlaceholderData && !showSkeleton;
  useLayoutEffect(() => {
    if (previousResultsMode.current !== resultsMode) {
      previousResultsMode.current = resultsMode;
      pendingResultsEntrance.current = true;
    }
    if (!pendingResultsEntrance.current || !resultsReady) return;
    const container = resultsRef.current;
    if (!container) return;
    pendingResultsEntrance.current = false;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Rapid switches share an in-flight entrance instead of flashing or remounting the grid.
    container.classList.add('search-results-enter');
  }, [resultsMode, resultsReady]);

  // Ambient "working" cue: any catalog fetch drifts the accent dot fields.
  useAmbientActivity(isFetching);

  // Long catalogs deserve a quick way back to the filters.
  const [showBackToTop, setShowBackToTop] = useState(false);
  useRafScrollListener(() => setShowBackToTop(window.scrollY > 700));

  return (
    <div className='page-enter pl-[60px]'>
      <div className='mx-auto w-full max-w-[1800px] px-4 pb-16 pt-8 sm:px-6 lg:px-8'>
        <div className='mx-auto w-full max-w-4xl'>
          <div className='mb-5 flex items-end justify-between gap-3'>
            <div className='min-w-0'>
              <h1 className='text-[24px] font-semibold leading-none tracking-[-0.03em] text-white'>
                {isBrowsing ? 'Discover' : 'Search'}
              </h1>
            </div>
            {results.length > 0 || isUpdating ? (
              // <output> is an implicit live region — silence it during page
              // appends so fetches don't announce the growing count.
              <output
                aria-live={isUpdating || isFetchingNextPage ? 'off' : 'polite'}
                className='shrink-0 text-[13px] tabular-nums text-zinc-500'
              >
                {isUpdating
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
              autoFocus
              autoComplete='off'
              autoCorrect='off'
              spellCheck={false}
              enterKeyHint='search'
              placeholder='Search movies, shows, anime...'
              aria-label='Search movies, shows, and anime'
              data-search-input
              ref={searchInputRef}
              className='h-11 w-full rounded-lg border-white/[0.08] bg-white/[0.04] pl-11 pr-20 text-[14px] text-zinc-100 placeholder:text-zinc-500 hover:bg-white/[0.06] focus-visible:border-(--accent-nav) focus-visible:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-(--accent-nav)/15'
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.defaultPrevented ||
                  event.nativeEvent.isComposing ||
                  event.ctrlKey ||
                  event.altKey ||
                  event.metaKey
                )
                  return;
                // Not a form submit — Enter only dismisses the software keyboard.
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                  return;
                }
                // Progressive dismissal: Esc clears text, then becomes back.
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                if (event.repeat) return;
                if (query) {
                  setQuery('');
                } else {
                  navigateAppBack();
                }
              }}
            />
            {/* eslint-enable jsx-a11y/no-autofocus */}
            <SearchIcon className='pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-zinc-500' />
            <div className='absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5'>
              {isUpdating ? (
                <Loader2 aria-hidden='true' className='h-4 w-4 animate-spin text-(--accent-nav)' />
              ) : null}
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

          <div className='mt-3 flex flex-wrap items-center justify-center gap-2 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]'>
            <div className='min-w-0 justify-self-start'>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button
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
                  <DropdownMenuItem
                    role='menuitemradio'
                    aria-checked={!activeGenre}
                    onSelect={() => {
                      // No-op when nothing's active — don't bounce the scroll.
                      if (!activeGenre) return;
                      clearGenre();
                      resetScroll();
                    }}
                    className='flex h-8 items-center justify-between px-2.5 text-[12.5px]'
                  >
                    All genres
                    {!activeGenre ? (
                      <Check className='h-3.5 w-3.5 shrink-0 text-(--accent-nav)' />
                    ) : null}
                  </DropdownMenuItem>
                  <div aria-hidden='true' className='mx-1 my-1 h-px bg-white/[0.06]' />
                  {menuGenres.map((genre) => {
                    const isActive = sameSearchGenre(genre, activeGenre);
                    return (
                      <DropdownMenuItem
                        key={genre}
                        role='menuitemradio'
                        aria-checked={isActive}
                        title={genre}
                        onSelect={() => {
                          if (isActive) return;
                          handleGenreChange(genre);
                          resetScroll();
                        }}
                        className='flex h-8 items-center justify-between px-2.5 text-[12.5px]'
                      >
                        <span className='truncate'>{genre}</span>
                        {isActive ? (
                          <Check className='h-3.5 w-3.5 shrink-0 text-(--accent-nav)' />
                        ) : null}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
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
                  className='nav-sliding-pill pointer-events-none absolute left-0 top-0 rounded-md bg-(--accent-nav)'
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
                  {SEARCH_FEED_OPTIONS.map((option) => {
                    const isActive = activeFeed === option.id;
                    return (
                      <DropdownMenuItem
                        key={option.id}
                        role='menuitemradio'
                        aria-checked={isActive}
                        onSelect={() => {
                          if (isActive) return;
                          handleFeedChange(option.id);
                          resetScroll();
                        }}
                        className='flex h-8 items-center justify-between px-2.5 text-[12.5px]'
                      >
                        {option.label}
                        {isActive ? (
                          <Check className='h-3.5 w-3.5 shrink-0 text-(--accent-nav)' />
                        ) : null}
                      </DropdownMenuItem>
                    );
                  })}
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
          ref={resultsRef}
          aria-busy={(isOnline && (showSkeleton || isUpdating || isFetching)) || undefined}
          className='pt-5'
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) {
              event.currentTarget.classList.remove('search-results-enter');
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
