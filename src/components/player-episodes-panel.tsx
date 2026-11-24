import { type Range, useVirtualizer } from '@tanstack/react-virtual';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  ListVideo,
  Play,
  X,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { EpisodeThumb } from '@/components/episode-thumb';
import {
  CHROME_CLOSE_BUTTON_CLASS,
  CHROME_ICON_BUTTON_CLASS,
  CHROME_ICON_CLASS,
  CHROME_ICON_STROKE,
} from '@/components/player-chrome-styles';
import { RetryBanner } from '@/components/retry-banner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SearchInput } from '@/components/ui/search-input';
import { focusedRowRange } from '@/components/window-virtualized-stack';
import { EPISODE_SEARCH_MIN_COUNT, useEpisodeSearch } from '@/hooks/use-item-search';
import { useFindShortcut } from '@/hooks/use-browse-hotkeys';
import { useDelayedUnmount } from '@/hooks/use-delayed-unmount';
import { usePlayerKeymap, useSpoilerProtection } from '@/hooks/use-app-ui-preferences';
import { useLocalDay } from '@/hooks/use-local-day';
import type { Episode, MediaDetails, TitleWatchProgress } from '@/lib/api';
import { ariaKeyShortcuts, withShortcutHint } from '@/lib/player-keybindings';
import { episodeMatchesCoordinates, isEpisodeSpoiler } from '@/lib/episode-stream-target';
import { episodeProgressKey, getWatchProgressPercent } from '@/lib/history-playback';
import { formatAirDate } from '@/lib/schedule-dates';
import { cn, getEpisodeTitle, pluralize } from '@/lib/utils';

interface PlayerEpisodesToggleButtonProps {
  open: boolean;
  onToggle: () => void;
}

export function PlayerEpisodesToggleButton({ open, onToggle }: PlayerEpisodesToggleButtonProps) {
  const keymap = usePlayerKeymap();
  return (
    <button
      type='button'
      aria-label={open ? 'Close episodes panel' : 'Open episodes panel'}
      aria-keyshortcuts={ariaKeyShortcuts(keymap, 'episodes')}
      aria-expanded={open}
      aria-controls={open ? 'player-episodes-panel' : undefined}
      className={CHROME_ICON_BUTTON_CLASS}
      title={withShortcutHint('Episodes', keymap, 'episodes')}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <ListVideo
        aria-hidden='true'
        className={CHROME_ICON_CLASS}
        strokeWidth={CHROME_ICON_STROKE}
      />
    </button>
  );
}

interface PlayerEpisodesPanelProps {
  panelRef?: Ref<HTMLElement>;
  open: boolean;
  /** Windowed mode must clear the 32px custom titlebar. */
  isFullscreen: boolean;
  seasons: NonNullable<MediaDetails['seasons']>;
  selectedSeason: number;
  onSeasonChange: (season: number) => void;
  episodes: Episode[];
  currentSeason?: number;
  currentEpisode?: number;
  backdrop?: string;
  mediaId?: string;
  episodeProgress?: TitleWatchProgress['episodeProgress'];
  watchedEpisodeCeiling?: TitleWatchProgress['watchedEpisodeCeiling'];
  /** The title's Continue target; that row gets the Resume pill. */
  resumeTarget?: { season?: number; episode?: number };
  onEpisodeSelect: (episode: Episode) => void;
  onClose: () => void;
}

// Fixed row heights keep long seasons cheap to scroll; virtual wrappers include the gap.
const EPISODE_ROW_ESTIMATE_PX = 90;
const EPISODE_ROW_GAP_PX = 4;
const SEASON_STEP_CLASS =
  'flex h-full w-7 cursor-pointer items-center justify-center text-zinc-400 outline-hidden transition-colors duration-120 not-aria-disabled:hover:bg-white/[0.04] not-aria-disabled:hover:text-white focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/30 aria-disabled:cursor-default aria-disabled:text-zinc-700 motion-reduce:transition-none';
const EPISODE_LIST_VIRTUALIZE_THRESHOLD = 40;

function formatSeasonLabel(season: number) {
  return season === 0 ? 'Specials' : `Season ${season}`;
}

