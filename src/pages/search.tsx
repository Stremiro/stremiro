import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  Clock3,
  Flame,
  History as HistoryIcon,
  Layers3,
  RotateCcw,
  Search as SearchIcon,
  SearchX,
  Shapes,
  Sparkles,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Link, NavigationType, useNavigationType } from 'react-router';
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { WindowVirtualizedGrid } from '@/components/window-virtualized-grid';
import { ScrollToTop } from '@/components/scroll-to-top';
import { useBrowseGenres } from '@/hooks/use-addon-configs';
import { useRecentSearches } from '@/hooks/use-app-ui-preferences';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useLocalDay } from '@/hooks/use-local-day';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { useScrolledPastTitlebar } from '@/hooks/use-scroll-edge-indicators';
import { useSearchPageState } from '@/hooks/use-search-page-state';
import { SLIDING_ACCENT_PILL_CLASS, useSlidingIndicator } from '@/hooks/use-sliding-indicator';
import { getErrorMessage, isNoCapableAddonError, type MediaItem } from '@/lib/api';
import { isAppLinkText, openAppLinkText } from '@/lib/app-links';
import { handleRadioGroupKeyDown, whenRowMounted } from '@/lib/dom';
import { navigateBack } from '@/lib/navigation';
import { prefetchSearchCatalog, searchCatalogQueryOptions } from '@/lib/search-catalog';
import { sameSearchGenre, type SearchFeed, type SearchMediaType } from '@/lib/search-page-state';
import {
  cn,
  createObjectIdentity,
  pluralize,
  queryNeedsRetry,
  scrollBehavior,
  SIDEBAR_PAGE_COLUMN_INSETS,
} from '@/lib/utils';

// Results fill every row edge to edge: auto-fill columns grow from the 170px
// home minimum so wide screens fit a full row with no trailing empty slot.
const SEARCH_RESULTS_CLASS_NAME =
  'grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-4 gap-y-8 sm:grid-cols-[repeat(auto-fill,minmax(170px,1fr))]';
// Scroll margins keep keyboard-focused cards clear of the fixed compact header.
const SEARCH_RESULT_ITEM_CLASS_NAME = 'min-w-0 scroll-mt-24 scroll-mb-4';

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

const SEARCH_FEED_OPTIONS: ReadonlyArray<{
  id: SearchFeed;
  label: string;
  icon: typeof Flame;
  tint: string;
}> = [
  { id: 'popular', label: 'Trending', icon: Flame, tint: 'text-orange-300' },
  { id: 'featured', label: 'Featured', icon: Sparkles, tint: 'text-amber-200' },
  { id: 'new', label: 'New', icon: Clock3, tint: 'text-sky-300' },
];

const getResultPageId = createObjectIdentity();

const SEARCH_SKELETON_COUNT = 21;
const SEARCH_SKELETON_KEYS = Array.from(
  { length: SEARCH_SKELETON_COUNT },
  (_, index) => `search-skeleton-${index}`,
);
const renderSearchResult = (item: MediaItem, index: number) => (
  <div data-search-result-index={index} className={SEARCH_RESULT_ITEM_CLASS_NAME}>
    <MediaCard item={item} showLibraryMark />
  </div>
);
const estimateSearchItemHeight = (itemWidth: number) =>
  itemWidth * 1.5 + MEDIA_CARD_TEXT_BLOCK_HEIGHT_PX;
const SEARCH_PILL_BUTTON_CLASS =
  'h-9 rounded-md border border-white/[0.08] bg-white/[0.04] px-3.5 text-[13px] font-medium text-zinc-300 transition-colors duration-150 motion-reduce:transition-none hover:enabled:not-aria-disabled:bg-white/[0.08] hover:enabled:not-aria-disabled:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 aria-disabled:cursor-default aria-disabled:opacity-50';
