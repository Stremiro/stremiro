import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileVideo,
  Loader2,
  Magnet,
  RotateCcw,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from 'lucide-react';
import { type Range, useVirtualizer } from '@tanstack/react-virtual';
import {
  Fragment,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { RemoteImage } from '@/components/remote-image';
import { isEpisodeSpoiler } from '@/components/details-episode-card';
import { CHROME_CLOSE_BUTTON_CLASS, CHROME_ICON_STROKE } from '@/components/player-chrome-styles';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SearchInput } from '@/components/ui/search-input';
import { WatchProgressStrip } from '@/components/watch-progress-strip';
import { focusedRowRange } from '@/components/window-virtualized-stack';
import { useFailedSrc } from '@/hooks/use-failed-src';
import { useSpoilerProtection } from '@/hooks/use-app-ui-preferences';
import {
  type AddonStream,
  type AddonStreamResolution,
  type Episode,
  type StreamSelectorBatch,
  type StreamSelectorPreferences,
  type StreamSelectorQuality,
  type StreamSelectorSort,
  type StreamSelectorSource,
  type StreamSelectorStats,
  type StreamSourceSummary,
  type WatchProgress,
  type TitleWatchProgress,
} from '@/lib/api';
import { whenRowMounted } from '@/lib/dom';
import { episodeMatchesCoordinates } from '@/lib/episode-stream-target';
import { getWatchProgressPercent, MIN_RESUME_POSITION_SECS } from '@/lib/history-playback';
import { RESOLUTION_LABELS } from '@/lib/stream-selector-utils';
import { formatAirDate } from '@/lib/schedule-dates';
import { cn, formatSeasonEpisode, formatTime, getEpisodeTitle, isHttpUrl } from '@/lib/utils';

const SELECTOR_SEGMENT_BASE_CLASS =
  'h-7 px-2.5 rounded-md text-[11px] font-semibold transition-colors duration-150 leading-none whitespace-nowrap focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30';
const SELECTOR_SEGMENT_INACTIVE_CLASS = 'text-zinc-400 hover:text-zinc-200';

// Filters use the app accent; only Quality keeps its own hue, echoing the violet 4K badge it sorts by.
const SORT_MODE_ACTIVE_CLASS: Record<StreamSelectorSort, string> = {
  smart: 'accent-active shadow-xs',
  quality: 'bg-violet-500/25 text-violet-300 shadow-xs',
  seeds: 'accent-active shadow-xs',
};
const SORT_MODE_ICON_TINT: Record<StreamSelectorSort, string> = {
  smart: 'text-[var(--accent-nav)]',
  quality: 'text-violet-300/80',
  seeds: 'text-[var(--accent-nav)]',
};
const SORT_MODE_LABELS: Record<StreamSelectorSort, string> = {
  smart: 'Smart',
  quality: 'Quality',
  seeds: 'Seeds',
};
const SORT_MODES = Object.keys(SORT_MODE_LABELS) as StreamSelectorSort[];
const QUALITY_OPTIONS: ReadonlyArray<[StreamSelectorQuality, string]> = [
  ['all', 'All'],
  ...(Object.entries(RESOLUTION_LABELS) as [AddonStreamResolution, string][]),
];

interface SegmentOption<T extends string> {
  value: T;
  label: string;
  count?: number;
  /** Defaults to the app-accent filter treatment. */
  activeClass?: string;
}

