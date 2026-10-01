import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ListVideo, Play, X } from 'lucide-react';
import { memo, type Ref, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CHROME_CLOSE_BUTTON_CLASS,
  CHROME_ICON_BUTTON_CLASS,
} from '@/components/player-chrome-styles';
import { RemoteImage } from '@/components/remote-image';
import { WatchProgressStrip } from '@/components/watch-progress-strip';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchInput } from '@/components/ui/search-input';
import { useDebounce } from '@/hooks/use-debounce';
import type { Episode, WatchProgress } from '@/lib/api';
import {
  EPISODE_SEARCH_DEBOUNCE_MS,
  EPISODE_SEARCH_MIN_COUNT,
  filterEpisodesBySearchQuery,
} from '@/lib/episode-search';
import { episodeMatchesCoordinates } from '@/lib/episode-stream-target';
import { getWatchProgressPercent } from '@/lib/history-playback';
import { cn, formatAirDate, getEpisodeTitle } from '@/lib/utils';

interface PlayerEpisodesToggleButtonProps {
  open: boolean;
  onToggle: () => void;
}

export function PlayerEpisodesToggleButton({ open, onToggle }: PlayerEpisodesToggleButtonProps) {
  return (
    <button
      type='button'
      aria-label={open ? 'Close episodes panel' : 'Open episodes panel'}
      aria-keyshortcuts='e'
      aria-expanded={open}
      className={cn(CHROME_ICON_BUTTON_CLASS, 'duration-150', open && 'bg-white/15 text-white')}
      title='Episodes (E)'
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <ListVideo className='w-5 h-5' strokeWidth={2.5} />
    </button>
  );
}

interface PlayerEpisodesPanelProps {
  panelRef?: Ref<HTMLElement>;
  open: boolean;
  /** Windowed mode must clear the 32px custom titlebar. */
  isFullscreen: boolean;
  seasons: number[];
  selectedSeason: number;
  onSeasonChange: (season: number) => void;
  episodes: Episode[];
  currentSeason?: number;
  currentEpisode?: number;
  backdrop?: string;
  /** Per-episode watch-row lookup — the same rows details cards render. */
  episodeProgressFor?: (episode: Episode) => WatchProgress | undefined;
  /** The title's Continue target; that row gets the Resume pill. */
  resumeTarget?: { season?: number; episode?: number };
  onEpisodeSelect: (episode: Episode) => void;
  onClose: () => void;
}

// Rows are ~100px (p-3 + 68px thumbnail) plus the 8px space-y-2 gap folded
// into each measured wrapper. Virtualization only matters for single-season
// outliers (long-running daily shows/anime); typical seasons render directly.
const EPISODE_ROW_ESTIMATE_PX = 100;
const EPISODE_ROW_GAP_PX = 8;
const EPISODE_LIST_VIRTUALIZE_THRESHOLD = 40;

