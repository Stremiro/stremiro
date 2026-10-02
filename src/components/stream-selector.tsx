import { defaultRangeExtractor, type Range, useVirtualizer } from '@tanstack/react-virtual';
import { ArrowUp, Globe, Magnet, Zap, type LucideIcon } from 'lucide-react';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  StreamAddonHealthChips,
  StreamFilterToolbar,
  StreamListEmptyState,
  StreamListErrorState,
  StreamListFilteredEmptyState,
  StreamListLoadingState,
  StreamListNoAddonsState,
  StreamListNoStreamAddonsState,
  StreamListOfflineState,
  StreamP2pNotice,
  StreamPackEpisodeList,
  StreamResolveFeedbackToast,
  StreamSelectorHeader,
} from '@/components/stream-selector-panel';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useStreamSelectorController } from '@/hooks/use-stream-selector-controller';
import { warmPlayerChunk } from '@/lib/player-session';
import {
  getErrorMessage,
  type AddonStream,
  type Episode,
  type StreamSelectorSort,
} from '@/lib/api';
import { buildEpisodeStreamTarget, episodeMatchesCoordinates } from '@/lib/episode-stream-target';
import { episodeProgressKey, getPlayableResumeStartTime } from '@/lib/history-playback';
import type { StreamSelectorTarget } from '@/lib/stream-selector-target';
import {
  buildStreamMatchBadges,
  buildStreamReasonChips,
  buildStreamTechBadges,
  DEFAULT_FILTERS,
  streamMatchTier,
  type StreamMatchBadge,
  type StreamMatchTier,
  type StreamReasonChip,
} from '@/lib/stream-selector-utils';
import { cn, mediaTypeLabel, nonBlank } from '@/lib/utils';

// Dev-only ranking inspector: `rankDebug` only exists on debug-build
// payloads, and this gate keeps the branch out of production bundles.
const isDev = import.meta.env.DEV;

// Match-tier tint for the corner dot grid.
const MATCH_DOT_COLORS: Record<StreamMatchTier, string> = {
  exact: 'rgba(110, 231, 183, 0.5)',
  episode_range: 'rgba(125, 211, 252, 0.42)',
  season_pack: 'rgba(252, 211, 77, 0.42)',
};

interface StreamItemProps {
  disabled: boolean;
  isActive: boolean;
  isLastUsed: boolean;
  /** Same release family as the last-used pick (exact key absent). */
  isSameFamily: boolean;
  isResolving: boolean;
  onRowFocus: (streamKey: string) => void;
  onSelect: (stream: AddonStream) => void;
  /** Active sort — the card emphasizes whichever fact ordered it so the
      ranking reads on the row instead of only in the toolbar. */
  sortMode: StreamSelectorSort;
  stream: AddonStream;
  tabIndex: number;
}

interface StreamRowModel {
  isPlayable: boolean;
  sourceName: string;
  streamTitle: string;
  techBadges: ReturnType<typeof buildStreamTechBadges>;
  matchBadges: StreamMatchBadge[];
  matchTier: StreamMatchTier | null;
  recommendationReasons: StreamReasonChip[];
  matchAria: string;
  playableAria: string;
  SourceIcon: LucideIcon;
  iconTileClass: string;
  metaParts: { key: string; className?: string; text: string }[];
}