export function PlayerEpisodesPanel({
  panelRef,
  open,
  isFullscreen,
  seasons,
  selectedSeason,
  onSeasonChange,
  episodes,
  currentSeason,
  currentEpisode,
  backdrop,
  mediaId,
  episodeProgress,
  watchedEpisodeCeiling,
  resumeTarget,
  onEpisodeSelect,
  onClose,
}: PlayerEpisodesPanelProps) {
  // The compiler caches getVirtualItems() on the stable virtualizer instance, freezing rows on scroll.
  'use no memo';
  const localDay = useLocalDay();
  const spoilerProtection = useSpoilerProtection();
  const seasonEpisodes = useMemo(
    () => episodes.filter((ep) => ep.season === selectedSeason),
    [episodes, selectedSeason],
  );
  const [episodeSearch, setEpisodeSearch] = useState('');
  // The field hides under the count threshold — a persisted query must not invisibly filter rows the user
  // can't see or clear. The text is kept so it returns with the field on a searchable season.
  const searchVisible = seasonEpisodes.length > EPISODE_SEARCH_MIN_COUNT;
  const {
    effectiveSearch: effectiveEpisodeSearch,
    filteredItems: visibleEpisodes,
    isSearchPending,
    searchError,
    isSearchFetching,
    retrySearch,
  } = useEpisodeSearch(seasonEpisodes, episodeSearch, searchVisible);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useFindShortcut(() => (open && searchVisible ? searchInputRef.current : null));
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const shouldVirtualize = visibleEpisodes.length >= EPISODE_LIST_VIRTUALIZE_THRESHOLD;
  // Keep rows through the exit fade, then stop observing the hidden viewport.
  const { mounted: listAlive } = useDelayedUnmount(open, 180);
  const rangeExtractor = useCallback(
    (range: Range) => focusedRowRange(range, focusedIndex),
    [focusedIndex],
  );
  const episodeVirtualizer = useVirtualizer({
    count: visibleEpisodes.length,
    getScrollElement: () => scrollViewportRef.current,
    estimateSize: () => EPISODE_ROW_ESTIMATE_PX + EPISODE_ROW_GAP_PX,
    overscan: 6,
    enabled: shouldVirtualize && listAlive,
    rangeExtractor,
  });

  // A new filter result starts at the top — a stale offset could leave a short list scrolled past its end.
  // Declared before the scroll-to-current effect: both run on mount and this reset must not wipe the centering.
  useEffect(() => {
    scrollViewportRef.current?.scrollTo({ top: 0 });
    if (shouldVirtualize) episodeVirtualizer.scrollToOffset(0);
  }, [effectiveEpisodeSearch, selectedSeason, shouldVirtualize, episodeVirtualizer]);

  // Follow playback only on opening, so browsing another season never fights the user's selection.
  const wasOpenRef = useRef(false);
  const didScrollToCurrentRef = useRef(false);
  useEffect(() => {
    const isOpening = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open) {
      didScrollToCurrentRef.current = false;
      return;
    }
    if (
      isOpening &&
      currentSeason !== undefined &&
      seasons.some((season) => season.number === currentSeason) &&
      selectedSeason !== currentSeason
    ) {
      onSeasonChange(currentSeason);
      return;
    }
    // An empty list or pending search is still loading — consuming the once-per-open flag here would skip centering on arrival.
    if (didScrollToCurrentRef.current || visibleEpisodes.length === 0 || isSearchPending) return;
    didScrollToCurrentRef.current = true;

    const index = visibleEpisodes.findIndex((ep) =>
      episodeMatchesCoordinates(ep, currentSeason, currentEpisode),
    );
    if (index < 0) return;

    if (shouldVirtualize) {
      episodeVirtualizer.scrollToIndex(index, { align: 'center' });
      return;
    }

    const viewport = scrollViewportRef.current;
    const row = viewport?.querySelector<HTMLElement>('[data-current-episode]');
    if (!viewport || !row) return;

    // Only this viewport may scroll: scrolling ancestors also moves the native-video overlay.
    const rowTop = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    viewport.scrollTop += rowTop - (viewport.clientHeight - row.offsetHeight) / 2;
  }, [
    open,
    visibleEpisodes,
    isSearchPending,
    shouldVirtualize,
    episodeVirtualizer,
    currentSeason,
    currentEpisode,
    seasons,
    selectedSeason,
    onSeasonChange,
  ]);

  const seasonIndex = seasons.findIndex((season) => season.number === selectedSeason);
  const seasonWatchedCount = useMemo(() => {
    if (!mediaId || !episodeProgress) return 0;
    let count = 0;
    for (const ep of seasonEpisodes) {
      if (episodeProgress[episodeProgressKey(mediaId, ep.season, ep.episode)]?.is_watched) {
        count += 1;
      }
    }
    return count;
  }, [episodeProgress, mediaId, seasonEpisodes]);
  const seasonProgressPercent =
    seasonEpisodes.length > 0 ? Math.round((seasonWatchedCount / seasonEpisodes.length) * 100) : 0;
  const currentEpisodeVisible =
    currentSeason !== undefined &&
    currentEpisode !== undefined &&
    visibleEpisodes.some((ep) => episodeMatchesCoordinates(ep, currentSeason, currentEpisode));
  const showJumpToCurrent =
    currentSeason !== undefined &&
    seasons.some((season) => season.number === currentSeason) &&
    (selectedSeason !== currentSeason ||
      (Boolean(effectiveEpisodeSearch) && !currentEpisodeVisible));

  const handleRowKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    )
      return;
    const rows = Array.from(
      scrollViewportRef.current?.querySelectorAll<HTMLElement>('[data-episode-row]') ?? [],
    );
    const index = rows.indexOf(event.currentTarget);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next =
      event.key === 'Home'
        ? rows[0]
        : event.key === 'End'
          ? rows[rows.length - 1]
          : rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: 'nearest' });
  }, []);

  const renderEpisode = useCallback(
    (ep: Episode) => {
      const isCurrent = episodeMatchesCoordinates(ep, currentSeason, currentEpisode);
      const airDate = formatAirDate(ep.releaseDate, localDay);
      // The Continue target gets Resume, never the already-marked Now playing row.
      const watchEntry = mediaId
        ? episodeProgress?.[episodeProgressKey(mediaId, ep.season, ep.episode)]
        : undefined;
      const isWatched = watchEntry?.is_watched === true;
      const isSpoiler = isEpisodeSpoiler(
        ep,
        spoilerProtection,
        watchedEpisodeCeiling,
        watchEntry,
        isCurrent,
      );
      const progressPercent = watchEntry
        ? getWatchProgressPercent(watchEntry.position, watchEntry.duration)
        : 0;
      const isResume =
        !isCurrent && resumeTarget?.season === ep.season && resumeTarget?.episode === ep.episode;
      const episodeTitle = getEpisodeTitle(isSpoiler ? undefined : ep.title, ep.episode);

      return (
        <button
          type='button'
          key={`${ep.season}-${ep.episode}`}
          data-episode-row
          onKeyDown={handleRowKeyDown}
          data-current-episode={isCurrent ? '' : undefined}
          aria-current={isCurrent ? 'true' : undefined}
          className={cn(
            'group/ep relative flex h-[90px] w-full cursor-pointer items-center gap-3.5 rounded-lg border px-2.5 text-left outline-hidden transition-[background-color,border-color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white/40 motion-reduce:transition-none',
            isCurrent
              ? 'border-white/[0.1] bg-white/[0.065] shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]'
              : 'border-transparent hover:border-white/[0.07] hover:bg-white/[0.04] hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] active:bg-white/[0.06] focus-visible:bg-white/[0.04]',
          )}
          onClick={() => onEpisodeSelect(ep)}
        >
          {isCurrent && (
            <span
              aria-hidden='true'
              className='absolute left-0 top-2.5 bottom-2.5 w-[2.5px] rounded-r-full bg-(--accent-act)'
            />
          )}
          <EpisodeThumb
            episode={ep.episode}
            src={ep.thumbnail}
            fallbackSrc={backdrop}
            fadeIn
            isSpoiler={isSpoiler}
            progressPercent={progressPercent}
            className='aspect-video w-[128px] rounded-md ring-1 ring-white/[0.08] transition-[box-shadow] duration-150 group-hover/ep:ring-white/[0.16] motion-reduce:transition-none'
            fallbackClassName='text-[13px] font-semibold tabular-nums text-zinc-700'
            imageClassName={cn(
              'transition-opacity duration-150 motion-reduce:transition-none',
              isWatched && !isCurrent && 'opacity-55 group-hover/ep:opacity-85',
            )}
            stripClassName='bg-black/55'
          >
            {!isCurrent && (
              <span
                aria-hidden='true'
                className='pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35 opacity-0 transition-opacity duration-150 group-hover/ep:opacity-100 group-focus-visible/ep:opacity-100 motion-reduce:transition-none'
              >
                <span className='flex h-7 w-7 items-center justify-center rounded-full bg-black/65 text-white ring-1 ring-white/20'>
                  <Play className='ml-0.5 h-3 w-3 fill-current' />
                </span>
              </span>
            )}
          </EpisodeThumb>

          <div className='min-w-0 flex-1'>
            <p className='flex min-w-0 items-center gap-1.5 text-[11.5px] leading-4 tabular-nums text-zinc-500'>
              <span
                className={cn(
                  'shrink-0 font-semibold',
                  isCurrent ? 'text-(--accent-act)' : 'text-zinc-400',
                )}
              >
                E{ep.episode}
              </span>
              {airDate && (
                <>
                  <span aria-hidden='true'>·</span>
                  <span className='truncate'>{airDate}</span>
                </>
              )}
              {(isCurrent || isResume || isWatched) && (
                <span
                  className={cn(
                    'ml-auto flex shrink-0 items-center gap-1 font-medium',
                    isCurrent || isResume ? 'text-(--accent-act)' : 'text-zinc-500',
                  )}
                >
                  {isCurrent ? (
                    <span
                      aria-hidden='true'
                      className='h-1.5 w-1.5 rounded-full bg-(--accent-act)'
                    />
                  ) : !isResume ? (
                    <Check aria-hidden='true' className='h-3 w-3' strokeWidth={2.5} />
                  ) : null}
                  {isCurrent ? 'Playing' : isResume ? 'Resume' : 'Watched'}
                </span>
              )}
            </p>
            <h3
              className={cn(
                'mt-0.5 truncate text-[13.5px] font-semibold leading-5 tracking-[-0.01em] transition-colors duration-150 motion-reduce:transition-none',
                isCurrent
                  ? 'text-white'
                  : isWatched
                    ? 'text-zinc-300 group-hover/ep:text-white'
                    : 'text-zinc-100 group-hover/ep:text-white',
              )}
              title={episodeTitle}
            >
              {episodeTitle}
            </h3>
            {(isSpoiler || ep.overview) && (
              <p
                className={cn(
                  'mt-0.5 line-clamp-2 text-[11.5px] leading-[15.5px]',
                  isSpoiler ? 'italic text-zinc-500' : 'text-zinc-400/90',
                )}
                title={isSpoiler ? undefined : ep.overview}
              >
                {isSpoiler ? 'Description hidden to prevent spoilers.' : ep.overview}
              </p>
            )}
          </div>
        </button>
      );
    },
    [
      backdrop,
      currentEpisode,
      currentSeason,
      mediaId,
      episodeProgress,
      handleRowKeyDown,
      localDay,
      onEpisodeSelect,
      resumeTarget,
      spoilerProtection,
      watchedEpisodeCeiling,
    ],
  );

  const headerMetaLabel = effectiveEpisodeSearch
    ? `${visibleEpisodes.length} of ${pluralize(seasonEpisodes.length, 'episode')}`
    : seasonWatchedCount > 0
      ? `${pluralize(seasonEpisodes.length, 'episode')} · ${
          seasonWatchedCount === seasonEpisodes.length
            ? 'All watched'
            : `${seasonWatchedCount} watched`
        }`
      : pluralize(seasonEpisodes.length, 'episode');

  return (
    <aside
      id='player-episodes-panel'
      ref={panelRef}
      data-player-interactive
      // Keep the mounted exit transition out of the tab order and accessibility tree.
      inert={!open}
      aria-hidden={!open}
      aria-label='Episodes'
      className={cn(
        'absolute right-3 bottom-3 z-60 flex w-[420px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden',
        // Opaque: any translucency lets the native video bleed through and muddies the rows.
        'rounded-xl border border-white/[0.09] bg-[#0a0a0c]',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_24px_64px_-16px_rgba(0,0,0,0.88)]',
        'transition-[translate,opacity] duration-180 ease-[cubic-bezier(0.22,1,0.36,1)] starting:translate-x-3 starting:opacity-0 motion-reduce:transition-none',
        // Below the custom titlebar in windowed mode so window controls never overlap the panel header.
        isFullscreen ? 'top-3' : 'top-12',
        open ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-3 opacity-0',
      )}
    >
      <span
        aria-hidden='true'
        className='pointer-events-none absolute inset-x-8 top-0 z-10 h-px bg-linear-to-r from-transparent via-white/[0.12] to-transparent'
      />
      <div className='relative shrink-0 border-b border-white/[0.06] bg-black/25 px-3.5 pt-3.5 pb-3'>
        <div className='flex items-center gap-2 pl-0.5'>
          <h2 className='text-[15px] font-semibold leading-5 tracking-tight text-white'>
            Episodes
          </h2>
          <span className='min-w-0 flex-1 truncate text-[12px] tabular-nums text-zinc-500'>
            {headerMetaLabel}
          </span>
          {showJumpToCurrent && (
            <button
              type='button'
              onClick={() => {
                didScrollToCurrentRef.current = false;
                if (episodeSearch) setEpisodeSearch('');
                if (selectedSeason !== currentSeason) onSeasonChange(currentSeason);
              }}
              className='flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 text-[12px] font-medium text-(--accent-act) outline-hidden transition-colors duration-120 hover:border-white/[0.14] hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-white/30 motion-reduce:transition-none'
            >
              <CornerDownRight aria-hidden='true' className='h-3.5 w-3.5' strokeWidth={2.25} />
              Now playing
            </button>
          )}
          <button
            type='button'
            onClick={onClose}
            aria-label='Close episodes panel'
            aria-keyshortcuts='Escape'
            title='Close (Esc)'
            className={cn(CHROME_CLOSE_BUTTON_CLASS, 'h-7 w-7 rounded-md')}
          >
            <X aria-hidden='true' className='h-4 w-4' strokeWidth={CHROME_ICON_STROKE} />
          </button>
        </div>

        {(seasons.length > 1 || searchVisible) && (
          <div className='mt-2.5 flex items-center gap-2'>
            {seasons.length > 1 && (
              <div className='flex h-8 shrink-0 items-center overflow-hidden rounded-lg border border-white/[0.08] bg-[#060608] shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]'>
                <button
                  type='button'
                  aria-label='Previous season'
                  aria-disabled={seasonIndex <= 0 || undefined}
                  onClick={() => {
                    if (seasonIndex > 0) onSeasonChange(seasons[seasonIndex - 1]!.number);
                  }}
                  className={SEASON_STEP_CLASS}
                >
                  <ChevronLeft aria-hidden='true' className='h-3.5 w-3.5' strokeWidth={2.25} />
                </button>
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type='button'
                      aria-label={`${formatSeasonLabel(selectedSeason)}, change season`}
                      className='flex h-full cursor-pointer items-center gap-1.5 border-x border-white/[0.07] px-2.5 text-[12.5px] font-medium text-zinc-200 outline-hidden transition-colors duration-120 hover:bg-white/[0.05] hover:text-white focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/30 data-[state=open]:bg-white/[0.06] motion-reduce:transition-none'
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      {formatSeasonLabel(selectedSeason)}
                      <ChevronDown
                        aria-hidden='true'
                        className='h-3.5 w-3.5 text-zinc-500'
                        strokeWidth={CHROME_ICON_STROKE}
                      />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align='start'
                    side='bottom'
                    className='z-80 max-h-[min(320px,var(--radix-dropdown-menu-content-available-height))] min-w-44 overflow-y-auto rounded-lg border-white/10 bg-zinc-950 backdrop-blur-none'
                    onClick={(e) => e.stopPropagation()}
                  >
                    {seasons.map(({ number: season, episodeCount: count }) => {
                      const isSelected = selectedSeason === season;
                      return (
                        <DropdownMenuItem
                          key={season}
                          role='menuitemradio'
                          aria-checked={isSelected}
                          onSelect={() => onSeasonChange(season)}
                          className={cn(
                            'cursor-pointer gap-2 rounded-md py-1.5 pr-3 pl-2 text-[13px]',
                            isSelected ? 'font-medium text-white' : 'text-zinc-300',
                          )}
                        >
                          <Check
                            aria-hidden='true'
                            className={cn(
                              'h-4 w-4 shrink-0 text-(--accent-nav)',
                              !isSelected && 'invisible',
                            )}
                            strokeWidth={CHROME_ICON_STROKE}
                          />
                          <span className='flex-1'>{formatSeasonLabel(season)}</span>
                          {season === currentSeason && (
                            <span
                              role='img'
                              aria-label='Now playing'
                              className='h-1.5 w-1.5 rounded-full bg-(--accent-act)'
                            />
                          )}
                          <span className='text-xs tabular-nums text-zinc-500'>{count}</span>
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  type='button'
                  aria-label='Next season'
                  aria-disabled={seasonIndex < 0 || seasonIndex >= seasons.length - 1 || undefined}
                  onClick={() => {
                    if (seasonIndex >= 0 && seasonIndex < seasons.length - 1)
                      onSeasonChange(seasons[seasonIndex + 1]!.number);
                  }}
                  className={SEASON_STEP_CLASS}
                >
                  <ChevronRight aria-hidden='true' className='h-3.5 w-3.5' strokeWidth={2.25} />
                </button>
              </div>
            )}
            {searchVisible && (
              <SearchInput
                inputRef={searchInputRef}
                placeholder='Search episodes…'
                value={episodeSearch}
                onValueChange={setEpisodeSearch}
                clearLabel='Clear episode search'
                wrapperClassName='min-w-0 flex-1'
                className='h-8 rounded-lg border-white/[0.08] bg-[#060608] text-xs text-white placeholder:text-zinc-500 focus-visible:border-(--accent-nav)/60 focus-visible:ring-(--accent-nav)/20'
              />
            )}
          </div>
        )}
        {searchError && (
          <RetryBanner
            className='mt-2.5 px-3 py-2'
            message='Search failed.'
            isRetrying={isSearchFetching}
            onRetry={retrySearch}
          />
        )}
        {seasonProgressPercent > 0 && (
          <div
            aria-hidden='true'
            className='pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-white/[0.04]'
          >
            <div
              className='h-full bg-(--accent-prog) transition-[width] duration-300 ease-out motion-reduce:transition-none'
              style={{ width: `${seasonProgressPercent}%` }}
            />
          </div>
        )}
      </div>

      <div ref={scrollViewportRef} className='min-h-0 flex-1 overflow-y-auto overscroll-contain'>
        {visibleEpisodes.length === 0 ? (
          <p
            role={isSearchPending ? 'status' : undefined}
            className='px-6 py-12 text-center text-xs text-zinc-400'
          >
            {isSearchPending ? (
              'Searching episodes…'
            ) : effectiveEpisodeSearch ? (
              <>
                No episodes match <span className='text-zinc-200'>{effectiveEpisodeSearch}</span>
              </>
            ) : (
              'No episodes found for this season.'
            )}
          </p>
        ) : shouldVirtualize ? (
          <div
            className='relative w-full'
            style={{ height: `${episodeVirtualizer.getTotalSize() + 16}px` }}
          >
            {episodeVirtualizer.getVirtualItems().map((virtualRow) => {
              const ep = visibleEpisodes[virtualRow.index];
              if (!ep) return null;
              return (
                <div
                  key={`${ep.season}-${ep.episode}`}
                  data-index={virtualRow.index}
                  ref={episodeVirtualizer.measureElement}
                  onFocusCapture={() => setFocusedIndex(virtualRow.index)}
                  onBlurCapture={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) setFocusedIndex(-1);
                  }}
                  className='absolute left-2 right-2 top-2'
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                    paddingBottom: `${EPISODE_ROW_GAP_PX}px`,
                  }}
                >
                  {renderEpisode(ep)}
                </div>
              );
            })}
          </div>
        ) : (
          <div className='space-y-1 p-2'>{visibleEpisodes.map(renderEpisode)}</div>
        )}
      </div>
    </aside>
  );
}
