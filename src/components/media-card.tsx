import { useQuery } from '@tanstack/react-query';
import { Bookmark, ChevronLeft, Play, Trash2 } from 'lucide-react';
import {
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  lazy,
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  Suspense,
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { currentPathWithSearch, navigateOnAnchorClick, navigateToDetails } from '@/lib/navigation';
import { HoverTrailerPreview } from '@/components/hover-trailer-preview';
import { CreateListDialog } from '@/components/list/list-editor-dialog';
import { RemoteImage } from '@/components/remote-image';
import { SaveIndicator } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { WatchProgressStrip } from '@/components/watch-progress-strip';
import { SelectionCheck, WatchStatusIcon } from '@/components/watch-status-icon';
import { useTrailerPreviews } from '@/hooks/use-app-ui-preferences';
import { useDelayedUnmount } from '@/hooks/use-delayed-unmount';
import {
  useLibraryMembership,
  useItemWatchStatus,
  useMediaResumeEntry,
  useListSummaries,
  useMediaCollectionActions,
} from '@/hooks/use-media-library';
import { useMediaPrimaryPlayback } from '@/hooks/use-media-primary-playback';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { usePrefetchDetails } from '@/hooks/use-prefetch-details';
import { api, type MediaItem, WATCH_STATUS_LABELS, type WatchStatus } from '@/lib/api';
import { pendingDetailsPrefetch } from '@/lib/details-prefetch';
import {
  buildDetailsRoute,
  resolvePlayerRouteMediaType,
  type PlayerRouteMediaType,
} from '@/lib/player-navigation';
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
const POPOUT_EXIT_MS = 100;

// Resting slot width shared by home rails and browse grids — cards render pixel-identical before hover.
export const MEDIA_CARD_SLOT_CLASS_NAME = 'w-[170px] md:w-[190px]';

// Includes the 6px top margin; reserve room for status before its query resolves.
export const MEDIA_CARD_TEXT_BLOCK_HEIGHT_PX = 82;
const MEDIA_CARD_TEXT_BLOCK_CLASS_NAME = 'mt-1.5 min-h-[76px] px-0.5 space-y-1';
const CARD_ICON_BUTTON_CLASS_NAME =
  'group/collection flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 not-aria-disabled:active:bg-white/[0.16] motion-reduce:transition-none';
const CARD_INACTIVE_ICON_BUTTON_CLASS_NAME =
  'border-white/[0.08] bg-white/[0.06] text-zinc-300 hover:bg-white/[0.12] hover:text-white';

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
  subtitle?: string;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (item: MediaItem, shiftKey?: boolean) => void;
}

function ResumeProgressBar({
  progress,
  animateEntrance = false,
  hidden = false,
}: {
  progress?: number;
  animateEntrance?: boolean;
  hidden?: boolean;
}) {
  if (progress === undefined || progress < MIN_PROGRESS_BAR_PERCENT) return null;
  return (
    <WatchProgressStrip
      percent={progress}
      animateEntrance={animateEntrance}
      className={cn('z-20 h-1', hidden && 'opacity-0')}
    />
  );
}