const SEARCH_FACET_BUTTON_CLASS =
  'nav-switch-item group flex h-[38px] items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] not-aria-disabled:hover:border-white/[0.18] not-aria-disabled:active:bg-white/[0.1] data-[state=open]:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25';
const FACET_ICON_CLASS =
  'h-3.5 w-3.5 shrink-0 opacity-75 transition-opacity duration-150 group-not-aria-disabled:group-hover:opacity-100 group-data-[state=open]:opacity-100 motion-reduce:transition-none';
const RECENT_SEARCH_ROW_BUTTON_CLASS =
  'flex h-9 items-center rounded-md text-zinc-400 transition-colors duration-150 hover:bg-white/[0.06] hover:text-zinc-100 focus-visible:bg-white/[0.08] focus-visible:text-zinc-100 focus-visible:outline-none';
// Mouse picks keep focus in the field so the panel stays put and typing continues.
const keepSearchInputFocus = (event: ReactMouseEvent) => event.preventDefault();
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
        <p className='w-full max-w-xs [overflow-wrap:anywhere] text-sm leading-relaxed text-zinc-400'>
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
  fetchNextPage: () => Promise<unknown>;
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
  refetch: () => Promise<unknown>;
  results: MediaItem[];
  resultSetKey: number;
  partial: boolean;
  showSkeleton: boolean;
  trimmedDebouncedQuery: string;
}

