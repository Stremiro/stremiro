import { type Range, useVirtualizer } from '@tanstack/react-virtual';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  ListVideo,
  X,
} from 'lucide-react';
import {
  type KeyboardEvent,
  memo,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { isEpisodeSpoiler } from '@/components/details-episode-card';
import {
  CHROME_CLOSE_BUTTON_CLASS,
  CHROME_ICON_BUTTON_CLASS,
  CHROME_ICON_CLASS,
  CHROME_ICON_STROKE,
} from '@/components/player-chrome-styles';
import { RemoteImage } from '@/components/remote-image';
import { RetryBanner } from '@/components/retry-banner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SearchInput } from '@/components/ui/search-input';
import { focusedRowRange } from '@/components/window-virtualized-stack';
import { EPISODE_SEARCH_MIN_COUNT, useEpisodeSearch } from '@/hooks/use-episode-search';
import { useDebounce } from '@/hooks/use-debounce';
import { usePlayerKeymap, useSpoilerProtection } from '@/hooks/use-app-ui-preferences';
import { useLocalDay } from '@/hooks/use-local-day';
import type { Episode, MediaDetails, TitleWatchProgress, WatchProgress } from '@/lib/api';
import { ariaKeyShortcuts, withShortcutHint } from '@/lib/player-keybindings';
import { episodeMatchesCoordinates } from '@/lib/episode-stream-target';
import { getWatchProgressPercent } from '@/lib/history-playback';
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
  /** Per-episode watch-row lookup — the same rows details cards render. */
  episodeProgressFor?: (episode: Episode) => WatchProgress | undefined;
  watchedEpisodeCeiling?: TitleWatchProgress['watchedEpisodeCeiling'];
  /** The title's Continue target; that row gets the Resume pill. */
  resumeTarget?: { season?: number; episode?: number };
  onEpisodeSelect: (episode: Episode) => void;
  onClose: () => void;
}

// Fixed row heights keep long seasons cheap to scroll; virtual wrappers include the gap.
const EPISODE_ROW_ESTIMATE_PX = 84;
const EPISODE_ROW_GAP_PX = 2;
const SEASON_STEP_CLASS =
  'flex h-full w-7 cursor-pointer items-center justify-center text-zinc-400 outline-hidden transition-colors duration-120 not-aria-disabled:hover:text-white focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/30 aria-disabled:cursor-default aria-disabled:text-zinc-700 motion-reduce:transition-none';
const EPISODE_LIST_VIRTUALIZE_THRESHOLD = 40;