// Everything the row derives from `stream` in one pass — memoized per
// stream identity so flag-only re-renders (resolve/focus/disabled changes)
// skip the badge builders entirely.
function buildStreamRowModel(stream: AddonStream): StreamRowModel {
  const { presentation } = stream;
  const isPlayable = presentation.isInstantlyPlayable;
  const isCached = presentation.deliveryKind === 'cached';
  const isHttp = presentation.deliveryKind === 'http';
  const matchBadges = buildStreamMatchBadges(stream);
  const deliveryClass = isCached
    ? 'text-emerald-400/90'
    : isHttp
      ? 'text-sky-400/90'
      : 'text-zinc-500';

  const metaParts: StreamRowModel['metaParts'] = [];
  if (stream.sourceName) metaParts.push({ key: 'addon', text: stream.sourceName });
  metaParts.push({ key: 'delivery', text: presentation.deliveryLabel, className: deliveryClass });
  if (presentation.sizeLabel) metaParts.push({ key: 'size', text: presentation.sizeLabel });
  if (presentation.codecLabel) metaParts.push({ key: 'codec', text: presentation.codecLabel });
  if (presentation.audioLabel) metaParts.push({ key: 'audio', text: presentation.audioLabel });
  if (presentation.multiAudioLabel)
    metaParts.push({ key: 'multi', text: presentation.multiAudioLabel });

  return {
    isPlayable,
    sourceName: nonBlank(presentation.sourceName) || 'Unknown',
    streamTitle: nonBlank(presentation.streamTitle) || 'Unknown',
    techBadges: buildStreamTechBadges(stream),
    matchBadges,
    matchTier: streamMatchTier(stream),
    recommendationReasons: buildStreamReasonChips(stream),
    matchAria:
      matchBadges.length > 0 ? `, ${matchBadges.map((badge) => badge.label).join(', ')}` : '',
    playableAria: isPlayable ? '' : ', P2P source, not playable in this build',
    SourceIcon: isCached ? Zap : isHttp ? Globe : Magnet,
    iconTileClass: isCached
      ? 'border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300'
      : isHttp
        ? 'border-sky-400/20 bg-sky-400/[0.08] text-sky-300'
        : 'border-white/[0.08] bg-white/[0.04] text-zinc-400',
    metaParts,
  };
}