function SearchResults({
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
  resultSetKey,
  partial,
  showSkeleton,
  trimmedDebouncedQuery,
}: SearchResultsProps) {
  // Sentinel observer; view-state deps re-attach it after offline/error/loading remounts.
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [pagingFocused, setPagingFocused] = useState(false);
  const completionMessage = partial
    ? "Some sources didn't respond — results may be incomplete"
    : `All ${pluralize(results.length, 'title')} loaded`;
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

  if (results.length === 0 && hasNextPage && !isPlaceholderData && !showSkeleton) {
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
            {isFetching ? 'Loading more titles…' : isError ? 'Retry' : 'Load more'}
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
          !isRetryingInitialLoad && isNoCapableAddonError(errorObj) ? (
            <Link
              to='/settings?section=addons'
              className={cn(SEARCH_PILL_BUTTON_CLASS, 'mt-1 inline-flex items-center gap-2')}
            >
              Manage addons
            </Link>
          ) : (
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
          )
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
          partial
            ? completionMessage
            : trimmedDebouncedQuery
              ? 'Try a shorter title, check the spelling, or include the release year.'
              : activeGenre
                ? 'Try another genre or feed.'
                : 'Try changing the category.'
        }
        action={
          (hasActiveFilters || trimmedDebouncedQuery) && (
            <div className='mt-1 flex flex-wrap justify-center gap-2'>
              {hasActiveFilters && (
                <button type='button' onClick={onResetFilters} className={SEARCH_PILL_BUTTON_CLASS}>
                  Reset filters
                </button>
              )}
              {trimmedDebouncedQuery && (
                <button type='button' onClick={onClearSearch} className={SEARCH_PILL_BUTTON_CLASS}>
                  Browse titles
                </button>
              )}
            </div>
          )
        }
      />
    );
  }

  return (
    // Old results also stand in during the debounce/composition interval,
    // before keepPreviousData takes over. Background refreshes stay full-opacity.
    <div
      aria-busy={(isOnline && (isFetching || isRefining)) || undefined}
      className={cn(
        'transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        isRefining && 'opacity-60',
      )}
    >
      {!isOnline && (
        <div
          role='status'
          className='mb-5 flex items-center gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.025] px-4 py-3 text-sm leading-relaxed text-zinc-300'
        >
          <WifiOff aria-hidden='true' className='h-4 w-4 shrink-0 text-zinc-500' />
          You&apos;re offline. Showing cached titles until you reconnect.
        </div>
      )}
      <div
        key={resultSetKey}
        className='animate-in fade-in-0 slide-in-from-bottom-1 duration-300 ease-out motion-reduce:animate-none'
      >
        <WindowVirtualizedGrid
          items={results}
          getItemKey={mediaCardRailKey}
          renderItem={renderSearchResult}
          estimateItemHeight={estimateSearchItemHeight}
          getColumnCount={getSearchGridColumnCount}
          gap={SEARCH_GRID_GAP_PX}
          rowGap={SEARCH_GRID_ROW_GAP_PX}
        />
      </div>
      <div ref={loadMoreRef} aria-hidden='true' className='h-1' />
      {isOnline && (hasNextPage || isError || isFetchingNextPage || pagingFocused) && (
        <div className='mt-5 flex min-h-16 flex-col items-center justify-center gap-2 border-t border-white/[0.06] pt-5'>
          {isError && (
            <p
              role='alert'
              className='max-w-lg text-center text-[13px] leading-relaxed text-zinc-300'
            >
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
            {isFetchingNextPage && (
              <span aria-hidden='true' className='h-1.5 w-1.5 rounded-full bg-(--accent-nav)' />
            )}
            <span aria-live='polite'>
              {isFetchingNextPage
                ? 'Loading more titles'
                : isError
                  ? 'Retry'
                  : hasNextPage
                    ? 'Load more'
                    : partial
                      ? completionMessage
                      : 'All titles loaded'}
            </span>
          </button>
        </div>
      )}
      {isOnline && !hasNextPage && !isError && !isRefining && !isFetching && !pagingFocused && (
        <p className='mt-5 border-t border-white/[0.06] pt-5 text-center text-[13px] leading-relaxed text-zinc-400'>
          {completionMessage}
        </p>
      )}
    </div>
  );
}

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
      className='flex min-h-9 items-center justify-between gap-2 px-2.5 text-sm text-zinc-300 aria-checked:font-medium aria-checked:text-white'
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
  // The `new` feed is the provider `year` catalog. `useLocalDay` re-keys after
  // a midnight rollover; a one-time `getFullYear()` would pin the mount day.
  const localDay = useLocalDay();
  const {
    data,
    error: errorObj,
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
  } = useInfiniteQuery({
    ...searchCatalogQueryOptions(
      {
        query: trimmedDebouncedQuery,
        type: activeType,
        feed: activeFeed,
        genre: activeGenre,
      },
      localDay.getFullYear(),
    ),
    // Keep previous facet results visible during switches; offline switches
    // must not show them as cached results.
    placeholderData: isOnline ? keepPreviousData : undefined,
    enabled: isOnline,
  });
  const results = data?.pages.flatMap((page) => page.items) ?? [];
  // Paging keeps the first page's identity, so only a new result set replays the entrance.
  const firstPage = data?.pages[0];
  const partial = data?.pages.some((page) => page.partial) ?? false;

  // Manifest-driven union of `genre` extra options the enabled addons declare
  // for the active catalog type (Cinemeta first), computed in Rust.
  const browseGenresQuery = useBrowseGenres({ enabled: isOnline });
  const { data: browseGenres } = browseGenresQuery;
  const hasGenreError = queryNeedsRetry(browseGenresQuery);
  // `all` unions the movie and series genre sets.
  const genreOptions = browseGenres?.[activeType] ?? [];
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
    includesGenre(browseGenres[nextType], activeGenre);

  const selectType = (nextType: SearchMediaType) => {
    handleTypeChange(nextType, !isGenreCompatible(nextType));
    // A no-op re-click changes nothing — don't bounce the scroll position.
    if (nextType !== activeType) resetScroll();
  };

  const isTyping = isComposing || trimmedQuery !== trimmedDebouncedQuery;
  // Hover/focus intent warms the next tab's catalog so the switch lands fast.
  const prefetchType = (nextType: SearchMediaType) => {
    if (!isOnline || isTyping || nextType === activeType) return;
    void prefetchSearchCatalog(queryClient, {
      query: trimmedDebouncedQuery,
      type: nextType,
      feed: activeFeed,
      genre: isGenreCompatible(nextType) ? activeGenre : undefined,
    });
  };

  const searchInputRef = useRef<HTMLInputElement>(null);
  const [autoFocusSearch] = useState(
    () => navigationType !== NavigationType.Pop || (!trimmedQuery && results.length === 0),
  );
  useEffect(() => {
    const input = searchInputRef.current;
    if (autoFocusSearch && input?.value) input.select();
  }, [autoFocusSearch]);
  const handleClearSearch = () => {
    setQuery('');
    searchInputRef.current?.focus({ preventScroll: true });
    resetScroll();
  };

  const { recentSearches, recordRecentSearch, removeRecentSearch, clearRecentSearches } =
    useRecentSearches();
  const [searchFieldFocused, setSearchFieldFocused] = useState(false);
  // Landing autofocus shouldn't drop the panel over the grid; the first click or key opens it.
  const [recentDismissed, setRecentDismissed] = useState(autoFocusSearch);
  const showRecentSearches =
    searchFieldFocused && !recentDismissed && !query && recentSearches.length > 0;
  const recentListRef = useRef<HTMLUListElement>(null);
  const dismissRecentOnEscape = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setRecentDismissed(true);
    searchInputRef.current?.focus({ preventScroll: true });
  };
  const focusRecentEntry = (index: number) => {
    const entries =
      recentListRef.current?.querySelectorAll<HTMLButtonElement>('[data-recent-entry]');
    if (!entries?.length) return;
    if (index < 0) searchInputRef.current?.focus({ preventScroll: true });
    else {
      const entry = entries[Math.min(index, entries.length - 1)];
      entry?.focus({ preventScroll: true });
      entry?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };
  // Only committed intent is remembered: Enter, opening a result, or a recent pick.
  const recordQuery = () => {
    if (trimmedQuery && !isComposing) recordRecentSearch(trimmedQuery);
  };
  const selectRecentSearch = (entry: string) => {
    setQuery(entry);
    recordRecentSearch(entry);
    searchInputRef.current?.focus({ preventScroll: true });
    resetScroll();
  };

  const handleResetFilters = () => {
    if (!hasActiveFilters) return;
    resetFilters();
    searchInputRef.current?.focus({ preventScroll: true });
    resetScroll();
  };

  const isRetryingInitialLoad = isFetched && isLoading;
  const isBrowsing = !trimmedQuery;
  const isRefining = isTyping || isPlaceholderData;
  const showSkeleton = (isLoading || isRefining) && !isRetryingInitialLoad && results.length === 0;
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
  const activeFeedOption =
    SEARCH_FEED_OPTIONS.find((option) => option.id === activeFeed) ?? SEARCH_FEED_OPTIONS[0];
  const activeFeedLabel = activeFeedOption.label;
  const resultCountLabel = `${results.length}${hasNextPage ? '+' : ''} ${isBrowsing ? 'title' : 'result'}${results.length === 1 && !hasNextPage ? '' : 's'}`;

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

  const moveResultFocus = (event: ReactKeyboardEvent) => {
    if (
      !event.key.startsWith('Arrow') ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey ||
      !(event.target instanceof HTMLElement) ||
      !event.target.matches('[data-media-card-poster]')
    )
      return;
    const cell = event.target.closest<HTMLElement>('[data-search-result-index]');
    const row = cell?.parentElement;
    if (!cell || !row) return;
    const index = Number(cell.dataset.searchResultIndex);
    const columns = getComputedStyle(row).gridTemplateColumns.split(' ').length;
    if (event.key === 'ArrowUp' && index < columns) {
      event.preventDefault();
      searchInputRef.current?.focus({ preventScroll: true });
      resetScroll();
      return;
    }
    const lastIndex = results.length - 1;
    const target =
      event.key === 'ArrowLeft'
        ? index - 1
        : event.key === 'ArrowRight'
          ? index + 1
          : event.key === 'ArrowUp'
            ? index - columns
            : Math.floor(index / columns) < Math.floor(lastIndex / columns)
              ? Math.min(index + columns, lastIndex)
              : -1;
    const targetCell =
      target >= 0 && target <= lastIndex
        ? resultsRef.current?.querySelector<HTMLElement>(`[data-search-result-index="${target}"]`)
        : null;
    const poster = targetCell?.querySelector<HTMLElement>('[data-media-card-poster]');
    if (!targetCell || !poster) return;
    event.preventDefault();
    poster.focus({ preventScroll: true });
    targetCell.scrollIntoView({ block: 'nearest' });
  };

  const headerEndRef = useRef<HTMLDivElement>(null);
  const compactHeaderRef = useRef<HTMLDivElement>(null);
  const headerPassed = useScrolledPastTitlebar(headerEndRef, compactHeaderRef, searchInputRef);

  const showCompactHeader =
    headerPassed && (!!trimmedQuery || hasActiveFilters || results.length > 0);
  const compactFilters = [
    {
      id: 'type',
      label:
        activeType !== 'all'
          ? SEARCH_TYPE_OPTIONS.find((option) => option.id === activeType)?.label
          : undefined,
    },
    { id: 'genre', label: activeGenre },
    { id: 'feed', label: isBrowsing ? activeFeedLabel : undefined },
  ];
  const returnToSearch = () => {
    searchInputRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  };

  return (
    <div className='page-enter'>
      <div className={`mx-auto w-full max-w-[1800px] ${SIDEBAR_PAGE_COLUMN_INSETS} pb-16 pt-8`}>
        <div className='relative mx-auto w-full max-w-4xl'>
          <div className='mb-5 flex min-h-6 items-end justify-between gap-3'>
            <div className='flex min-w-0 items-center gap-3'>
              <h1 className='min-w-0 text-[24px] font-semibold leading-none tracking-[-0.03em] text-white'>
                {isBrowsing ? 'Discover' : 'Search'}
              </h1>
              <TooltipProvider delayDuration={120}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type='button'
                      aria-label='About unified catalog results'
                      className='group inline-flex shrink-0 cursor-help items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-[13px] text-zinc-400 transition-colors duration-150 hover:border-white/[0.08] hover:bg-white/[0.05] hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 data-[state=delayed-open]:text-zinc-100 motion-reduce:transition-none'
                    >
                      <Layers3
                        aria-hidden='true'
                        className='h-3.5 w-3.5 transition-transform duration-200 ease-out group-hover:-translate-y-px motion-reduce:transition-none'
                      />
                      <span className='hidden sm:inline'>Unified results</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side='bottom' align='start' className='max-w-72 space-y-1'>
                    <p className='font-medium text-white'>One card per title</p>
                    <p className='text-zinc-300'>
                      When several addons list the same title, it shows once. A listing doesn't
                      guarantee a stream is available.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            {/* Keep the live region mounted; never label old-facet counts as new results. */}
            <output
              aria-live={isRefining || isUpdating || isFetchingNextPage ? 'off' : 'polite'}
              aria-atomic='true'
              title={
                isRefining
                  ? 'Previous results remain visible while updating'
                  : 'Unique titles loaded so far'
              }
              className='flex shrink-0 items-center gap-2 text-[13px] tabular-nums text-zinc-400'
            >
              {results.length > 0 && <span>{isRefining ? 'Updating…' : resultCountLabel}</span>}
              {showUpdating && (!isRefining || results.length === 0) && (
                <span className='text-(--accent-nav)'>Updating…</span>
              )}
            </output>
          </div>

          <div
            className='relative w-full'
            onFocus={() => setSearchFieldFocused(true)}
            onBlur={(event) => {
              if (
                !(
                  event.relatedTarget instanceof Node &&
                  event.currentTarget.contains(event.relatedTarget)
                )
              )
                setSearchFieldFocused(false);
            }}
          >
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
              className='h-12 w-full rounded-lg border-white/[0.1] bg-white/[0.04] pl-11 pr-20 text-base text-zinc-100 placeholder:text-zinc-400 hover:bg-white/[0.06] focus-visible:border-(--accent-nav) focus-visible:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-(--accent-nav)/15 md:text-base'
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onPaste={(event) => {
                const pasted = event.clipboardData.getData('text');
                if (!isAppLinkText(pasted)) return;
                event.preventDefault();
                void openAppLinkText(pasted);
              }}
              onPointerDown={() => setRecentDismissed(false)}
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
                if (event.key !== 'Escape') setRecentDismissed(false);
                if (
                  (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
                  !query &&
                  recentSearches.length > 0
                ) {
                  event.preventDefault();
                  const target = event.key === 'ArrowDown' ? 0 : recentSearches.length - 1;
                  requestAnimationFrame(() => focusRecentEntry(target));
                  return;
                }
                if (event.key === 'Enter' || event.key === 'ArrowDown') {
                  event.preventDefault();
                  if (event.repeat) return;
                  if (event.key === 'Enter' && isAppLinkText(query)) {
                    // Links never reach catalog search: addon links can carry API keys.
                    setQuery('');
                    void openAppLinkText(query);
                    return;
                  }
                  if (event.key === 'Enter') {
                    flushQuery();
                    recordQuery();
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
                } else if (showRecentSearches) {
                  setRecentDismissed(true);
                } else {
                  navigateBack();
                }
              }}
            />
            {/* eslint-enable jsx-a11y/no-autofocus */}
            <SearchIcon className='pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-zinc-500' />
            <div className='absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5'>
              <span aria-hidden='true' className='flex h-4 w-4 items-center justify-center'>
                {showUpdating && (
                  <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-(--accent-nav) motion-reduce:animate-none' />
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
              ) : showRecentSearches ? (
                <button
                  type='button'
                  aria-label='Clear recent searches'
                  onMouseDown={keepSearchInputFocus}
                  onKeyDown={dismissRecentOnEscape}
                  onClick={() => {
                    void clearRecentSearches();
                    searchInputRef.current?.focus({ preventScroll: true });
                  }}
                  className={cn(RECENT_SEARCH_ROW_BUTTON_CLASS, 'h-8 w-8 justify-center')}
                >
                  <Trash2 aria-hidden='true' className='size-3.5' />
                </button>
              ) : null}
            </div>
            {showRecentSearches && (
              <section
                data-key-capture
                aria-label='Recent searches'
                className='absolute inset-x-0 top-full z-30 mt-2 rounded-lg border border-white/[0.09] bg-zinc-950/98 p-1.5 shadow-[0_12px_32px_-14px_rgb(0_0_0/0.9),inset_0_1px_0_rgb(255_255_255/0.05)] animate-in fade-in-0 slide-in-from-top-0.5 duration-150 ease-out motion-reduce:animate-none'
              >
                <ul
                  ref={recentListRef}
                  className='max-h-[min(216px,38vh)] overflow-y-auto overscroll-contain'
                >
                  {recentSearches.map((entry, index) => (
                    <li key={entry} className='group/recent flex items-center gap-1'>
                      <button
                        type='button'
                        onMouseDown={keepSearchInputFocus}
                        data-recent-entry
                        onClick={() => selectRecentSearch(entry)}
                        onKeyDown={(event) => {
                          dismissRecentOnEscape(event);
                          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                          event.preventDefault();
                          if (event.key === 'ArrowDown' && index === recentSearches.length - 1)
                            focusFirstResult();
                          else focusRecentEntry(index + (event.key === 'ArrowDown' ? 1 : -1));
                        }}
                        className={cn(
                          RECENT_SEARCH_ROW_BUTTON_CLASS,
                          'min-w-0 flex-1 gap-2.5 px-2.5 text-left text-[13px] text-zinc-300',
                        )}
                      >
                        <HistoryIcon
                          aria-hidden='true'
                          className='h-3.5 w-3.5 shrink-0 text-zinc-500'
                        />
                        <span className='truncate'>{entry}</span>
                      </button>
                      <button
                        type='button'
                        aria-label={`Remove ${entry} from recent searches`}
                        onMouseDown={keepSearchInputFocus}
                        onKeyDown={dismissRecentOnEscape}
                        onClick={() => {
                          void removeRecentSearch(entry);
                          // Keyboard removal unmounts the focused row.
                          searchInputRef.current?.focus({ preventScroll: true });
                        }}
                        className={cn(
                          RECENT_SEARCH_ROW_BUTTON_CLASS,
                          'w-9 shrink-0 justify-center opacity-0 transition-opacity duration-150 group-hover/recent:opacity-100 group-focus-within/recent:opacity-100 focus-visible:opacity-100',
                        )}
                      >
                        <X aria-hidden='true' className='h-3.5 w-3.5' />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
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
                    <Shapes
                      aria-hidden='true'
                      className={cn(FACET_ICON_CLASS, 'text-violet-300')}
                    />
                    <span className='max-w-[120px] truncate'>{activeGenre ?? 'Genre'}</span>
                    <ChevronDown
                      aria-hidden='true'
                      className='h-3.5 w-3.5 opacity-60 transition-[transform,opacity] duration-150 group-hover:opacity-100 group-data-[state=open]:rotate-180 motion-reduce:transition-none'
                    />
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
                    <p
                      role='status'
                      className='px-2.5 py-2 text-[13px] leading-relaxed text-zinc-400'
                    >
                      Connect to the internet to load genres.
                    </p>
                  ) : hasGenreError ? (
                    <>
                      <p
                        role='alert'
                        className='px-2.5 pt-1 text-[13px] leading-relaxed text-zinc-300'
                      >
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
                        className='h-9 px-2.5 text-[13px] aria-disabled:opacity-50'
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
                    'w-[38px] justify-center px-0 animate-in fade-in-0 zoom-in-90 duration-150 motion-reduce:animate-none',
                  )}
                >
                  <X aria-hidden='true' className='h-3.5 w-3.5' />
                </button>
              )}
            </div>

            <div
              ref={typeGroupRef}
              role='radiogroup'
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
                  role='radio'
                  aria-checked={activeType === option.id}
                  tabIndex={activeType === option.id ? 0 : -1}
                  onKeyDown={handleRadioGroupKeyDown}
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
                      !isBrowsing
                        ? 'border-white/[0.08] bg-white/[0.04] text-zinc-400'
                        : activeFeed !== 'popular'
                          ? 'accent-lattice-soft'
                          : SEARCH_FACET_IDLE_CLASS,
                    )}
                  >
                    <activeFeedOption.icon
                      aria-hidden='true'
                      className={cn(FACET_ICON_CLASS, activeFeedOption.tint)}
                    />
                    {/* Every label occupies one cell so the trigger keeps the widest width. */}
                    <span className='grid text-left'>
                      {SEARCH_FEED_OPTIONS.map((option) => (
                        <span
                          key={option.id}
                          className={cn(
                            'col-start-1 row-start-1',
                            option.id !== activeFeed && 'invisible',
                          )}
                        >
                          {option.label}
                        </span>
                      ))}
                    </span>
                    <ChevronDown
                      aria-hidden='true'
                      className='h-3.5 w-3.5 opacity-60 transition-[transform,opacity] duration-150 group-not-aria-disabled:group-hover:opacity-100 group-data-[state=open]:rotate-180 motion-reduce:transition-none'
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align='end' sideOffset={6} className='w-44'>
                  {SEARCH_FEED_OPTIONS.map((option) => (
                    <FacetMenuItem
                      key={option.id}
                      checked={activeFeed === option.id}
                      onSelect={() => handleFeedChange(option.id)}
                    >
                      <span className='flex items-center gap-2'>
                        <option.icon
                          aria-hidden='true'
                          className={cn('h-3.5 w-3.5', option.tint)}
                        />
                        {option.label}
                      </span>
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
                <RotateCcw aria-hidden='true' className={FACET_ICON_CLASS} />
                Reset
              </button>
            </div>
          </div>
          <div ref={headerEndRef} aria-hidden='true' className='absolute inset-x-0 bottom-0 h-px' />
        </div>

        <div
          id='search-results'
          ref={resultsRef}
          aria-busy={(isOnline && (isRefining || isFetching)) || undefined}
          className='pt-5'
          onClickCapture={(event) => {
            flushQuery();
            if (
              !isRefining &&
              event.target instanceof Element &&
              event.target.closest('[data-search-result-index]')
            )
              recordQuery();
          }}
          onKeyDownCapture={moveResultFocus}
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
            resultSetKey={firstPage ? getResultPageId(firstPage.items) : 0}
            partial={partial}
            showSkeleton={showSkeleton}
            trimmedDebouncedQuery={trimmedDebouncedQuery}
          />
        </div>
      </div>

      <div
        ref={compactHeaderRef}
        role='region'
        aria-label='Search summary'
        aria-hidden={!showCompactHeader || undefined}
        inert={!showCompactHeader}
        className={cn(
          'pointer-events-none fixed inset-x-0 top-8 z-40 transition-[opacity,translate] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          showCompactHeader ? 'translate-y-0 opacity-100' : '-translate-y-1.5 opacity-0',
        )}
      >
        <div className={`mx-auto w-full max-w-[1800px] pt-2 ${SIDEBAR_PAGE_COLUMN_INSETS}`}>
          <div
            className={cn(
              'mx-auto flex h-11 w-full max-w-4xl items-center gap-1 rounded-lg border border-white/[0.09] bg-zinc-950/85 py-1 pl-1 pr-1.5 shadow-[0_12px_32px_-14px_rgb(0_0_0/0.9),inset_0_1px_0_rgb(255_255_255/0.05)] backdrop-blur-md',
              showCompactHeader && 'pointer-events-auto',
            )}
          >
            <button
              type='button'
              aria-label={trimmedQuery ? `Edit search: ${trimmedQuery}` : 'Search titles'}
              title='Back to search'
              onClick={returnToSearch}
              className='flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md px-3 text-left text-[13px] font-medium transition-colors duration-150 hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/25'
            >
              <SearchIcon aria-hidden='true' className='h-4 w-4 shrink-0 text-zinc-500' />
              <span className={cn('truncate', trimmedQuery ? 'text-zinc-100' : 'text-zinc-400')}>
                {trimmedQuery || 'Search movies, shows, anime...'}
              </span>
            </button>
            <div className='flex min-w-0 max-w-[45%] items-center gap-1 overflow-x-auto scrollbar-hide'>
              {compactFilters.map(({ id, label }) =>
                label ? (
                  <span
                    key={id}
                    title={label}
                    className='accent-lattice-soft max-w-36 shrink-0 truncate rounded-[5px] border px-2 py-1 text-[13px] font-medium'
                  >
                    {label}
                  </span>
                ) : null,
              )}
            </div>
            {(results.length > 0 || showUpdating) && (
              <span
                aria-hidden='true'
                className='hidden shrink-0 px-2 text-[13px] tabular-nums text-zinc-400 sm:inline'
              >
                {isRefining || showUpdating ? 'Updating…' : resultCountLabel}
              </span>
            )}
            <span aria-hidden='true' className='mx-1 h-4 w-px shrink-0 bg-white/10' />
            {hasActiveFilters && (
              <button
                type='button'
                title='Reset all filters'
                onClick={handleResetFilters}
                className='flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-zinc-300 transition-colors duration-150 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50'
              >
                <RotateCcw aria-hidden='true' className='h-3.5 w-3.5' />
                Reset
              </button>
            )}
          </div>
        </div>
      </div>
      <ScrollToTop />
    </div>
  );
}
