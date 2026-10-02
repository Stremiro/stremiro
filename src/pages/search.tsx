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
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { useSearchPageState } from '@/hooks/use-search-page-state';
import { useSearchResults } from '@/hooks/use-search-results';
import { getErrorMessage, type MediaItem } from '@/lib/api';
import { navigateAppBack } from '@/lib/navigation';
import { searchCatalogKey } from '@/lib/search-catalog';
import {
  sameSearchGenre,
  searchGenreOptions,
  type SearchFeed,
  type SearchMediaType,
} from '@/lib/search-page-state';
import { cn, prefersReducedMotion } from '@/lib/utils';

// Results fill every row edge to edge at near-home size: columns grow from
// the 170px home minimum, so wide screens fit a full row (9+ on large
// displays) with no trailing empty slot.
const SEARCH_RESULTS_CLASS_NAME =
  'grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-4 gap-y-8 sm:grid-cols-[repeat(auto-fill,minmax(170px,1fr))]';
const SEARCH_RESULT_ITEM_CLASS_NAME = 'min-w-0';

// The virtualized grid needs a numeric column count; this mirrors the
// auto-fill minmax() rules above (16px column gap, 150px min below the sm
// breakpoint, 170px at sm+) so both render paths produce identical columns.
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
  'h-9 rounded-full border border-white/[0.08] bg-white/[0.04] px-5 text-[13px] font-medium text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 aria-disabled:cursor-default aria-disabled:opacity-50';

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
      className='mx-auto mt-10 flex max-w-sm flex-col items-center rounded-3xl border border-white/[0.07] bg-white/[0.02] px-8 py-12 text-center'
    >
      {icon ? (
        <span className='flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.05]'>
          {icon}
        </span>
      ) : null}
      <p role={titleRole} className='mt-4 text-[15px] font-medium text-white'>
        {title}
      </p>
      {description ? (
        <p className='mt-1 text-[13px] leading-relaxed text-zinc-500'>{description}</p>
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
  onResetFilters: () => void;
  refetch: () => void;
  results: MediaItem[];
  showSkeleton: boolean;
  trimmedDebouncedQuery: string;
}

// Memoized so a keystroke in the input only re-renders the header — the
// virtualized grid (virtualizer math + every mounted card) is untouched
// until a prop that actually describes the results changes.
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
  onResetFilters,
  refetch,
  results,
  showSkeleton,
  trimmedDebouncedQuery,
}: SearchResultsProps) {
  // Sentinel observer; view-state deps re-attach it after offline/error/loading remounts.
  const loadMoreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    // `isError` must gate observation, not just re-run the effect: a failed
    // next-page leaves the sentinel in view, and re-observing would refire
    // `fetchNextPage` in a loop. The explicit retry button stays the only
    // recovery while the query sits in error.
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

  // A failed next-page fetch keeps the loaded grid — the full error panel is
  // only for a query that produced nothing at all.
  if (isError && results.length === 0) {
    return (
      <SearchPanel
        role='alert'
        title='Failed to load content'
        description={getErrorMessage(errorObj)}
        action={
          <button
            type='button'
            // Guard, not `disabled` — the refetch disables the focused
            // button, which would drop keyboard focus to <body>.
            aria-disabled={isFetching || undefined}
            onClick={() => {
              if (!isFetching) void refetch();
            }}
            className={cn(SEARCH_PILL_BUTTON_CLASS, 'mt-4')}
          >
            Try again
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
          // A text-query miss offers nothing to reset — only surfaces when a
          // facet (type/feed/genre) is part of the empty result.
          hasActiveFilters ? (
            <button
              type='button'
              onClick={onResetFilters}
              className={cn(SEARCH_PILL_BUTTON_CLASS, 'mt-4')}
            >
              Reset filters
            </button>
          ) : undefined
        }
      />
    );
  }

  return (
    // keepPreviousData leaves the old grid mounted while the next query
    // resolves; the dim + aria-busy signal the refresh without a layout jump.
    <div
      aria-busy={isFetching || undefined}
      className={cn(
        'transition-opacity duration-200',
        isFetching && !isFetchingNextPage && 'opacity-60',
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
        getItemKey={searchCatalogKey}
        renderItem={renderSearchResult}
        estimateItemHeight={estimateSearchItemHeight}
        getColumnCount={getSearchGridColumnCount}
        gap={SEARCH_GRID_GAP_PX}
        rowGap={SEARCH_GRID_ROW_GAP_PX}
      />
      <div ref={loadMoreRef} aria-hidden='true' className='h-1' />
      {isOnline && isFetchingNextPage ? (
        <output className='flex items-center justify-center gap-2 pb-2 pt-5 text-[12px] text-zinc-500'>
          <Loader2 className='h-3.5 w-3.5 animate-spin' />
          Loading more titles
        </output>
      ) : isOnline && isError ? (
        <div className='flex flex-col items-center gap-1.5 pt-6' role='alert'>
          <p className='text-[12px] text-zinc-500'>{getErrorMessage(errorObj)}</p>
          <button
            type='button'
            aria-disabled={isFetching || undefined}
            onClick={() => {
              if (!isFetching) void (isFetchNextPageError ? fetchNextPage() : refetch());
            }}
            className={SEARCH_PILL_BUTTON_CLASS}
          >
            {isFetchNextPageError ? 'Retry loading more' : 'Try again'}
          </button>
        </div>
      ) : isOnline && hasNextPage ? (
        <div className='flex justify-center pt-6'>
          <button
            type='button'
            aria-disabled={isFetching || undefined}
            onClick={() => {
              if (!isFetching) void fetchNextPage();
            }}
            className={SEARCH_PILL_BUTTON_CLASS}
          >
            Load more
          </button>
        </div>
      ) : null}
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
  const {
    errorObj,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchNextPageError,
    isFetching,
    isFetchingNextPage,
    isLoading,
    refetch,
    results,
  } = useSearchResults({ query: debouncedQuery, activeType, activeFeed, activeGenre, isOnline });

  // Genre menu entries are manifest-driven: the union of `genre` extra
  // options the enabled addons declare for the active catalog type
  // (Cinemeta first), computed in Rust.
  const { data: browseGenres } = useBrowseGenres({ enabled: isOnline });
  // `all` unions the movie and series genre sets (dedupe inside the helper).
  const genreOptions = useMemo(
    () => searchGenreOptions(browseGenres, activeType),
    [browseGenres, activeType],
  );
  // A deep-linked genre the manifests don't enumerate still gets an entry so
  // the active filter is never invisible.
  const menuGenres = useMemo(
    () =>
      activeGenre && !includesGenre(genreOptions, activeGenre)
        ? [activeGenre, ...genreOptions]
        : genreOptions,
    [activeGenre, genreOptions],
  );

  const selectType = (nextType: SearchMediaType) => {
    // A genre the next type's catalogs don't offer would strand an empty grid.
    const clearIncompatibleGenre = Boolean(
      activeGenre &&
      browseGenres &&
      nextType !== activeType &&
      !includesGenre(searchGenreOptions(browseGenres, nextType), activeGenre),
    );
    handleTypeChange(nextType, clearIncompatibleGenre);
    // A no-op re-click changes nothing — don't bounce the scroll position.
    if (nextType !== activeType) resetScroll();
  };

  // One stable handler so `SearchResults`' memo isn't defeated by an inline
  // arrow — shared by the header Reset pill and the empty-state action.
  const handleResetFilters = useCallback(() => {
    if (!hasActiveFilters) return;
    resetFilters();
    resetScroll();
  }, [hasActiveFilters, resetFilters]);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const showSkeleton = !isError && (isLoading || (isFetching && results.length === 0));
  const isBrowsing = trimmedDebouncedQuery.length === 0;
  const activeFeedLabel =
    SEARCH_FEED_OPTIONS.find((option) => option.id === activeFeed)?.label ?? 'Trending';

  // Ambient "working" cue: any catalog fetch — facet switch, fresh query,
  // pagination — drifts the accent dot fields while results resolve.
  useAmbientActivity(isFetching);

  // Long catalogs deserve a quick way back to the filters.
  const [showBackToTop, setShowBackToTop] = useState(false);
  useEffect(() => {
    const handleScroll = () => setShowBackToTop(window.scrollY > 700);
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <div className='page-enter pl-[60px]'>
      <div className='mx-auto w-full max-w-[1800px] px-4 pb-16 pt-8 sm:px-6 lg:px-8'>
        <div className='mx-auto w-full max-w-4xl'>
          <div className='mb-5 flex items-end justify-between gap-3'>
            <div className='min-w-0'>
              <h1 className='bg-linear-to-br from-white via-white to-zinc-400 bg-clip-text text-[26px] font-semibold leading-none tracking-[-0.045em] text-transparent'>
                {isBrowsing ? 'Discover' : 'Search'}
              </h1>
              <p className='mt-2 text-[12.5px] font-medium tracking-[-0.01em] text-zinc-500'>
                {isBrowsing
                  ? 'Find your next great watch.'
                  : 'Movies, series, and anime. One place to explore.'}
              </p>
            </div>
            {results.length > 0 ? (
              // <output> is an implicit live region — silence it during page
              // appends so each fetch doesn't announce the growing count.
              <output
                aria-live={isFetchingNextPage ? 'off' : 'polite'}
                className='shrink-0 text-[13px] tabular-nums text-zinc-500'
              >
                {results.length} {isBrowsing ? 'title' : 'result'}
                {results.length === 1 ? '' : 's'}
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
              className='h-12 w-full rounded-2xl border-white/[0.08] bg-white/[0.06] pl-11 pr-20 text-[15px] text-zinc-100 placeholder:text-zinc-500 hover:bg-white/[0.07] focus-visible:border-white/20 focus-visible:bg-white/[0.07] focus-visible:ring-0'
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
                // Not a form submit — Enter's only job is dismissing the
                // software keyboard.
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                  return;
                }
                // Progressive dismissal: Esc clears the text, then becomes
                // the app-level back gesture once the box is empty.
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
              {isFetching && !isFetchingNextPage ? (
                <Loader2 className='h-4 w-4 animate-spin text-zinc-500' />
              ) : null}
              {query ? (
                <button
                  type='button'
                  aria-label='Clear search'
                  title='Clear search (Esc)'
                  className='flex h-7 w-7 items-center justify-center rounded-full bg-white/[0.08] text-zinc-400 transition-colors hover:bg-white/[0.14] hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25'
                  onClick={() => {
                    setQuery('');
                    // The button unmounts with the text — keep focus in the
                    // field instead of dropping it to <body>.
                    searchInputRef.current?.focus();
                  }}
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              ) : null}
            </div>
          </div>

          {/* lg+ pins the type group under the search bar's midpoint while
              genre/feed/reset flank the container edges; narrower widths fall
              back to the centered wrapping row. */}
          <div className='mt-3 flex flex-wrap items-center justify-center gap-2 lg:grid lg:grid-cols-[1fr_auto_1fr]'>
            <div className='justify-self-start'>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button
                    type='button'
                    title='Filter by genre'
                    className={cn(
                      'group flex h-[42px] items-center gap-1.5 rounded-xl border px-3.5 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25',
                      activeGenre
                        ? 'accent-lattice-soft'
                        : 'border-white/[0.08] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 data-[state=open]:bg-white/[0.07] data-[state=open]:text-zinc-100',
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
                        onSelect={() => {
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
              role='group'
              aria-label='Content type'
              className='inline-flex items-center justify-center gap-1 rounded-xl border border-white/[0.08] bg-white/[0.04] p-1'
            >
              {SEARCH_TYPE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type='button'
                  aria-pressed={activeType === option.id}
                  onClick={() => selectType(option.id)}
                  className={cn(
                    'inline-flex h-8 min-w-[64px] items-center justify-center rounded-lg px-4 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25',
                    activeType === option.id
                      ? 'font-semibold text-(--on-accent-nav) shadow-xs'
                      : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100',
                  )}
                  style={
                    activeType === option.id ? { backgroundColor: 'var(--accent-nav)' } : undefined
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className='flex items-center gap-2 justify-self-end'>
              <DropdownMenu modal={false}>
                {/* aria-disabled + guards, not `disabled`: a native-disabled
                  button swallows pointer events, so the "why is it off"
                  tooltip could never appear. Radix respects defaultPrevented
                  on pointerdown/keydown, so the guards keep it closed. */}
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
                      'group flex h-[42px] items-center gap-1.5 rounded-xl border px-3.5 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 aria-disabled:cursor-default aria-disabled:opacity-40',
                      activeFeed !== 'popular'
                        ? 'accent-lattice-soft'
                        : 'border-white/[0.08] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 data-[state=open]:bg-white/[0.07] data-[state=open]:text-zinc-100',
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

              {/* Always rendered so it can't shove the facet controls left on
                appear: idle it sits dimmed, active it matches the pills. */}
              <button
                type='button'
                onClick={handleResetFilters}
                aria-disabled={!hasActiveFilters || undefined}
                title='Reset all filters'
                className={cn(
                  'flex h-[42px] items-center gap-1.5 rounded-xl border px-3.5 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25',
                  hasActiveFilters
                    ? 'border-white/[0.08] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.07] hover:text-white'
                    : 'cursor-default border-transparent text-zinc-700',
                )}
              >
                <RotateCcw className='h-3.5 w-3.5' />
                Reset
              </button>
            </div>
          </div>
        </div>

        <div className='pt-5'>
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
            onResetFilters={handleResetFilters}
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
        onClick={() =>
          window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
        }
        className={cn(
          'fixed bottom-6 left-[calc(50%+30px)] z-40 -translate-x-1/2 flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.1] bg-zinc-950/80 text-zinc-400 shadow-lg backdrop-blur-md transition-[opacity,translate,background-color,border-color,color] duration-200 hover:border-white/[0.16] hover:bg-zinc-900/90 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25',
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
