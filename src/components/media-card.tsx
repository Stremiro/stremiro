import { useQuery } from '@tanstack/react-query';
import { Bookmark, Check, ChevronLeft, Heart, Loader2, Play, Trash2 } from 'lucide-react';
import {
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  lazy,
  memo,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SetStateAction,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { currentPathWithSearch, navigateOnAnchorClick } from '@/lib/navigation';
import { HoverTrailerPreview } from '@/components/hover-trailer-preview';
import { CreateListDialog } from '@/components/list/list-editor-dialog';
import { RemoteImage } from '@/components/remote-image';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { WatchProgressStrip } from '@/components/watch-progress-strip';
import { useTrailerPreviews } from '@/hooks/use-app-ui-preferences';
import {
  useIsItemInLibrary,
  useItemWatchStatus,
  useMediaResumeEntry,
  useListSummaries,
  useMediaCollectionActions,
} from '@/hooks/use-media-library';
import { useMediaPrimaryPlayback } from '@/hooks/use-media-primary-playback';
import { useMountedRef } from '@/hooks/use-mounted-ref';
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
import { routeChunks } from '@/lib/route-chunks';
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

const loadSaveToCollectionPanel = () => import('@/components/list/save-to-collection');
const SaveToCollectionPanel = lazy(() =>
  loadSaveToCollectionPanel().then((module) => ({ default: module.SaveToCollectionPanel })),
);

function warmSaveToCollectionPanel() {
  void loadSaveToCollectionPanel().catch(() => undefined);
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
  playbackIntent?: 'resume' | 'next-episode';
  isPlayPending?: boolean;
  onRemoveFromContinue?: (event: ReactMouseEvent) => void;
  subtitle?: string;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (item: MediaItem, shiftKey?: boolean) => void;
}

function ResumeProgressBar({ progress }: { progress?: number }) {
  if (progress === undefined || progress < MIN_PROGRESS_BAR_PERCENT) return null;
  return <WatchProgressStrip percent={progress} className='z-20 h-1' />;
}

interface MediaCardPosterProps {
  currentStatus: WatchStatus | null;
  detailsRouteType: PlayerRouteMediaType;
  expanded: boolean;
  isPlayPending?: boolean;
  item: MediaItem;
  metaLine?: string;
  onPlay?: (event: ReactMouseEvent) => void | Promise<void>;
  playbackIntent: 'resume' | 'next-episode';
  onPrefetchDetails?: () => void;
  progress?: number;
  subtitle?: string;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (item: MediaItem, shiftKey?: boolean) => void;
}

function MediaCardPoster({
  currentStatus,
  detailsRouteType,
  expanded,
  isPlayPending = false,
  item,
  metaLine,
  onPlay,
  playbackIntent,
  onPrefetchDetails,
  progress,
  subtitle,
  selectionMode = false,
  isSelected = false,
  onToggleSelect,
}: MediaCardPosterProps) {
  const detailsPath = buildDetailsRoute(detailsRouteType, item.id);
  const anchorLabel = onPlay
    ? [
        `${playbackIntent === 'next-episode' ? 'Play next episode of' : 'Resume'} ${item.title}`,
        subtitle,
        metaLine,
      ]
        .filter(Boolean)
        .join(', ')
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
            fadeIn
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
          onToggleSelect?.(item, event.shiftKey);
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
        data-media-card-poster
        tabIndex={expanded ? -1 : undefined}
        aria-label={anchorLabel}
        aria-busy={isPlayPending || undefined}
        className='block relative rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background'
        onClick={(event) => {
          if (event.detail === 0) onPrefetchDetails?.();
          onPlay?.(event);
          navigateOnAnchorClick(event, detailsPath, {
            state: { from: currentPathWithSearch() },
          });
        }}
        onFocus={onPlay ? undefined : () => void routeChunks.details().catch(() => undefined)}
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
  contextMenu?: {
    onCloseAutoFocus: (event: Event) => void;
    onInteractOutside: () => void;
    onOpenChange: (open: boolean) => void;
    onRemove: () => void;
  };
  createListOpen: boolean;
  currentStatus: WatchStatus | null;
  detailsRouteType: PlayerRouteMediaType;
  /** Set only when the caller already knows membership (library tab) — otherwise the overlay resolves it on mount. */
  isInLibraryOverride?: boolean;
  isPlayPending?: boolean;
  item: MediaItem;
  launchOwnerMountedRef: RefObject<boolean>;
  metaLine?: string;
  onCreateListOpenChange: (open: boolean) => void;
  onPlay?: (event: ReactMouseEvent) => void | Promise<void>;
  playbackIntent: 'resume' | 'next-episode';
  onRemoveFromContinue?: (event: ReactMouseEvent) => void;
  onToggleListPicker: (event: ReactMouseEvent) => void;
  popoverAlign: PopoverAlign;
  progress?: number;
  showListPicker: boolean;
  subtitle?: string;
}

// Expanded-only surface — resting cards stay free of the details/lists/history observers and playback hook chain.
function MediaCardOverlay({
  contextMenu,
  createListOpen,
  currentStatus,
  detailsRouteType,
  isInLibraryOverride,
  isPlayPending = false,
  item,
  launchOwnerMountedRef,
  metaLine,
  onCreateListOpenChange,
  onPlay,
  playbackIntent,
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
    ...api.cardDetailsQueryOptions(detailsRouteType, item.id),
    enabled: !contextMenu && !!item.id.trim(),
  });

  const { data: lists } = useListSummaries(item.id);
  const { data: historyEntry } = useMediaResumeEntry(item.id, item.type, {
    enabled: !onPlay,
  });

  // Membership resolves here, not on the resting card — browse grids carry no per-card library observer.
  const libraryQuery = useIsItemInLibrary(item.id, {
    enabled: isInLibraryOverride === undefined,
  });
  const isInLibrary = isInLibraryOverride ?? libraryQuery.data ?? false;
  const libraryReady = isInLibraryOverride !== undefined || libraryQuery.data !== undefined;
  const libraryActionLabel = libraryReady
    ? isInLibrary
      ? 'Remove from Library'
      : 'Add to Library'
    : libraryQuery.isError
      ? 'Library unavailable'
      : 'Loading Library…';

  const collectionActions = useMediaCollectionActions({
    item,
    isInLibrary,
  });
  const { addItemToNewList, toggleLibrary } = collectionActions;
  const primaryPlayback = useMediaPrimaryPlayback({
    from,
    historyEntry,
    item,
    launchOwnerMountedRef,
    surface: 'card',
  });

  const ratingScore = details?.ratingPercent ?? null;
  const ratingStyle = getRatingStyle(ratingScore);

  const trailerVideoId = details?.trailers?.[0]?.id;
  // Reduced-motion CSS cannot stop playback inside an iframe.
  const trailersEnabled = useTrailerPreviews() && !contextMenu && !prefersReducedMotion();

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
      ? `${playbackIntent === 'next-episode' ? 'Play' : 'Resume'} ${subtitle}`
      : playbackIntent === 'next-episode'
        ? 'Play next episode'
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

  const handleToggleLibrary = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!libraryReady || toggleLibrary.isPending) return;
    if (isInLibrary && isInLibraryOverride) contextMenu?.onRemove();
    toggleLibrary.mutate();
  };

  if (contextMenu) {
    return (
      <ContextMenuContent
        onCloseAutoFocus={contextMenu.onCloseAutoFocus}
        onInteractOutside={contextMenu.onInteractOutside}
      >
        <ContextMenuItem asChild>
          <a
            href={detailsPath}
            onClick={(event) => {
              navigateOnAnchorClick(event, detailsPath, { state: { from } });
              contextMenu.onOpenChange(false);
            }}
          >
            Open details
          </a>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={isPrimaryPending}
          onClick={(event) => {
            handlePrimaryAction(event);
            contextMenu.onOpenChange(false);
          }}
        >
          {primaryActionLabel}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!libraryReady || toggleLibrary.isPending}
          onClick={(event) => {
            handleToggleLibrary(event);
            contextMenu.onOpenChange(false);
          }}
        >
          {libraryActionLabel}
        </ContextMenuItem>
        {onRemoveFromContinue && (
          <ContextMenuItem
            onClick={(event) => {
              onRemoveFromContinue(event);
              contextMenu.onOpenChange(false);
            }}
          >
            Remove from watch history
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    );
  }

  return (
    <>
      {/* Top-anchored popout — center uses a negative margin, not translate, so the enter zoom never fights it. */}
      <div
        className={cn(
          'absolute top-0 z-20 flex h-fit max-h-full max-w-[86vw] origin-top select-none flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-950 shadow-[0_24px_70px_-12px_rgba(0,0,0,0.85)] ring-1 ring-black/40 -outline-offset-2 group-has-[[data-media-card-poster]:focus-visible]/card:outline-2 group-has-[[data-media-card-poster]:focus-visible]/card:outline-white/40 animate-in fade-in-0 zoom-in-95 duration-200',
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
              fallbackSrc={isHttpUrl(item.poster) ? item.poster : undefined}
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
              aria-label={`Remove ${item.title} from watch history`}
              title='Remove from watch history'
              className='absolute right-2 top-2 z-10 flex h-9 w-9 items-center justify-center rounded-lg bg-black/55 text-zinc-300 backdrop-blur-xs transition-colors duration-150 hover:bg-black/75 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
              onClick={onRemoveFromContinue}
            >
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          )}
        </div>

        <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
          {showListPicker ? (
            <div
              data-media-card-picker
              className='relative z-10 flex min-h-0 flex-1 flex-col p-2.5'
            >
              <div className='mb-1 flex shrink-0 items-center gap-1.5'>
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

              <Suspense fallback={null}>
                <SaveToCollectionPanel
                  item={item}
                  isInLibrary={isInLibrary}
                  actions={collectionActions}
                  onCreateList={() => onCreateListOpenChange(true)}
                />
              </Suspense>
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
                    !libraryReady && 'opacity-50',
                  )}
                  title={libraryActionLabel}
                  aria-label={libraryActionLabel}
                  aria-pressed={libraryReady ? isInLibrary : undefined}
                  // Disabling a focused control would blur and collapse the card.
                  aria-disabled={!libraryReady || toggleLibrary.isPending || undefined}
                  onClick={handleToggleLibrary}
                >
                  {toggleLibrary.isPending || (!libraryReady && !libraryQuery.isError) ? (
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
                  onPointerEnter={warmSaveToCollectionPanel}
                  onFocus={warmSaveToCollectionPanel}
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
  playbackIntent = 'resume',
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
  const [contextMenuOpen, setContextMenuOpenState, contextMenuOpenRef] = useSyncedBooleanState();
  const restoreMenuFocusRef = useRef(true);
  const menuFocusTargetRef = useRef<(() => HTMLElement | null) | null>(null);
  const previousListPickerRef = useRef(showListPicker);
  const cardRef = useRef<HTMLElement>(null);
  const launchOwnerMountedRef = useMountedRef();
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoringFocusRef = useRef(false);
  const hoverFocusRef = useRef(false);

  const clearExpandTimer = useCallback(() => clearTimer(expandTimer), []);

  const hasLockedCardInteraction = useCallback(
    () => showListPickerRef.current || createListOpenRef.current || contextMenuOpenRef.current,
    [contextMenuOpenRef, createListOpenRef, showListPickerRef],
  );

  const collapseCard = useCallback(() => {
    clearExpandTimer();
    lastCardCollapseAt = Date.now();
    setExpanded(false);
    setShowListPickerState(false);
  }, [clearExpandTimer, setShowListPickerState]);

  const handleContextMenuOpenChange = (open: boolean) => {
    setContextMenuOpenState(open);
    if (open) {
      restoreMenuFocusRef.current = true;
      menuFocusTargetRef.current = null;
      collapseCard();
    }
  };

  const handleContextMenuCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    if (!restoreMenuFocusRef.current) return;
    restoringFocusRef.current = true;
    (
      menuFocusTargetRef.current?.() ??
      cardRef.current?.querySelector<HTMLElement>('[data-media-card-poster]')
    )?.focus({ preventScroll: true });
    restoringFocusRef.current = false;
  };

  const prepareRemovalFocus = () => {
    const card = cardRef.current;
    const collection = card?.closest<HTMLElement>(
      '[data-media-scroller], [data-collection-selection]',
    );
    if (
      card &&
      collection &&
      (contextMenuOpenRef.current || card.contains(document.activeElement))
    ) {
      const cards = Array.from(collection.querySelectorAll('article'));
      const index = cards.indexOf(card);
      const nextHref = cards[index + 1]
        ?.querySelector('[data-media-card-poster]')
        ?.getAttribute('href');
      const previousHref = cards[index - 1]
        ?.querySelector('[data-media-card-poster]')
        ?.getAttribute('href');
      const section =
        collection.closest<HTMLElement>('[data-resume-section], [role="tabpanel"]') ?? collection;
      let headingScope: HTMLElement | null = section;
      while (headingScope && !headingScope.querySelector('h1, h2')) {
        headingScope = headingScope.parentElement;
      }
      const heading = headingScope?.querySelector<HTMLElement>('h1, h2');
      const resolveTarget = () => {
        const posters = Array.from(
          collection.querySelectorAll<HTMLElement>('[data-media-card-poster]'),
        );
        const target =
          posters.find((poster) => poster.getAttribute('href') === nextHref) ??
          posters.find((poster) => poster.getAttribute('href') === previousHref) ??
          collection.querySelector<HTMLElement>('input') ??
          (heading?.isConnected ? heading : section);
        if (!target.isConnected) return null;
        if (target.tabIndex < 0) target.tabIndex = -1;
        return target;
      };
      if (contextMenuOpenRef.current) {
        menuFocusTargetRef.current = resolveTarget;
      } else {
        resolveTarget()?.focus({ preventScroll: true });
      }
    }
  };

  const handleRemoveFromHistory = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    prepareRemovalFocus();
    onRemoveFromContinue?.(event);
    collapseCard();
  };

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
    if (selectionMode || expanded || restoringFocusRef.current || contextMenuOpenRef.current)
      return;
    // Hover focus can inherit an earlier keyboard ring; track its owner here.
    hoverFocusRef.current = !cardRef.current?.contains(document.activeElement);
    clearExpandTimer();
    const delay =
      Date.now() - lastCardCollapseAt < HOVER_CHAIN_WINDOW_MS
        ? HOVER_CHAIN_DELAY_MS
        : HOVER_EXPAND_DELAY_MS;
    expandTimer.current = setTimeout(() => {
      void routeChunks.details().catch(() => undefined);
      warmPlayerChunk();
      setPopoverAlign(resolvePopoverAlign());
      setExpanded(true);
      expandTimer.current = null;
    }, delay);
  }, [clearExpandTimer, contextMenuOpenRef, expanded, resolvePopoverAlign, selectionMode]);

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

  // The open picker locks hover/blur collapse, so interaction elsewhere must dismiss it.
  useEffect(() => {
    if (!showListPicker) return;
    const dismissOutside = (event: Event) => {
      if (createListOpenRef.current) return;
      if (event.target instanceof Node && !cardRef.current?.contains(event.target)) collapseCard();
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside);
    };
  }, [collapseCard, createListOpenRef, showListPicker]);

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

  useLayoutEffect(() => {
    const pickerChanged = previousListPickerRef.current !== showListPicker;
    previousListPickerRef.current = showListPicker;
    if (!expanded || !pickerChanged) return;
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
    <ContextMenu open={contextMenuOpen} onOpenChange={handleContextMenuOpenChange}>
      <ContextMenuTrigger asChild disabled={selectionMode}>
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <article
          ref={cardRef}
          data-media-card-expanded={(!selectionMode && expanded) || undefined}
          className={cn('group/card relative', !selectionMode && expanded && 'z-30')}
          aria-label={item.title}
          onMouseEnter={scheduleExpand}
          onMouseLeave={handleMouseLeave}
          onFocus={scheduleExpand}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
        >
          <div className={cn(!selectionMode && expanded && 'pointer-events-none opacity-0')}>
            <MediaCardPoster
              currentStatus={currentStatus}
              detailsRouteType={detailsRouteType}
              expanded={!selectionMode && expanded}
              isPlayPending={isPlayPending}
              item={item}
              metaLine={metaLine}
              onPlay={onPlay}
              playbackIntent={playbackIntent}
              onPrefetchDetails={onPlay ? undefined : prefetchDetails}
              progress={safeProgress}
              subtitle={subtitle}
              selectionMode={selectionMode}
              isSelected={isSelected}
              onToggleSelect={onToggleSelect}
            />
          </div>

          {!selectionMode && (expanded || contextMenuOpen) && (
            <MediaCardOverlay
              contextMenu={
                contextMenuOpen
                  ? {
                      onCloseAutoFocus: handleContextMenuCloseAutoFocus,
                      onInteractOutside: () => {
                        restoreMenuFocusRef.current = false;
                      },
                      onOpenChange: handleContextMenuOpenChange,
                      onRemove: prepareRemovalFocus,
                    }
                  : undefined
              }
              createListOpen={createListOpen}
              currentStatus={currentStatus}
              detailsRouteType={detailsRouteType}
              isInLibraryOverride={isInLibraryOverride}
              isPlayPending={isPlayPending}
              item={item}
              launchOwnerMountedRef={launchOwnerMountedRef}
              metaLine={metaLine}
              onCreateListOpenChange={handleCreateListOpenChange}
              onPlay={onPlay}
              playbackIntent={playbackIntent}
              onRemoveFromContinue={onRemoveFromContinue ? handleRemoveFromHistory : undefined}
              onToggleListPicker={toggleListPicker}
              popoverAlign={popoverAlign}
              progress={safeProgress}
              showListPicker={showListPicker}
              subtitle={subtitle}
            />
          )}
        </article>
      </ContextMenuTrigger>
    </ContextMenu>
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