// Memoized so resolving-state changes only re-render the active row: the
// parent passes a stable handler plus per-row flags, never a fresh closure.
const StreamItem = memo(function StreamItem({
  stream,
  onSelect,
  onRowFocus,
  isActive,
  isLastUsed,
  isSameFamily,
  isResolving,
  disabled,
  sortMode,
  tabIndex,
}: StreamItemProps) {
  const {
    isPlayable,
    sourceName,
    streamTitle,
    techBadges,
    matchBadges,
    matchTier,
    recommendationReasons,
    matchAria,
    playableAria,
    SourceIcon,
    iconTileClass,
    metaParts,
  } = useMemo(() => buildStreamRowModel(stream), [stream]);

  return (
    <div
      role='listitem'
      className={cn(
        'group relative px-3 py-2.5 rounded-xl',
        'bg-white/[0.02] border border-white/[0.05]',
        'hover:bg-white/[0.045] hover:border-white/[0.1]',
        'transition-[background-color,border-color,opacity] duration-150 cursor-pointer w-full overflow-hidden',
        !isPlayable && 'opacity-55 saturate-[0.65]',
        isActive && 'border-emerald-400/30 bg-emerald-400/[0.04]',
        disabled && !isResolving && 'opacity-50',
        isResolving && 'pointer-events-none border-white/[0.16] bg-white/[0.05]',
      )}
    >
      {/* Match-tier dot grid (see MATCH_DOT_COLORS). */}
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

      <button
        type='button'
        onClick={() => onSelect(stream)}
        onFocus={() => onRowFocus(stream.streamKey)}
        aria-disabled={disabled || undefined}
        data-stream-key={stream.streamKey}
        tabIndex={tabIndex}
        aria-label={`Select ${sourceName} stream${techBadges.map((badge) => `, ${badge.label}`).join('')}${matchAria}${playableAria}. ${streamTitle}`}
        className='absolute inset-0 z-0 rounded-xl focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-0'
      />

      {isResolving && (
        <div className='absolute bottom-0 left-0 right-0 h-[2px] bg-white/5 overflow-hidden rounded-b-xl'>
          <div className='h-full w-1/3 bg-white/50 animate-[progress-slide_1.6s_linear_infinite]' />
        </div>
      )}

      <div className='relative z-10 flex items-center gap-3 pointer-events-none'>
        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
            iconTileClass,
          )}
        >
          <SourceIcon className='h-4 w-4' strokeWidth={2} />
        </div>

        <div className='flex-1 min-w-0'>
          <div className='flex items-center gap-1.5 min-w-0'>
            <p
              className='text-[13px] font-semibold text-zinc-100 truncate group-hover:text-white transition-colors leading-tight min-w-0'
              title={sourceName}
            >
              {sourceName}
            </p>
            <div className='flex items-center gap-1 shrink-0'>
              {techBadges.map((badge, badgeIndex) => (
                <span
                  key={`${badge.label}:${badge.cls}`}
                  className={cn(
                    'inline-flex h-[18px] items-center px-1.5 rounded-md border text-[10px] font-semibold tracking-wide leading-none tabular-nums',
                    badge.cls,
                    // Sorting by quality lights the resolution chip the
                    // sort ordered on — the ranking key reads on the card.
                    badgeIndex === 0 && sortMode === 'quality' && 'ring-1 ring-violet-300/50',
                  )}
                >
                  {badge.label}
                </span>
              ))}
              {isActive && (
                <span className='inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-[3px] rounded-md border bg-emerald-400/[0.08] border-emerald-400/25 text-emerald-200 leading-none'>
                  <span className='h-1 w-1 rounded-full bg-emerald-400 animate-pulse' />
                  Current
                </span>
              )}
              {!isActive && isLastUsed && (
                <span
                  title='The stream this title last played through'
                  className='inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-sky-300/90 leading-none'
                >
                  <span className='h-1 w-1 rounded-full bg-sky-400' />
                  Last used
                </span>
              )}
              {!isActive && !isLastUsed && isSameFamily && (
                <span
                  title='Same release family as the stream this title last played through'
                  className='text-[10px] font-medium uppercase tracking-wider text-zinc-500 leading-none'
                >
                  Same release
                </span>
              )}
            </div>
          </div>

          <p
            className='text-[11px] text-zinc-400/80 truncate mt-0.5 leading-snug'
            title={streamTitle}
          >
            {streamTitle}
          </p>

          <div className='flex items-center gap-1.5 mt-1 overflow-hidden whitespace-nowrap'>
            {metaParts.map((part, index) => (
              <Fragment key={part.key}>
                {index > 0 && <span className='text-zinc-700 text-[10px]'>·</span>}
                <span
                  className={cn(
                    'text-[10px] font-medium text-zinc-400/75 truncate min-w-0',
                    part.className,
                  )}
                >
                  {part.text}
                </span>
              </Fragment>
            ))}
            {typeof stream.seeders === 'number' && stream.seeders > 0 && (
              <>
                <span className='text-zinc-700 text-[10px]'>·</span>
                <span
                  className={cn(
                    'text-[10px] inline-flex items-center gap-0.5 shrink-0',
                    sortMode === 'seeds'
                      ? 'text-emerald-300 font-semibold'
                      : 'text-emerald-400/90 font-medium',
                  )}
                >
                  <ArrowUp className='w-[9px] h-[9px]' strokeWidth={2.5} />
                  {stream.seeders}
                </span>
              </>
            )}
          </div>

          {/* Signal line: colored-dot match tokens plus plain-text reasons —
              the facts stay, the chip chrome doesn't stack up. */}
          {(matchBadges.length > 0 || recommendationReasons.length > 0) && (
            <div className='mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1'>
              {matchBadges.map((badge) => (
                <span
                  key={badge.kind}
                  className={cn(
                    'inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider leading-none',
                    badge.textCls,
                  )}
                >
                  <span className={cn('h-1 w-1 rounded-full', badge.dotCls)} />
                  {badge.label}
                </span>
              ))}
              {recommendationReasons.map((reason) => (
                <span
                  key={reason.kind}
                  className={cn(
                    'text-[10px] font-medium leading-none',
                    reason.caution ? 'text-amber-200/70' : 'text-zinc-500',
                  )}
                >
                  {reason.label}
                </span>
              ))}
            </div>
          )}

          {isDev && stream.rankDebug && (
            <p className='mt-1 truncate font-mono text-[10px] leading-4 text-white/30'>
              {stream.rankDebug}
            </p>
          )}
        </div>
      </div>
    </div>
  );
});

const STREAM_ROW_ESTIMATE_PX = 92;
const STREAM_ROW_GAP_PX = 6;
const STREAM_LIST_VIRTUALIZE_THRESHOLD = 40;

interface StreamVirtualListProps {
  streams: readonly AddonStream[];
  activeResolveKey: string | null;
  currentStreamKey?: string;
  lastStreamKey?: string;
  /** Release family of the last-used pick — the fallback badge when the
      exact key can't exist (sibling episode) or rotted. */
  lastStreamFamily?: string;
  handleSelectStream: (stream: AddonStream) => void;
  isAnyResolving: boolean;
  /** True once per dialog open: focus + scroll the remembered row into view. */
  initialFocusPending: boolean;
  onInitialFocusDone: () => void;
  /** Active sort — rows emphasize the fact the list is ordered by. */
  sortMode: StreamSelectorSort;
}

