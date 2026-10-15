import { useQuery } from '@tanstack/react-query';
import { Bookmark, Check, ChevronLeft, Heart, Loader2, Play, Trash2 } from 'lucide-react';
import {
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  memo,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { currentPathWithSearch, navigateOnAnchorClick } from '@/lib/navigation';
import { HoverTrailerPreview } from '@/components/hover-trailer-preview';
import { CreateListDialog } from '@/components/list/list-editor-dialog';
import { SaveToCollectionPanel } from '@/components/list/save-to-collection';
import { RemoteImage } from '@/components/remote-image';
import { WatchProgressStrip } from '@/components/watch-progress-strip';
import { useTrailerPreviews } from '@/hooks/use-app-ui-preferences';
import {
  useIsItemInLibrary,
  useItemWatchStatus,
  useLatestWatchHistoryEntry,
  useListSummaries,
  useMediaCollectionActions,
} from '@/hooks/use-media-library';
import { useMediaPrimaryPlayback } from '@/hooks/use-media-primary-playback';
import { usePrefetchDetails } from '@/hooks/use-prefetch-details';
import {
  api,
  type MediaItem,
  WATCH_STATUS_COLORS,
  WATCH_STATUS_LABELS,
  type WatchStatus,
} from '@/lib/api';
import { warmPlayerChunk } from '@/lib/player-session';
import {
  buildDetailsRoute,
  resolvePlayerRouteMediaType,
  type PlayerRouteMediaType,
} from '@/lib/player-navigation';
import {
  detailsCardQueryKey,
  DETAILS_GC_TIME_MS,
  DETAILS_STALE_TIME_MS,
} from '@/lib/query-invalidation';
import { searchGenrePath } from '@/lib/search-page-state';
import {
  clamp,
  clearTimer,
  cn,
  isHttpUrl,
  mediaTypeLabel,
  prefersReducedMotion,
  primaryGenrePills,
} from '@/lib/utils';

function normalizeRating(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const val = parseFloat(raw);
  if (Number.isNaN(val)) return null;
  return Math.round(val * 10);
}
function getRatingStyle(score: number | null) {
  if (score === null) return null;
  if (score >= 70)
    return { text: 'text-green-200/90', bg: 'bg-green-500/[0.08]', border: 'border-green-500/20' };
  if (score >= 50)
    return {
      text: 'text-yellow-200/90',
      bg: 'bg-yellow-500/[0.08]',
      border: 'border-yellow-500/20',
    };
  return { text: 'text-red-200/90', bg: 'bg-red-500/[0.08]', border: 'border-red-500/20' };
}

// Dwell gates addon requests; recently collapsed cards allow faster rail hops.
const HOVER_EXPAND_DELAY_MS = 180;
const HOVER_CHAIN_DELAY_MS = 70;
const HOVER_CHAIN_WINDOW_MS = 1200;
let lastCardCollapseAt = 0;
const MIN_PROGRESS_BAR_PERCENT = 2;
const POPOUT_WIDTH_PX = 270;

// Resting slot width shared by home rails and browse grids — cards render pixel-identical before hover.
export const MEDIA_CARD_SLOT_CLASS_NAME = 'w-[170px] md:w-[190px]';

// Includes the 6px top margin; reserve room for status before its query resolves.
export const MEDIA_CARD_TEXT_BLOCK_HEIGHT_PX = 70;
const MEDIA_CARD_TEXT_BLOCK_CLASS_NAME = 'mt-1.5 min-h-16 px-0.5 space-y-1';
const CARD_ICON_BUTTON_CLASS_NAME =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:scale-95';
const CARD_INACTIVE_ICON_BUTTON_CLASS_NAME =
  'border-white/[0.08] bg-white/[0.06] text-zinc-300 hover:bg-white/[0.12] hover:text-white';

// Shared rail callbacks for plain MediaCard rows — stable identities keep HorizontalMediaRail's memo from re-running.
export const mediaCardRailKey = (item: MediaItem) => `${item.type}:${item.id}`;
export const renderMediaCardRailItem = (item: MediaItem) => <MediaCard item={item} />;

type PopoverAlign = 'left' | 'center' | 'right';

interface MediaCardProps {
  item: MediaItem;
  currentStatusOverride?: WatchStatus | null;
  isInLibraryOverride?: boolean;
  progress?: number;
  /** Below-title resume line ("S1:E2 · 24m left") — plain string so memo holds. */
  metaLine?: string;
  onPlay?: (event: ReactMouseEvent) => void | Promise<void>;
  isPlayPending?: boolean;
  onRemoveFromContinue?: (event: ReactMouseEvent) => void;
  subtitle?: string;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (item: MediaItem) => void;
}

function ResumeProgressBar({ progress }: { progress?: number }) {
  if (progress === undefined || progress < MIN_PROGRESS_BAR_PERCENT) return null;
  return <WatchProgressStrip percent={progress} className='z-20 h-1' />;
}

interface MediaCardPosterProps {
  currentStatus: WatchStatus | null;
  detailsRouteType: PlayerRouteMediaType;
  isPlayPending?: boolean;
  item: MediaItem;
  metaLine?: string;
  onPlay?: (event: ReactMouseEvent) => void | Promise<void>;
  onPrefetchDetails?: () => void;
  progress?: number;
  subtitle?: string;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (item: MediaItem) => void;
}

function MediaCardPoster({
  currentStatus,
  detailsRouteType,
  isPlayPending = false,
  item,
  metaLine,
  onPlay,
  onPrefetchDetails,
  progress,
  subtitle,
  selectionMode = false,
  isSelected = false,
  onToggleSelect,
}: MediaCardPosterProps) {
  const detailsPath = buildDetailsRoute(detailsRouteType, item.id);
  const anchorLabel = onPlay
    ? [`Resume ${item.title}`, subtitle, metaLine].filter(Boolean).join(', ')
    : item.title;

  const poster = (
    <div
      className={cn(
        'relative rounded-lg bg-zinc-900',
        selectionMode &&
          isSelected &&
          'ring-2 ring-(--accent-nav) ring-offset-2 ring-offset-zinc-950',
      )}
    >
      <div className='relative aspect-2/3 rounded-lg overflow-hidden bg-zinc-900'>
        <div
          aria-hidden='true'
          className='absolute inset-0 flex items-center justify-center px-4 text-center'
        >
          <span
            dir='auto'
            className='line-clamp-3 text-sm font-medium leading-relaxed text-zinc-500'
          >
            {item.title}
          </span>
        </div>
        {isHttpUrl(item.poster) ? (
          <RemoteImage
            src={item.poster}
            alt={item.title}
            className='relative object-cover w-full h-full bg-zinc-900'
            loading='lazy'
          />
        ) : null}
        {selectionMode && (
          <span
            aria-hidden='true'
            className={cn(
              'absolute top-2.5 left-2.5 z-20 flex h-6 w-6 items-center justify-center rounded-lg border transition-all duration-150',
              isSelected
                ? 'border-(--accent-nav) bg-(--accent-nav) text-(--on-accent-nav) shadow-md scale-100'
                : 'border-white/30 bg-black/55 text-transparent backdrop-blur-md group-hover:border-white/60',
            )}
          >
            <Check className='h-3.5 w-3.5' strokeWidth={3} />
          </span>
        )}

        {subtitle && (
          <div className='absolute bottom-1.5 left-1.5 z-10 flex max-w-[calc(100%-12px)] flex-col items-start gap-1'>
            <div className='rounded-[5px] border border-white/10 bg-black/75 px-1.5 py-1 text-[10.5px] font-semibold leading-none tabular-nums text-white/90 backdrop-blur-xs'>
              {subtitle}
            </div>
          </div>
        )}

        <ResumeProgressBar progress={progress} />

        {!selectionMode && isPlayPending && (
          <div className='absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/55 backdrop-blur-[2px] animate-in fade-in duration-150'>
            <Loader2 className='h-5 w-5 animate-spin text-white/85' />
            <span className='text-[11.5px] font-medium text-white/80'>Opening…</span>
          </div>
        )}
      </div>
    </div>
  );
  const textBlock = (
    <div className={MEDIA_CARD_TEXT_BLOCK_CLASS_NAME}>
      <p
        dir='auto'
        title={item.title}
        className='line-clamp-2 min-h-[2.5em] [overflow-wrap:anywhere] text-[13px] font-medium leading-tight tracking-[-0.01em] text-zinc-100'
      >
        {item.title}
      </p>
      {metaLine ? (
        <p
          title={metaLine}
          className='truncate text-[11px] font-normal leading-none tabular-nums text-zinc-400'
        >
          {metaLine}
        </p>
      ) : item.displayYear ? (
        <p className='text-[11px] font-normal leading-none text-zinc-500'>{item.displayYear}</p>
      ) : null}
      {currentStatus && (
        <p className='flex items-center gap-1.5 text-[11px] font-medium leading-none text-zinc-400'>
          <span
            aria-hidden='true'
            className={cn(
              'h-1 w-1 rounded-full bg-current',
              WATCH_STATUS_COLORS[currentStatus].text,
            )}
          />
          {WATCH_STATUS_LABELS[currentStatus]}
        </p>
      )}
    </div>
  );

  if (selectionMode) {
    return (
      <button
        type='button'
        aria-label={`${isSelected ? 'Deselect' : 'Select'} ${item.title}`}
        aria-pressed={isSelected}
        className='group block w-full rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background'
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggleSelect?.(item);
        }}
      >
        {poster}
        {textBlock}
      </button>
    );
  }

  return (
    <>
      {/* Plain anchor avoids subscribing every resting card to navigation. */}
      <a
        href={detailsPath}
        aria-label={anchorLabel}
        aria-busy={isPlayPending || undefined}
        className='block relative rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background'
        onClick={(event) => {
          onPlay?.(event);
          navigateOnAnchorClick(event, detailsPath, {
            state: { from: currentPathWithSearch() },
          });
        }}
        onFocus={onPrefetchDetails}
        onPointerDown={onPrefetchDetails}
      >
        {poster}
      </a>
      {textBlock}
    </>
  );
}