function NewEpisodeBadge() {
  return (
    <span className='pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-1.5 rounded-md border border-white/15 bg-zinc-950/85 px-2 py-1 text-[10px] font-medium leading-none text-zinc-100 shadow-sm backdrop-blur-sm'>
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
        className='relative aspect-2/3 rounded-lg overflow-hidden bg-zinc-900'
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
        />
        {!selectionMode && !expanded && isPlayPending && <PlaybackPendingOverlay />}
      </div>
    </div>
  );
  const textBlock = (
    <div className={MEDIA_CARD_TEXT_BLOCK_CLASS_NAME}>
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
      {currentStatus && (
        <p className='flex items-center gap-1.5 text-[13px] font-medium leading-4 text-zinc-400'>
          <WatchStatusIcon status={currentStatus} className='size-3.5' strokeWidth={2.1} />
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

// Shared by the hover overlay and the context menu — both mount on demand, so resting cards stay free of the
// history/library observers and playback hook chain.
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

interface MediaCardMenuTarget extends MediaCardActionOptions {
  onCloseAutoFocus: (event: Event) => void;
  onInteractOutside: () => void;
  onOpenChange: (open: boolean) => void;
  onRemoveFromContinue?: (event: ReactMouseEvent) => void;
  removeFrom: string;
}

function MediaCardMenu({
  onClose,
  onClosed,
  target,
}: {
  onClose: () => void;
  onClosed: () => void;
  target: MediaCardMenuTarget;
}) {
  const {
    collectionActions,
    detailsPath,
    from,
    handlePrimaryAction,
    handleToggleLibrary,
    isPrimaryPending,
    libraryActionLabel,
    libraryReady,
    primaryActionLabel,
  } = useMediaCardActions(target);
  const { onRemoveFromContinue, removeFrom } = target;

  return (
    <ContextMenuContent
      onCloseAutoFocus={(event) => {
        target.onCloseAutoFocus(event);
        onClosed();
      }}
      onInteractOutside={target.onInteractOutside}
    >
      <ContextMenuItem asChild>
        <a
          href={detailsPath}
          onClick={(event) => {
            navigateOnAnchorClick(event, detailsPath, { state: { from } });
            onClose();
          }}
        >
          Open details
        </a>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={isPrimaryPending}
        onClick={(event) => {
          handlePrimaryAction(event);
          onClose();
        }}
      >
        {primaryActionLabel}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!libraryReady || collectionActions.toggleLibrary.isPending}
        onClick={(event) => {
          handleToggleLibrary(event);
          onClose();
        }}
      >
        {libraryActionLabel}
      </ContextMenuItem>
      {onRemoveFromContinue && (
        <ContextMenuItem
          onClick={(event) => {
            onRemoveFromContinue(event);
            onClose();
          }}
        >
          Remove from {removeFrom}
        </ContextMenuItem>
      )}
    </ContextMenuContent>
  );
}

type OpenMediaCardMenu = (target: MediaCardMenuTarget, clientX: number, clientY: number) => void;

const MediaCardMenuContext = createContext<OpenMediaCardMenu | null>(null);

// One Radix root for every card: each root registers document-level listeners even while closed.
export function MediaCardMenuScope({
  children,
  resetKey,
}: {
  children: ReactNode;
  resetKey: string;
}) {
  const [menu, setMenu] = useState<{ id: number; target: MediaCardMenuTarget } | null>(null);
  const [open, setOpen] = useState(false);
  const activeTargetRef = useRef<MediaCardMenuTarget | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) return;
    activeTargetRef.current?.onOpenChange(false);
    activeTargetRef.current = null;
  }, []);

  const openMenu = useCallback<OpenMediaCardMenu>((target, clientX, clientY) => {
    activeTargetRef.current?.onOpenChange(false);
    activeTargetRef.current = target;
    target.onOpenChange(true);
    setMenu((current) => ({ id: (current?.id ?? 0) + 1, target }));
    // Radix anchors the menu at its trigger's contextmenu coordinates.
    triggerRef.current?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY }),
    );
  }, []);

  useEffect(() => () => handleOpenChange(false), [handleOpenChange, resetKey]);

  return (
    <MediaCardMenuContext value={openMenu}>
      {children}
      <ContextMenu open={open} onOpenChange={handleOpenChange}>
        <ContextMenuTrigger ref={triggerRef} hidden />
        {menu && (
          <MediaCardMenu
            key={menu.id}
            target={menu.target}
            onClose={() => handleOpenChange(false)}
            onClosed={() => setMenu((current) => (current?.id === menu.id ? null : current))}
          />
        )}
      </ContextMenu>
    </MediaCardMenuContext>
  );
}

interface MediaCardOverlayProps extends MediaCardActionOptions {
  exiting: boolean;
  expandedContentId: string;
  isNewEpisode?: boolean;
  createListOpen: boolean;
  currentStatus: WatchStatus | null;
  metaLine?: string;
  onCreateListOpenChange: (open: boolean) => void;
  onRemoveFromContinue?: (event: ReactMouseEvent) => void;
  onToggleListPicker: (event: ReactMouseEvent) => void;
  popoverAlign: PopoverAlign;
  progress?: number;
  removeFrom: string;
  showListPicker: boolean;
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
  onRemoveFromContinue,
  onToggleListPicker,
  popoverAlign,
  progress,
  removeFrom,
  showListPicker,
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