// Container-virtualized stream rows: a 500-row payload costs ~15 mounted
// rows; below the threshold it renders directly with no virtualizer overhead.
// Plain function — useVirtualizer helpers are unmemoizable by design.
function StreamVirtualList({
  streams,
  activeResolveKey,
  currentStreamKey,
  lastStreamKey,
  lastStreamFamily,
  handleSelectStream,
  isAnyResolving,
  initialFocusPending,
  onInitialFocusDone,
  sortMode,
}: StreamVirtualListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Latched at mount: progressive arrivals crossing the threshold mid-session
  // would swap every row's DOM under the focused element, killing keyboard
  // nav. Filter remounts (key) still re-evaluate.
  const [isVirtualized] = useState(() => streams.length >= STREAM_LIST_VIRTUALIZE_THRESHOLD);
  const streamIndexByKey = useMemo(() => {
    const indices = new Map<string, number>();
    streams.forEach((stream, index) => indices.set(stream.streamKey, index));
    return indices;
  }, [streams]);
  const getItemKey = useCallback((index: number) => streams[index].streamKey, [streams]);

  // Roving tabindex: one tab stop for the whole list; arrows move the stop.
  // Lands on the currently-playing row, else the last-used pick, else the
  // first playable row.
  const [focusedStreamKey, setFocusedStreamKey] = useState(() => {
    if (currentStreamKey && streamIndexByKey.has(currentStreamKey)) return currentStreamKey;
    if (lastStreamKey && streamIndexByKey.has(lastStreamKey)) return lastStreamKey;
    return (
      streams.find((stream) => stream.presentation.isInstantlyPlayable)?.streamKey ??
      streams[0]?.streamKey
    );
  });
  // Progressive ranking can insert rows before the focused stream. Identity,
  // not its old index, owns the tab stop and the next arrow-key destination.
  const matchedFocusedIndex = streamIndexByKey.get(focusedStreamKey ?? '');
  const focusedIndex = matchedFocusedIndex ?? 0;
  const firstStreamKey = streams[0]?.streamKey;
  // Keep one extra row mounted: scrolling or progressive re-ranking must not
  // remove the focused button (or the pack picker's return-focus target).
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indices = defaultRangeExtractor(range);
      if (focusedIndex < range.count && !indices.includes(focusedIndex)) {
        indices.push(focusedIndex);
        indices.sort((left, right) => left - right);
      }
      return indices;
    },
    [focusedIndex],
  );
  const virtualizer = useVirtualizer({
    count: streams.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => STREAM_ROW_ESTIMATE_PX,
    getItemKey,
    rangeExtractor,
    overscan: 8,
    enabled: isVirtualized,
  });

  // Which row the open-time autofocus targeted — lets a late-resolving
  // lastStreamKey complete the deferred autofocus below.
  const autofocusKeyRef = useRef<string | null>(null);

  // Family fallback badge: only when the exact key isn't listed (sibling
  // episode / re-digested key). The badge lands on the first family member
  // in the active list order.
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

  // A virtual row mounts only after the scroll commit, so the frame after
  // scrollToIndex can still miss it — retry once before giving up. The
  // initial pass also scrolls the remembered row into view, which covers
  // the non-virtualized path (the virtualizer scrolls itself).
  const scheduleRowFocus = useCallback((streamKey: string, initial: boolean) => {
    let retried = false;
    const attempt = () => {
      const row = scrollRef.current?.querySelector<HTMLElement>(
        `[data-stream-key="${CSS.escape(streamKey)}"]`,
      );
      if (!row) {
        if (!retried) {
          retried = true;
          requestAnimationFrame(attempt);
        }
        return;
      }
      row.focus({ preventScroll: initial });
      if (initial) row.scrollIntoView({ block: 'nearest' });
    };
    requestAnimationFrame(attempt);
  }, []);

  const focusRow = useCallback(
    (index: number) => {
      const stream = streams[index];
      if (!stream) return;
      setFocusedStreamKey(stream.streamKey);
      if (isVirtualized) {
        virtualizer.scrollToIndex(index, { align: 'auto' });
      }
      scheduleRowFocus(stream.streamKey, false);
    },
    [isVirtualized, scheduleRowFocus, streams, virtualizer],
  );

  // Per-open: focus the remembered row and scroll it into view. Filter
  // remounts leave pending=false so a chip click never steals focus back.
  useEffect(() => {
    if (!initialFocusPending) return;
    onInitialFocusDone();
    const streamKey = streams[focusedIndex]?.streamKey;
    if (!streamKey) return;
    autofocusKeyRef.current = streamKey;
    if (isVirtualized) {
      virtualizer.scrollToIndex(focusedIndex, { align: 'center' });
    }
    // Deliberately not the effect's cleanup: `onInitialFocusDone` flips
    // `initialFocusPending`, which re-runs this effect and would cancel the
    // frame it just scheduled. The rAF callback is null-safe after unmount
    // and self-limits to one retry, so it needs no cancellation.
    scheduleRowFocus(streamKey, true);
    // focusedIndex intentionally read once at open — later arrow moves must
    // not retrigger the auto-focus path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVirtualized, onInitialFocusDone, initialFocusPending, scheduleRowFocus, virtualizer]);

  // lastStreamKey resolves via a query that can land after mount on a cold
  // cache. Retarget autofocus onto the last-used row — but only while the
  // roving stop still sits where autofocus left it: resting focus (opener
  // trigger, dialog default) is not a user claim.
  useEffect(() => {
    const from = autofocusKeyRef.current;
    if (!lastStreamKey || from === null) return;
    if (focusedStreamKey !== from || (currentStreamKey && streamIndexByKey.has(currentStreamKey))) {
      autofocusKeyRef.current = null;
      return;
    }
    const lastUsed = streamIndexByKey.get(lastStreamKey);
    if (lastUsed === undefined) return;
    autofocusKeyRef.current = null;
    if (lastStreamKey === from) return;

    // Tabbing to chrome doesn't change the roving stop. Only retarget while
    // focus still rests on the auto-focused row or the dialog container.
    const listEl = scrollRef.current;
    const active = document.activeElement;
    const autoRow = listEl?.querySelector(`[data-stream-key="${CSS.escape(from)}"]`);
    const focusIsResting =
      !active ||
      active === document.body ||
      active === autoRow ||
      active === listEl ||
      (listEl !== null && active.contains(listEl));
    if (focusIsResting) focusRow(lastUsed);
  }, [currentStreamKey, focusRow, focusedStreamKey, lastStreamKey, streamIndexByKey]);

  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const count = streams.length;
      if (count === 0) return;
      let next: number | null = null;
      switch (event.key) {
        case 'ArrowDown':
          next = Math.min(count - 1, focusedIndex + 1);
          break;
        case 'ArrowUp':
          next = Math.max(0, focusedIndex - 1);
          break;
        case 'PageDown':
          next = Math.min(count - 1, focusedIndex + 8);
          break;
        case 'PageUp':
          next = Math.max(0, focusedIndex - 8);
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = count - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
      focusRow(next);
    },
    [focusRow, focusedIndex, streams.length],
  );

  const renderRow = useCallback(
    (stream: AddonStream, index: number) => {
      const streamKey = stream.streamKey;
      return (
        <StreamItem
          key={streamKey}
          stream={stream}
          onSelect={handleSelectStream}
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
    },
    [
      activeResolveKey,
      currentStreamKey,
      focusedIndex,
      handleSelectStream,
      isAnyResolving,
      lastStreamKey,
      familyFallbackKey,
      sortMode,
    ],
  );

  return (
    // Keydown lands here via bubbling from the focused row button — the
    // container itself is never the interaction target.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={scrollRef}
      role='list'
      className={cn(
        'h-full overflow-y-auto overscroll-contain',
        !isVirtualized && 'p-3 space-y-1.5 pb-6',
      )}
      onKeyDown={handleListKeyDown}
    >
      {isVirtualized ? (
        <div
          className='relative w-full'
          // Absolute rows ignore padding: 12px top + 24px bottom insets are
          // folded into the explicit height (top-3 offsets + trailing space
          // matching the non-virtualized pb-6).
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
      ) : (
        streams.map(renderRow)
      )}
    </div>
  );
}

interface StreamSelectorProps {
  open: boolean;
  onClose: () => void;
  onBeforePlayerNavigation?: () => void | Promise<void>;
  target: StreamSelectorTarget;
  currentStreamKey?: string;
  /** Resume position read at pick time — a getter so live positions stay fresh. */
  getStartTime?: () => number | undefined;
}

export function StreamSelector({
  open,
  onClose,
  onBeforePlayerNavigation,
  target,
  currentStreamKey,
  getStartTime,
}: StreamSelectorProps) {
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
    title,
    type,
  } = target;
  const {
    activeResolveFeedback,
    activeResolveKey,
    addonHealthMetrics,
    batchFilter,
    cancelResolve,
    compactOverview,
    effectiveAddonFilter,
    enabledAddons,
    episodeProgressMap,
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
    lastStreamKey,
    lastStreamFamily,
    lookupId,
    qualityFilter,
    refetchStreams,
    resetFilters,
    selectorSessionKey,
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

  // Canonical display coordinates — the header shows the numbering the user
  // browsed (absolute), not the addon's stream-space remap.
  const displaySeason = absoluteSeason ?? season;
  const displayEpisode = absoluteEpisode ?? episode;

  // Pack browsing: a playable batch row opens the "inside the pack" episode
  // picker instead of resolving blind. Reset on close and on session change.
  const [packStream, setPackStream] = useState<AddonStream | null>(null);
  // Row that opened the picker — refocused on return. The stream list stays
  // mounted under the pack overlay, so the element survives the round-trip.
  const packReturnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    setPackStream(null);
    packReturnFocusRef.current = null;
  }, [open, selectorSessionKey]);

  const closePackPicker = useCallback(() => {
    cancelResolve();
    setPackStream(null);
    // The picker unmounts with focus inside it — hand it back to the pack
    // row that opened it rather than dropping to <body>.
    requestAnimationFrame(() => packReturnFocusRef.current?.focus());
  }, [cancelResolve]);

  // `episodes` arrives (season, episode)-sorted natively — no re-sort; the
  // memo only pins a stable empty list for `undefined`.
  const packEpisodes = useMemo(() => episodes ?? [], [episodes]);

  const handleStreamPress = useCallback(
    (stream: AddonStream) => {
      if (isAnyResolving) return;
      if (
        stream.presentation.isBatch &&
        stream.presentation.isInstantlyPlayable &&
        packEpisodes.length > 0
      ) {
        packReturnFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setPackStream(stream);
        return;
      }
      handleSelectStream(stream);
    },
    [handleSelectStream, isAnyResolving, packEpisodes.length],
  );

  const packProgressFor = useCallback(
    (ep: Episode) => episodeProgressMap.get(episodeProgressKey(target.id, ep.season, ep.episode)),
    [episodeProgressMap, target.id],
  );

  const handlePickPackEpisode = useCallback(
    (ep: Episode) => {
      if (!packStream) return;
      // The selector's own target episode keeps the live/resume getter;
      // any other episode reads its own saved progress row.
      const isTargetEpisode = episodeMatchesCoordinates(ep, displaySeason, displayEpisode);
      const startTime = isTargetEpisode
        ? getStartTime?.()
        : getPlayableResumeStartTime(packProgressFor(ep));
      handleSelectStream(packStream, {
        ...buildEpisodeStreamTarget(lookupId, ep),
        startTime,
      });
    },
    [
      packStream,
      displaySeason,
      displayEpisode,
      getStartTime,
      packProgressFor,
      lookupId,
      handleSelectStream,
    ],
  );

  // Opening the selector predicts a player mount moments later — warm the
  // lazy chunk now so the transition is an instant Suspense hit.
  useEffect(() => {
    if (open) warmPlayerChunk();
  }, [open]);

  // One-shot row autofocus per open: the flag survives list remounts from
  // filter changes, so a chip click can't steal focus back to row zero.
  const [listFocusPending, setListFocusPending] = useState(false);
  useEffect(() => {
    if (open) setListFocusPending(true);
  }, [open]);
  const handleInitialFocusDone = useCallback(() => setListFocusPending(false), []);

  // Filter or sort changes drop the list to the top — remounting the virtual
  // list resets scroll offset and row measurements in one step.
  const listResetKey = `${qualityFilter}:${sourceFilter}:${batchFilter}:${sortMode}:${effectiveAddonFilter}`;

  // Per-source chips ride the loading state too — the roster snapshot lands
  // before any stream, so "searching" shows real names instead of skeletons.
  const healthChips =
    addonHealthMetrics.length > 0 ? (
      <StreamAddonHealthChips
        effectiveAddonFilter={effectiveAddonFilter}
        healthSummary={healthSummary}
        metrics={addonHealthMetrics}
        onFiltersChange={setFilters}
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
        title={title || 'Unknown Title'}
      />

      {/* Divider */}
      <div className='h-px bg-white/5 shrink-0' />

      {/* Stream list — or the in-selector pack episode picker. The stream
          tree stays mounted under the pack overlay (`inert` keeps it out of
          the tab order and a11y tree) so scroll offset, roving tabindex, and
          virtualizer state survive the round-trip. */}
      <div className='relative flex-1 min-h-0 bg-zinc-950'>
        <div className='h-full min-h-0' inert={packStream !== null}>
          {isLoading ? (
            <StreamListLoadingState sourceCount={streamSourceCount} chips={healthChips} />
          ) : fatalAddonError ? (
            <StreamListErrorState
              message={getErrorMessage(fatalAddonError)}
              onRetry={refetchStreams}
              chips={healthChips}
            />
          ) : !isOnline ? (
            <StreamListOfflineState />
          ) : !isLoadingAddonConfigs && enabledAddons.length === 0 ? (
            <StreamListNoAddonsState />
          ) : !isLoadingAddonConfigs && streamSourceCount === 0 ? (
            <StreamListNoStreamAddonsState />
          ) : streams.length > 0 ? (
            <div className='flex h-full min-h-0 flex-col'>
              {/* Must stay a bounded flex column: the list below is flex-1, and
                without min-h-0/flex context it overflows instead of scrolling. */}
              <div
                className={cn(
                  'flex min-h-0 flex-1 flex-col px-3 pt-3',
                  isAnyResolving && 'pointer-events-none',
                )}
              >
                {healthChips}

                <StreamFilterToolbar
                  batchFilter={batchFilter}
                  filteredCount={sortedStreams.length}
                  hasActiveFilter={hasActiveFilter}
                  onFiltersChange={setFilters}
                  onResetFilters={resetFilters}
                  qualityFilter={qualityFilter}
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
                  <div className='min-h-0 flex-1'>
                    <StreamVirtualList
                      key={listResetKey}
                      streams={sortedStreams}
                      activeResolveKey={activeResolveKey}
                      currentStreamKey={currentStreamKey}
                      lastStreamKey={lastStreamKey}
                      lastStreamFamily={lastStreamFamily}
                      handleSelectStream={handleStreamPress}
                      isAnyResolving={isAnyResolving}
                      initialFocusPending={listFocusPending}
                      onInitialFocusDone={handleInitialFocusDone}
                      sortMode={sortMode}
                    />
                  </div>
                ) : (
                  <StreamListFilteredEmptyState
                    // A true clear, not resetFilters: the session default
                    // (`batch: 'episodes'` for series) can itself be the filter
                    // that emptied the list.
                    onClearFilters={() => setFilters({ ...DEFAULT_FILTERS })}
                  />
                )}
              </div>
            </div>
          ) : (
            <StreamListEmptyState
              sourceCount={streamSourceCount}
              onRetry={refetchStreams}
              chips={healthChips}
            />
          )}
        </div>
        {packStream && (
          <div className='absolute inset-0 z-10 bg-zinc-950'>
            <StreamPackEpisodeList
              backdrop={backdrop}
              disabled={isAnyResolving}
              episodes={packEpisodes}
              onBack={closePackPicker}
              onPick={handlePickPackEpisode}
              progressFor={packProgressFor}
              stream={packStream}
              targetEpisode={displayEpisode}
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
        onKeyDown={(event) => {
          if (
            packStream &&
            event.key === 'Backspace' &&
            !event.defaultPrevented &&
            !event.nativeEvent.isComposing &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) closePackPicker();
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
        className='sm:max-w-4xl h-[82vh] flex flex-col p-0 bg-transparent border-none shadow-none rounded-md [&>button]:hidden'
      >
        {streamPanel}
      </DialogContent>
    </Dialog>
  );
}