function useSyncedBooleanState(initialState = false) {
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state);

  const setSyncedState = useCallback((nextState: SetStateAction<boolean>) => {
    // Resolve against the ref mirror so the updater stays pure under batching.
    const resolvedState = typeof nextState === 'function' ? nextState(stateRef.current) : nextState;
    stateRef.current = resolvedState;
    setState(resolvedState);
  }, []);

  return [state, setSyncedState, stateRef] as const;
}

interface MediaCardOverlayProps {
  createListOpen: boolean;
  currentStatus: WatchStatus | null;
  detailsRouteType: PlayerRouteMediaType;
  /** Set only when the caller already knows membership (library tab) — otherwise the overlay resolves it on mount. */
  isInLibraryOverride?: boolean;
  isPlayPending?: boolean;
  item: MediaItem;
  metaLine?: string;
  onCollapse: () => void;
  onCreateListOpenChange: (open: boolean) => void;
  onPlay?: (event: ReactMouseEvent) => void | Promise<void>;
  onRemoveFromContinue?: (event: ReactMouseEvent) => void;
  onToggleListPicker: (event: ReactMouseEvent) => void;
  popoverAlign: PopoverAlign;
  progress?: number;
  showListPicker: boolean;
  subtitle?: string;
}

// Expanded-only surface — resting cards stay free of the details/lists/history observers and playback hook chain.
function MediaCardOverlay({
  createListOpen,
  currentStatus,
  detailsRouteType,
  isInLibraryOverride,
  isPlayPending = false,
  item,
  metaLine,
  onCollapse,
  onCreateListOpenChange,
  onPlay,
  onRemoveFromContinue,
  onToggleListPicker,
  popoverAlign,
  progress,
  showListPicker,
  subtitle,
}: MediaCardOverlayProps) {
  // Where the user expanded the card — read once at mount so the overlay holds no location subscription.
  const [from] = useState(currentPathWithSearch);
  const detailsPath = buildDetailsRoute(detailsRouteType, item.id);

  // The id guard avoids a doomed IPC (Rust rejects empty ids); card payload only — hover never needs episodes.
  const { data: details } = useQuery({
    queryKey: detailsCardQueryKey(detailsRouteType, item.id),
    queryFn: () => api.getMediaCardDetails(detailsRouteType, item.id),
    enabled: !!item.id.trim(),
    staleTime: DETAILS_STALE_TIME_MS,
    gcTime: DETAILS_GC_TIME_MS,
  });

  const { data: lists } = useListSummaries(item.id);
  const { data: historyEntry } = useLatestWatchHistoryEntry(item.id, {
    enabled: !onPlay,
  });

  // Membership resolves here, not on the resting card — browse grids carry no per-card library observer.
  const { data: resolvedIsInLibrary = false } = useIsItemInLibrary(item.id, {
    enabled: isInLibraryOverride === undefined,
  });
  const isInLibrary = isInLibraryOverride ?? resolvedIsInLibrary;

  const collectionActions = useMediaCollectionActions({
    item,
    isInLibrary,
  });
  const { addItemToNewList, toggleLibrary } = collectionActions;
  const primaryPlayback = useMediaPrimaryPlayback({
    from,
    historyEntry,
    item,
    surface: 'card',
  });

  const ratingScore = normalizeRating(details?.rating ?? null);
  const ratingStyle = getRatingStyle(ratingScore);

  const trailerVideoId = details?.trailers?.[0]?.id;
  // Reduced-motion CSS cannot stop playback inside an iframe.
  const trailersEnabled = useTrailerPreviews() && !prefersReducedMotion();

  // A second dwell avoids mounting expensive embeds during quick card hops.
  const [trailerArmed, setTrailerArmed] = useState(false);
  useEffect(() => {
    if (!trailerVideoId || !trailersEnabled) return;
    const timer = window.setTimeout(() => setTrailerArmed(true), 500);
    return () => window.clearTimeout(timer);
  }, [trailerVideoId, trailersEnabled]);

  const backdropSrc = details?.backdrop || item.backdrop || item.poster;

  const isInAnyList = lists?.some((list) => list.contains_item) ?? false;
  const primaryActionLabel = onPlay
    ? subtitle
      ? `Resume ${subtitle}`
      : 'Resume'
    : primaryPlayback.primaryActionLabel;
  const isPrimaryPending = isPlayPending || primaryPlayback.isResolvingPrimaryAction;

  const handlePrimaryAction = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isPrimaryPending) return;
    if (onPlay) {
      onPlay(e);
      return;
    }

    void primaryPlayback.handlePrimaryAction();
  };

  return (
    <>
      {/* Top-anchored popout — center uses a negative margin, not translate, so the enter zoom never fights it. */}
      <div
        className={cn(
          'absolute top-0 z-20 flex h-fit max-w-[86vw] origin-top select-none flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-950 shadow-[0_24px_70px_-12px_rgba(0,0,0,0.85)] ring-1 ring-black/40 animate-in fade-in-0 zoom-in-95 duration-200',
          popoverAlign === 'left' && 'left-0',
          popoverAlign === 'right' && 'right-0',
          popoverAlign === 'center' && 'left-1/2',
        )}
        style={{
          width: POPOUT_WIDTH_PX,
          marginLeft: popoverAlign === 'center' ? -POPOUT_WIDTH_PX / 2 : undefined,
        }}
      >
        <div className='relative aspect-16/10 w-full shrink-0 overflow-hidden bg-zinc-900'>
          {isHttpUrl(backdropSrc) && (
            <RemoteImage
              src={backdropSrc}
              alt=''
              className='absolute inset-0 object-cover w-full h-full'
              loading='lazy'
            />
          )}
          {trailerVideoId && trailerArmed && trailersEnabled && (
            <HoverTrailerPreview videoId={trailerVideoId} />
          )}
          <div className='pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-zinc-950 via-zinc-950/60 to-transparent' />
          <a
            href={detailsPath}
            className='absolute inset-0'
            tabIndex={-1}
            aria-hidden
            onClick={(event) => {
              onPlay?.(event);
              navigateOnAnchorClick(event, detailsPath, { state: { from } });
            }}
          />
          <ResumeProgressBar progress={progress} />
          {onRemoveFromContinue && (
            <button
              type='button'
              aria-label={`Remove ${item.title} from history`}
              title='Remove from history'
              className='absolute right-2 top-2 z-10 flex h-9 w-9 items-center justify-center rounded-lg bg-black/55 text-zinc-300 backdrop-blur-xs transition-colors duration-150 hover:bg-black/75 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRemoveFromContinue(e);
                onCollapse();
              }}
            >
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          )}
        </div>

        <div className='flex flex-1 flex-col overflow-hidden'>
          {showListPicker ? (
            <div data-media-card-picker className='relative z-10 flex flex-1 flex-col p-2.5'>
              <div className='mb-1 flex items-center gap-1.5'>
                <button
                  type='button'
                  aria-label='Back to actions'
                  title='Back'
                  className='h-8 w-8 rounded-md flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/10 transition-colors duration-150 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30'
                  onClick={onToggleListPicker}
                >
                  <ChevronLeft className='h-3.5 w-3.5' />
                </button>
                <span className='text-[12px] font-semibold text-white'>Add to List</span>
              </div>

              <SaveToCollectionPanel
                item={item}
                isInLibrary={isInLibrary}
                actions={collectionActions}
                onCreateList={() => onCreateListOpenChange(true)}
              />
            </div>
          ) : (
            <div className='relative z-10 flex flex-1 flex-col gap-2 p-3 pt-2.5'>
              <div className='flex items-start justify-between gap-2'>
                <h3 className='min-w-0 flex-1 text-[13.5px] font-semibold leading-[1.3] tracking-[-0.01em] text-white line-clamp-1'>
                  {currentStatus && (
                    <span
                      aria-hidden='true'
                      title={WATCH_STATUS_LABELS[currentStatus]}
                      className={cn(
                        'mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current align-middle',
                        WATCH_STATUS_COLORS[currentStatus].text,
                      )}
                    />
                  )}
                  {/* Every other target on a resume card plays — the title link is the non-play path to details. */}
                  <a
                    href={detailsPath}
                    title={item.title}
                    className='transition-colors hover:text-white/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40 rounded-xs'
                    onClick={(event) =>
                      navigateOnAnchorClick(event, detailsPath, { state: { from } })
                    }
                  >
                    {item.title}
                  </a>
                </h3>
                {ratingStyle && (
                  <span
                    className={cn(
                      'mt-px shrink-0 rounded border px-1.5 py-[3px] text-[11px] font-bold leading-none tabular-nums animate-in fade-in duration-300',
                      ratingStyle.text,
                      ratingStyle.bg,
                      ratingStyle.border,
                    )}
                  >
                    {ratingScore}%
                  </span>
                )}
              </div>

              <div className='flex items-center gap-1.5'>
                <button
                  type='button'
                  data-media-card-primary
                  className='accent-lattice flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold tracking-[-0.005em] transition-colors duration-150 hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:scale-[0.98] aria-disabled:cursor-wait aria-disabled:opacity-80'
                  title={primaryActionLabel}
                  onClick={handlePrimaryAction}
                  aria-disabled={isPrimaryPending || undefined}
                >
                  {isPrimaryPending ? (
                    <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin' />
                  ) : (
                    <Play className='h-3.5 w-3.5 shrink-0 fill-current' />
                  )}
                  <span className='truncate'>{primaryActionLabel}</span>
                </button>

                <button
                  type='button'
                  className={cn(
                    CARD_ICON_BUTTON_CLASS_NAME,
                    isInLibrary
                      ? 'accent-lattice-soft hover:bg-[rgb(var(--accent-act-rgb)/0.14)]'
                      : CARD_INACTIVE_ICON_BUTTON_CLASS_NAME,
                    toggleLibrary.isPending && 'cursor-wait opacity-70',
                  )}
                  title={isInLibrary ? 'Remove from library' : 'Add to library'}
                  aria-label={isInLibrary ? 'Remove from library' : 'Add to library'}
                  aria-pressed={isInLibrary}
                  // Disabling a focused control would blur and collapse the card.
                  aria-disabled={toggleLibrary.isPending || undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (toggleLibrary.isPending) return;
                    toggleLibrary.mutate();
                  }}
                >
                  {toggleLibrary.isPending ? (
                    <Loader2 className='h-3.5 w-3.5 animate-spin' />
                  ) : (
                    <Heart className={cn('h-3.5 w-3.5', isInLibrary && 'fill-current')} />
                  )}
                </button>

                <button
                  type='button'
                  className={cn(
                    CARD_ICON_BUTTON_CLASS_NAME,
                    isInAnyList
                      ? 'border-white/20 bg-white/[0.12] text-white hover:bg-white/[0.16]'
                      : CARD_INACTIVE_ICON_BUTTON_CLASS_NAME,
                  )}
                  title='Add to List'
                  aria-label='Add to List'
                  aria-pressed={isInAnyList}
                  aria-expanded={showListPicker}
                  onClick={onToggleListPicker}
                >
                  <Bookmark className={cn('h-3.5 w-3.5', isInAnyList && 'fill-current')} />
                </button>
              </div>

              <div className='flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] font-medium leading-none text-zinc-400'>
                <span className='text-zinc-200'>{mediaTypeLabel(item.type)}</span>
                {item.displayYear && (
                  <>
                    <span className='text-zinc-700'>·</span>
                    <span>{item.displayYear}</span>
                  </>
                )}
                {metaLine && (
                  <>
                    <span className='text-zinc-700'>·</span>
                    <span className='tabular-nums text-zinc-200'>{metaLine}</span>
                  </>
                )}
                {primaryGenrePills(item.genres, details?.genres).map((genre) => {
                  const genrePath = searchGenrePath(item.type, genre);
                  return (
                    <a
                      key={genre}
                      href={genrePath}
                      title={`Browse ${genre}`}
                      onClick={(event) => navigateOnAnchorClick(event, genrePath)}
                      className='flex items-center gap-x-1.5 rounded-xs transition-colors hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40'
                    >
                      <span aria-hidden='true' className='text-zinc-700'>
                        ·
                      </span>
                      {genre}
                    </a>
                  );
                })}
              </div>

              <p className='min-h-[54px] text-[12px] leading-[1.5] text-zinc-400 line-clamp-3'>
                {details?.description || item.description || 'No synopsis available yet.'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Create-list dialog lives in the overlay — the picker lock holds the card open until the dialog closes. */}
      <CreateListDialog
        open={createListOpen}
        onOpenChange={onCreateListOpenChange}
        onCreated={addItemToNewList}
      />
    </>
  );
}

