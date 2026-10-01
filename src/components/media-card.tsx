import { useQuery } from '@tanstack/react-query';
import { Bookmark, Check, ChevronLeft, Heart, ListPlus, Loader2, Play, Trash2 } from 'lucide-react';
import {
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  memo,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { currentPathWithSearch, navigateOnAnchorClick } from '@/lib/navigation';
import { HoverTrailerPreview } from '@/components/hover-trailer-preview';
import { CreateListDialog } from '@/components/list/list-editor-dialog';
import { ListIcon } from '@/components/list/list-icons';
import { RemoteImage } from '@/components/remote-image';
import { useTrailerPreviews } from '@/hooks/use-app-ui-preferences';
import {
  useIsItemInLibrary,
  useItemWatchStatus,
  useLatestWatchHistoryEntry,
  useLists,
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
import { resolvePlayerRouteMediaType, type PlayerRouteMediaType } from '@/lib/player-navigation';
import {
  detailsCardQueryKey,
  DETAILS_GC_TIME_MS,
  DETAILS_STALE_TIME_MS,
} from '@/lib/query-invalidation';
import { searchGenrePath } from '@/lib/search-page-state';
import { extractYouTubeVideoId } from '@/lib/trailer-utils';
import {
  clamp,
  cn,
  isHttpUrl,
  mediaTypeLabel,
  prefersReducedMotion,
  primaryGenrePills,
} from '@/lib/utils';

// IMDb "8.3" or percentage "83" to a 0-100 score.
function normalizeRating(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const val = parseFloat(raw);
  if (Number.isNaN(val)) return null;
  return val <= 10 ? Math.round(val * 10) : Math.round(val);
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

// Dwell before the card expands (and any details fetch fires): sweeping the
// cursor across a row expands nothing; only an intentional hover pays for the
// details/lists/history requests. The chain delay keeps card-to-card hops
// fast.
const HOVER_EXPAND_DELAY_MS = 180;
const HOVER_CHAIN_DELAY_MS = 70;
const HOVER_CHAIN_WINDOW_MS = 1200;
let lastCardCollapseAt = 0;
const MIN_PROGRESS_BAR_PERCENT = 2;
// Fixed popout width — applied as an inline style so the centering margin
// can be derived from it.
const POPOUT_WIDTH_PX = 270;

// Resting slot width shared by home rails and all browse grids, so cards
// render pixel-identical everywhere before hover.
export const MEDIA_CARD_SLOT_CLASS_NAME = 'w-[170px] md:w-[190px]';

// Title/subtitle block under the 2:3 poster; virtualized grids use it to
// estimate row height before the first measurement pass.
export const MEDIA_CARD_TEXT_BLOCK_HEIGHT_PX = 68;

// Shared rail callbacks for plain MediaCard rows (media-row, similar titles):
// stable identities so HorizontalMediaRail's key-set memo doesn't re-run on
// every parent render.
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
}

// Resume progress: no knob, stays quiet under the artwork.
function ResumeProgressBar({ progress }: { progress?: number }) {
  if (progress === undefined || progress < MIN_PROGRESS_BAR_PERCENT) return null;
  return (
    <div className='absolute bottom-0 left-0 right-0 z-20 h-[5px] bg-white/[0.14]'>
      <div
        className='h-full rounded-r-full bg-(--accent-prog) shadow-[0_0_6px_rgb(var(--accent-prog-rgb)/0.45)]'
        style={{ width: `${progress}%` }}
      />
    </div>
  );
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
}: MediaCardPosterProps) {
  const detailsPath = `/details/${detailsRouteType}/${item.id}`;
  // Resume cards play on click — say so, with the episode and time left.
  const anchorLabel = onPlay
    ? [`Resume ${item.title}`, subtitle, metaLine].filter(Boolean).join(', ')
    : item.title;

  return (
    <>
      {/* Plain anchor + root-bound navigate: a <Link> subscribes to location,
          so every mounted card would re-render on each search URL reflect. */}
      <a
        href={detailsPath}
        aria-label={anchorLabel}
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
        <div className='relative rounded-lg bg-zinc-900'>
          <div className='relative aspect-2/3 rounded-lg overflow-hidden bg-zinc-900'>
            {isHttpUrl(item.poster) ? (
              <RemoteImage
                src={item.poster}
                alt={item.title}
                className='object-cover w-full h-full'
                loading='lazy'
              />
            ) : (
              <div className='flex items-center justify-center w-full h-full text-zinc-600 text-xs p-2 text-center'>
                <span className='line-clamp-2'>{item.title}</span>
              </div>
            )}

            {subtitle && (
              <div className='absolute bottom-1.5 left-1.5 z-10 flex max-w-[calc(100%-12px)] flex-col items-start gap-1'>
                <div className='rounded-md border border-white/10 bg-black/70 px-1.5 py-[3px] text-[9px] font-semibold uppercase tracking-[0.08em] text-white/85 backdrop-blur-xs'>
                  {subtitle}
                </div>
              </div>
            )}

            <ResumeProgressBar progress={progress} />

            {/* Resume lookups can pay a live addon fetch — the spinner shows
                the click landed. */}
            {isPlayPending && (
              <div className='absolute inset-0 z-20 flex items-center justify-center bg-black/35'>
                <Loader2 className='h-5 w-5 animate-spin text-white/85' />
              </div>
            )}
          </div>
        </div>
      </a>

      <div className='mt-1.5 px-0.5 space-y-1'>
        <p className='line-clamp-1 text-[13px] font-medium leading-tight tracking-[-0.01em] text-zinc-100'>
          {item.title}
        </p>
        {metaLine ? (
          <p className='truncate text-[11px] font-normal leading-none tabular-nums text-zinc-500'>
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
    </>
  );
}

function useSyncedBooleanState(initialState = false) {
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state);

  const setSyncedState = useCallback((nextState: SetStateAction<boolean>) => {
    // Resolve against the ref (the synchronous mirror) so the updater stays
    // pure — the ref already carries the last resolved value under batching.
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
  /** Set only when the caller already knows membership (library tab) —
      otherwise the overlay resolves it itself on mount. */
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

// Expanded-only surface: mounting it on hover keeps every resting card free
// of the details/lists/history observers and the playback hook chain — the
// per-card cost of a browse grid stays at the poster render.
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
  // Where the user expanded the card — read once at mount so the overlay
  // holds no location subscription.
  const [from] = useState(currentPathWithSearch);
  const detailsPath = `/details/${detailsRouteType}/${item.id}`;

  // The id guard avoids a doomed IPC (Rust rejects empty ids). Card payload
  // only: hover needs rating/backdrop/trailer, never the episode array.
  const { data: details } = useQuery({
    queryKey: detailsCardQueryKey(detailsRouteType, item.id),
    queryFn: () => api.getMediaCardDetails(detailsRouteType, item.id),
    enabled: !!item.id.trim(),
    staleTime: DETAILS_STALE_TIME_MS,
    gcTime: DETAILS_GC_TIME_MS,
  });

  const { data: lists } = useLists();

  // Membership is derived from the already-fetched lists (each carries
  // `item_ids`) — no second IPC round-trip per expanded card.
  const itemListIds = useMemo(
    () => lists?.filter((list) => list.item_ids.includes(item.id)).map((list) => list.id),
    [lists, item.id],
  );
  const { data: historyEntry } = useLatestWatchHistoryEntry(item.id, {
    enabled: !onPlay,
  });

  // Membership resolves here rather than on the resting card: the poster
  // never shows it, so browse grids don't carry a per-card library observer.
  const shouldResolveLibraryMembership = isInLibraryOverride === undefined;
  const { data: resolvedIsInLibrary = false } = useIsItemInLibrary(item.id, {
    enabled: shouldResolveLibraryMembership,
  });
  const isInLibrary = isInLibraryOverride ?? resolvedIsInLibrary;

  const { addItemToNewList, toggleLibrary, toggleListMembership } = useMediaCollectionActions({
    item,
    isInLibrary,
    itemListIds,
    lists,
  });
  const primaryPlayback = useMediaPrimaryPlayback({
    from,
    historyEntry,
    item,
    surface: 'card',
  });

  const ratingScore = normalizeRating(details?.rating ?? null);
  const ratingStyle = getRatingStyle(ratingScore);

  // YouTube draws title/channel chrome before play, on pause, and on end.
  // The preview stays hidden until PLAYING, then auto-resumes so that chrome
  // never paints. No playlist loop — it summons prev/next overlays.
  const trailerVideoId = extractYouTubeVideoId(details?.trailers?.[0]?.url);
  // Opt-out pref + OS reduced-motion both keep the embed from ever mounting —
  // reduced-motion can't reach inside a YouTube iframe, so the only fix is
  // not creating it. Skipping the arm timer also avoids the iframe's whole
  // script+socket cost.
  const trailersEnabled = useTrailerPreviews() && !prefersReducedMotion();

  // The iframe waits out a second, longer dwell than the overlay: sweeping
  // the cursor across a row mounts/unmounts overlays quickly, and a YouTube
  // player per card fans out iframe + script + socket work.
  const [trailerArmed, setTrailerArmed] = useState(false);
  useEffect(() => {
    if (!trailerVideoId || !trailersEnabled) return;
    const timer = window.setTimeout(() => setTrailerArmed(true), 500);
    return () => window.clearTimeout(timer);
  }, [trailerVideoId, trailersEnabled]);

  const backdropSrc = details?.backdrop || item.backdrop || item.poster;

  const isInAnyList = (itemListIds?.length ?? 0) > 0;
  const primaryActionLabel = onPlay
    ? subtitle
      ? `Resume ${subtitle}`
      : 'Resume'
    : primaryPlayback.primaryActionLabel;
  // `onPlay` callers (resume/history cards) resolve a playback plan before
  // navigating — surface that wait on the same spinner the resolve path uses.
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
      {/* Top-anchored popout. Center uses a negative margin rather than
          translate so the enter zoom never fights it. */}
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
              className='absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-red-400 backdrop-blur-xs transition-colors duration-100 hover:bg-black/75 hover:text-red-300'
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
                  className='h-5 w-5 rounded flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/10 transition-colors shrink-0'
                  onClick={onToggleListPicker}
                >
                  <ChevronLeft className='h-3.5 w-3.5' />
                </button>
                <span className='text-[12px] font-semibold text-white'>Add to List</span>
              </div>

              <div className='space-y-0.5 max-h-24 overflow-y-auto'>
                {lists && lists.length > 0 ? (
                  lists.map((list) => {
                    const isInThisList = itemListIds?.includes(list.id) ?? false;
                    return (
                      <button
                        key={list.id}
                        type='button'
                        className='w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/8 transition-colors text-left'
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          // Same disabled-focus-collapse trap as the library
                          // button — guard instead of disabling.
                          if (toggleListMembership.isPending) return;
                          toggleListMembership.mutate(list);
                        }}
                        aria-disabled={toggleListMembership.isPending || undefined}
                      >
                        <span className='text-zinc-400 shrink-0'>
                          <ListIcon iconId={list.icon} size={13} />
                        </span>
                        <span className='flex-1 truncate text-[11px] text-zinc-200'>
                          {list.name}
                        </span>
                        <span className='text-zinc-600 text-[10px] shrink-0'>
                          {list.item_ids.length}
                        </span>
                        {isInThisList && <Check className='w-3 h-3 text-emerald-400 shrink-0' />}
                      </button>
                    );
                  })
                ) : (
                  <p className='text-[11px] text-zinc-600 px-2 py-1'>No lists yet</p>
                )}
              </div>

              <div className='pt-1 border-t border-white/[0.06]'>
                <button
                  type='button'
                  className='w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/8 transition-colors text-zinc-400 hover:text-white'
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onCreateListOpenChange(true);
                  }}
                >
                  <ListPlus className='h-3.5 w-3.5 shrink-0' />
                  <span className='text-[11px]'>Create New List…</span>
                </button>
              </div>
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
                  {/* Every other target on a resume card plays — the title is
                      the details route so there is always a non-play path. */}
                  <a
                    href={detailsPath}
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

              {/* Compact action row — h-8 primary next to the icon pair. */}
              <div className='flex items-center gap-1.5'>
                <button
                  type='button'
                  data-media-card-primary
                  className='accent-lattice flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold tracking-[-0.005em] transition-colors duration-150 hover:brightness-105 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 active:scale-[0.98] aria-disabled:cursor-wait aria-disabled:opacity-80'
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
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:scale-95',
                    isInLibrary
                      ? 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-200/80 hover:bg-emerald-500/[0.10] hover:text-emerald-200'
                      : 'border-white/[0.08] bg-white/[0.06] text-zinc-300 hover:bg-white/[0.12] hover:text-white',
                    toggleLibrary.isPending && 'cursor-wait opacity-70',
                  )}
                  title={isInLibrary ? 'Remove from library' : 'Add to library'}
                  aria-label={isInLibrary ? 'Remove from library' : 'Add to library'}
                  aria-pressed={isInLibrary}
                  // Never `disabled` here: a focused button loses focus the
                  // moment it disables, the focusout bubbles to the card's
                  // blur handler with relatedTarget=null and collapses the
                  // popout mid-click. Guard re-entry instead.
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
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:scale-95',
                    isInAnyList
                      ? 'border-white/20 bg-white/[0.12] text-white hover:bg-white/[0.16]'
                      : 'border-white/[0.08] bg-white/[0.06] text-zinc-300 hover:bg-white/[0.12] hover:text-white',
                  )}
                  title='Add to List'
                  aria-pressed={isInAnyList}
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

      {/* Create-list dialog lives in the overlay: it can only open while the
          card is expanded, and the picker lock holds the card open until the
          dialog closes. */}
      <CreateListDialog
        open={createListOpen}
        onOpenChange={onCreateListOpenChange}
        onCreated={(newList) => {
          void addItemToNewList(newList);
        }}
      />
    </>
  );
}

