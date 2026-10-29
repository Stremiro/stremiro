import { useQuery } from '@tanstack/react-query';
import {
  Bookmark,
  Check,
  ChevronLeft,
  Info,
  Library,
  Link2,
  Play,
  SkipForward,
  Star,
  Trash2,
} from 'lucide-react';
import {
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  lazy,
  memo,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { currentPathWithSearch, navigateOnAnchorClick, navigateToDetails } from '@/lib/navigation';
import { HoverTrailerPreview } from '@/components/hover-trailer-preview';
import { InlineMenu, INLINE_MENU_EXIT_MS } from '@/components/inline-menu';
import { CreateListDialog } from '@/components/list/list-editor-dialog';
import { RemoteImage } from '@/components/remote-image';
import { SaveIndicator } from '@/components/ui/button';
import { WatchProgressStrip } from '@/components/watch-progress-strip';
import { SelectionCheck, WatchStatusIcon } from '@/components/watch-status-icon';
import { useTrailerPreviews } from '@/hooks/use-app-ui-preferences';
import { useDelayedUnmount } from '@/hooks/use-delayed-unmount';
import {
  useIsItemInLibrary,
  useLibraryMembership,
  useItemWatchStatus,
  useMediaResumeEntry,
  useListSummaries,
  useMediaCollectionActions,
} from '@/hooks/use-media-library';
import { useMediaPrimaryPlayback } from '@/hooks/use-media-primary-playback';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { usePointerIdle } from '@/hooks/use-pointer-idle';
import { usePrefetchDetails } from '@/hooks/use-prefetch-details';
import { api, type MediaItem, WATCH_STATUS_LABELS, type WatchStatus } from '@/lib/api';
import { buildTitleShareLink } from '@/lib/app-links';
import { pendingDetailsPrefetch } from '@/lib/details-prefetch';
import {
  buildDetailsRoute,
  resolvePlayerRouteMediaType,
  type PlayerRouteMediaType,
} from '@/lib/player-navigation';
import { copyText } from '@/lib/notify';
import { usePlayerSession } from '@/lib/player-session';
import { routeChunks, warmPlayerChunk } from '@/lib/route-chunks';
import { searchGenrePath } from '@/lib/search-page-state';
import {
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

function ratingToneClassName(score: number) {
  if (score >= 70) return 'bg-emerald-400/[0.12] text-emerald-300 ring-emerald-300/20';
  if (score >= 50) return 'bg-amber-400/[0.12] text-amber-200 ring-amber-300/20';
  return 'bg-rose-400/[0.12] text-rose-300 ring-rose-300/20';
}

// Dwell gates addon requests; recently collapsed cards allow faster rail hops.
const HOVER_EXPAND_DELAY_MS = 180;
const HOVER_CHAIN_DELAY_MS = 70;
const HOVER_CHAIN_WINDOW_MS = 1200;
let lastCardCollapseAt = 0;
const MIN_PROGRESS_BAR_PERCENT = 2;
const POPOUT_WIDTH_PX = 270;
const POPOUT_EXIT_MS = 100;
// Bounds embeds spent on titles whose first trailers refuse embedding.
const MAX_TRAILER_ATTEMPTS = 3;
const TRAILER_ARM_MS = 100;

// Resting slot width shared by home rails and browse grids — cards render pixel-identical before hover.
export const MEDIA_CARD_SLOT_CLASS_NAME = 'w-[170px] md:w-[190px]';

// Includes the 6px top margin; reserve room for status before its query resolves.
export const MEDIA_CARD_TEXT_BLOCK_HEIGHT_PX = 82;
const MEDIA_CARD_TEXT_BLOCK_CLASS_NAME = 'mt-1.5 min-h-[76px] px-0.5 space-y-1';
const CARD_ICON_BUTTON_CLASS_NAME =
  'group/collection flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 not-aria-disabled:active:bg-white/[0.16] motion-reduce:transition-none';
const CARD_INACTIVE_ICON_BUTTON_CLASS_NAME =
  'border-white/[0.08] bg-white/[0.06] text-zinc-300 hover:bg-white/[0.12] hover:text-white';
type CardPanel = 'details' | 'menu' | 'lists';

// Shared rail callbacks for plain MediaCard rows — stable identities keep HorizontalMediaRail's memo from re-running.
export const mediaCardRailKey = (item: MediaItem) => `${item.type}:${item.id}`;
export const renderMediaCardRailItem = (item: MediaItem) => <MediaCard item={item} />;

type PopoverAlign = 'left' | 'center' | 'right';
export type PlaybackIntent = 'resume' | 'next-episode' | 'replay';

const PLAYBACK_INTENT_VERB: Record<PlaybackIntent, string> = {
  resume: 'Resume',
  'next-episode': 'Play',
  replay: 'Play again',
};

interface MediaCardProps {
  item: MediaItem;
  currentStatusOverride?: WatchStatus | null;
  isInLibraryOverride?: boolean;
  /** Resting "In Library" line for unstatused saved titles; opt-in so most cards skip the library observer. */
  showLibraryMark?: boolean;
  progress?: number;
  isNewEpisode?: boolean;
  /** Below-title resume line ("S1:E2 · 24m left") — plain string so memo holds. */
  metaLine?: string;
  onPlay?: (event: ReactMouseEvent) => void | Promise<void>;
  playbackIntent?: PlaybackIntent;
  isPlayPending?: boolean;
  onRemoveFromContinue?: (event: ReactMouseEvent) => void;
  /** Surface the remove action names ("Remove from …"). */
  removeFrom?: string;
  /** Resume-row menu extras; their presence replaces the library rows the panel already shows. */
  onPlayNext?: () => void;
  onMarkWatched?: () => void;
  subtitle?: string;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (item: MediaItem, shiftKey?: boolean) => void;
}

function ResumeProgressBar({
  progress,
  animateEntrance = false,
  hidden = false,
  remaining,
}: {
  progress?: number;
  animateEntrance?: boolean;
  hidden?: boolean;
  /** Popout artwork hover thickens the strip and names the time left above it. */
  remaining?: { label: string; hidden: boolean };
}) {
  if (progress === undefined || progress < MIN_PROGRESS_BAR_PERCENT) return null;
  return (
    <>
      {remaining && (
        <span
          aria-hidden='true'
          className={cn(
            'pointer-events-none absolute bottom-3 right-2.5 z-20 rounded-[5px] bg-black/60 px-1.5 py-1 text-[11px] font-semibold leading-none tabular-nums text-white/90 opacity-0 backdrop-blur-xs transition-opacity duration-300 group-hover/artwork:opacity-100 motion-reduce:transition-none',
            remaining.hidden && 'group-hover/artwork:opacity-0',
          )}
        >
          {remaining.label}
        </span>
      )}
      <WatchProgressStrip
        percent={progress}
        animateEntrance={animateEntrance}
        className={cn(
          'z-20 h-1',
          remaining &&
            'transition-[height,opacity] duration-200 ease-out group-hover/artwork:h-1.5 motion-reduce:transition-none',
          hidden && 'opacity-0',
        )}
      />
    </>
  );
}

function NewEpisodeBadge({ hidden = false }: { hidden?: boolean }) {
  return (
    <span
      className={cn(
        'pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-1.5 rounded-md border border-white/15 bg-zinc-950/85 px-2 py-1 text-[10px] font-medium leading-none text-zinc-100 shadow-sm backdrop-blur-sm transition-opacity duration-300 motion-reduce:transition-none',
        hidden && 'opacity-0',
      )}
    >
      <span aria-hidden='true' className='h-1 w-1 rounded-full bg-(--accent-nav)' />
      New episode
    </span>
  );
}

function PlaybackPendingOverlay() {
  return (
    <div
      role='status'
      aria-live='polite'
      className='pointer-events-none absolute inset-0 z-20 bg-linear-to-t from-black/90 via-black/35 to-transparent animate-in fade-in duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none'
    >
      <span className='absolute bottom-3 left-3 text-[11.5px] font-medium leading-none text-white/90'>
        Opening…
      </span>
      <div
        aria-hidden='true'
        className='absolute inset-x-0 bottom-0 h-px overflow-hidden bg-white/[0.08]'
      >
        <div className='h-full w-1/3 bg-(--accent-prog) motion-safe:animate-[progress-slide_1.6s_linear_infinite]' />
      </div>
    </div>
  );
}

interface MediaCardPosterProps {
  currentStatus: WatchStatus | null;
  inLibrary: boolean;
  detailsRouteType: PlayerRouteMediaType;
  expanded: boolean;
  expandedContentId: string;
  isNewEpisode?: boolean;
  isPlayPending?: boolean;
  item: MediaItem;
  metaLine?: string;
  onPlay?: (event: ReactMouseEvent) => void | Promise<void>;
  playbackIntent: PlaybackIntent;
  onPrefetchDetails?: () => void;
  progress?: number;
  subtitle?: string;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (item: MediaItem, shiftKey?: boolean) => void;
}

function MediaCardPoster({
  currentStatus,
  inLibrary,
  detailsRouteType,
  expanded,
  expandedContentId,
  isNewEpisode,
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
        `${playbackIntent === 'next-episode' ? 'Play next episode of' : PLAYBACK_INTENT_VERB[playbackIntent]} ${item.title}`,
        subtitle,
        metaLine,
        isNewEpisode ? 'New episode' : undefined,
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
      <div
        data-details-artwork
        className='group/artwork relative aspect-2/3 overflow-hidden rounded-lg bg-zinc-900'
      >
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
        {isNewEpisode && <NewEpisodeBadge />}
        {selectionMode && (
          <SelectionCheck
            selected={isSelected}
            className={cn(
              'absolute top-2.5 z-20 size-6 rounded-lg transition-[color,background-color,border-color,box-shadow,scale] duration-150 [&_svg]:size-3.5',
              isNewEpisode ? 'right-2.5' : 'left-2.5',
              isSelected
                ? 'shadow-md scale-100'
                : 'border-white/30 bg-black/65 group-hover:border-white/60',
            )}
          />
        )}

        {subtitle && (
          <div className='absolute bottom-1.5 left-1.5 z-10 max-w-[calc(100%-12px)] rounded-[5px] border border-white/10 bg-black/75 px-1.5 py-1 text-[10.5px] font-semibold leading-none tabular-nums text-white/90'>
            {subtitle}
          </div>
        )}

        <ResumeProgressBar
          progress={progress}
          animateEntrance={Boolean(onPlay) && !selectionMode}
          hidden={isPlayPending}
          remaining={metaLine?.endsWith('left') ? { label: metaLine, hidden: false } : undefined}
        />
        {!selectionMode && !expanded && isPlayPending && <PlaybackPendingOverlay />}
      </div>
    </div>
  );
  // Fade-through: resting text never crossfades with the popout's differently sized text.
  const textBlock = (
    <div
      className={cn(
        MEDIA_CARD_TEXT_BLOCK_CLASS_NAME,
        'transition-opacity motion-reduce:transition-none',
        expanded ? 'opacity-0 duration-0' : 'duration-150 delay-100 ease-out',
      )}
    >
      <p
        dir='auto'
        title={item.title}
        className='line-clamp-2 min-h-9 [overflow-wrap:anywhere] text-[14px] font-medium leading-[18px] tracking-[-0.01em] text-zinc-100'
      >
        {item.title}
      </p>
      {metaLine ? (
        <p
          title={metaLine}
          className='truncate text-[13px] font-normal leading-4 tabular-nums text-zinc-400'
        >
          {metaLine}
        </p>
      ) : item.displayYear ? (
        <p className='text-[13px] font-normal leading-4 text-zinc-400'>{item.displayYear}</p>
      ) : null}
      {currentStatus ? (
        <p className='flex items-center gap-1.5 text-[13px] font-medium leading-4 text-zinc-400'>
          <WatchStatusIcon status={currentStatus} className='size-3.5' strokeWidth={2.1} />
          {WATCH_STATUS_LABELS[currentStatus]}
        </p>
      ) : inLibrary ? (
        <p className='flex items-center gap-1.5 text-[13px] font-medium leading-4 text-zinc-400'>
          <Library aria-hidden='true' className='size-3.5' strokeWidth={2.1} />
          In Library
        </p>
      ) : null}
    </div>
  );

  if (selectionMode) {
    return (
      <button
        type='button'
        aria-label={`${isSelected ? 'Deselect' : 'Select'} ${item.title}`}
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
        aria-controls={expanded ? expandedContentId : undefined}
        aria-busy={isPlayPending || undefined}
        className='block relative rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background'
        onClick={(event) => {
          if (event.detail === 0) onPrefetchDetails?.();
          void onPlay?.(event);
          navigateToDetails(
            event,
            detailsPath,
            { state: { from: currentPathWithSearch() } },
            event.currentTarget.querySelector<HTMLElement>('[data-details-artwork]'),
          );
        }}
        onFocus={onPrefetchDetails}
        onPointerEnter={(event) => {
          if (!onPlay && event.pointerType !== 'touch')
            void routeChunks.details().catch(() => undefined);
        }}
        onPointerDown={onPrefetchDetails}
      >
        {poster}
        {!onPlay && textBlock}
      </a>
      {onPlay && textBlock}
    </>
  );
}

function useSyncedState<T>(initialState: T) {
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state);

  const setSyncedState = useCallback((nextState: T) => {
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  return [state, setSyncedState, stateRef] as const;
}

interface MediaCardActionOptions {
  detailsRouteType: PlayerRouteMediaType;
  /** Set only when the caller already knows membership (library tab) — otherwise the surface resolves it on mount. */
  isInLibraryOverride?: boolean;
  isPlayPending?: boolean;
  item: MediaItem;
  launchOwnerMountedRef: RefObject<boolean>;
  onLibraryRemove: () => void;
  onPlay?: (event: ReactMouseEvent) => void | Promise<void>;
  playbackIntent: PlaybackIntent;
  subtitle?: string;
}

// Mounted with the overlay only, so resting cards stay free of the history/library observers and playback hook chain.
function useMediaCardActions({
  detailsRouteType,
  isInLibraryOverride,
  isPlayPending = false,
  item,
  launchOwnerMountedRef,
  onLibraryRemove,
  onPlay,
  playbackIntent,
  subtitle,
}: MediaCardActionOptions) {
  // Where the user opened the surface — read once at mount so it holds no location subscription.
  const [from] = useState(currentPathWithSearch);
  const detailsPath = buildDetailsRoute(detailsRouteType, item.id);

  const historyQuery = useMediaResumeEntry(item.id, item.type, {
    enabled: !onPlay,
  });

  const { isInLibrary, libraryActionLabel, libraryError, libraryReady } = useLibraryMembership(
    item.id,
    isInLibraryOverride,
  );

  const collectionActions = useMediaCollectionActions({
    item,
    isInLibrary,
  });
  const { toggleLibrary } = collectionActions;
  const primaryPlayback = useMediaPrimaryPlayback({
    from,
    historyEntry: historyQuery.data,
    item,
    launchOwnerMountedRef,
    surface: 'card',
  });

  const primaryActionLabel = onPlay
    ? subtitle
      ? `${PLAYBACK_INTENT_VERB[playbackIntent]} ${subtitle}`
      : playbackIntent === 'next-episode'
        ? 'Play next episode'
        : PLAYBACK_INTENT_VERB[playbackIntent]
    : primaryPlayback.primaryActionLabel;
  const needsHistory =
    !onPlay && !primaryPlayback.canReturnToActivePlayer && !historyQuery.isSuccess;
  const isPrimaryPending =
    isPlayPending ||
    primaryPlayback.isResolvingPrimaryAction ||
    (needsHistory && (historyQuery.isPending || historyQuery.isFetching));

  const handlePrimaryAction = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isPrimaryPending) return;
    if (onPlay) {
      void onPlay(e);
      return;
    }

    if (needsHistory) {
      void historyQuery.refetch();
      return;
    }
    void primaryPlayback.handlePrimaryAction();
  };

  const handleToggleLibrary = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!libraryReady || toggleLibrary.isPending) return;
    if (isInLibrary && isInLibraryOverride) onLibraryRemove();
    toggleLibrary.mutate();
  };

  return {
    collectionActions,
    detailsPath,
    from,
    handlePrimaryAction,
    handleToggleLibrary,
    isInLibrary,
    isPrimaryPending,
    libraryActionLabel,
    libraryError,
    libraryReady,
    primaryActionLabel,
  };
}