  const ratingScore = details?.ratingPercent ?? null;
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

  // Metadata artwork fades in over the catalog artwork instead of swapping under the cursor.
  const backdropLayers = [...new Set([item.backdrop, details?.backdrop].filter(isHttpUrl))];
  if (!backdropLayers.length && !isDetailsLoading && isHttpUrl(item.poster)) {
    backdropLayers.push(item.poster);
  }

  const isInAnyList = lists?.some((list) => list.contains_item) ?? false;

  return (
    <>
      {/* Centering uses a margin so the resume panel's short entrance never changes its anchor. */}
      <div
        id={expandedContentId}
        role='group'
        aria-label={`Actions for ${item.title}`}
        inert={exiting}
        className={cn(
          'absolute top-0 z-20 flex max-w-[86vw] origin-top select-none flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-950 shadow-[0_24px_70px_-12px_rgba(0,0,0,0.85)] ring-1 ring-black/40 -outline-offset-2 group-has-[[data-media-card-poster]:focus-visible]/card:outline-2 group-has-[[data-media-card-poster]:focus-visible]/card:outline-white/40 motion-reduce:animate-none',
          exiting
            ? 'pointer-events-none animate-out fade-out-0 duration-100 ease-in fill-mode-forwards'
            : removeFrom === 'Continue Watching'
              ? 'resume-card-enter'
              : 'animate-in fade-in-0 duration-150 ease-out',
          popoverAlign === 'left' && 'left-0',
          popoverAlign === 'right' && 'right-0',
          popoverAlign === 'center' && 'left-1/2',
        )}
        style={{
          width: POPOUT_WIDTH_PX,
          marginLeft: popoverAlign === 'center' ? -POPOUT_WIDTH_PX / 2 : undefined,
        }}
      >
        <div
          ref={artworkRef}
          className='relative aspect-16/9 w-full shrink-0 overflow-hidden bg-zinc-900'
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
            <HoverTrailerPreview videoId={trailerVideoId} />
          )}
          <div className='pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-zinc-950 via-zinc-950/60 to-transparent' />
          {isNewEpisode && <NewEpisodeBadge />}
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
            <ResumeProgressBar progress={progress} />
          )}
          {onRemoveFromContinue && (
            <button
              type='button'
              aria-label={`Remove ${item.title} from ${removeFrom}`}
              title={`Remove from ${removeFrom}`}
              className='absolute right-2 top-2 z-10 flex h-9 w-9 items-center justify-center rounded-lg bg-black/55 text-zinc-300 backdrop-blur-xs transition-colors duration-150 hover:bg-black/75 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
              onClick={onRemoveFromContinue}
            >
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          )}
        </div>

        <div className='flex flex-1 flex-col'>
          {showListPicker ? (
            <div
              data-media-card-picker
              className='page-enter relative z-10 flex flex-1 flex-col p-2.5'
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
            <div className='relative z-10 flex flex-col gap-2 p-3 pt-2.5'>
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
                    title={item.title}
                    className='transition-colors hover:text-white/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40 rounded-xs'
                    onClick={(event) =>
                      navigateToDetails(event, detailsPath, { state: { from } }, artworkRef.current)
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
                  className='accent-lattice flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[14px] font-semibold tracking-[-0.005em] transition-colors duration-150 hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:scale-[0.98] aria-disabled:cursor-default aria-disabled:opacity-80'
                  title={primaryActionLabel}
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
                  title={libraryActionLabel}
                  aria-label={libraryActionLabel}
                  aria-pressed={libraryReady ? isInLibrary : undefined}
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
                  title='Add to List'
                  aria-label='Add to List'
                  aria-pressed={isInAnyList}
                  aria-expanded={showListPicker}
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

              {/* One fixed-height line: genres arrive async, and a second wrapped
                  row would shift the actions out from under the cursor. */}
              <div className='flex h-4 items-center gap-x-1.5 overflow-hidden text-[13px] font-medium leading-4 whitespace-nowrap text-zinc-400'>
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

              <p className='min-h-[60px] text-[13px] leading-5 text-zinc-400 line-clamp-3'>
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
  isNewEpisode,
  metaLine,
  onPlay,
  playbackIntent = 'resume',
  onRemoveFromContinue,
  removeFrom = 'watch history',
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
  const [showListPicker, setShowListPickerState, showListPickerRef] = useSyncedBooleanState();
  const [createListOpen, setCreateListOpenState, createListOpenRef] = useSyncedBooleanState();
  const openMenu = use(MediaCardMenuContext);
  const contextMenuOpenRef = useRef(false);
  const restoreMenuFocusRef = useRef(true);
  const menuFocusTargetRef = useRef<(() => HTMLElement | null) | null>(null);
  const previousListPickerRef = useRef(showListPicker);
  const cardRef = useRef<HTMLElement>(null);
  const launchOwnerMountedRef = useMountedRef();
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoringFocusRef = useRef(false);
  const hoverFocusRef = useRef(false);

  const clearExpandTimer = useCallback(() => clearTimer(expandTimer), []);

  const hasLockedCardInteraction = () =>
    showListPickerRef.current || createListOpenRef.current || contextMenuOpenRef.current;

  const collapseCard = useCallback(() => {
    clearExpandTimer();
    lastCardCollapseAt = Date.now();
    setExpanded(false);
    setShowListPickerState(false);
  }, [clearExpandTimer, setShowListPickerState]);

  const handleContextMenuOpenChange = (open: boolean) => {
    contextMenuOpenRef.current = open;
    if (!open) return;
    restoreMenuFocusRef.current = true;
    menuFocusTargetRef.current = null;
    collapseCard();
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

  const openContextMenu = (clientX: number, clientY: number) => {
    openMenu?.(
      {
        detailsRouteType,
        isInLibraryOverride,
        isPlayPending,
        item,
        launchOwnerMountedRef,
        onCloseAutoFocus: handleContextMenuCloseAutoFocus,
        onInteractOutside: () => {
          restoreMenuFocusRef.current = false;
        },
        onLibraryRemove: prepareRemovalFocus,
        onOpenChange: handleContextMenuOpenChange,
        onPlay,
        onRemoveFromContinue: onRemoveFromContinue ? handleRemoveFromHistory : undefined,
        playbackIntent,
        removeFrom,
        subtitle,
      },
      clientX,
      clientY,
    );
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

  const scheduleExpand = () => {
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
      setPopoverAlign(resolvePopoverAlign());
      setExpanded(true);
      expandTimer.current = null;
    }, delay);
  };

  const handleMouseLeave = () => {
    if (
      hasLockedCardInteraction() ||
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

  const toggleListPicker = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowListPickerState((currentState) => !currentState);
  };

  const handleCreateListOpenChange = (open: boolean) => {
    setCreateListOpenState(open);
    if (!open) {
      // Restore the picker lock so the card stays expanded.
      setShowListPickerState(true);
    }
  };

  // The card isn't a [role="dialog"] — without this a keyboard-opened overlay leaks Esc to the global back
  // gesture. Collapses picker first, then the card; the portaled create-list dialog owns its own Esc via Radix.
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    hoverFocusRef.current = false;
    if (event.defaultPrevented) return;
    if (
      openMenu &&
      !selectionMode &&
      (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const rect = event.currentTarget.getBoundingClientRect();
      openContextMenu(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return;
    }
    if (event.key !== 'Escape' || !expanded) return;
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
  };

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
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => {
        if (selectionMode || !openMenu) return;
        event.preventDefault();
        openContextMenu(event.clientX, event.clientY);
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
          onPlay={onPlay}
          playbackIntent={playbackIntent}
          onRemoveFromContinue={onRemoveFromContinue ? handleRemoveFromHistory : undefined}
          onToggleListPicker={toggleListPicker}
          popoverAlign={popoverAlign}
          progress={progress}
          removeFrom={removeFrom}
          showListPicker={showListPicker}
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