function SegmentGroup<T extends string>({
  label,
  leading,
  onChange,
  options,
  isResolving,
  value,
}: {
  label: string;
  leading?: ReactNode;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  isResolving: boolean;
  value: T;
}) {
  return (
    <div
      role='group'
      aria-label={label}
      className='flex shrink-0 items-center gap-px bg-black/50 rounded-lg p-0.5'
    >
      {leading}
      {options.map((option) => (
        <button
          key={option.value}
          type='button'
          aria-pressed={value === option.value}
          aria-disabled={isResolving || undefined}
          onClick={() => {
            if (isResolving) return;
            onChange(option.value);
          }}
          className={cn(
            SELECTOR_SEGMENT_BASE_CLASS,
            value === option.value
              ? (option.activeClass ?? 'accent-active shadow-xs')
              : SELECTOR_SEGMENT_INACTIVE_CLASS,
          )}
        >
          {option.label}
          {option.count !== undefined && (
            <span className='ml-1 opacity-60 font-normal text-[9px] tabular-nums'>
              {option.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function SegmentDivider() {
  return <div className='w-px h-4 bg-white/[0.12] shrink-0' />;
}

interface StreamSelectorHeaderProps {
  backdrop?: string;
  compactOverview: string;
  /** Canonical display coordinates — the kicker's S/E label. */
  episode?: number;
  episodeTitle?: string;
  logo?: string;
  /** `mediaTypeLabel` of the target — the movie kicker fallback. */
  mediaLabel: string;
  onRequestClose: () => void;
  poster?: string;
  season?: number;
  startTime?: number;
  title: string;
}

const HEADER_KICKER_CLASS =
  'text-[10px] font-semibold uppercase tracking-[0.22em] leading-none text-white/40';

export function StreamSelectorHeader({
  backdrop,
  compactOverview,
  episode,
  episodeTitle,
  logo,
  mediaLabel,
  onRequestClose,
  poster,
  season,
  startTime,
  title,
}: StreamSelectorHeaderProps) {
  const [logoSrc, onLogoError] = useFailedSrc(isHttpUrl(logo) ? logo : null);
  const kicker = formatSeasonEpisode(season, episode) || mediaLabel;
  const playbackLabel =
    startTime !== undefined && Number.isFinite(startTime) && startTime >= 0
      ? startTime < MIN_RESUME_POSITION_SECS
        ? 'Start from the beginning'
        : `Resume from ${formatTime(startTime)}`
      : 'Choose a stream to play';
  return (
    <div className='relative h-56 shrink-0 overflow-hidden [@media(max-height:800px)]:h-36'>
      {backdrop ? (
        <div className='absolute inset-0 z-0'>
          <RemoteImage
            src={backdrop}
            loading='lazy'
            className='w-full h-full object-cover opacity-30'
            alt=''
          />
          <div className='absolute inset-0 bg-linear-to-t from-zinc-950 via-zinc-950/70 to-transparent' />
          <div className='absolute inset-0 bg-linear-to-r from-zinc-950/80 via-transparent to-transparent' />
        </div>
      ) : (
        <div className='absolute inset-0 bg-zinc-900/60 z-0' />
      )}

      <button
        type='button'
        onClick={onRequestClose}
        aria-label='Close stream selector'
        aria-keyshortcuts='Escape'
        title='Close (Esc)'
        className={cn('absolute right-4 top-4 z-20', CHROME_CLOSE_BUTTON_CLASS)}
      >
        <X aria-hidden='true' className='h-4 w-4' strokeWidth={CHROME_ICON_STROKE} />
      </button>

      <DialogHeader className='relative z-10 p-6 h-full flex flex-col justify-end text-left [@media(max-height:800px)]:p-4'>
        <div className='flex items-end gap-4'>
          {poster && (
            <RemoteImage
              src={poster}
              loading='lazy'
              className='w-20 h-[120px] rounded-md shadow-2xl border border-white/10 object-cover hidden sm:block mb-0.5 shrink-0 [@media(max-height:800px)]:h-24 [@media(max-height:800px)]:w-16'
              alt=''
            />
          )}
          <div className='flex min-w-0 flex-1 flex-col gap-1.5 pr-8'>
            <p className={HEADER_KICKER_CLASS}>{kicker}</p>
            <div className='min-w-0'>
              {logoSrc ? (
                <>
                  <RemoteImage
                    src={logoSrc}
                    className='max-h-12 w-auto max-w-full object-contain object-left drop-shadow-[0_6px_24px_rgba(0,0,0,0.65)] sm:max-w-72 [@media(max-height:800px)]:max-h-10'
                    alt=''
                    onError={onLogoError}
                  />
                  <DialogTitle className='sr-only'>{title}</DialogTitle>
                </>
              ) : (
                <DialogTitle className='line-clamp-2 text-[26px] font-bold leading-[1.08] tracking-[-0.02em] text-white [@media(max-height:800px)]:line-clamp-1 [@media(max-height:800px)]:text-[22px]'>
                  {title}
                </DialogTitle>
              )}
            </div>
            {episodeTitle && (
              <p className='truncate text-[15px] font-medium leading-snug text-white/75'>
                {episodeTitle}
              </p>
            )}
            <DialogDescription className='text-xs font-medium leading-snug text-zinc-300'>
              <span className='sr-only'>Choose a stream source. {kicker}. </span>
              {playbackLabel}
            </DialogDescription>
            {compactOverview && (
              <p className='line-clamp-2 max-w-2xl text-xs leading-relaxed text-zinc-400 hidden sm:block [@media(max-height:800px)]:hidden'>
                {compactOverview}
              </p>
            )}
          </div>
        </div>
      </DialogHeader>
    </div>
  );
}

// Matches StreamItem's silhouette so the swap to real rows is a fill-in, not a layout jump.
function StreamRowSkeleton() {
  return (
    <div className='flex items-center gap-3 rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-2.5'>
      <div className='h-9 w-9 shrink-0 animate-pulse rounded-[10px] bg-white/[0.05]' />
      <div className='min-w-0 flex-1 space-y-1.5'>
        <div className='flex items-center gap-1.5'>
          <div className='h-3 w-28 animate-pulse rounded bg-white/[0.06]' />
          <div className='h-[18px] w-9 animate-pulse rounded-md bg-white/[0.05]' />
          <div className='h-[18px] w-12 animate-pulse rounded-md bg-white/[0.05]' />
        </div>
        <div className='h-2.5 w-2/3 animate-pulse rounded bg-white/[0.04]' />
        <div className='h-2 w-1/3 animate-pulse rounded bg-white/[0.03]' />
      </div>
    </div>
  );
}

export function StreamResultsStatus({
  resultCount,
  pendingSourceCount,
  searching,
}: {
  resultCount: number;
  pendingSourceCount: number;
  searching: boolean;
}) {
  const summary = `${resultCount} stream${resultCount === 1 ? '' : 's'} found. ${
    searching
      ? pendingSourceCount > 0
        ? `${pendingSourceCount} source${pendingSourceCount === 1 ? '' : 's'} still searching.`
        : 'Searching sources.'
      : 'Source search complete.'
  }`;
  const [announcement, setAnnouncement] = useState('');
  const lastAnnouncementAtRef = useRef(0);
  useEffect(() => {
    if (summary === announcement) return;
    const timer = setTimeout(
      () => {
        lastAnnouncementAtRef.current = Date.now();
        setAnnouncement(summary);
      },
      Math.max(0, 1000 - (Date.now() - lastAnnouncementAtRef.current)),
    );
    return () => clearTimeout(timer);
  }, [announcement, summary]);

  return (
    <p role='status' aria-live='polite' aria-atomic='true' className='sr-only'>
      {announcement}
    </p>
  );
}

export function StreamListLoadingState({
  sourceCount,
  chips,
}: {
  sourceCount: number;
  /** Per-source health chips once the roster lands — real progress beats anonymous skeletons. */
  chips?: ReactNode;
}) {
  return (
    <div className='flex h-full min-h-0 flex-col px-3 pt-3'>
      {chips}
      <div className='mb-3 flex items-center gap-2 px-1 py-1'>
        <Loader2 className='h-3.5 w-3.5 animate-spin text-white/45' />
        <p className='text-[12px] font-medium text-zinc-400'>
          {sourceCount > 0
            ? `Searching ${sourceCount} source${sourceCount === 1 ? '' : 's'}…`
            : 'Preparing sources…'}
        </p>
      </div>
      <div aria-hidden='true' className='min-h-0 flex-1 space-y-1.5 overflow-hidden'>
        {Array.from({ length: 6 }, (_, i) => (
          <StreamRowSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export function StreamListErrorState({
  chips,
  isRetrying = false,
  message,
  onRetry,
}: {
  /** Per-source health chips — the roster often shows *which* addon failed. */
  chips?: ReactNode;
  isRetrying?: boolean;
  message: string;
  onRetry: () => void;
}) {
  return (
    <StreamListMessage
      chips={chips}
      role='alert'
      icon={<TriangleAlert className='w-10 h-10 text-amber-400/60' strokeWidth={1.5} />}
      title="Couldn't load streams."
      body={message}
      action={
        <Button
          variant='outline'
          size='sm'
          onClick={() => {
            if (!isRetrying) onRetry();
          }}
          aria-disabled={isRetrying || undefined}
          aria-busy={isRetrying}
          className='aria-disabled:cursor-wait aria-disabled:opacity-50'
        >
          <RotateCcw
            className={cn('h-3.5 w-3.5', isRetrying && 'animate-spin motion-reduce:animate-none')}
          />
          Retry
        </Button>
      }
    />
  );
}

const STREAM_LIST_MESSAGE_ICON = <FileVideo className='w-10 h-10 opacity-15' />;

function StreamListMessage({
  action,
  body,
  chips,
  icon = STREAM_LIST_MESSAGE_ICON,
  role,
  title,
}: {
  action?: ReactNode;
  body: string;
  /** Health chips ride the message states so per-source failures stay visible on error/empty outcomes. */
  chips?: ReactNode;
  icon?: ReactNode;
  role?: 'alert' | 'status';
  title: string;
}) {
  return (
    <div className='flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain px-3 py-3'>
      {chips}
      <div
        role={role}
        className='flex flex-1 shrink-0 flex-col items-center justify-center gap-2 text-muted-foreground text-center'
      >
        {icon}
        <p className='text-sm'>{title}</p>
        <p className='text-xs text-zinc-400 leading-relaxed max-w-sm break-words'>{body}</p>
        {action}
      </div>
    </div>
  );
}

export function StreamListOfflineState() {
  return <StreamListMessage title="You're offline." body='Reconnect to load stream sources.' />;
}

export function StreamListNoAddonsState({ onManageAddons }: { onManageAddons: () => void }) {
  return (
    <StreamListMessage
      title='No enabled stream sources.'
      body='Enable at least one addon in Settings → Addons, then try again.'
      action={
        <Button variant='outline' size='sm' onClick={onManageAddons}>
          Manage addons
        </Button>
      }
    />
  );
}

export function StreamListNoStreamAddonsState({ onManageAddons }: { onManageAddons: () => void }) {
  return (
    <StreamListMessage
      title='No stream-capable addons enabled.'
      body='Your enabled addons provide metadata only. Add a stream addon in Settings → Addons to get playable sources.'
      action={
        <Button variant='outline' size='sm' onClick={onManageAddons}>
          Manage addons
        </Button>
      }
    />
  );
}

export function StreamListEmptyState({
  chips,
  isRetrying = false,
  sourceCount,
  onRetry,
  onManageAddons,
}: {
  /** Per-source health chips — a zero-result roster explains the empty list. */
  chips?: ReactNode;
  isRetrying?: boolean;
  sourceCount: number;
  onRetry: () => void;
  onManageAddons: () => void;
}) {
  return (
    <StreamListMessage
      chips={chips}
      title='No streams found.'
      body={
        sourceCount > 0
          ? 'Your stream sources returned nothing for this title. Try again shortly or add another stream addon.'
          : 'Add a stream addon in Settings → Addons to get playable sources.'
      }
      action={
        <div className='flex flex-wrap items-center justify-center gap-2'>
          {sourceCount > 0 && (
            <Button
              variant='outline'
              size='sm'
              onClick={() => {
                if (!isRetrying) onRetry();
              }}
              aria-disabled={isRetrying || undefined}
              aria-busy={isRetrying}
              className='aria-disabled:cursor-wait aria-disabled:opacity-50'
            >
              <RotateCcw
                className={cn(
                  'h-3.5 w-3.5',
                  isRetrying && 'animate-spin motion-reduce:animate-none',
                )}
              />
              Retry
            </Button>
          )}
          <Button variant='outline' size='sm' onClick={onManageAddons}>
            Manage addons
          </Button>
        </div>
      }
    />
  );
}

export function StreamListFilteredEmptyState({
  isSearchPending = false,
  isResolving,
  onClearFilters,
  searchQuery = '',
}: {
  isSearchPending?: boolean;
  isResolving: boolean;
  onClearFilters: () => void;
  searchQuery?: string;
}) {
  return (
    <StreamListMessage
      icon={<FileVideo className='w-8 h-8 opacity-15' />}
      title={
        isSearchPending
          ? 'Searching streams…'
          : searchQuery.trim()
            ? 'No matching streams'
            : 'No streams match these filters'
      }
      body={
        isSearchPending
          ? 'Updating results for your search.'
          : searchQuery.trim()
            ? `No releases match “${searchQuery.trim()}” with the current filters.`
            : 'Try another filter or show all streams.'
      }
      action={
        !isSearchPending && (
          <Button
            variant='outline'
            size='sm'
            aria-disabled={isResolving || undefined}
            onClick={() => {
              if (isResolving) return;
              onClearFilters();
            }}
          >
            Show all streams
          </Button>
        )
      }
    />
  );
}

interface StreamAddonHealthChipsProps {
  effectiveAddonFilter: string;
  hasStreams?: boolean;
  healthSummary: { degraded: number; offline: number; pending: number };
  isRetrying?: boolean;
  isResolving: boolean;
  metrics: StreamSourceSummary[];
  onFiltersChange: Dispatch<SetStateAction<StreamSelectorPreferences>>;
  onRetry?: () => void;
  sourcesStillLoading: boolean;
}

export function StreamAddonHealthChips({
  effectiveAddonFilter,
  hasStreams: hasAnyStreams = false,
  healthSummary,
  isRetrying = false,
  isResolving,
  metrics,
  onFiltersChange,
  onRetry,
  sourcesStillLoading,
}: StreamAddonHealthChipsProps) {
  return (
    // The roster lands mid-fetch — fading in keeps the chip row from popping under the spinner.
    <div className='shrink-0 bg-white/[0.025] border border-white/[0.07] rounded-lg px-3 py-2 mb-3 animate-in fade-in duration-300'>
      <div className='flex max-h-[4.25rem] items-center gap-2 flex-wrap overflow-y-auto overscroll-contain'>
        {metrics.map((metric) => {
          // Chips filter on the addon config id (stamped on each stream as `sourceId`) — a differing display
          // name can't select a source into a false empty list.
          const isSelected = effectiveAddonFilter === metric.id;
          const isPending = sourcesStillLoading && metric.status === 'pending';
          const hasStreams = metric.streamCount > 0;
          const sourceStatus = isPending
            ? 'Searching…'
            : metric.status === 'no_results'
              ? 'No results for this title'
              : metric.status === 'degraded'
                ? 'Slow response'
                : metric.status === 'offline'
                  ? 'Unavailable'
                  : `${metric.streamCount} streams`;
          const latency =
            typeof metric.latencyMs === 'number'
              ? metric.latencyMs < 1000
                ? `${metric.latencyMs}ms`
                : `${(metric.latencyMs / 1000).toFixed(1)}s`
              : null;

          return (
            <button
              key={metric.id}
              type='button'
              // Truncated chips hide the name — keep the full name (and any fetch error) reachable on hover.
              title={`${metric.name} — ${metric.errorMessage ?? sourceStatus}${latency ? ` · ${latency}` : ''}`}
              // A selected chip whose count drops to 0 must stay clickable — `disabled` would drop focus to <body> mid-fetch.
              aria-disabled={isResolving || (!hasStreams && !isSelected) || undefined}
              aria-pressed={isSelected}
              aria-label={`${metric.name}: ${sourceStatus}${metric.errorMessage ? `, ${metric.errorMessage}` : ''}`}
              onClick={() => {
                if (isResolving || (!hasStreams && !isSelected)) return;
                onFiltersChange((prev) => ({
                  ...prev,
                  addon: isSelected ? 'all' : metric.id,
                }));
              }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] font-semibold transition-all border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30',
                isSelected
                  ? 'accent-lattice-soft'
                  : hasStreams
                    ? 'bg-black/40 text-zinc-300 border-white/10 hover:border-white/20 hover:text-white'
                    : 'bg-black/40 text-zinc-400 border-white/[0.06] cursor-default',
              )}
            >
              {isPending && <Loader2 className='h-2.5 w-2.5 shrink-0 animate-spin text-zinc-500' />}
              {/* State lives on the name tint, not a dot — degraded/offline read as muted warnings. */}
              <span
                className={cn(
                  'truncate max-w-[90px]',
                  !isSelected &&
                    (metric.status === 'offline'
                      ? 'text-red-300/80'
                      : metric.status === 'degraded'
                        ? 'text-amber-200/80'
                        : undefined),
                )}
              >
                {metric.name}
              </span>
              {!isPending && (
                <span className='text-zinc-400 tabular-nums'>
                  {metric.status === 'no_results' ? 'No results' : metric.streamCount}
                </span>
              )}
              {latency && <span className='text-zinc-500 tabular-nums'>· {latency}</span>}
            </button>
          );
        })}

        {hasAnyStreams && (healthSummary.offline > 0 || isRetrying) && onRetry && (
          <Button
            variant='ghost'
            size='sm'
            onClick={() => {
              if (isResolving || isRetrying || sourcesStillLoading) return;
              onRetry();
            }}
            aria-disabled={isResolving || isRetrying || sourcesStillLoading || undefined}
            aria-busy={isRetrying}
            className='h-7 gap-1.5 px-2 text-[10px] text-zinc-300 hover:bg-white/[0.06] hover:text-white aria-disabled:cursor-wait aria-disabled:opacity-50'
          >
            <RotateCcw
              className={cn('h-3 w-3', isRetrying && 'animate-spin motion-reduce:animate-none')}
            />
            Retry failed sources
          </Button>
        )}

        <span className='ml-auto flex items-center gap-1.5 text-[10px] font-medium text-zinc-400 whitespace-nowrap tabular-nums'>
          {healthSummary.pending > 0 && sourcesStillLoading && (
            <span className='flex items-center gap-1'>
              <Loader2 className='h-2.5 w-2.5 animate-spin text-zinc-500' />
              {healthSummary.pending} searching
            </span>
          )}
          <span>
            {metrics.length} {metrics.length === 1 ? 'source' : 'sources'}
          </span>
          {healthSummary.degraded > 0 && (
            <span className='text-amber-200/70'>· {healthSummary.degraded} slow</span>
          )}
          {healthSummary.offline > 0 && (
            <span className='text-red-300/70'>· {healthSummary.offline} unavailable</span>
          )}
        </span>
      </div>
    </div>
  );
}

interface StreamFilterToolbarProps {
  batchFilter: StreamSelectorBatch;
  filteredCount: number;
  hasActiveFilter: boolean;
  isResolving: boolean;
  onFiltersChange: Dispatch<SetStateAction<StreamSelectorPreferences>>;
  onResetFilters: () => void;
  onSearchQueryChange: (value: string) => void;
  qualityFilter: StreamSelectorQuality;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  showBatchFilter: boolean;
  sortMode: StreamSelectorSort;
  sourceFilter: StreamSelectorSource;
  stats: StreamSelectorStats;
  totalCount: number;
}

export function StreamFilterToolbar({
  batchFilter,
  filteredCount,
  hasActiveFilter,
  isResolving,
  onFiltersChange,
  onResetFilters,
  onSearchQueryChange,
  qualityFilter,
  searchInputRef,
  searchQuery,
  showBatchFilter,
  sortMode,
  sourceFilter,
  stats,
  totalCount,
}: StreamFilterToolbarProps) {
  return (
    <div
      role='group'
      aria-label='Stream filters'
      aria-disabled={isResolving || undefined}
      className='shrink-0 bg-white/[0.025] border border-white/[0.07] rounded-lg px-3 py-2 mb-3'
    >
      <div className='mb-2 flex items-center gap-2'>
        <SearchInput
          inputRef={searchInputRef}
          value={searchQuery}
          onValueChange={(value) => {
            if (isResolving) return;
            onSearchQueryChange(value);
          }}
          aria-label='Search streams by release, codec or keyword'
          placeholder='Find a release, codec or keyword…'
          className='h-8 text-xs bg-black/20 border-white/[0.07]'
          wrapperClassName='min-w-0 flex-1'
        />
        <span className='shrink-0 text-[10px] font-semibold text-zinc-400 tabular-nums whitespace-nowrap'>
          {filteredCount === totalCount
            ? `${totalCount} streams`
            : `${filteredCount} / ${totalCount}`}
          {stats.p2pCount > 0 && (
            <span className='hidden sm:inline'>{` · ${stats.playableCount} playable`}</span>
          )}
        </span>
        <button
          type='button'
          aria-disabled={isResolving || !hasActiveFilter || undefined}
          onClick={() => {
            if (isResolving || !hasActiveFilter) return;
            onResetFilters();
          }}
          className={cn(
            'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40',
            hasActiveFilter
              ? 'accent-lattice-soft hover:bg-[rgb(var(--accent-act-rgb)/0.14)]'
              : 'pointer-events-none border-white/[0.07] text-zinc-500',
          )}
        >
          <RotateCcw className='h-3.5 w-3.5' strokeWidth={2.25} />
          Reset
        </button>
      </div>
      <div className='flex items-center gap-2'>
        <div className='-my-1 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-1 scrollbar-hide [mask-image:linear-gradient(to_right,black_calc(100%_-_20px),transparent)]'>
          <SegmentGroup
            label='Quality filter'
            isResolving={isResolving}
            value={qualityFilter}
            onChange={(quality) => onFiltersChange((f) => ({ ...f, quality }))}
            options={QUALITY_OPTIONS.flatMap<SegmentOption<StreamSelectorQuality>>(
              ([value, label]) => {
                if (value === 'all') return [{ value, label }];
                const count = stats.resCounts[value];
                // The active option stays visible at 0 — hiding it would leave an invisible filter emptying the list.
                return count > 0 || qualityFilter === value ? [{ value, label, count }] : [];
              },
            )}
          />

          {(stats.cachedCount > 0 || sourceFilter === 'cached') && (
            <>
              <SegmentDivider />
              <SegmentGroup
                label='Source filter'
                isResolving={isResolving}
                value={sourceFilter}
                onChange={(source) => onFiltersChange((f) => ({ ...f, source }))}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'cached', label: `Cached ${stats.cachedCount}` },
                ]}
              />
            </>
          )}

          {showBatchFilter &&
            (stats.batchCount > 0 || stats.episodeLikeCount > 0 || batchFilter !== 'all') && (
              <>
                <SegmentDivider />
                <SegmentGroup
                  label='Episode or season-pack filter'
                  isResolving={isResolving}
                  value={batchFilter}
                  onChange={(batch) => onFiltersChange((f) => ({ ...f, batch }))}
                  options={(
                    [
                      { value: 'episodes', label: 'Episodes', count: stats.episodeLikeCount },
                      { value: 'packs', label: 'Packs', count: stats.batchCount },
                      { value: 'all', label: 'All' },
                    ] satisfies SegmentOption<StreamSelectorBatch>[]
                  ).filter((option) => option.count !== 0 || option.value === batchFilter)}
                />
              </>
            )}

          <SegmentDivider />

          <SegmentGroup
            label='Sort order'
            isResolving={isResolving}
            value={sortMode}
            onChange={(sort) => onFiltersChange((f) => ({ ...f, sort }))}
            leading={
              <SlidersHorizontal
                className={cn(
                  'w-3 h-3 ml-1.5 mr-0.5 shrink-0 transition-colors',
                  SORT_MODE_ICON_TINT[sortMode],
                )}
              />
            }
            options={SORT_MODES.map((value) => ({
              value,
              label: SORT_MODE_LABELS[value],
              activeClass: SORT_MODE_ACTIVE_CLASS[value],
            }))}
          />
        </div>
      </div>
    </div>
  );
}

export function StreamP2pNotice({ p2pCount }: { p2pCount: number }) {
  return (
    <div className='mb-3 flex items-start gap-2 rounded-lg border border-amber-400/15 bg-amber-400/[0.06] px-3 py-2'>
      <Magnet className='mt-px h-3.5 w-3.5 shrink-0 text-amber-300/70' />
      <p className='text-[11px] leading-snug text-amber-200/80'>
        {p2pCount} P2P source{p2pCount === 1 ? '' : 's'} found, but none are playable in this build
        — it plays cached and direct links only. Try another addon.
      </p>
    </div>
  );
}

interface StreamResolveFeedbackToastProps {
  feedback: { title: string; subtitle: string };
  onCancel: () => void;
  /** Title poster — brands the wait the same way the action pill does. */
  poster?: string;
}

export function StreamResolveFeedbackToast({
  feedback,
  onCancel,
  poster,
}: StreamResolveFeedbackToastProps) {
  return (
    <div className='pointer-events-none absolute inset-x-3 bottom-3 z-30 flex justify-center'>
      <div
        role='status'
        className='animate-in fade-in slide-in-from-bottom-2 duration-200 relative w-full max-w-xs overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-950/85 shadow-lg shadow-black/40 backdrop-blur-xl'
      >
        <div className='flex items-center gap-2.5 py-2 pl-2 pr-1.5'>
          {poster ? (
            <RemoteImage
              src={poster}
              className='h-9 w-6 shrink-0 rounded-[5px] object-cover'
              alt=''
            />
          ) : (
            <Loader2 className='ml-1 h-3.5 w-3.5 shrink-0 animate-spin text-white/45' />
          )}

          <div className='min-w-0 flex-1'>
            <p className='truncate text-[13px] font-medium leading-tight text-white/90'>
              Opening stream
            </p>
            <p className='mt-0.5 truncate text-[11.5px] leading-tight text-white/45'>
              {[feedback.title, feedback.subtitle].filter(Boolean).join(' · ')}
            </p>
          </div>

          <button
            type='button'
            onClick={onCancel}
            title='Cancel opening stream (Esc)'
            aria-keyshortcuts='Escape'
            className='pointer-events-auto h-7 shrink-0 rounded-md px-2.5 text-[12px] font-medium text-white/55 transition-colors duration-150 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40'
          >
            Cancel
          </button>
        </div>

        <div className='absolute inset-x-0 bottom-0 h-px overflow-hidden bg-white/[0.06]'>
          <div className='h-full w-1/3 bg-white/50 motion-safe:animate-[progress-slide_1.6s_linear_infinite]' />
        </div>
      </div>
    </div>
  );
}

interface StreamPackEpisodeListProps {
  /** Thumb fallback when an episode carries no still of its own. */
  backdrop?: string;
  disabled: boolean;
  /** Episodes the pack plausibly covers — arrive (season, episode)-sorted. */
  episodes: Episode[];
  onBack: () => void;
  onPick: (episode: Episode) => void;
  progressFor: (episode: Episode) => WatchProgress | undefined;
  watchedEpisodeCeiling?: TitleWatchProgress['watchedEpisodeCeiling'];
  stream: AddonStream;
  /** Canonical coordinates of the selector's target — the "Current" marker. */
  targetEpisode?: number;
  targetSeason?: number;
}

// Flattened header|episode row model — the virtualizer keeps long packs cheap with season headers in the same scroll.
type PackListRow = { type: 'header'; season: number } | { type: 'episode'; episode: Episode };

const PACK_EPISODE_ROW_ESTIMATE_PX = 70;
const PACK_HEADER_ROW_ESTIMATE_PX = 30;
const PACK_ROW_GAP_PX = 6;
const PACK_LIST_VIRTUALIZE_THRESHOLD = 40;

function packRowKey(row: PackListRow): string {
  return row.type === 'header'
    ? `season-${row.season}`
    : `${row.episode.id}:${row.episode.season}:${row.episode.episode}`;
}

// In-selector "inside the pack" view — same row vocabulary (thumb, E-tag, progress strip) as the player episodes panel.
export function StreamPackEpisodeList({
  backdrop,
  disabled,
  episodes,
  onBack,
  onPick,
  progressFor,
  watchedEpisodeCeiling,
  stream,
  targetEpisode,
  targetSeason,
}: StreamPackEpisodeListProps) {
  const spoilerProtection = useSpoilerProtection();
  const listRef = useRef<HTMLDivElement | null>(null);
  const multiSeason = useMemo(() => new Set(episodes.map((ep) => ep.season)).size > 1, [episodes]);
  const packTitle = stream.presentation.streamTitle || stream.presentation.sourceName;
  const packMeta = [
    stream.sourceName,
    stream.presentation.deliveryLabel,
    stream.presentation.sizeLabel,
  ]
    .filter(Boolean)
    .join(' · ');

  const rows = useMemo<PackListRow[]>(() => {
    const flat: PackListRow[] = [];
    let lastSeason: number | null = null;
    for (const episode of episodes) {
      // Episodes arrive (season, episode)-sorted — a season change is the group boundary.
      if (multiSeason && episode.season !== lastSeason) {
        flat.push({ type: 'header', season: episode.season });
        lastSeason = episode.season;
      }
      flat.push({ type: 'episode', episode });
    }
    return flat;
  }, [episodes, multiSeason]);

  // Latched at mount like the stream list — a threshold swap mid-session would rebuild rows under the focused element.
  const [isVirtualized] = useState(() => rows.length >= PACK_LIST_VIRTUALIZE_THRESHOLD);

  const firstEpisodeIndex = useMemo(() => rows.findIndex((row) => row.type === 'episode'), [rows]);
  const lastEpisodeIndex = useMemo(
    () => rows.findLastIndex((row) => row.type === 'episode'),
    [rows],
  );
  const targetIndex = useMemo(
    () =>
      rows.findIndex(
        (row) =>
          row.type === 'episode' &&
          episodeMatchesCoordinates(row.episode, targetSeason, targetEpisode),
      ),
    [rows, targetEpisode, targetSeason],
  );

  // Roving tabindex mirroring the stream list — headers never take the stop.
  const [focusedIndex, setFocusedIndex] = useState(() =>
    targetIndex >= 0 ? targetIndex : Math.max(0, firstEpisodeIndex),
  );
  const rangeExtractor = useCallback(
    (range: Range) => focusedRowRange(range, focusedIndex),
    [focusedIndex],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) =>
      rows[index]?.type === 'header' ? PACK_HEADER_ROW_ESTIMATE_PX : PACK_EPISODE_ROW_ESTIMATE_PX,
    rangeExtractor,
    overscan: 8,
    enabled: isVirtualized,
  });

  // A virtual row mounts only after the scroll commit — retry one frame before giving up.
  const scheduleRowFocus = useCallback((index: number, preventScroll: boolean) => {
    whenRowMounted(
      () => listRef.current,
      `[data-pack-row="${index}"]`,
      (row) => row.focus({ preventScroll }),
    );
  }, []);

  const focusRow = useCallback(
    (index: number) => {
      setFocusedIndex(index);
      if (isVirtualized) {
        virtualizer.scrollToIndex(index, { align: 'auto' });
      }
      scheduleRowFocus(index, isVirtualized);
    },
    [isVirtualized, scheduleRowFocus, virtualizer],
  );

  // Arrow nav steps over header rows — they never hold the roving stop.
  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const count = rows.length;
      if (count === 0) return;
      const step = (distance: number, direction: 1 | -1): number => {
        let next = focusedIndex;
        for (let remaining = distance; remaining > 0; remaining -= 1) {
          let candidate = next + direction;
          while (candidate >= 0 && candidate < count && rows[candidate]?.type === 'header') {
            candidate += direction;
          }
          if (candidate < 0 || candidate >= count) return next;
          next = candidate;
        }
        return next;
      };
      let next: number | null = null;
      switch (event.key) {
        case 'ArrowDown':
          next = step(1, 1);
          break;
        case 'ArrowUp':
          next = step(1, -1);
          break;
        case 'PageDown':
          next = step(8, 1);
          break;
        case 'PageUp':
          next = step(8, -1);
          break;
        case 'Home':
          next = firstEpisodeIndex;
          break;
        case 'End':
          next = lastEpisodeIndex;
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (next >= 0 && next !== focusedIndex) focusRow(next);
    },
    [firstEpisodeIndex, focusRow, focusedIndex, lastEpisodeIndex, rows],
  );

  // Land on the target episode once — the picker overlays the stream list, so DOM focus must move here explicitly.
  useEffect(() => {
    const anchor = targetIndex >= 0 ? targetIndex : Math.max(0, firstEpisodeIndex);
    if (anchor < 0) return;
    if (isVirtualized) {
      virtualizer.scrollToIndex(anchor, { align: 'center' });
    } else {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-pack-row="${anchor}"]`)
        ?.scrollIntoView({ block: 'center' });
    }
    scheduleRowFocus(anchor, true);
    // Mount-only anchor — later list changes must not re-scroll/refocus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderRow = (row: PackListRow, index: number) => {
    if (row.type === 'header') {
      return (
        <p
          className={cn(
            'px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500',
            index === 0 ? 'pt-0' : 'pt-2',
          )}
        >
          Season {row.season}
        </p>
      );
    }

    const ep = row.episode;
    const isTarget = episodeMatchesCoordinates(ep, targetSeason, targetEpisode);
    const artwork = ep.thumbnail || backdrop;
    const watchEntry = progressFor(ep);
    const isSpoiler = isEpisodeSpoiler(
      ep,
      spoilerProtection,
      watchedEpisodeCeiling,
      watchEntry,
      isTarget,
    );
    const episodeTitle = getEpisodeTitle(isSpoiler ? undefined : ep.title, ep.episode);
    const progressPercent = watchEntry
      ? getWatchProgressPercent(watchEntry.position, watchEntry.duration)
      : 0;
    const airDate = formatAirDate(ep.releaseDate);

    return (
      <div role='listitem'>
        <button
          type='button'
          data-pack-row={index}
          data-current-episode={isTarget ? '' : undefined}
          aria-current={isTarget ? 'true' : undefined}
          aria-label={`Play ${formatSeasonEpisode(ep.season, ep.episode)} — ${episodeTitle}`}
          // aria-disabled, not disabled — a resolving pick must not drop the row out of the roving tabindex (focus → <body>).
          aria-disabled={disabled || undefined}
          tabIndex={index === focusedIndex ? 0 : -1}
          onFocus={() => setFocusedIndex(index)}
          onClick={() => {
            if (!disabled) onPick(ep);
          }}
          className={cn(
            'group relative flex w-full items-center gap-3 rounded-xl border px-2.5 py-2 text-left',
            'bg-white/[0.02] border-white/[0.05] transition-all duration-150 cursor-pointer',
            'hover:bg-white/[0.045] hover:border-white/[0.1]',
            'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/25',
            isTarget &&
              'border-[rgb(var(--accent-act-rgb)/0.22)] bg-[rgb(var(--accent-act-rgb)/0.05)]',
          )}
        >
          {isTarget && (
            <span className='absolute left-0 inset-y-2.5 w-[2px] rounded-full bg-(--accent-act)' />
          )}
          <div className='relative h-12 w-[84px] shrink-0 overflow-hidden rounded-md bg-zinc-900'>
            <div className='absolute inset-0 flex items-center justify-center text-[11px] font-bold tracking-wide text-white/15 bg-zinc-800/50'>
              E{ep.episode}
            </div>
            {artwork && (
              <RemoteImage
                src={artwork}
                loading='lazy'
                className={cn(
                  'relative h-full w-full object-cover opacity-80 transition-opacity duration-200 group-hover:opacity-100',
                  isSpoiler && 'scale-110 blur-md',
                )}
                alt=''
              />
            )}
            <WatchProgressStrip percent={progressPercent} />
          </div>

          <div className='min-w-0 flex-1'>
            <div className='flex items-center gap-1.5'>
              <span className='shrink-0 text-[10px] font-semibold uppercase tracking-wider tabular-nums text-zinc-500'>
                {formatSeasonEpisode(ep.season, ep.episode)}
              </span>
              {isTarget && (
                <span className='shrink-0 text-[10.5px] font-medium leading-none text-(--accent-act)'>
                  Current
                </span>
              )}
              {watchEntry?.is_watched && (
                <Check
                  className='h-3 w-3 shrink-0 text-zinc-400'
                  strokeWidth={3}
                  aria-label='Watched'
                />
              )}
            </div>
            <p className='mt-0.5 truncate text-[13px] font-medium leading-snug text-zinc-200 transition-colors group-hover:text-white'>
              {episodeTitle}
            </p>
            {airDate && <p className='mt-0.5 text-[11px] leading-none text-zinc-400'>{airDate}</p>}
          </div>
          <ChevronRight
            className='h-4 w-4 shrink-0 text-white/30 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100'
            strokeWidth={2}
          />
        </button>
      </div>
    );
  };

  return (
    <div className='flex h-full min-h-0 flex-col animate-in fade-in duration-150'>
      <div className='shrink-0 px-3 pt-3'>
        <div className='mb-2 flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5'>
          <button
            type='button'
            onClick={onBack}
            aria-label='Back to streams'
            title='Back to streams (Esc / Backspace)'
            aria-keyshortcuts='Escape Backspace'
            className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/40 text-white/70 transition-colors hover:bg-black/60 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30'
          >
            <ChevronLeft className='h-4 w-4' strokeWidth={2.25} />
          </button>
          <div className='min-w-0 flex-1'>
            <p className='flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.22em] leading-none text-white/40'>
              <span className='h-1 w-1 rounded-full bg-amber-400/80' />
              Season pack
            </p>
            <p
              className='mt-1.5 truncate text-[13px] font-semibold leading-tight text-zinc-100'
              title={packTitle}
            >
              {packTitle}
            </p>
            {packMeta && (
              <p className='mt-0.5 truncate text-[11px] leading-snug text-zinc-400'>{packMeta}</p>
            )}
          </div>
        </div>
        <p className='mb-2 px-1 text-[11px] font-medium text-zinc-500'>
          Choose an episode · {episodes.length} {episodes.length === 1 ? 'episode' : 'episodes'}
        </p>
      </div>

      {/* Keydown lands here via bubbling from the focused row — the container is never the target. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={listRef}
        role='list'
        aria-label='Episodes'
        className={cn(
          'min-h-0 flex-1 overflow-y-auto overscroll-contain px-3',
          isVirtualized ? 'pb-6' : 'space-y-1.5 pb-6',
          disabled && 'pointer-events-none opacity-60',
        )}
        onKeyDown={handleListKeyDown}
      >
        {isVirtualized ? (
          <div className='relative w-full' style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;
              return (
                <div
                  key={packRowKey(row)}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className='absolute left-0 right-0 top-0'
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                    paddingBottom: `${PACK_ROW_GAP_PX}px`,
                  }}
                >
                  {renderRow(row, virtualRow.index)}
                </div>
              );
            })}
          </div>
        ) : (
          rows.map((row, index) => (
            <Fragment key={packRowKey(row)}>{renderRow(row, index)}</Fragment>
          ))
        )}
      </div>
    </div>
  );
}