interface MediaCardOverlayProps extends MediaCardActionOptions {
  exiting: boolean;
  expandedContentId: string;
  isNewEpisode?: boolean;
  createListOpen: boolean;
  currentStatus: WatchStatus | null;
  metaLine?: string;
  onCreateListOpenChange: (open: boolean) => void;
  onMarkWatched?: () => void;
  onPanelChange: (panel: CardPanel) => void;
  onPlayNext?: () => void;
  onRemoveFromContinue?: (event: ReactMouseEvent) => void;
  onToggleListPicker: (event: ReactMouseEvent) => void;
  panel: CardPanel;
  popoverAlign: PopoverAlign;
  progress?: number;
  removeFrom: string;
}

// Expanded-only surface — resting cards stay free of the details/lists/history observers and playback hook chain.
function MediaCardOverlay({
  exiting,
  expandedContentId,
  isNewEpisode,
  createListOpen,
  currentStatus,
  metaLine,
  onCreateListOpenChange,
  onMarkWatched,
  onPanelChange,
  onPlayNext,
  onRemoveFromContinue,
  onToggleListPicker,
  panel,
  popoverAlign,
  progress,
  removeFrom,
  ...actionOptions
}: MediaCardOverlayProps) {
  const { detailsRouteType, item, onPlay } = actionOptions;
  const {
    collectionActions,
    detailsPath,
    from,
    handlePrimaryAction,
    handleToggleLibrary,
    isInLibrary,
    isPrimaryPending,
    libraryActionLabel,
    libraryError,
    libraryReady,
    primaryActionLabel,
  } = useMediaCardActions(actionOptions);
  const { addItemToNewList, toggleLibrary } = collectionActions;

  // The id guard avoids a doomed IPC (Rust rejects empty ids); card payload only — hover never needs episodes.
  const { data: details, isLoading: isDetailsLoading } = useQuery({
    ...api.cardDetailsQueryOptions(detailsRouteType, item.id),
    queryFn: async (context) =>
      (await pendingDetailsPrefetch(detailsRouteType, item.id))?.details ??
      api.cardDetailsQueryOptions(detailsRouteType, item.id).queryFn!(context),
    enabled: !!item.id.trim(),
  });
  const artworkRef = useRef<HTMLDivElement>(null);

  const { data: lists } = useListSummaries(item.id);

  const ratingScore = details?.ratingPercent;

  const [trailerIndex, setTrailerIndex] = useState(0);
  const skipTrailer = useCallback(() => setTrailerIndex((index) => index + 1), []);
  const trailerVideoId =
    trailerIndex < MAX_TRAILER_ATTEMPTS ? details?.trailers?.[trailerIndex]?.id : undefined;
  // Reduced-motion CSS cannot stop playback inside an iframe.
  const { session } = usePlayerSession();
  const trailersEnabled = useTrailerPreviews() && !session && !prefersReducedMotion();

  // A still pointer over a playing trailer fades the remaining artwork chrome.
  const [trailerShowing, setTrailerShowing] = useState(false);
  const { idle: pointerIdle, wake: wakePointer } = usePointerIdle();
  useEffect(() => wakePointer(), [wakePointer]);
  const hideArtworkChrome = trailersEnabled && trailerShowing && pointerIdle;
  const menu = useDelayedUnmount(panel === 'menu', INLINE_MENU_EXIT_MS);
  const closeMenu = () => onPanelChange('details');
  const hasResumeActions = !!(onPlayNext || onMarkWatched);

  // A second dwell avoids mounting expensive embeds during quick card hops.
  const [trailerArmed, setTrailerArmed] = useState(false);
  useEffect(() => {
    setTrailerArmed(false);
    setTrailerShowing(false);
    if (!trailerVideoId || !trailersEnabled) return;
    const timer = window.setTimeout(() => setTrailerArmed(true), TRAILER_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [trailerVideoId, trailersEnabled]);

  // Metadata artwork fades in over the catalog artwork instead of swapping under the cursor.
  const backdropLayers = [...new Set([item.backdrop, details?.backdrop].filter(isHttpUrl))];
  if (!backdropLayers.length && !isDetailsLoading && isHttpUrl(item.poster)) {
    backdropLayers.push(item.poster);
  }

  const isInAnyList = lists?.some((list) => list.contains_item) ?? false;

  return (
    <>
      {/* Center without transforming the text layer. */}
      <div
        id={expandedContentId}
        role='group'
        aria-label={`Actions for ${item.title}`}
        inert={exiting}
        className={cn(
          'absolute top-0 z-20 flex max-w-[86vw] origin-top select-none flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-950 shadow-[0_24px_70px_-12px_rgba(0,0,0,0.85)] ring-1 ring-black/40 -outline-offset-2 group-has-[[data-media-card-poster]:focus-visible]/card:outline-2 group-has-[[data-media-card-poster]:focus-visible]/card:outline-white/40 motion-reduce:animate-none',
          exiting ? 'pointer-events-none animate-surface-out' : 'animate-surface-in',
          popoverAlign === 'left' && 'left-0',
          popoverAlign === 'right' && 'right-0',
          popoverAlign === 'center' && 'left-1/2',
        )}
        style={{
          width: POPOUT_WIDTH_PX,
          marginLeft: popoverAlign === 'center' ? -POPOUT_WIDTH_PX / 2 : undefined,
        }}
        onPointerMove={wakePointer}
      >
        <div
          ref={artworkRef}
          className='group/artwork relative aspect-16/9 w-full shrink-0 overflow-hidden bg-zinc-900'
        >
          {backdropLayers.map((src, index) => (
            <RemoteImage
              key={src}
              src={src}
              fallbackSrc={index === 0 && isHttpUrl(item.poster) ? item.poster : undefined}
              alt=''
              className='absolute inset-0 h-full w-full object-cover'
              loading='lazy'
              fadeIn
            />
          ))}
          {trailerVideoId && trailerArmed && trailersEnabled && (
            <HoverTrailerPreview
              videoId={trailerVideoId}
              onUnavailable={skipTrailer}
              onRevealChange={setTrailerShowing}
            />
          )}
          <div className='pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-zinc-950 via-zinc-950/60 to-transparent' />
          {isNewEpisode && <NewEpisodeBadge hidden={hideArtworkChrome} />}
          <a
            href={detailsPath}
            className='absolute inset-0'
            tabIndex={-1}
            aria-hidden
            onClick={(event) => {
              void onPlay?.(event);
              navigateToDetails(event, detailsPath, { state: { from } }, artworkRef.current);
            }}
          />
          {isPrimaryPending ? (
            <PlaybackPendingOverlay />
          ) : (
            <ResumeProgressBar
              progress={progress}
              remaining={
                metaLine?.endsWith('left')
                  ? { label: metaLine, hidden: hideArtworkChrome }
                  : undefined
              }
            />
          )}
          {onRemoveFromContinue && (
            <button
              type='button'
              aria-label={`Remove ${item.title} from ${removeFrom}`}
              className={cn(
                'absolute right-2 top-2 z-10 flex h-9 w-9 items-center justify-center rounded-lg bg-black/55 text-zinc-300 backdrop-blur-xs transition-[color,background-color,opacity] duration-300 hover:bg-black/75 hover:text-red-300 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-none',
                hideArtworkChrome && 'opacity-0',
              )}
              onClick={onRemoveFromContinue}
            >
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          )}
        </div>

        <div className='relative flex flex-1 flex-col'>
          {panel === 'lists' ? (
            <div
              data-media-card-picker
              className='page-enter relative z-10 flex flex-1 flex-col p-2.5'
            >
              <div className='mb-1 flex shrink-0 items-center gap-1.5'>
                <button
                  type='button'
                  aria-label='Back to actions'
                  className='h-8 w-8 rounded-md flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/10 transition-colors duration-150 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30'
                  onClick={onToggleListPicker}
                >
                  <ChevronLeft className='h-3.5 w-3.5' />
                </button>
                <span className='text-[14px] font-semibold text-white'>Add to List</span>
              </div>

              <Suspense
                fallback={
                  <p role='status' className='p-3 text-[13px] leading-5 text-zinc-400'>
                    Loading lists…
                  </p>
                }
              >
                <SaveToCollectionPanel
                  item={item}
                  isInLibrary={isInLibrary}
                  actions={collectionActions}
                  onCreateList={() => onCreateListOpenChange(true)}
                />
              </Suspense>
            </div>
          ) : (
            <>
              <div
                inert={panel === 'menu'}
                className={cn(
                  'relative z-10 flex flex-col gap-2 p-3 pt-2.5 transition-opacity duration-150 ease-out motion-reduce:transition-none',
                  menu.mounted && 'opacity-0 duration-0',
                )}
              >
                <div className='flex items-start justify-between gap-2'>
                  <h3 className='min-w-0 flex-1 text-[14px] font-semibold leading-5 tracking-[-0.01em] text-white line-clamp-1'>
                    {currentStatus && (
                      <WatchStatusIcon
                        status={currentStatus}
                        className='mr-1.5 inline-block size-3.5 align-[-2px]'
                        strokeWidth={2.1}
                      />
                    )}
                    {/* Every other target on a resume card plays — the title link is the non-play path to details. */}
                    <a
                      href={detailsPath}
                      className='transition-colors hover:text-white/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40 rounded-xs'
                      onClick={(event) =>
                        navigateToDetails(
                          event,
                          detailsPath,
                          { state: { from } },
                          artworkRef.current,
                        )
                      }
                    >
                      {item.title}
                    </a>
                  </h3>
                  {ratingScore !== undefined && (
                    <span
                      className={cn(
                        'flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold leading-none tabular-nums ring-1 ring-inset animate-in fade-in duration-300',
                        ratingToneClassName(ratingScore),
                      )}
                    >
                      <Star aria-hidden='true' className='size-2.5 fill-current' />
                      {ratingScore}%
                    </span>
                  )}
                </div>

                <div className='flex items-center gap-1.5'>
                  <button
                    type='button'
                    data-media-card-primary
                    className='accent-lattice flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[14px] font-semibold tracking-[-0.005em] transition-colors duration-150 hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:scale-[0.98] aria-disabled:cursor-default aria-disabled:opacity-80'
                    onPointerEnter={warmPlayerChunk}
                    onFocus={warmPlayerChunk}
                    onClick={handlePrimaryAction}
                    aria-disabled={isPrimaryPending || undefined}
                    aria-busy={isPrimaryPending || undefined}
                  >
                    <Play aria-hidden='true' className='h-3.5 w-3.5 shrink-0 fill-current' />
                    <span className='truncate'>
                      {isPrimaryPending ? 'Opening…' : primaryActionLabel}
                    </span>
                  </button>

                  <button
                    type='button'
                    className={cn(
                      CARD_ICON_BUTTON_CLASS_NAME,
                      isInLibrary
                        ? 'accent-lattice-soft hover:bg-[rgb(var(--accent-act-rgb)/0.14)]'
                        : CARD_INACTIVE_ICON_BUTTON_CLASS_NAME,
                    )}
                    aria-label={libraryActionLabel}
                    aria-busy={
                      toggleLibrary.isPending || (!libraryReady && !libraryError) || undefined
                    }
                    // Disabling a focused control would blur and collapse the card.
                    aria-disabled={!libraryReady || toggleLibrary.isPending || undefined}
                    onClick={handleToggleLibrary}
                  >
                    <SaveIndicator saved={isInLibrary} className='size-3.5' />
                  </button>

                  <button
                    type='button'
                    className={cn(
                      CARD_ICON_BUTTON_CLASS_NAME,
                      isInAnyList
                        ? 'border-white/20 bg-white/[0.12] text-white hover:bg-white/[0.16]'
                        : CARD_INACTIVE_ICON_BUTTON_CLASS_NAME,
                    )}
                    aria-label='Add to List'
                    aria-pressed={isInAnyList}
                    aria-expanded={false}
                    onPointerEnter={warmSaveToCollectionPanel}
                    onFocus={warmSaveToCollectionPanel}
                    onClick={onToggleListPicker}
                  >
                    <Bookmark
                      aria-hidden='true'
                      className={cn(
                        'h-3.5 w-3.5 transition-[fill,color] duration-150 motion-reduce:transition-none',
                        isInAnyList
                          ? 'fill-current'
                          : 'fill-transparent group-hover/collection:fill-white/10',
                      )}
                    />
                  </button>
                </div>

                {/* One fixed-height line: genres arrive async, so a growing row would shift the
                  actions out from under the cursor. A genre that doesn't fit wraps out of view whole. */}
                <div className='flex h-4 flex-wrap content-start items-center gap-x-1.5 overflow-hidden text-[13px] font-medium leading-4 whitespace-nowrap text-zinc-400'>
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

                <p className='min-h-[60px] text-[13px] leading-5 text-zinc-400 line-clamp-3'>
                  {details?.description || item.description || 'No synopsis available yet.'}
                </p>
              </div>
              {/* Right-click crossfades the info panel into actions in place; the panel keeps its height. */}
              <InlineMenu
                presence={menu}
                label={`More actions for ${item.title}`}
                className='bg-zinc-950'
                onAction={closeMenu}
                actions={[
                  {
                    key: 'back',
                    label: 'Back',
                    icon: ChevronLeft,
                    muted: true,
                    onSelect: closeMenu,
                  },
                  {
                    key: 'play',
                    label: isPrimaryPending ? 'Opening…' : primaryActionLabel,
                    icon: Play,
                    iconClassName: 'fill-current',
                    disabled: isPrimaryPending,
                    onWarm: warmPlayerChunk,
                    onSelect: handlePrimaryAction,
                  },
                  onPlayNext && {
                    key: 'play-next',
                    label: 'Play next episode',
                    icon: SkipForward,
                    disabled: isPrimaryPending,
                    onWarm: warmPlayerChunk,
                    onSelect: onPlayNext,
                  },
                  onMarkWatched && {
                    key: 'mark-watched',
                    label: 'Mark watched',
                    icon: Check,
                    onSelect: onMarkWatched,
                  },
                  {
                    key: 'details',
                    label: 'Open details',
                    icon: Info,
                    href: detailsPath,
                    onSelect: (event) =>
                      navigateToDetails(
                        event,
                        detailsPath,
                        { state: { from } },
                        artworkRef.current,
                      ),
                  },
                  !hasResumeActions && {
                    key: 'library',
                    label: libraryActionLabel,
                    icon: Library,
                    disabled: !libraryReady || toggleLibrary.isPending,
                    onSelect: handleToggleLibrary,
                  },
                  !hasResumeActions && {
                    key: 'lists',
                    label: 'Add to list',
                    icon: Bookmark,
                    keepOpen: true,
                    onWarm: warmSaveToCollectionPanel,
                    onSelect: onToggleListPicker,
                  },
                  {
                    key: 'copy-link',
                    label: 'Copy link',
                    icon: Link2,
                    onSelect: () =>
                      void copyText(buildTitleShareLink(detailsRouteType, item.id), {
                        success: 'Title link copied',
                        successDetail: item.title,
                        failure: 'Could not copy title link',
                      }),
                  },
                  onRemoveFromContinue && {
                    key: 'remove',
                    label: `Remove from ${removeFrom}`,
                    icon: Trash2,
                    destructive: true,
                    onSelect: onRemoveFromContinue,
                  },
                ]}
              />
            </>
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
  showLibraryMark = false,
  progress,
  isNewEpisode,
  metaLine,
  onPlay,
  playbackIntent = 'resume',
  onRemoveFromContinue,
  removeFrom = 'watch history',
  onPlayNext,
  onMarkWatched,
  subtitle,
  isPlayPending = false,
  selectionMode = false,
  isSelected = false,
  onToggleSelect,
}: MediaCardProps) {
  const expandedContentId = useId();
  const detailsRouteType = resolvePlayerRouteMediaType(item.type);
  const prefetchDetails = usePrefetchDetails(item.id, item.type);

  const [expanded, setExpanded] = useState(false);
  const [popoverAlign, setPopoverAlign] = useState<PopoverAlign>('center');
  const [panel, setPanelState, panelRef] = useSyncedState<CardPanel>('details');
  const [createListOpen, setCreateListOpenState, createListOpenRef] = useSyncedState(false);
  const previousPanelRef = useRef(panel);
  const cardRef = useRef<HTMLElement>(null);
  const launchOwnerMountedRef = useMountedRef();
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoringFocusRef = useRef(false);
  const hoverFocusRef = useRef(false);

  const clearExpandTimer = useCallback(() => clearTimer(expandTimer), []);

  const hasLockedCardInteraction = () =>
    panelRef.current !== 'details' || createListOpenRef.current;

  const collapseCard = useCallback(() => {
    clearExpandTimer();
    lastCardCollapseAt = Date.now();
    setExpanded(false);
    setPanelState('details');
  }, [clearExpandTimer, setPanelState]);

  const prepareRemovalFocus = () => {
    const card = cardRef.current;
    const collection = card?.closest<HTMLElement>(
      '[data-media-scroller], [data-collection-selection]',
    );
    if (card && collection && card.contains(document.activeElement)) {
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
      resolveTarget()?.focus({ preventScroll: true });
    }
  };

  const handleRemoveFromHistory = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    prepareRemovalFocus();
    onRemoveFromContinue?.(event);
    collapseCard();
  };

  // A watched row leaves or advances in the rail, so focus moves on like a removal.
  const handleMarkWatched = () => {
    prepareRemovalFocus();
    onMarkWatched?.();
    collapseCard();
  };

  // Pin the popout toward the side with room, measured vs the rail scrollport or the window (grids).
  const resolvePopoverAlign = (): PopoverAlign => {
    const card = cardRef.current;
    if (!card) {
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
  };

  const expandCard = () => {
    clearExpandTimer();
    void routeChunks.details().catch(() => undefined);
    setPopoverAlign(resolvePopoverAlign());
    setExpanded(true);
  };

  const scheduleExpand = () => {
    // Escape restores poster focus without immediately reopening the card.
    if (selectionMode || expanded || restoringFocusRef.current) return;
    // Hover focus can inherit an earlier keyboard ring; track its owner here.
    hoverFocusRef.current = !cardRef.current?.contains(document.activeElement);
    clearExpandTimer();
    const delay =
      Date.now() - lastCardCollapseAt < HOVER_CHAIN_WINDOW_MS
        ? HOVER_CHAIN_DELAY_MS
        : HOVER_EXPAND_DELAY_MS;
    expandTimer.current = setTimeout(expandCard, delay);
  };

  // Right-click and the menu keys morph the popout's info panel into actions instead of a detached menu.
  const toggleCardMenu = () => {
    if (!expanded) expandCard();
    setPanelState(panelRef.current === 'menu' ? 'details' : 'menu');
  };

  // The menu is part of the hover surface; only the list picker outlives the pointer.
  const handleMouseLeave = () => {
    if (
      panelRef.current === 'lists' ||
      createListOpenRef.current ||
      (!hoverFocusRef.current && cardRef.current?.querySelector(':focus-visible'))
    )
      return;
    collapseCard();
  };

  const handleBlur = (event: ReactFocusEvent) => {
    if (hasLockedCardInteraction()) return;
    const nextFocus = event.relatedTarget;
    if (nextFocus instanceof Node && cardRef.current && cardRef.current.contains(nextFocus)) {
      hoverFocusRef.current = false;
      return;
    }
    // Pointer leave owns hovered cards: clicks on plain text hand focus to <main>, and unmounting or inert controls drop it.
    if (cardRef.current?.matches(':hover')) return;
    collapseCard();
  };

  useEffect(() => {
    return () => {
      clearExpandTimer();
    };
  }, [clearExpandTimer]);

  useEffect(() => {
    if (selectionMode) collapseCard();
  }, [selectionMode, collapseCard]);

  // The menu and picker lock blur collapse, so interaction elsewhere must dismiss them.
  useEffect(() => {
    if (panel === 'details') return;
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
  }, [collapseCard, createListOpenRef, panel]);

  const toggleListPicker = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPanelState(panelRef.current === 'lists' ? 'details' : 'lists');
  };

  const handleCreateListOpenChange = (open: boolean) => {
    setCreateListOpenState(open);
    if (!open) {
      // Restore the picker lock so the card stays expanded.
      setPanelState('lists');
    }
  };

  // The card isn't a [role="dialog"] — without this a keyboard-opened overlay leaks Esc to the global back
  // gesture. Collapses the menu or picker first, then the card; the portaled create-list dialog owns its own Esc via Radix.
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    if (
      !selectionMode &&
      (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggleCardMenu();
      return;
    }
    if (event.key !== 'Escape' || !expanded) return;
    if (createListOpenRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (panelRef.current !== 'details') {
      setPanelState('details');
      return;
    }
    collapseCard();
    // The overlay unmounts with its focused control — hand focus back to the poster link, not <body>.
    window.requestAnimationFrame(() => {
      restoringFocusRef.current = true;
      cardRef.current?.querySelector<HTMLElement>('a[href]')?.focus({ preventScroll: true });
      restoringFocusRef.current = false;
    });
  };

  useLayoutEffect(() => {
    const panelChanged = previousPanelRef.current !== panel;
    previousPanelRef.current = panel;
    if (!expanded || !panelChanged) return;
    // Pointer-opened menus take focus on the container so no row reads as preselected.
    const target = cardRef.current?.querySelector<HTMLElement>(
      panel === 'lists'
        ? '[data-media-card-picker] button'
        : panel === 'details'
          ? '[data-media-card-primary]'
          : hoverFocusRef.current
            ? '[data-inline-menu]'
            : '[data-inline-menu] [role="menuitem"] + [role="menuitem"]',
    );
    target?.focus({ preventScroll: true });
  }, [expanded, panel]);

  const { data: resolvedCurrentStatus = null } = useItemWatchStatus(item.id, {
    enabled: currentStatusOverride === undefined,
  });
  const currentStatus =
    currentStatusOverride !== undefined ? currentStatusOverride : resolvedCurrentStatus;
  const { data: inLibrary = false } = useIsItemInLibrary(item.id, { enabled: showLibraryMark });

  const overlay = useDelayedUnmount(!selectionMode && expanded, POPOUT_EXIT_MS);

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <article
      ref={cardRef}
      data-media-card-expanded={(!selectionMode && expanded) || undefined}
      className={cn('group/card relative', overlay.exiting ? 'z-20' : overlay.mounted && 'z-30')}
      aria-label={item.title}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') scheduleExpand();
      }}
      onPointerLeave={handleMouseLeave}
      onFocus={(event) => {
        if (event.target instanceof HTMLElement && event.target.matches(':focus-visible'))
          scheduleExpand();
      }}
      onBlur={handleBlur}
      onKeyDownCapture={() => {
        hoverFocusRef.current = false;
      }}
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => {
        // Portaled descendants (the create-list dialog) keep their own context menu.
        if (selectionMode || !event.currentTarget.contains(event.target as Node)) return;
        event.preventDefault();
        // Keyboard-raised context menus already toggled on keydown.
        if (event.button !== 2) return;
        hoverFocusRef.current = true;
        toggleCardMenu();
      }}
    >
      <div
        className={cn(
          'transition-opacity duration-150 ease-out motion-reduce:transition-none',
          !selectionMode && expanded && 'pointer-events-none opacity-0',
        )}
      >
        <MediaCardPoster
          currentStatus={currentStatus}
          inLibrary={showLibraryMark && inLibrary}
          detailsRouteType={detailsRouteType}
          expanded={!selectionMode && expanded}
          expandedContentId={expandedContentId}
          isNewEpisode={isNewEpisode}
          isPlayPending={isPlayPending}
          item={item}
          metaLine={metaLine}
          onPlay={onPlay}
          playbackIntent={playbackIntent}
          onPrefetchDetails={onPlay ? undefined : prefetchDetails}
          progress={progress}
          subtitle={subtitle}
          selectionMode={selectionMode}
          isSelected={isSelected}
          onToggleSelect={onToggleSelect}
        />
      </div>

      {overlay.mounted && (
        <MediaCardOverlay
          exiting={overlay.exiting}
          expandedContentId={expandedContentId}
          isNewEpisode={isNewEpisode}
          createListOpen={createListOpen}
          currentStatus={currentStatus}
          detailsRouteType={detailsRouteType}
          isInLibraryOverride={isInLibraryOverride}
          isPlayPending={isPlayPending}
          item={item}
          launchOwnerMountedRef={launchOwnerMountedRef}
          metaLine={metaLine}
          onCreateListOpenChange={handleCreateListOpenChange}
          onLibraryRemove={prepareRemovalFocus}
          onMarkWatched={onMarkWatched ? handleMarkWatched : undefined}
          onPanelChange={setPanelState}
          onPlay={onPlay}
          onPlayNext={onPlayNext}
          panel={panel}
          playbackIntent={playbackIntent}
          onRemoveFromContinue={onRemoveFromContinue ? handleRemoveFromHistory : undefined}
          onToggleListPicker={toggleListPicker}
          popoverAlign={popoverAlign}
          progress={progress}
          removeFrom={removeFrom}
          subtitle={subtitle}
        />
      )}
    </article>
  );
});

export function MediaCardSkeleton() {
  return (
    <div aria-hidden='true' className='animate-pulse motion-reduce:animate-none'>
      <div className='aspect-2/3 rounded-lg border border-white/5 bg-zinc-900/50' />
      <div className={MEDIA_CARD_TEXT_BLOCK_CLASS_NAME}>
        <div className='h-9 space-y-1'>
          <div className='h-4 w-3/4 rounded-md bg-zinc-900/40' />
          <div className='h-4 w-1/2 rounded-md bg-zinc-900/30' />
        </div>
        <div className='h-4 w-1/3 rounded-md bg-zinc-900/30' />
      </div>
    </div>
  );
}