// Memoized — `item` is referentially stable via TanStack structural sharing, so a pure-props bail-out skips
// most re-renders. Callers must keep `onPlay`/`onRemoveFromContinue` referentially stable.
export const MediaCard = memo(function MediaCard({
  item,
  currentStatusOverride,
  isInLibraryOverride,
  progress,
  metaLine,
  onPlay,
  onRemoveFromContinue,
  subtitle,
  isPlayPending = false,
  selectionMode = false,
  isSelected = false,
  onToggleSelect,
}: MediaCardProps) {
  const detailsRouteType = resolvePlayerRouteMediaType(item.type);
  const prefetchDetails = usePrefetchDetails(item.id, item.type);

  const [expanded, setExpanded] = useState(false);
  const [popoverAlign, setPopoverAlign] = useState<PopoverAlign>('center');
  const [showListPicker, setShowListPickerState, showListPickerRef] = useSyncedBooleanState();
  const [createListOpen, setCreateListOpenState, createListOpenRef] = useSyncedBooleanState();
  const cardRef = useRef<HTMLElement>(null);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoringFocusRef = useRef(false);
  const hoverFocusRef = useRef(false);

  const clearExpandTimer = useCallback(() => clearTimer(expandTimer), []);

  const hasLockedCardInteraction = useCallback(
    () => showListPickerRef.current || createListOpenRef.current,
    [createListOpenRef, showListPickerRef],
  );

  const collapseCard = useCallback(() => {
    clearExpandTimer();
    lastCardCollapseAt = Date.now();
    setExpanded(false);
    setShowListPickerState(false);
  }, [clearExpandTimer, setShowListPickerState]);

  // Pin the popout toward the side with room, measured vs the rail scrollport or the window (grids).
  const resolvePopoverAlign = useCallback((): PopoverAlign => {
    const card = cardRef.current;
    if (!card || typeof window === 'undefined') {
      return 'center';
    }

    const overlayWidth = Math.min(POPOUT_WIDTH_PX, window.innerWidth * 0.86);
    const overhang = Math.max(0, (overlayWidth - card.offsetWidth) / 2);
    const cardRect = card.getBoundingClientRect();
    const scroller = card.closest('[data-media-scroller]');
    const bounds = scroller
      ? scroller.getBoundingClientRect()
      : { left: 8, right: window.innerWidth - 8 };

    if (cardRect.left - overhang < bounds.left + 2) {
      return 'left';
    }

    if (cardRect.right + overhang > bounds.right - 2) {
      return 'right';
    }

    return 'center';
  }, []);

  const scheduleExpand = useCallback(() => {
    // Escape restores poster focus without immediately reopening the card.
    if (selectionMode || expanded || restoringFocusRef.current) return;
    // Hover focus can inherit an earlier keyboard ring; track its owner here.
    hoverFocusRef.current = !cardRef.current?.contains(document.activeElement);
    clearExpandTimer();
    const delay =
      Date.now() - lastCardCollapseAt < HOVER_CHAIN_WINDOW_MS
        ? HOVER_CHAIN_DELAY_MS
        : HOVER_EXPAND_DELAY_MS;
    expandTimer.current = setTimeout(() => {
      prefetchDetails();
      warmPlayerChunk();
      setPopoverAlign(resolvePopoverAlign());
      setExpanded(true);
      expandTimer.current = null;
    }, delay);
  }, [clearExpandTimer, expanded, prefetchDetails, resolvePopoverAlign, selectionMode]);

  const handleMouseLeave = useCallback(() => {
    if (
      hasLockedCardInteraction() ||
      (!hoverFocusRef.current && cardRef.current?.querySelector(':focus-visible'))
    )
      return;
    collapseCard();
  }, [collapseCard, hasLockedCardInteraction]);

  const handleBlur = useCallback(
    (event: ReactFocusEvent) => {
      if (hasLockedCardInteraction()) return;
      const nextFocus = event.relatedTarget;
      if (nextFocus instanceof Node && cardRef.current && cardRef.current.contains(nextFocus)) {
        hoverFocusRef.current = false;
        return;
      }
      collapseCard();
    },
    [collapseCard, hasLockedCardInteraction],
  );

  useEffect(() => {
    return () => {
      clearExpandTimer();
    };
  }, [clearExpandTimer]);

  useEffect(() => {
    if (selectionMode) collapseCard();
  }, [selectionMode, collapseCard]);

  const toggleListPicker = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setShowListPickerState((currentState) => !currentState);
    },
    [setShowListPickerState],
  );

  const handleCreateListOpenChange = useCallback(
    (open: boolean) => {
      setCreateListOpenState(open);
      if (!open) {
        // Restore the picker lock so the card stays expanded.
        setShowListPickerState(true);
      }
    },
    [setCreateListOpenState, setShowListPickerState],
  );

  // The card isn't a [role="dialog"] — without this a keyboard-opened overlay leaks Esc to the global back
  // gesture. Collapses picker first, then the card; the portaled create-list dialog owns its own Esc via Radix.
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      hoverFocusRef.current = false;
      if (event.key !== 'Escape' || event.defaultPrevented || !expanded) return;
      if (createListOpenRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (showListPickerRef.current) {
        setShowListPickerState(false);
        return;
      }
      collapseCard();
      // The overlay unmounts with its focused control — hand focus back to the poster link, not <body>.
      window.requestAnimationFrame(() => {
        restoringFocusRef.current = true;
        cardRef.current?.querySelector<HTMLElement>('a[href]')?.focus({ preventScroll: true });
        restoringFocusRef.current = false;
      });
    },
    [expanded, collapseCard, createListOpenRef, setShowListPickerState, showListPickerRef],
  );

  // Transfer focus before the hidden poster blurs and closes the overlay; a focus owner elsewhere stays untouched.
  useLayoutEffect(() => {
    if (!expanded) return;
    if (
      document.activeElement !== document.body &&
      !cardRef.current?.contains(document.activeElement)
    )
      return;
    const target = cardRef.current?.querySelector<HTMLElement>(
      showListPicker ? '[data-media-card-picker] button' : '[data-media-card-primary]',
    );
    target?.focus({ preventScroll: true });
  }, [expanded, showListPicker]);

  const { data: resolvedCurrentStatus = null } = useItemWatchStatus(item.id, {
    enabled: currentStatusOverride === undefined,
  });
  const currentStatus =
    currentStatusOverride !== undefined ? currentStatusOverride : resolvedCurrentStatus;

  const safeProgress =
    typeof progress === 'number' && Number.isFinite(progress) ? clamp(progress, 0, 100) : undefined;

  return (
    // Ambient hover/focus listeners drive expand/collapse — the card itself stays non-interactive.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <article
      ref={cardRef}
      data-media-card='true'
      data-media-card-expanded={(!selectionMode && expanded) || undefined}
      className={cn('relative', !selectionMode && expanded && 'z-30')}
      aria-label={item.title}
      onMouseEnter={scheduleExpand}
      onMouseLeave={handleMouseLeave}
      onFocus={scheduleExpand}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <div className={cn(!selectionMode && expanded && 'invisible')}>
        <MediaCardPoster
          currentStatus={currentStatus}
          detailsRouteType={detailsRouteType}
          isPlayPending={isPlayPending}
          item={item}
          metaLine={metaLine}
          onPlay={onPlay}
          onPrefetchDetails={prefetchDetails}
          progress={safeProgress}
          subtitle={subtitle}
          selectionMode={selectionMode}
          isSelected={isSelected}
          onToggleSelect={onToggleSelect}
        />
      </div>

      {!selectionMode && expanded && (
        <MediaCardOverlay
          createListOpen={createListOpen}
          currentStatus={currentStatus}
          detailsRouteType={detailsRouteType}
          isInLibraryOverride={isInLibraryOverride}
          isPlayPending={isPlayPending}
          item={item}
          metaLine={metaLine}
          onCollapse={collapseCard}
          onCreateListOpenChange={handleCreateListOpenChange}
          onPlay={onPlay}
          onRemoveFromContinue={onRemoveFromContinue}
          onToggleListPicker={toggleListPicker}
          popoverAlign={popoverAlign}
          progress={safeProgress}
          showListPicker={showListPicker}
          subtitle={subtitle}
        />
      )}
    </article>
  );
});

export function MediaCardSkeleton() {
  return (
    <div aria-hidden='true'>
      <div className='aspect-2/3 animate-pulse rounded-lg border border-white/5 bg-zinc-900/50' />
      <div className={MEDIA_CARD_TEXT_BLOCK_CLASS_NAME}>
        <div className='h-8 space-y-1'>
          <div className='h-3.5 w-3/4 animate-pulse rounded-md bg-zinc-900/40' />
          <div className='h-3.5 w-1/2 animate-pulse rounded-md bg-zinc-900/30' />
        </div>
        <div className='h-3 w-1/3 animate-pulse rounded-md bg-zinc-900/30' />
      </div>
    </div>
  );
}
