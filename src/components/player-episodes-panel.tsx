import { type Range, useVirtualizer } from '@tanstack/react-virtual';
import { Check, ChevronDown, PanelRight, X } from 'lucide-react';
import { memo, type Ref, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isEpisodeSpoiler } from '@/components/details-episode-card';
import {
  CHROME_CLOSE_BUTTON_CLASS,
  CHROME_ICON_BUTTON_CLASS,
} from '@/components/player-chrome-styles';
import { RemoteImage } from '@/components/remote-image';
import { RetryBanner } from '@/components/retry-banner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchInput } from '@/components/ui/search-input';
import { focusedRowRange } from '@/components/window-virtualized-stack';
import { EPISODE_SEARCH_MIN_COUNT, useEpisodeSearch } from '@/hooks/use-episode-search';
import { useDebounce } from '@/hooks/use-debounce';
import { usePlayerKeymap, useSpoilerProtection } from '@/hooks/use-app-ui-preferences';
import type { Episode, MediaDetails, TitleWatchProgress, WatchProgress } from '@/lib/api';
import { ariaKeyShortcuts, withShortcutHint } from '@/lib/player-keybindings';
import { episodeMatchesCoordinates } from '@/lib/episode-stream-target';
import { getWatchProgressPercent } from '@/lib/history-playback';
import { cn, formatAirDate, getEpisodeTitle } from '@/lib/utils';

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
      className={cn(
        CHROME_ICON_BUTTON_CLASS,
        'rounded-md text-zinc-300 duration-150 hover:bg-white/[0.06] hover:text-white active:scale-100 motion-reduce:transition-none',
        open && 'bg-white/[0.08] text-white',
      )}
      title={withShortcutHint('Episodes', keymap, 'episodes')}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <PanelRight className='h-5 w-5' strokeWidth={2} />
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
const EPISODE_ROW_ESTIMATE_PX = 112;
const EPISODE_ROW_GAP_PX = 4;
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
    effectiveEpisodeSearch,
    filteredEpisodes: visibleEpisodes,
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

  const renderEpisode = useCallback(
    (ep: Episode) => {
      const isCurrent = episodeMatchesCoordinates(ep, currentSeason, currentEpisode);
      const airDate = formatAirDate(ep.releaseDate);
      // The Continue target gets Resume, never the already-marked Now playing row.
      const watchEntry = episodeProgressFor?.(ep);
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
          data-current-episode={isCurrent ? '' : undefined}
          aria-current={isCurrent ? 'true' : undefined}
          className={cn(
            'relative flex h-28 w-full cursor-pointer items-center gap-3 rounded-md p-2 text-left outline-hidden transition-colors duration-120 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white/40 motion-reduce:transition-none',
            isCurrent ? 'bg-white/[0.04]' : 'hover:bg-white/[0.025] focus-visible:bg-white/[0.025]',
          )}
          onClick={() => onEpisodeSelect(ep)}
        >
          {isCurrent && (
            <span
              aria-hidden='true'
              className='absolute left-0 top-4 bottom-4 w-0.5 rounded-r-full bg-(--accent-act)'
            />
          )}
          <div className='relative aspect-video w-[clamp(7rem,38%,10rem)] shrink-0 overflow-hidden rounded-md bg-zinc-900 ring-1 ring-white/[0.06]'>
            {/* Placeholder sits under the thumb — hiding the broken image reveals it without sibling-DOM poking. */}
            <div className='absolute inset-0 flex items-center justify-center text-sm font-semibold tracking-wide text-zinc-700'>
              E{ep.episode}
            </div>
            {thumbnail && (
              <RemoteImage
                src={thumbnail}
                loading='lazy'
                className={cn(
                  'relative h-full w-full object-cover',
                  isSpoiler && 'scale-110 blur-md',
                )}
                alt=''
              />
            )}
            {progressPercent > 0 && (
              <div className='absolute inset-x-0 bottom-0 h-0.5 bg-black/40'>
                <div
                  className='h-full w-full origin-left bg-(--accent-act)'
                  style={{ transform: `scaleX(${progressPercent / 100})` }}
                />
              </div>
            )}
          </div>

          <div className='flex h-full min-w-0 flex-1 flex-col py-0.5'>
            <h3
              className='truncate text-sm font-medium leading-5 tracking-tight text-zinc-100'
              title={episodeTitle}
            >
              <span className='tabular-nums text-zinc-500'>{ep.episode}</span>
              <span className='mx-1.5 text-zinc-700'>·</span>
              {episodeTitle}
            </h3>
            <p
              className='mt-1 line-clamp-2 text-[13px] leading-[19px] text-zinc-400'
              title={isSpoiler ? undefined : ep.overview || undefined}
            >
              {isSpoiler
                ? 'Description hidden to prevent spoilers.'
                : ep.overview || 'No description available.'}
            </p>
            <div className='mt-auto flex min-w-0 items-center gap-2 text-[11px] leading-4'>
              {(isCurrent || isResume) && (
                <span className='shrink-0 font-medium text-(--accent-act)'>
                  {isCurrent ? 'Playing' : 'Resume'}
                </span>
              )}
              {airDate && <span className='truncate tabular-nums text-zinc-500'>{airDate}</span>}
            </div>
          </div>
        </button>
      );
    },
    [
      backdrop,
      currentEpisode,
      currentSeason,
      episodeProgressFor,
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
        'absolute right-3 bottom-3 z-60 flex w-[460px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden',
        // Opaque: any translucency lets the native video bleed through and muddies the rows.
        'rounded-lg border border-white/[0.07] bg-zinc-950',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_16px_48px_-16px_rgba(0,0,0,0.7)]',
        'transition-[translate,opacity] duration-160 ease-out starting:translate-x-2 starting:opacity-0 motion-reduce:transition-none',
        // Below the custom titlebar in windowed mode so window controls never overlap the panel header.
        isFullscreen ? 'top-3' : 'top-12',
        open ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-2 opacity-0',
      )}
    >
      <div className='shrink-0 border-b border-white/[0.06]'>
        <div className='flex items-center gap-2.5 px-4 pt-4 pb-3'>
          <h2 className='text-[15px] leading-5 font-semibold tracking-tight text-white'>
            Episodes
          </h2>
          <p className='min-w-0 flex-1 truncate text-xs tabular-nums text-zinc-400'>
            {seasonEpisodes.length} {seasonEpisodes.length === 1 ? 'episode' : 'episodes'}
          </p>
          <button
            type='button'
            onClick={onClose}
            aria-label='Close episodes panel'
            title='Close (Esc)'
            className={cn(
              CHROME_CLOSE_BUTTON_CLASS,
              'rounded-md duration-120 hover:bg-white/[0.05] motion-reduce:transition-none',
            )}
          >
            <X className='w-4 h-4' strokeWidth={2.25} />
          </button>
        </div>

        {(seasons.length > 1 || searchVisible) && (
          <div className='flex items-center gap-2 px-4 pb-3'>
            {seasons.length > 1 && (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button
                    type='button'
                    aria-label={`Season ${selectedSeason}, change season`}
                    className='flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.03] pr-2.5 pl-3 text-xs font-medium text-zinc-200 outline-hidden transition-colors duration-120 hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-white/30 data-[state=open]:bg-white/[0.05] motion-reduce:transition-none'
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    Season {selectedSeason}
                    <ChevronDown className='h-3.5 w-3.5 text-zinc-500' strokeWidth={2} />
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
                          'cursor-pointer gap-2 rounded-md py-2 pr-3 pl-2 text-[13px]',
                          isSelected ? 'font-medium text-white' : 'text-zinc-300',
                        )}
                      >
                        <Check
                          className={cn('h-4 w-4 shrink-0', !isSelected && 'invisible')}
                          strokeWidth={2.25}
                        />
                        <span className='flex-1'>Season {season}</span>
                        <span className='text-xs tabular-nums text-zinc-500'>{count}</span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {searchVisible && (
              <SearchInput
                placeholder='Search episodes…'
                value={episodeSearch}
                onValueChange={setEpisodeSearch}
                clearLabel='Clear episode search'
                wrapperClassName='min-w-0 flex-1'
                className='h-9 rounded-md border-white/[0.06] bg-white/[0.03] text-xs text-white placeholder:text-zinc-500 focus-visible:border-white/20 focus-visible:ring-white/20'
              />
            )}
          </div>
        )}
        {searchError && (
          <RetryBanner
            className='mx-4 mb-3 px-3 py-2'
            message='Search failed.'
            isRetrying={isSearchFetching}
            onRetry={retrySearch}
          />
        )}
      </div>

      <ScrollArea viewportRef={scrollViewportRef} className='min-h-0 flex-1'>
        {visibleEpisodes.length === 0 ? (
          <p className='px-6 py-12 text-center text-xs text-zinc-400'>
            {effectiveEpisodeSearch ? (
              <>
                No episodes match <span className='text-zinc-400'>{effectiveEpisodeSearch}</span>
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
      </ScrollArea>
    </aside>
  );
});
