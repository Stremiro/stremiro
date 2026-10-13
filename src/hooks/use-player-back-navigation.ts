import { type RefObject, useCallback } from 'react';
import { useNavigate } from 'react-router';

import { type DetailsHistoryRouteState, playableResumePosition } from '@/lib/history-playback';
import { pathBelowTop, stashDetailsReturnState } from '@/lib/navigation';
import {
  buildDetailsRoute,
  type PlayerRouteMediaType,
  resolveSafeInternalReturnPath,
} from '@/lib/player-navigation';

interface UsePlayerBackNavigationOptions {
  currentTimeRef: RefObject<number>;
  effectiveResolveMediaType: PlayerRouteMediaType;
  from?: string;
  id?: string;
  /** The launch page's own origin — lets Back→details→Back reach the real origin. */
  originFrom?: string;
  restoreCursorVisibility: () => void;
  routeAbsoluteEpisode?: number;
  routeAbsoluteSeason?: number;
  setShowControls: (value: boolean) => void;
  setShowEpisodes: (value: boolean) => void;
  /** Back-time check: reopen the selector only when leaving is meaningful (failed, unverified, finished). */
  shouldReopenStreamSelector: () => boolean;
  startTime?: number;
}

interface UsePlayerBackNavigationResult {
  navigateBack: () => Promise<void>;
}

export function usePlayerBackNavigation({
  currentTimeRef,
  effectiveResolveMediaType,
  from,
  id,
  originFrom,
  restoreCursorVisibility,
  routeAbsoluteEpisode,
  routeAbsoluteSeason,
  setShowControls,
  setShowEpisodes,
  shouldReopenStreamSelector,
  startTime,
}: UsePlayerBackNavigationOptions): UsePlayerBackNavigationResult {
  const navigate = useNavigate();
  // Replace the player in history so Back never re-launches it; Back drops
  // to the mini player and the dock transition flushes progress.
  const navigateBack = useCallback(async () => {
    setShowControls(true);
    setShowEpisodes(false);
    restoreCursorVisibility();
    // The selector/Esc can swallow Back mid-pick, so only route coordinates can ride the back target.
    const backSeason = routeAbsoluteSeason;
    const backEpisode = routeAbsoluteEpisode;
    const backStartTime = playableResumePosition(currentTimeRef.current, startTime);
    // Reopen state: 0 stays valid, episode needs a season, start time positive.
    const safeFrom = resolveSafeInternalReturnPath(from);
    const safeOriginFrom = resolveSafeInternalReturnPath(originFrom);
    const detailsTarget = safeFrom?.startsWith('/details/')
      ? safeFrom
      : buildDetailsRoute(effectiveResolveMediaType, id ?? '');
    const reopenSelectorState: DetailsHistoryRouteState = {
      reopenStreamSelector: shouldReopenStreamSelector(),
    };
    // `from` is the launch page's origin — writing the details path would dead-end titlebar Back.
    if (safeOriginFrom && safeOriginFrom !== detailsTarget) {
      reopenSelectorState.from = safeOriginFrom;
    }
    if (typeof backSeason === 'number' && Number.isFinite(backSeason)) {
      reopenSelectorState.season = backSeason;
      reopenSelectorState.reopenStreamSeason = backSeason;
    }
    if (
      typeof backEpisode === 'number' &&
      Number.isFinite(backEpisode) &&
      reopenSelectorState.reopenStreamSeason !== undefined
    ) {
      reopenSelectorState.reopenStreamEpisode = backEpisode;
    }
    if (backStartTime !== undefined) {
      reopenSelectorState.reopenStartTime = backStartTime;
    }

    // If the launch entry sits directly below the player, pop onto it — a replace
    // would stack a duplicate. History state can't ride a POP, so the reopen handoff uses the path-keyed stash.
    if (safeFrom && pathBelowTop() === safeFrom) {
      if (safeFrom.startsWith('/details/')) {
        stashDetailsReturnState(safeFrom, reopenSelectorState);
      }
      navigate(-1);
      return;
    }

    if (safeFrom) {
      if (safeFrom.startsWith('/details/')) {
        navigate(safeFrom, { replace: true, state: reopenSelectorState });
      } else {
        navigate(safeFrom, { replace: true });
      }
    } else {
      navigate(detailsTarget, { replace: true, state: reopenSelectorState });
    }
  }, [
    navigate,
    routeAbsoluteSeason,
    routeAbsoluteEpisode,
    from,
    originFrom,
    effectiveResolveMediaType,
    id,
    restoreCursorVisibility,
    startTime,
    setShowEpisodes,
    setShowControls,
    currentTimeRef,
    shouldReopenStreamSelector,
  ]);

  return { navigateBack };
}