// Memoized so playback ticks (time-pos updates) never re-render the
// episode list while the panel sits closed off-screen.
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
  resumeTarget,
  onEpisodeSelect,
  onClose,
}: PlayerEpisodesPanelProps) {
  const seasonEpisodes = useMemo(
    () => episodes.filter((ep) => ep.season === selectedSeason),
    [episodes, selectedSeason],
  );
  // Same filter vocabulary as the details episode grid — number, title,
  // overview — shared via `episode-search` so the surfaces can't drift.
  const [episodeSearch, setEpisodeSearch] = useState('');
  const debouncedEpisodeSearch = useDebounce(episodeSearch.trim(), EPISODE_SEARCH_DEBOUNCE_MS);
  // The field hides under the count threshold — a persisted query must not
  // silently filter rows the user can't see or clear. The text itself is kept
  // so it returns with the field on a searchable season.
  const searchVisible = seasonEpisodes.length > EPISODE_SEARCH_MIN_COUNT;
  const effectiveEpisodeSearch = searchVisible ? debouncedEpisodeSearch : '';
  const visibleEpisodes = useMemo(
    () => filterEpisodesBySearchQuery(seasonEpisodes, effectiveEpisodeSearch),
    [effectiveEpisodeSearch, seasonEpisodes],
  );
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = visibleEpisodes.length >= EPISODE_LIST_VIRTUALIZE_THRESHOLD;
  const episodeVirtualizer = useVirtualizer({
    count: visibleEpisodes.length,
    getScrollElement: () => scrollViewportRef.current,
    estimateSize: () => EPISODE_ROW_ESTIMATE_PX,
    overscan: 6,
    enabled: shouldVirtualize,
  });

  // Opening mid-season lands on context, not episode 1: center the playing
  // row once per open, then leave scroll ownership to the user.
  const didScrollToCurrentRef = useRef(false);
  useEffect(() => {
    if (!open) {
      didScrollToCurrentRef.current = false;
      return;
    }
    if (didScrollToCurrentRef.current) return;
    didScrollToCurrentRef.current = true;

    const index = visibleEpisodes.findIndex((ep) =>
      episodeMatchesCoordinates(ep, currentSeason, currentEpisode),
    );
    if (index < 0) return;

    if (shouldVirtualize) {
      episodeVirtualizer.scrollToIndex(index, { align: 'center' });
      return;
    }

    scrollViewportRef.current
      ?.querySelector<HTMLElement>('[data-current-episode]')
      ?.scrollIntoView({ block: 'center' });
  }, [open, visibleEpisodes, shouldVirtualize, episodeVirtualizer, currentSeason, currentEpisode]);

  // A new filter result starts at the top — clamp both scroll surfaces so a
  // stale offset can't leave a short filtered list scrolled past its end.
  useEffect(() => {
    scrollViewportRef.current?.scrollTo({ top: 0 });
    if (shouldVirtualize) episodeVirtualizer.scrollToOffset(0);
  }, [effectiveEpisodeSearch, selectedSeason, shouldVirtualize, episodeVirtualizer]);

  const renderEpisode = useCallback(
    (ep: Episode) => {
      const isCurrent = episodeMatchesCoordinates(ep, currentSeason, currentEpisode);
      const airDate = formatAirDate(ep.releaseDate ?? ep.released);
      // Same bar/badge vocabulary as the details episode cards — the accent
      // bar lives on the thumbnail's bottom edge, the Resume pill marks the
      // Continue target (never the already-marked Now Playing row).
      const watchEntry = episodeProgressFor?.(ep);
      const progressPercent = watchEntry
        ? getWatchProgressPercent(watchEntry.position, watchEntry.duration)
        : 0;
      const isResume =
        !isCurrent && resumeTarget?.season === ep.season && resumeTarget?.episode === ep.episode;
      const thumbnail = ep.thumbnail || backdrop;

      return (
        <button
          type='button'
          key={`${ep.season}-${ep.episode}`}
          data-current-episode={isCurrent ? '' : undefined}
          aria-current={isCurrent ? 'true' : undefined}
          className={cn(
            'w-full text-left group relative flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors duration-200 outline-hidden focus-visible:ring-2 focus-visible:ring-white/25',
            isCurrent
              ? 'bg-white/[0.07] border-white/[0.12]'
              : 'border-transparent hover:bg-white/[0.04]',
          )}
          onClick={() => onEpisodeSelect(ep)}
        >
          <div className='relative w-28 h-[68px] bg-zinc-900 rounded-md overflow-hidden shrink-0'>
            {/* Placeholder sits under the thumb — hiding the broken image
                reveals it without sibling-DOM poking. */}
            <div className='absolute inset-0 flex items-center justify-center text-white/10 font-bold text-base tracking-wide bg-zinc-800/50'>
              EP {ep.episode}
            </div>
            {thumbnail && (
              <RemoteImage
                src={thumbnail}
                loading='lazy'
                className={cn(
                  'relative w-full h-full object-cover transition-opacity duration-300',
                  isCurrent ? 'opacity-100' : 'opacity-55 group-hover:opacity-80',
                )}
                alt=''
              />
            )}
            {isResume && (
              <span className='absolute left-1 top-1 flex h-4 items-center rounded-md bg-white px-1 text-[9px] font-bold uppercase leading-none tracking-[0.08em] text-black'>
                Resume
              </span>
            )}
            <div className='absolute bottom-1 right-1 flex h-4 items-center rounded bg-black/60 px-1 text-[10px] font-semibold leading-none tabular-nums text-white/70 backdrop-blur-xs'>
              {ep.episode}
            </div>
            <WatchProgressStrip percent={progressPercent} />
          </div>

          <div className='flex flex-col min-w-0 flex-1'>
            <h3
              className={cn(
                'text-sm font-medium truncate transition-colors mb-0.5',
                isCurrent ? 'text-white' : 'text-zinc-300 group-hover:text-white',
              )}
            >
              {getEpisodeTitle(ep.title, ep.episode)}
            </h3>
            {(isCurrent || airDate) && (
              <div className='flex items-center gap-1.5 mb-1'>
                {isCurrent && (
                  <span className='flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-white/70'>
                    <Play className='h-2.5 w-2.5 fill-white' />
                    Now playing
                  </span>
                )}
                {/* Air date — same muted meta vocabulary as the details cards. */}
                {airDate && (
                  <span className='text-[10px] tabular-nums text-zinc-500'>{airDate}</span>
                )}
              </div>
            )}
            <p
              className='text-[11px] text-zinc-400 line-clamp-2 leading-relaxed'
              title={ep.overview || undefined}
            >
              {ep.overview || 'No description available.'}
            </p>
          </div>
        </button>
      );
    },
    [backdrop, currentEpisode, currentSeason, episodeProgressFor, onEpisodeSelect, resumeTarget],
  );

  return (
    <aside
      ref={panelRef}
      data-player-interactive
      // Off-screen but mounted for the slide transition: keep it out of the
      // tab order and a11y tree while closed.
      inert={!open}
      aria-hidden={!open}
      aria-label='Episodes'
      className={cn(
        'absolute right-3 bottom-3 w-[380px] max-w-[calc(100vw-1.5rem)] z-60 flex flex-col overflow-hidden',
        'rounded-2xl border border-white/[0.08] bg-zinc-950/95 backdrop-blur-2xl',
        'shadow-2xl shadow-black/70',
        'transition-[translate,opacity] duration-380 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        // Below the custom titlebar in windowed mode so the window controls
        // never overlap the panel header.
        isFullscreen ? 'top-3' : 'top-12',
        open ? 'translate-x-0 opacity-100' : 'translate-x-[calc(100%+24px)] opacity-0',
      )}
    >
      <div className='flex items-center justify-between gap-3 px-4 pb-3 pt-4 border-b border-white/[0.07] shrink-0'>
        <div className='flex flex-col gap-1.5 min-w-0'>
          <h2 className='font-semibold text-[15px] text-white tracking-tight leading-none'>
            Episodes
          </h2>

          {seasons.length > 1 ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant='outline'
                  size='sm'
                  className='h-7 text-[11px] font-medium border-white/10 bg-white/[0.04] hover:bg-white/10 text-zinc-300 transition-colors'
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  Season {selectedSeason} <ChevronDown className='w-3 h-3 ml-1.5 opacity-60' />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align='start'
                side='bottom'
                className='z-80 max-h-[300px] overflow-y-auto bg-zinc-950/95 border-white/10'
                onClick={(e) => e.stopPropagation()}
              >
                {seasons.map((seasonNumber) => (
                  <DropdownMenuItem
                    key={seasonNumber}
                    onSelect={() => onSeasonChange(seasonNumber)}
                    className={cn(
                      'cursor-pointer py-2 px-3 text-sm transition-colors',
                      selectedSeason === seasonNumber
                        ? 'bg-white/10 text-white font-medium'
                        : 'hover:bg-white/10',
                    )}
                  >
                    Season {seasonNumber}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <p className='text-xs text-zinc-500 font-medium'>Season {selectedSeason}</p>
          )}
        </div>
        <button
          type='button'
          onClick={onClose}
          aria-label='Close episodes panel'
          title='Close (E)'
          className={CHROME_CLOSE_BUTTON_CLASS}
        >
          <X className='w-4 h-4' strokeWidth={2.25} />
        </button>
      </div>

      {searchVisible && (
        <div className='px-4 pb-3 pt-3 border-b border-white/[0.07] shrink-0'>
          <SearchInput
            placeholder='Search episodes…'
            value={episodeSearch}
            onValueChange={setEpisodeSearch}
            clearLabel='Clear episode search'
            className='h-9 bg-white/[0.04] border-white/10 text-sm text-white placeholder:text-zinc-600 focus-visible:ring-white/20 focus-visible:border-white/20 rounded-lg'
          />
        </div>
      )}

      <ScrollArea
        viewportRef={scrollViewportRef}
        className='flex-1 [&>[data-radix-scroll-area-viewport]>div]:block!'
      >
        {visibleEpisodes.length === 0 ? (
          <p className='px-6 py-10 text-center text-xs text-zinc-500'>
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
            style={{ height: `${episodeVirtualizer.getTotalSize() + 24}px` }}
          >
            {episodeVirtualizer.getVirtualItems().map((virtualRow) => {
              const ep = visibleEpisodes[virtualRow.index];
              if (!ep) return null;
              return (
                <div
                  key={`${ep.season}-${ep.episode}`}
                  data-index={virtualRow.index}
                  ref={episodeVirtualizer.measureElement}
                  className='absolute left-3 right-3 top-3'
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
          <div className='p-3 space-y-2'>{visibleEpisodes.map((ep) => renderEpisode(ep))}</div>
        )}
      </ScrollArea>
    </aside>
  );
});
