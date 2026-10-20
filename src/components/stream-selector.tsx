import { type Range, useVirtualizer } from '@tanstack/react-virtual';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUp,
  Check,
  ChevronRight,
  CloudCheck,
  Copy,
  Layers,
  Link2,
  Package,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import {
  StreamAddonHealthChips,
  StreamFilterToolbar,
  StreamListEmptyState,
  StreamListErrorState,
  StreamListFilteredEmptyState,
  StreamListLoadingState,
  StreamListNoAddonsState,
  StreamListOfflineState,
  type PackListRow,
  StreamP2pNotice,
  StreamPackEpisodeList,
  StreamResolveFeedbackToast,
  StreamResultsStatus,
  StreamSelectorHeader,
  rovingListTarget,
} from '@/components/stream-selector-panel';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { focusedRowRange } from '@/components/window-virtualized-stack';
import { useStreamSelectorController } from '@/hooks/use-stream-selector-controller';
import { warmPlayerChunk } from '@/lib/player-session';
import {
  api,
  getErrorMessage,
  type AddonStream,
  type Episode,
  type StreamMatchBadgeKind,
  type StreamMatchTier,
  type StreamSelectorSort,
} from '@/lib/api';
import { isEditableTarget, whenRowMounted } from '@/lib/dom';
import { buildEpisodeStreamTarget, episodeMatchesCoordinates } from '@/lib/episode-stream-target';
import { episodeProgressKey } from '@/lib/history-playback';
import { copyText } from '@/lib/notify';
import { navigateApp } from '@/lib/navigation';
import type { StreamSelectorTarget } from '@/lib/stream-selector-target';
import {
  buildStreamReasonChips,
  buildStreamTechBadges,
  DEFAULT_FILTERS,
  MATCH_BADGES,
  type StreamReasonChip,
} from '@/lib/stream-selector-utils';
import { cn, mediaTypeLabel, nonBlank } from '@/lib/utils';

const MATCH_BADGE_ICONS: Record<StreamMatchBadgeKind, LucideIcon | null> = {
  episode: Check,
  range: Layers,
  season: Package,
  multi_season: Package,
  title: Check,
  title_partial: null,
};

// Dot field follows the profile accent ("artwork" target); tiers differ by tint density, not hue, so any accent keeps them distinct.
const MATCH_DOT_COLORS: Record<StreamMatchTier, string> = {
  exact: 'rgb(var(--accent-art-rgb) / 0.5)',
  episode_range: 'rgb(var(--accent-art-rgb) / 0.34)',
  season_pack: 'rgb(var(--accent-art-rgb) / 0.24)',
  title: 'rgb(var(--accent-art-rgb) / 0.42)',
};

// Mixed toward white so a dark profile accent stays legible on the zinc row.
const REASON_TONE_CLASS: Record<StreamReasonChip['tone'], string> = {
  positive: 'font-medium text-[color-mix(in_srgb,var(--accent-act)_70%,white)]',
  caution: 'font-medium text-amber-200/90',
  neutral: 'text-zinc-400',
};

const DELIVERY_TILES: Record<
  AddonStream['presentation']['deliveryKind'],
  { Icon: LucideIcon; iconClass: string }
> = {
  cached: { Icon: CloudCheck, iconClass: 'text-(--accent-act)' },
  http: { Icon: Link2, iconClass: 'text-zinc-200' },
  p2p: { Icon: Waypoints, iconClass: 'text-zinc-500' },
};

interface StreamItemProps {
  canBrowsePack: boolean;
  disabled: boolean;
  isActive: boolean;
  isLastUsed: boolean;
  /** Same release family as the last-used pick (exact key absent). */
  isSameFamily: boolean;
  isResolving: boolean;
  onRowFocus: (streamKey: string) => void;
  onSelect: (stream: AddonStream) => void;
  onCopyLink: (stream: AddonStream) => Promise<void>;
  /** Active sort — the row emphasizes whichever fact ordered it, so the ranking reads on the row. */
  sortMode: StreamSelectorSort;
  stream: AddonStream;
  tabIndex: number;
}