// Memoized: cards render in virtualized grids and rails that re-render on
// scroll/resize state changes; `item` is referentially stable through
// TanStack structural sharing, so a pure-props bail-out skips most renders.
// Call sites must keep `onPlay`/`onRemoveFromContinue` referentially stable.
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
}: MediaCardProps) {
  const detailsRouteType = resolvePlayerRouteMediaType(item.type);
  const prefetchDetails = usePrefetchDetails(item.id, item.type);

  // Hover-expand state: the resting poster hides in place so layout never shifts.
  const [expanded, setExpanded] = useState(false);
  const [popoverAlign, setPopoverAlign] = useState<PopoverAlign>('center');
  const [showListPicker, setShowListPickerState, showListPickerRef] = useSyncedBooleanState();
  const [createListOpen, setCreateListOpenState, createListOpenRef] = useSyncedBooleanState();
  const cardRef = useRef<HTMLElement>(null);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearExpandTimer = useCallback(() => {
    if (expandTimer.current) {
      clearTimeout(expandTimer.current);
      expandTimer.current = null;
    }
  }, []);

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

  // Pin the popout toward the side with room, measured vs the rail
  // scrollport when inside one else the window (grids).
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
    // Already open — focus bubbling between overlay controls re-fires this
    // handler and must not re-arm the dwell timer or re-run the warm path.
    if (expanded) return;
    clearExpandTimer();
    // Dwell-gated (see above); a hop from a just-collapsed card chains fast.
    const delay =
      Date.now() - lastCardCollapseAt < HOVER_CHAIN_WINDOW_MS
        ? HOVER_CHAIN_DELAY_MS
        : HOVER_EXPAND_DELAY_MS;
    expandTimer.current = setTimeout(() => {
      prefetchDetails();
      // Dwell-expand is a strong play signal — the module cache makes repeat
      // warms free, and a warm chunk turns a Play click into a Suspense hit.
      warmPlayerChunk();
      setPopoverAlign(resolvePopoverAlign());
      setExpanded(true);
      expandTimer.current = null;
    }, delay);
  }, [clearExpandTimer, expanded, prefetchDetails, resolvePopoverAlign]);

  const handleMouseLeave = useCallback(() => {
    // Don't collapse while the picker/dialog is open.
    if (hasLockedCardInteraction()) return;
    collapseCard();
  }, [collapseCard, hasLockedCardInteraction]);

  const handleBlur = useCallback(
    (event: ReactFocusEvent) => {
      if (hasLockedCardInteraction()) return;
      const nextFocus = event.relatedTarget;
      if (nextFocus instanceof Node && cardRef.current && cardRef.current.contains(nextFocus)) {
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

  // The card isn't a [role="dialog"], so without this a keyboard-opened
  // overlay leaks Esc to the global browse-back gesture. The global listener
  // yields to `[data-media-card-expanded]` targets and this collapses —
  // picker first, then the card. The portaled create-list dialog owns its
  // own Esc via Radix.
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !expanded) return;
      if (createListOpenRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      if (showListPickerRef.current) {
        setShowListPickerState(false);
        return;
      }
      collapseCard();
      // The overlay unmounts with its focused control — hand focus back to
      // the resting poster link instead of dropping keyboard users on <body>.
      window.requestAnimationFrame(() => {
        cardRef.current?.querySelector<HTMLElement>('a[href]')?.focus({ preventScroll: true });
      });
    },
    [expanded, collapseCard, createListOpenRef, setShowListPickerState, showListPickerRef],
  );

  // Focus a card's overlay the moment it opens: the resting poster goes
  // `invisible` on expand, which drops DOM focus to <body> — stranding a
  // keyboard-opened card's Esc collapse and its action row. The body check
  // also lets a hover-opened card take focus so Esc works there too, while a
  // focus owner elsewhere (search box, another card) is never stolen.
  useEffect(() => {
    if (!expanded) return;
    if (document.activeElement !== document.body) return;
    const target = cardRef.current?.querySelector<HTMLElement>(
      showListPicker ? '[data-media-card-picker] button' : '[data-media-card-primary]',
    );
    target?.focus({ preventScroll: true });
  }, [expanded, showListPicker]);

  const shouldResolveWatchStatus = currentStatusOverride === undefined;
  const { data: resolvedCurrentStatus = null } = useItemWatchStatus(item.id, {
    enabled: shouldResolveWatchStatus,
  });
  const currentStatus =
    currentStatusOverride !== undefined ? currentStatusOverride : resolvedCurrentStatus;

  const safeProgress =
    typeof progress === 'number' && Number.isFinite(progress) ? clamp(progress, 0, 100) : undefined;

  return (
    // Ambient hover/focus listeners drive the preview card's expand/collapse
    // timing — the card itself stays non-interactive.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <article
      ref={cardRef}
      data-media-card-expanded={expanded || undefined}
      className={cn('relative', expanded && 'z-30')}
      aria-label={item.title}
      onMouseEnter={scheduleExpand}
      onMouseLeave={handleMouseLeave}
      onFocus={scheduleExpand}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      {/* Poster hides in place while expanded so layout never shifts. */}
      <div className={cn(expanded && 'invisible')}>
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
        />
      </div>

      {expanded && (
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
    <div className='space-y-1.5'>
      <div className='aspect-2/3 animate-pulse rounded-lg border border-white/5 bg-zinc-900/50' />
      <div className='h-3.5 w-3/4 animate-pulse rounded-md bg-zinc-900/40' />
      <div className='h-3 w-1/3 animate-pulse rounded-md bg-zinc-900/30' />
    </div>
  );
}