// Memoized so playback ticks never re-render the episode list while the panel sits closed off-screen.
export const PlayerEpisodesPanel = memo(function PlayerEpisodesPanel({
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
  episodeProgressFor,
  watchedEpisodeCeiling,
  resumeTarget,
  onEpisodeSelect,
  onClose,
}: PlayerEpisodesPanelProps) {
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
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const shouldVirtualize = visibleEpisodes.length >= EPISODE_LIST_VIRTUALIZE_THRESHOLD;
  // Keep rows through the exit fade, then stop observing the hidden viewport.
  const listExiting = useDebounce(open, 180);
  const rangeExtractor = useCallback(
    (range: Range) => focusedRowRange(range, focusedIndex),
    [focusedIndex],
  );
  const episodeVirtualizer = useVirtualizer({
    count: visibleEpisodes.length,
    getScrollElement: () => scrollViewportRef.current,
    estimateSize: () => EPISODE_ROW_ESTIMATE_PX + EPISODE_ROW_GAP_PX,
    overscan: 6,
    enabled: shouldVirtualize && (open || listExiting),
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
  const showJumpToCurrent =
    currentSeason !== undefined &&
    selectedSeason !== currentSeason &&
    seasons.some((season) => season.number === currentSeason);

  const handleRowKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = Array.from(
      scrollViewportRef.current?.querySelectorAll<HTMLElement>('[data-episode-row]') ?? [],
    );
    const index = rows.indexOf(event.currentTarget);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: 'nearest' });
  }, []);

  const renderEpisode = useCallback(
    (ep: Episode) => {
      const isCurrent = episodeMatchesCoordinates(ep, currentSeason, currentEpisode);
      const airDate = formatAirDate(ep.releaseDate, localDay);
      // The Continue target gets Resume, never the already-marked Now playing row.
      const watchEntry = episodeProgressFor?.(ep);
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
      const thumbnail = ep.thumbnail || backdrop;
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
            'relative flex h-[84px] w-full cursor-pointer items-center gap-3 rounded-md px-2 text-left outline-hidden transition-colors duration-120 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white/40 motion-reduce:transition-none',
            isCurrent ? 'bg-white/[0.05]' : 'hover:bg-white/[0.03] focus-visible:bg-white/[0.03]',
          )}
          onClick={() => onEpisodeSelect(ep)}
        >
          {isCurrent && (
            <span
              aria-hidden='true'
              className='absolute left-0 top-3 bottom-3 w-0.5 rounded-r-full bg-(--accent-act)'
            />
          )}
          <div className='relative aspect-video w-[120px] shrink-0 overflow-hidden rounded-[5px] bg-zinc-900 ring-1 ring-white/[0.06]'>
            <div className='absolute inset-0 flex items-center justify-center text-[13px] font-semibold tabular-nums text-zinc-700'>
              E{ep.episode}
            </div>
            {thumbnail && (
              <RemoteImage
                src={thumbnail}
                loading='lazy'
                className={cn(
                  'relative h-full w-full object-cover',
                  isSpoiler && 'scale-110 blur-md',
                  isWatched && !isCurrent && 'opacity-60',
                )}
                alt=''
              />
            )}
            {progressPercent > 0 && (
              <div className='absolute inset-x-0 bottom-0 h-[3px] bg-black/50'>
                <div
                  className='h-full w-full origin-left bg-(--accent-prog)'
                  style={{ transform: `scaleX(${progressPercent / 100})` }}
                />
              </div>
            )}
          </div>

          <div className='min-w-0 flex-1'>
            <p className='flex min-w-0 items-center gap-1.5 text-[11.5px] leading-4 tabular-nums text-zinc-500'>
              <span className='shrink-0 font-medium text-zinc-400'>E{ep.episode}</span>
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
                  {!isCurrent && !isResume && (
                    <Check aria-hidden='true' className='h-3 w-3' strokeWidth={2.5} />
                  )}
                  {isCurrent ? 'Playing' : isResume ? 'Resume' : 'Watched'}
                </span>
              )}
            </p>
            <h3
              className={cn(
                'mt-0.5 truncate text-[13.5px] font-medium leading-5 tracking-[-0.005em]',
                isCurrent ? 'text-white' : 'text-zinc-100',
              )}
              title={episodeTitle}
            >
              {episodeTitle}
            </h3>
            {(isSpoiler || ep.overview) && (
              <p
                className='mt-0.5 truncate text-[12px] leading-[17px] text-zinc-500'
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
      episodeProgressFor,
      handleRowKeyDown,
      localDay,
      onEpisodeSelect,
      resumeTarget,
      spoilerProtection,
      watchedEpisodeCeiling,
    ],
  );

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
        'absolute right-3 bottom-3 z-60 flex w-[400px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden',
        // Opaque: any translucency lets the native video bleed through and muddies the rows.
        'rounded-lg border border-white/[0.07] bg-zinc-950',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_16px_48px_-16px_rgba(0,0,0,0.7)]',
        'transition-[translate,opacity] duration-160 ease-out starting:translate-x-2 starting:opacity-0 motion-reduce:transition-none',
        // Below the custom titlebar in windowed mode so window controls never overlap the panel header.
        isFullscreen ? 'top-3' : 'top-12',
        open ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-2 opacity-0',
      )}
    >
      <div className='shrink-0 border-b border-white/[0.06] px-3 pt-3 pb-2.5'>
        <div className='flex items-center gap-2 pl-1'>
          <h2 className='text-[14px] font-semibold leading-5 tracking-tight text-white'>
            Episodes
          </h2>
          <span className='min-w-0 flex-1 truncate text-[12px] tabular-nums text-zinc-500'>
            {pluralize(seasonEpisodes.length, 'episode')}
          </span>
          {showJumpToCurrent && (
            <button
              type='button'
              onClick={() => {
                didScrollToCurrentRef.current = false;
                onSeasonChange(currentSeason);
              }}
              className='flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-(--accent-act) outline-hidden transition-colors duration-120 hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-white/30 motion-reduce:transition-none'
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
              <div className='flex h-8 shrink-0 items-center rounded-md border border-white/[0.07] bg-white/[0.03]'>
                <button
                  type='button'
                  aria-label='Previous season'
                  aria-disabled={seasonIndex <= 0 || undefined}
                  onClick={() => {
                    if (seasonIndex > 0) onSeasonChange(seasons[seasonIndex - 1].number);
                  }}
                  className={SEASON_STEP_CLASS}
                >
                  <ChevronLeft aria-hidden='true' className='h-3.5 w-3.5' strokeWidth={2.25} />
                </button>
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type='button'
                      aria-label={`Season ${selectedSeason}, change season`}
                      className='flex h-full cursor-pointer items-center gap-1.5 border-x border-white/[0.07] px-2.5 text-[12px] font-medium text-zinc-200 outline-hidden transition-colors duration-120 hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/30 data-[state=open]:bg-white/[0.05] motion-reduce:transition-none'
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      Season {selectedSeason}
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
                            className={cn('h-4 w-4 shrink-0', !isSelected && 'invisible')}
                            strokeWidth={CHROME_ICON_STROKE}
                          />
                          <span className='flex-1'>Season {season}</span>
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
                      onSeasonChange(seasons[seasonIndex + 1].number);
                  }}
                  className={SEASON_STEP_CLASS}
                >
                  <ChevronRight aria-hidden='true' className='h-3.5 w-3.5' strokeWidth={2.25} />
                </button>
              </div>
            )}
            {searchVisible && (
              <SearchInput
                placeholder='Search episodes'
                value={episodeSearch}
                onValueChange={setEpisodeSearch}
                clearLabel='Clear episode search'
                wrapperClassName='min-w-0 flex-1'
                className='h-8 rounded-md border-white/[0.07] bg-white/[0.03] text-xs text-white placeholder:text-zinc-500 focus-visible:border-white/20 focus-visible:ring-white/20'
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
            style={{ height: `${episodeVirtualizer.getTotalSize() + 12}px` }}
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
                  className='absolute left-1.5 right-1.5 top-1.5'
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
          <div className='space-y-0.5 p-1.5'>{visibleEpisodes.map(renderEpisode)}</div>
        )}
      </div>
    </aside>
  );
});