const StreamItem = memo(function StreamItem({
  canBrowsePack,
  stream,
  onSelect,
  onRowFocus,
  onCopyLink,
  isActive,
  isLastUsed,
  isSameFamily,
  isResolving,
  disabled,
  sortMode,
  tabIndex,
}: StreamItemProps) {
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const { presentation } = stream;
  const isPlayable = presentation.isInstantlyPlayable;
  const matchBadges = stream.matchBadgeKinds.map((kind) => MATCH_BADGES[kind]);
  const deliveryClass =
    presentation.deliveryKind === 'cached'
      ? 'text-(--accent-act)'
      : presentation.deliveryKind === 'http'
        ? 'text-zinc-300'
        : 'text-zinc-500';

  const metaParts: { key: string; className?: string; text: string }[] = [];
  if (stream.sourceName) metaParts.push({ key: 'addon', text: stream.sourceName });
  metaParts.push({ key: 'delivery', text: presentation.deliveryLabel, className: deliveryClass });
  if (presentation.codecLabel) metaParts.push({ key: 'codec', text: presentation.codecLabel });
  if (presentation.audioLabel) metaParts.push({ key: 'audio', text: presentation.audioLabel });
  if (presentation.multiAudioLabel)
    metaParts.push({ key: 'multi', text: presentation.multiAudioLabel });

  const sourceName = nonBlank(presentation.sourceName) || 'Unknown';
  const streamTitle = nonBlank(presentation.streamTitle) || 'Unknown';
  const techBadges = buildStreamTechBadges(stream);
  const matchTier = stream.matchTier;
  const recommendationReasons = buildStreamReasonChips(stream);
  const matchAria =
    matchBadges.length > 0 ? `, ${matchBadges.map((badge) => badge.label).join(', ')}` : '';
  const playableAria = isPlayable ? '' : ', P2P source, not playable in this build';
  const deliveryTile = DELIVERY_TILES[presentation.deliveryKind];
  const DeliveryIcon = deliveryTile.Icon;
  const opensPack = canBrowsePack && isPlayable && stream.presentation.isBatch;

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) rowRef.current?.focus({ preventScroll: true });
      }}
    >
      <div
        role='listitem'
        className={cn(
          'group relative px-3 py-2.5 rounded-xl',
          'bg-white/[0.02] border border-white/[0.05]',
          'hover:bg-white/[0.045] hover:border-white/[0.1]',
          'transition-[background-color,border-color,opacity] duration-150 cursor-pointer w-full overflow-hidden',
          !isPlayable && 'opacity-55 saturate-[0.65]',
          isActive &&
            'border-[rgb(var(--accent-act-rgb)/0.3)] bg-[rgb(var(--accent-act-rgb)/0.05)] hover:border-[rgb(var(--accent-act-rgb)/0.4)]',
          disabled && 'cursor-default',
          isResolving && 'pointer-events-none border-white/[0.16] bg-white/[0.05]',
        )}
      >
        {matchTier && (
          <span
            aria-hidden='true'
            className='pointer-events-none absolute right-0 top-0 h-20 w-52'
            style={{
              backgroundImage: `radial-gradient(${MATCH_DOT_COLORS[matchTier]} 0.85px, transparent 1.35px)`,
              backgroundSize: '5.5px 5.5px',
              backgroundPosition: 'top right',
              maskImage:
                'radial-gradient(210px 96px at 100% 0%, black 0%, rgba(0,0,0,0.5) 42%, transparent 84%)',
              WebkitMaskImage:
                'radial-gradient(210px 96px at 100% 0%, black 0%, rgba(0,0,0,0.5) 42%, transparent 84%)',
            }}
          />
        )}

        <ContextMenuTrigger asChild>
          <button
            ref={rowRef}
            type='button'
            onClick={() => {
              if (!disabled) onSelect(stream);
            }}
            onFocus={() => onRowFocus(stream.streamKey)}
            aria-disabled={disabled || undefined}
            aria-current={isActive ? 'true' : undefined}
            aria-busy={isResolving || undefined}
            data-stream-key={stream.streamKey}
            tabIndex={tabIndex}
            title={streamTitle}
            aria-label={`${opensPack ? 'Browse episodes in' : 'Select'} ${sourceName} ${opensPack ? 'pack' : 'stream'}${techBadges.map((badge) => `, ${badge.label}`).join('')}${matchAria}${playableAria}. ${streamTitle}`}
            className='absolute inset-0 z-0 rounded-xl aria-disabled:cursor-default focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/25'
          />
        </ContextMenuTrigger>

        {isResolving && (
          <div className='absolute bottom-0 left-0 right-0 h-[2px] bg-white/5 overflow-hidden rounded-b-xl'>
            <div className='h-full w-1/3 bg-white/50 motion-safe:animate-[progress-slide_1.6s_linear_infinite]' />
          </div>
        )}

        <div className='relative z-10 flex items-center gap-3 pointer-events-none'>
          <div
            aria-hidden='true'
            className='flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-white/[0.08] bg-linear-to-b from-white/[0.08] to-white/[0.015] shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_1px_2px_rgba(0,0,0,0.4)]'
          >
            <DeliveryIcon
              className={cn('h-[17px] w-[17px]', deliveryTile.iconClass)}
              strokeWidth={1.75}
            />
          </div>

          <div className='flex-1 min-w-0'>
            <div className='flex items-center gap-1.5 min-w-0'>
              <p className='text-[13px] font-semibold text-zinc-100 truncate group-hover:text-white transition-colors leading-tight min-w-0'>
                {sourceName}
              </p>
              <div className='flex items-center gap-1 shrink-0'>
                {techBadges.map((badge, badgeIndex) => (
                  <span
                    key={`${badge.label}:${badge.cls}`}
                    className={cn(
                      'inline-flex h-[18px] items-center px-1.5 rounded-[5px] border text-[10.5px] font-semibold leading-none tabular-nums',
                      badge.cls,
                      badgeIndex === 0 && sortMode === 'quality' && 'ring-1 ring-violet-300/50',
                    )}
                  >
                    {badge.label}
                  </span>
                ))}
                {isActive && (
                  <span className='accent-lattice-soft inline-flex h-[18px] items-center gap-1 rounded-[5px] border px-1.5 text-[10.5px] font-medium leading-none'>
                    <span className='h-1.5 w-1.5 rounded-full bg-(--accent-act)' />
                    Current
                  </span>
                )}
                {!isActive && isLastUsed && (
                  <span className='inline-flex h-[18px] items-center gap-1 rounded-[5px] border border-white/[0.12] bg-white/[0.05] px-1.5 text-[10.5px] font-medium leading-none text-zinc-200'>
                    <span className='h-1.5 w-1.5 rounded-full bg-zinc-300' />
                    Last played
                  </span>
                )}
                {!isActive && !isLastUsed && isSameFamily && (
                  <span className='text-[11px] font-medium leading-none text-zinc-400'>
                    Same release
                  </span>
                )}
              </div>
            </div>

            <p
              title={streamTitle}
              className='text-[11px] text-zinc-400 truncate mt-0.5 leading-snug'
            >
              {streamTitle}
            </p>

            <div className='flex items-center gap-1.5 mt-1 overflow-hidden whitespace-nowrap'>
              <span className='w-16 shrink-0 truncate text-[10.5px] font-medium tabular-nums text-zinc-400'>
                {stream.presentation.sizeLabel}
              </span>
              <span
                className={cn(
                  'w-[4.5rem] shrink-0 inline-flex items-center gap-0.5 truncate text-[10.5px] tabular-nums',
                  stream.seeders === 0
                    ? 'text-zinc-500 font-medium'
                    : sortMode === 'seeds'
                      ? 'text-white font-semibold'
                      : 'text-zinc-300 font-medium',
                )}
              >
                {typeof stream.seeders === 'number' && (
                  <>
                    {stream.seeders > 0 && (
                      <ArrowUp className='w-[9px] h-[9px] shrink-0' strokeWidth={2.5} />
                    )}
                    {stream.seeders === 0 ? '0 seeds' : stream.seeders}
                  </>
                )}
              </span>
              <div className='flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden'>
                {metaParts.map((part, index) => (
                  <Fragment key={part.key}>
                    {index > 0 && <span className='text-zinc-700 text-[10px]'>·</span>}
                    <span
                      className={cn(
                        'text-[10.5px] font-medium text-zinc-400 truncate min-w-0',
                        part.className,
                      )}
                    >
                      {part.text}
                    </span>
                  </Fragment>
                ))}
              </div>
            </div>

            {(opensPack || matchBadges.length > 0 || recommendationReasons.length > 0) && (
              <div className='mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-1'>
                {matchBadges.map((badge) => {
                  const BadgeIcon = MATCH_BADGE_ICONS[badge.kind];
                  return (
                    <span
                      key={badge.kind}
                      className={cn(
                        'inline-flex h-[18px] items-center gap-1 rounded-[4px] border px-1.5 text-[10.5px] font-medium leading-none',
                        badge.cls,
                      )}
                    >
                      {BadgeIcon && (
                        <BadgeIcon className='-ml-px h-[11px] w-[11px]' strokeWidth={2.5} />
                      )}
                      {badge.label}
                    </span>
                  );
                })}
                {recommendationReasons.map((reason, index) => (
                  <Fragment key={reason.kind}>
                    {index > 0 && (
                      <span aria-hidden='true' className='text-[11px] text-zinc-700'>
                        ·
                      </span>
                    )}
                    <span
                      className={cn(
                        'text-[11px] leading-none',
                        index === 0 && matchBadges.length > 0 && 'ml-1.5',
                        REASON_TONE_CLASS[reason.tone],
                      )}
                    >
                      {reason.label}
                    </span>
                  </Fragment>
                ))}
                {opensPack && (
                  <span className='ml-auto inline-flex items-center gap-0.5 pl-2 text-[11px] font-medium text-amber-100/75 group-hover:text-amber-100 group-focus-within:text-amber-100'>
                    Choose episode
                    <ChevronRight aria-hidden='true' className='h-3 w-3' />
                  </span>
                )}
              </div>
            )}
          </div>
          {isPlayable && stream.presentation.deliveryKind !== 'p2p' && (
            <button
              type='button'
              aria-label='Copy stream URL'
              title='Copy stream URL'
              tabIndex={tabIndex}
              onFocus={() => onRowFocus(stream.streamKey)}
              onClick={(event) => {
                event.stopPropagation();
                void onCopyLink(stream);
              }}
              className='pointer-events-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-zinc-400 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/30'
            >
              <Copy aria-hidden='true' className='h-3.5 w-3.5' />
            </button>
          )}
        </div>
      </div>
      <ContextMenuContent
        onKeyDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          rowRef.current?.focus({ preventScroll: true });
        }}
      >
        <ContextMenuItem onSelect={() => void onCopyLink(stream)}>
          <Copy className='h-4 w-4' />
          {stream.presentation.deliveryKind === 'p2p' ? 'Copy magnet link' : 'Copy stream link'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

const STREAM_ROW_ESTIMATE_PX = 92;
const STREAM_ROW_GAP_PX = 6;
const EMPTY_PACK_EPISODES: Episode[] = [];
const EMPTY_PACK_ROWS: PackListRow[] = [];

interface StreamVirtualListProps {
  canBrowsePack: boolean;
  streams: readonly AddonStream[];
  activeResolveKey: string | null;
  currentStreamKey?: string;
  lastStreamKey?: string;
  /** Release family of the last-used pick — fallback badge when the exact key can't exist (sibling episode) or rotted. */
  lastStreamFamily?: string;
  handleSelectStream: (stream: AddonStream) => void;
  handleCopyLink: (stream: AddonStream) => Promise<void>;
  isAnyResolving: boolean;
  /** True once per dialog open: focus + scroll the remembered row into view. */
  initialFocusPending: boolean;
  onInitialFocusDone: () => void;
  /** Active sort — rows emphasize the fact the list is ordered by. */
  sortMode: StreamSelectorSort;
  resetKey: string;
}

// Container-virtualized rows: a 500-row payload costs ~15 mounted rows.
// Plain function — useVirtualizer helpers are unmemoizable by design.
function StreamVirtualList({
  canBrowsePack,
  streams,
  activeResolveKey,
  currentStreamKey,
  lastStreamKey,
  lastStreamFamily,
  handleSelectStream,
  handleCopyLink,
  isAnyResolving,
  initialFocusPending,
  onInitialFocusDone,
  sortMode,
  resetKey,
}: StreamVirtualListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const streamIndexByKey = useMemo(() => {
    const indices = new Map<string, number>();
    streams.forEach((stream, index) => indices.set(stream.streamKey, index));
    return indices;
  }, [streams]);
  const getItemKey = useCallback((index: number) => streams[index].streamKey, [streams]);

  // Roving tabindex: one tab stop for the list; lands on the playing row, else last-used, else first playable.
  const [focusedStreamKey, setFocusedStreamKey] = useState(() => {
    if (currentStreamKey && streamIndexByKey.has(currentStreamKey)) return currentStreamKey;
    if (lastStreamKey && streamIndexByKey.has(lastStreamKey)) return lastStreamKey;
    return (
      streams.find((stream) => stream.presentation.isInstantlyPlayable)?.streamKey ??
      streams[0]?.streamKey
    );
  });
  // Progressive ranking can insert rows before the focused stream — identity, not index, owns the tab stop.
  const matchedFocusedIndex = streamIndexByKey.get(focusedStreamKey ?? '');
  const focusedIndex = matchedFocusedIndex ?? 0;
  const firstStreamKey = streams[0]?.streamKey;
  // Keep the focused row always mounted — scrolling or re-ranking must not remove it (or the pack picker's return target).
  const rangeExtractor = useCallback(
    (range: Range) => focusedRowRange(range, focusedIndex),
    [focusedIndex],
  );
  const virtualizer = useVirtualizer({
    count: streams.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => STREAM_ROW_ESTIMATE_PX,
    getItemKey,
    rangeExtractor,
    overscan: 8,
  });

  // Which row open-time autofocus targeted — lets a late-resolving lastStreamKey complete the deferred autofocus.
  const autofocusKeyRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    autofocusKeyRef.current = null;
    virtualizer.scrollToOffset(0);
  }, [resetKey, virtualizer]);

  // Family fallback badge: only when the exact key isn't listed (sibling episode / re-digested key); lands on the first family member.
  const familyFallbackKey = useMemo(() => {
    if (!lastStreamFamily) return null;
    if (lastStreamKey && streamIndexByKey.has(lastStreamKey)) return null;
    return (
      streams.find((s) => s.streamFamily && s.streamFamily === lastStreamFamily)?.streamKey ?? null
    );
  }, [lastStreamFamily, lastStreamKey, streamIndexByKey, streams]);

  // A removed stream leaves the tab stop on the first remaining row.
  useEffect(() => {
    if (matchedFocusedIndex === undefined) {
      setFocusedStreamKey(firstStreamKey);
    }
  }, [firstStreamKey, matchedFocusedIndex]);

  // A virtual row mounts only after the scroll commit, so the frame after scrollToIndex can still miss it — retry once.
  const scheduleRowFocus = useCallback((streamKey: string, initial: boolean) => {
    whenRowMounted(
      () => scrollRef.current,
      `[data-stream-key="${CSS.escape(streamKey)}"]`,
      (row) => {
        if (initial) {
          const active = document.activeElement;
          const dialog = scrollRef.current?.closest('[role="dialog"]');
          // Progressive results must not steal focus after the user starts interacting with the chrome.
          if (active && active !== document.body && active !== dialog && active !== row) return;
        }
        row.focus({ preventScroll: initial });
        if (initial) row.scrollIntoView({ block: 'nearest' });
      },
    );
  }, []);

  const focusRow = useCallback(
    (index: number) => {
      const stream = streams[index];
      if (!stream) return;
      setFocusedStreamKey(stream.streamKey);
      virtualizer.scrollToIndex(index, { align: 'auto' });
      scheduleRowFocus(stream.streamKey, false);
    },
    [scheduleRowFocus, streams, virtualizer],
  );

  // Per-open: filter changes leave pending=false so a chip click never steals focus.
  useEffect(() => {
    if (!initialFocusPending) return;
    onInitialFocusDone();
    const streamKey = streams[focusedIndex]?.streamKey;
    if (!streamKey) return;
    autofocusKeyRef.current = streamKey;
    virtualizer.scrollToIndex(focusedIndex, { align: 'center' });
    // No cleanup — `onInitialFocusDone` re-runs this effect and would cancel the frame it just scheduled.
    scheduleRowFocus(streamKey, true);
  }, [
    onInitialFocusDone,
    initialFocusPending,
    focusedIndex,
    streams,
    scheduleRowFocus,
    virtualizer,
  ]);

  useEffect(() => {
    const from = autofocusKeyRef.current;
    if (from === null) return;
    if (focusedStreamKey !== from) {
      autofocusKeyRef.current = null;
      return;
    }
    const targetKey =
      currentStreamKey && streamIndexByKey.has(currentStreamKey) ? currentStreamKey : lastStreamKey;
    if (!targetKey) return;
    const targetIndex = streamIndexByKey.get(targetKey);
    if (targetIndex === undefined) return;
    if (targetKey === from) {
      if (targetKey === currentStreamKey) autofocusKeyRef.current = null;
      return;
    }

    // Tabbing to chrome doesn't move the roving stop — retarget only while focus rests on the auto-focused row or container.
    const listEl = scrollRef.current;
    const active = document.activeElement;
    const autoRow = listEl?.querySelector(`[data-stream-key="${CSS.escape(from)}"]`);
    const focusIsResting =
      !active ||
      active === document.body ||
      active === autoRow ||
      active === listEl ||
      (listEl !== null && active.contains(listEl));
    autofocusKeyRef.current = focusIsResting && targetKey !== currentStreamKey ? targetKey : null;
    if (focusIsResting) focusRow(targetIndex);
  }, [currentStreamKey, focusRow, focusedStreamKey, lastStreamKey, streamIndexByKey]);

  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const last = streams.length - 1;
      const next = rovingListTarget(
        event,
        { count: streams.length, first: 0, last },
        (distance, direction) => Math.min(last, Math.max(0, focusedIndex + direction * distance)),
      );
      if (next !== null) focusRow(next);
    },
    [focusRow, focusedIndex, streams.length],
  );

  const renderRow = (stream: AddonStream, index: number) => {
    const streamKey = stream.streamKey;
    return (
      <StreamItem
        key={streamKey}
        canBrowsePack={canBrowsePack}
        stream={stream}
        onSelect={handleSelectStream}
        onCopyLink={handleCopyLink}
        onRowFocus={setFocusedStreamKey}
        isActive={currentStreamKey === streamKey}
        isLastUsed={lastStreamKey === streamKey}
        isSameFamily={familyFallbackKey === streamKey}
        isResolving={isAnyResolving && activeResolveKey === streamKey}
        disabled={isAnyResolving}
        sortMode={sortMode}
        tabIndex={index === focusedIndex ? 0 : -1}
      />
    );
  };

  return (
    // Keydown lands here via bubbling from the focused row button — the container is never the target.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={scrollRef}
      role='list'
      className='h-full overflow-y-auto overscroll-contain'
      onKeyDown={handleListKeyDown}
    >
      <div
        className='relative w-full'
        // Absolute rows ignore padding — the 12px top + 24px bottom insets are folded into the explicit height.
        style={{ height: `${virtualizer.getTotalSize() + 36}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const stream = streams[virtualRow.index];
          if (!stream) return null;
          return (
            <div
              key={stream.streamKey}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className='absolute left-3 right-3 top-3'
              style={{
                transform: `translateY(${virtualRow.start}px)`,
                paddingBottom: `${STREAM_ROW_GAP_PX}px`,
              }}
            >
              {renderRow(stream, virtualRow.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface StreamSelectorProps {
  open: boolean;
  onClose: () => void;
  onClosed?: () => void;
  onBeforePlayerNavigation?: () => void | Promise<void>;
  target: StreamSelectorTarget;
  currentStreamKey?: string;
  /** Resume position read at pick time — a getter so live positions stay fresh. */
  getStartTime?: () => number | undefined;
}

export function StreamSelector({
  open,
  onClose,
  onClosed,
  onBeforePlayerNavigation,
  target,
  currentStreamKey,
  getStartTime,
}: StreamSelectorProps) {
  const dialogContentRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchFocusPendingRef = useRef(false);
  const resultsFocusPendingRef = useRef(false);
  const {
    absoluteEpisode,
    absoluteSeason,
    backdrop,
    episode,
    episodes,
    episodeTitle,
    logo,
    poster,
    season,
    targetMasked,
    title,
    type,
  } = target;
  const {
    activeResolveEpisode,
    activeResolveFeedback,
    activeResolveKey,
    addonHealthMetrics,
    batchFilter,
    cancelResolve,
    compactOverview,
    effectiveAddonFilter,
    hasEnabledAddons,
    episodeProgress,
    watchedEpisodeCeiling,
    fatalAddonError,
    handleDialogOpenChange,
    handleRequestClose,
    handleSelectStream,
    hasActiveFilter,
    healthSummary,
    isAnyResolving,
    isLoading,
    isLoadingAddonConfigs,
    isOnline,
    isRetrying,
    isSearchPending,
    lastStreamKey,
    lastStreamFamily,
    listResetKey,
    lookupId,
    qualityFilter,
    rankingOptions,
    refetchStreams,
    refreshFailed,
    resetFilters,
    selectorSessionKey,
    searchQuery,
    setSearchQuery,
    setFilters,
    showBatchFilter,
    sortMode,
    sortedStreams,
    sourceFilter,
    sourcesStillLoading,
    streamSourceCount,
    streamStats,
    streams,
  } = useStreamSelectorController({
    open,
    onClose,
    onBeforePlayerNavigation,
    getStartTime,
    target,
  });

  const focusResults = () =>
    dialogContentRef.current
      ?.querySelector<HTMLElement>('[data-stream-key][tabindex="0"]')
      ?.focus();
  // Enter in the search box waits for the debounced results so focus never lands on a row that is about to be replaced.
  useLayoutEffect(() => {
    if (searchFocusPendingRef.current) {
      searchFocusPendingRef.current = false;
      searchInputRef.current?.focus({ preventScroll: true });
    }
    if (resultsFocusPendingRef.current && !isSearchPending) {
      resultsFocusPendingRef.current = false;
      focusResults();
    }
  });

  const handleCopyLink = async (stream: AddonStream) => {
    await api
      .getStreamLink(
        type,
        lookupId,
        stream.streamKey,
        season,
        episode,
        absoluteEpisode,
        rankingOptions,
        stream.sourceId,
      )
      .then((link) =>
        copyText(link.url, link.kind === 'magnet' ? 'Magnet link copied' : 'Stream link copied'),
      )
      .catch((error) => {
        toast.error(getErrorMessage(error));
      });
  };

  // Canonical display coordinates — the header shows the browsed (absolute) numbering, not the addon's stream-space remap.
  const displaySeason = absoluteSeason ?? season;
  const displayEpisode = absoluteEpisode ?? episode;
  const headerStartTime = open ? getStartTime?.() : undefined;

  // Pack browsing: a playable batch row opens the in-pack episode picker instead of resolving blind.
  const [packSelection, setPackSelection] = useState<{
    stream: AddonStream;
    sessionKey: string;
  } | null>(null);
  const packStream =
    open && packSelection?.sessionKey === selectorSessionKey ? packSelection.stream : null;
  const isPackOpen = packStream !== null;
  const packOpenRef = useRef(false);
  // Row that opened the picker — refocused on return; the list stays mounted under the overlay, so the element survives.
  const packReturnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    packOpenRef.current = false;
    setPackSelection(null);
    packReturnFocusRef.current = null;
  }, [open, selectorSessionKey]);

  const closePackPicker = useCallback(() => {
    cancelResolve();
    packOpenRef.current = false;
    setPackSelection(null);
    // The picker unmounts with focus inside it — hand focus back to the pack row rather than dropping to <body>.
    const returnTarget = packReturnFocusRef.current;
    packReturnFocusRef.current = null;
    requestAnimationFrame(() => {
      if (packOpenRef.current || dialogContentRef.current?.dataset.state !== 'open') return;
      const focusTarget = returnTarget?.isConnected ? returnTarget : searchInputRef.current;
      (focusTarget ?? dialogContentRef.current)?.focus({ preventScroll: true });
    });
  }, [cancelResolve]);

  const allPackEpisodes = episodes ?? EMPTY_PACK_EPISODES;
  const packCoordinates = isPackOpen
    ? allPackEpisodes.map((ep) => ({
        season: ep.season,
        episode: ep.episode,
        streamSeason: ep.streamSeason,
        streamEpisode: ep.streamEpisode,
      }))
    : EMPTY_PACK_EPISODES;
  const {
    data: packRowModel,
    error: packError,
    isFetching: isLoadingPack,
    refetch: retryPack,
  } = useQuery({
    queryKey: ['stream-pack-rows', packStream?.matchSummary?.packCoverage ?? null, packCoordinates],
    queryFn: () => api.getStreamPackRows(packStream?.matchSummary?.packCoverage, packCoordinates),
    enabled: isPackOpen,
    networkMode: 'always',
    staleTime: Infinity,
    gcTime: 120_000,
    retry: false,
  });
  const [packRetry, setPackRetry] = useState<{
    selection: typeof packSelection;
    error: unknown;
  } | null>(null);
  const packEpisodeError =
    packError ?? (packRetry?.selection === packSelection ? packRetry?.error : null);
  const packRows =
    packRowModel?.map((row): PackListRow =>
      row.type === 'header' ? row : { type: 'episode', episode: allPackEpisodes[row.index] },
    ) ?? EMPTY_PACK_ROWS;

  const handleStreamPress = (stream: AddonStream) => {
    if (isAnyResolving || packOpenRef.current) return;
    if (
      stream.presentation.isBatch &&
      stream.presentation.isInstantlyPlayable &&
      allPackEpisodes.length > 0
    ) {
      packOpenRef.current = true;
      packReturnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPackSelection({ stream, sessionKey: selectorSessionKey });
      return;
    }
    handleSelectStream(stream);
  };

  const packProgressFor = useCallback(
    (ep: Episode) => episodeProgress?.[episodeProgressKey(target.id, ep.season, ep.episode)],
    [episodeProgress, target.id],
  );
  const packPlaybackRef = useRef({ packProgressFor, getStartTime });
  useLayoutEffect(() => {
    packPlaybackRef.current = { packProgressFor, getStartTime };
  }, [getStartTime, packProgressFor]);

  const handlePickPackEpisode = (ep: Episode) => {
    if (!packStream) return;
    // The selector's target episode keeps the live/resume getter; any other episode reads its own progress row.
    const isTargetEpisode = episodeMatchesCoordinates(ep, displaySeason, displayEpisode);
    handleSelectStream(packStream, {
      ...buildEpisodeStreamTarget(lookupId, ep),
      getStartTime: () =>
        isTargetEpisode
          ? packPlaybackRef.current.getStartTime?.()
          : packPlaybackRef.current.packProgressFor(ep)?.resume_start_time,
    });
  };

  // Opening the selector predicts a player mount — warm the lazy chunk so the transition is an instant Suspense hit.
  useEffect(() => {
    if (open) warmPlayerChunk();
  }, [open]);

  // One-shot row autofocus per open.
  const [listFocusPending, setListFocusPending] = useState(false);
  useEffect(() => {
    if (open) setListFocusPending(true);
  }, [open]);
  const handleInitialFocusDone = () => setListFocusPending(false);

  const handleManageAddons = () => {
    handleRequestClose();
    navigateApp('/settings?section=addons');
  };

  // Per-source chips ride the loading state too — the roster lands before any stream, so "searching" shows real names.
  const healthChips =
    addonHealthMetrics.length > 0 ? (
      <StreamAddonHealthChips
        effectiveAddonFilter={effectiveAddonFilter}
        hasStreams={streams.length > 0}
        healthSummary={healthSummary}
        isRetrying={isRetrying}
        isResolving={isAnyResolving}
        metrics={addonHealthMetrics}
        onFiltersChange={setFilters}
        onRetry={refetchStreams}
        refreshFailed={refreshFailed}
        sourcesStillLoading={sourcesStillLoading}
      />
    ) : null;

  const streamPanel = (
    <div className='relative flex h-[82vh] flex-col gap-0 overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-950 p-0 shadow-2xl sm:max-w-4xl'>
      <StreamSelectorHeader
        backdrop={backdrop}
        compactOverview={compactOverview}
        episode={displayEpisode}
        episodeTitle={episodeTitle}
        logo={logo}
        mediaLabel={mediaTypeLabel(type)}
        onRequestClose={handleRequestClose}
        poster={poster}
        season={displaySeason}
        startTime={headerStartTime}
        title={title || 'Unknown Title'}
      />

      <div className='h-px bg-white/5 shrink-0' />
      <StreamResultsStatus
        resultCount={sortedStreams.length}
        pendingSourceCount={healthSummary.pending}
        searching={isLoading || sourcesStillLoading}
      />

      {/* Stream list — or the in-selector pack episode picker. The tree stays mounted under the pack overlay
          (`inert` drops it from tab order/a11y) so scroll, roving tabindex, and virtualizer state survive. */}
      <div className='relative flex-1 min-h-0 bg-zinc-950'>
        <div className='h-full min-h-0' inert={isPackOpen}>
          {isLoading ? (
            <StreamListLoadingState sourceCount={streamSourceCount} chips={healthChips} />
          ) : fatalAddonError ? (
            <StreamListErrorState
              isRetrying={isRetrying}
              message={getErrorMessage(fatalAddonError)}
              onRetry={refetchStreams}
              chips={healthChips}
            />
          ) : !isOnline ? (
            <StreamListOfflineState />
          ) : !isLoadingAddonConfigs && (!hasEnabledAddons || streamSourceCount === 0) ? (
            <StreamListNoAddonsState
              metadataOnly={hasEnabledAddons}
              onManageAddons={handleManageAddons}
            />
          ) : streams.length > 0 ? (
            <div
              className={cn(
                'flex h-full min-h-0 flex-col px-3 pt-3',
                isAnyResolving && 'pointer-events-none',
              )}
            >
              {healthChips}

              <StreamFilterToolbar
                batchFilter={batchFilter}
                filteredCount={sortedStreams.length}
                hasActiveFilter={hasActiveFilter}
                isResolving={isAnyResolving}
                onFiltersChange={setFilters}
                onResetFilters={resetFilters}
                onSearchQueryChange={setSearchQuery}
                onSearchSubmit={() => {
                  if (isSearchPending) resultsFocusPendingRef.current = true;
                  else focusResults();
                }}
                qualityFilter={qualityFilter}
                searchInputRef={searchInputRef}
                searchQuery={searchQuery}
                showBatchFilter={showBatchFilter}
                sortMode={sortMode}
                sourceFilter={sourceFilter}
                stats={streamStats}
                totalCount={streams.length}
              />

              {streamStats.playableCount === 0 && (
                <StreamP2pNotice p2pCount={streamStats.p2pCount} />
              )}

              {sortedStreams.length > 0 ? (
                <div className='min-h-0 flex-1' aria-busy={isSearchPending || undefined}>
                  <StreamVirtualList
                    key={selectorSessionKey}
                    resetKey={listResetKey}
                    canBrowsePack={allPackEpisodes.length > 0}
                    streams={sortedStreams}
                    activeResolveKey={activeResolveKey}
                    currentStreamKey={currentStreamKey}
                    lastStreamKey={lastStreamKey}
                    lastStreamFamily={lastStreamFamily}
                    handleSelectStream={handleStreamPress}
                    handleCopyLink={handleCopyLink}
                    isAnyResolving={isAnyResolving}
                    initialFocusPending={listFocusPending}
                    onInitialFocusDone={handleInitialFocusDone}
                    sortMode={sortMode}
                  />
                </div>
              ) : (
                <StreamListFilteredEmptyState
                  isSearchPending={isSearchPending}
                  isResolving={isAnyResolving}
                  searchQuery={searchQuery}
                  // A true clear, not resetFilters — the session default (`batch: 'episodes'` for series) can itself be the emptying filter.
                  onClearFilters={() => {
                    searchFocusPendingRef.current = true;
                    setSearchQuery('');
                    setFilters({ ...DEFAULT_FILTERS });
                  }}
                />
              )}
            </div>
          ) : (
            <StreamListEmptyState
              isRetrying={isRetrying}
              sourceCount={streamSourceCount}
              onRetry={refetchStreams}
              onManageAddons={handleManageAddons}
              chips={healthChips}
            />
          )}
        </div>
        {packStream && (
          <div className='absolute inset-0 z-10 bg-zinc-950'>
            <StreamPackEpisodeList
              backdrop={backdrop}
              disabled={isAnyResolving}
              error={packEpisodeError ? getErrorMessage(packEpisodeError) : null}
              rows={packRows}
              isLoading={isLoadingPack}
              onBack={closePackPicker}
              onPick={handlePickPackEpisode}
              onRetry={() => {
                if (isLoadingPack) return;
                const retry = { selection: packSelection, error: packEpisodeError };
                setPackRetry(retry);
                void retryPack({ cancelRefetch: false }).finally(() => {
                  setPackRetry((current) => (current === retry ? null : current));
                });
              }}
              onPlayTarget={() => handleSelectStream(packStream)}
              progressFor={packProgressFor}
              pendingEpisode={activeResolveEpisode}
              watchedEpisodeCeiling={watchedEpisodeCeiling}
              stream={packStream}
              targetEpisode={displayEpisode}
              targetMasked={targetMasked}
              targetSeason={displaySeason}
            />
          </div>
        )}
      </div>

      {activeResolveFeedback && (
        <StreamResolveFeedbackToast
          feedback={activeResolveFeedback}
          onCancel={cancelResolve}
          poster={poster}
        />
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        ref={dialogContentRef}
        hideCloseButton
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          dialogContentRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={() => {
          if (!open) onClosed?.();
        }}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            event.ctrlKey ||
            event.altKey ||
            event.metaKey ||
            isEditableTarget(event.target)
          )
            return;
          if (packStream) {
            if (event.key === 'Backspace') {
              event.preventDefault();
              event.stopPropagation();
              if (!event.repeat) closePackPicker();
            }
          } else if (
            !isAnyResolving &&
            !event.repeat &&
            event.key.length === 1 &&
            event.key !== ' '
          ) {
            // The default action then types the key into the newly focused field; repeats skip it so a held open-shortcut isn't typed.
            searchInputRef.current?.focus({ preventScroll: true });
          }
        }}
        onEscapeKeyDown={(event) => {
          if (event.repeat) {
            event.preventDefault();
          } else if (isAnyResolving) {
            event.preventDefault();
            cancelResolve();
          } else if (packStream) {
            event.preventDefault();
            closePackPicker();
          }
        }}
        overlayClassName='bg-black/55 backdrop-blur-[2px]'
        className='sm:max-w-4xl h-[82vh] flex flex-col p-0 bg-transparent border-none shadow-none rounded-md outline-hidden'
      >
        {streamPanel}
      </DialogContent>
    </Dialog>
  );
}
