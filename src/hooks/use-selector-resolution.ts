import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { getErrorKind, getErrorMessage, type AddonStream } from '@/lib/api';
import type { NextEpisodeStreamCoordinates } from '@/lib/episode-stream-target';
import { launchResolvedStream } from '@/lib/player-navigation';
import { resolvePlayerStream } from '@/lib/resolve-player-stream';
import type { StreamSelectorTarget } from '@/lib/stream-selector-target';

const isDev = import.meta.env.DEV;

interface ActiveResolveFeedback {
  subtitle: string;
  title: string;
}

/** Episode-in-pack pick: the pack row supplies the stream; the pick supplies
    the episode coordinates + resume point to resolve against. */
interface SelectorEpisodeOverride extends NextEpisodeStreamCoordinates {
  startTime?: number;
}

interface SelectorResolveAttempt {
  feedback: ActiveResolveFeedback;
  stream: AddonStream;
  attemptId: number;
  sessionKey: string;
  episodeOverride?: SelectorEpisodeOverride;
}

interface UseSelectorResolutionArgs {
  getStartTime?: () => number | undefined;
  /** `streamId ?? id`, resolved upstream so the session key cannot drift. */
  lookupId: string;
  onBeforePlayerNavigation?: () => void | Promise<void>;
  onClose: () => void;
  open: boolean;
  selectorSessionKey: string;
  target: StreamSelectorTarget;
}

function buildResolveFeedback(stream: AddonStream): ActiveResolveFeedback {
  const normalizedTitle =
    stream.presentation.streamTitle.trim() ||
    stream.presentation.sourceName.trim() ||
    'Selected stream';
  const subtitle = [stream.sourceName?.trim(), stream.presentation.deliveryLabel]
    .filter(Boolean)
    .join(' | ');

  return {
    subtitle,
    title: normalizedTitle,
  };
}

export function useSelectorResolution({
  getStartTime,
  lookupId,
  onBeforePlayerNavigation,
  onClose,
  open,
  selectorSessionKey,
  target,
}: UseSelectorResolutionArgs) {
  const {
    absoluteEpisode,
    absoluteSeason,
    backdrop,
    episode,
    from,
    id,
    logo,
    originFrom,
    poster,
    season,
    title,
    type: streamMediaType,
  } = target;
  const navigate = useNavigate();
  // Key/session/feedback always move as one unit — a single nullable state
  // can't tear mid-update the way three sibling states could.
  const [activeResolve, setActiveResolve] = useState<{
    feedback: ActiveResolveFeedback;
    key: string;
    sessionKey: string;
  } | null>(null);
  // Synchronous in-flight guard: `isPending` is render-time state — two
  // selects in the same tick would both spawn a resolve IPC.
  const resolveInFlightRef = useRef(false);
  // A slow resolve can outlive the close click and the component — `open`/
  // `mounted` captured in the mutation closure would go stale.
  const openRef = useRef(open);
  const latestSessionKeyRef = useRef(selectorSessionKey);
  // Resume position reads through the getter at resolve time — the selector
  // never subscribes to the playback clock.
  const getStartTimeRef = useRef(getStartTime);
  // Per-attempt identity: a cancelled/superseded resolve can never match
  // again — its late winner can't navigate or reset newer UI state.
  const resolveAttemptIdRef = useRef(0);
  // Latest-render binding for the resolve body: `handleSelectStream` is an
  // event handler (`useEffectEvent` is off-contract) — a per-render ref gives
  // the same latest-closure semantics.
  const resolveStreamRef = useRef<((attempt: SelectorResolveAttempt) => Promise<void>) | undefined>(
    undefined,
  );
  // Unmount invalidates every outstanding attempt.
  const mountedRef = useMountedRef(() => {
    resolveAttemptIdRef.current += 1;
  });

  useEffect(() => {
    openRef.current = open;
    latestSessionKeyRef.current = selectorSessionKey;
    getStartTimeRef.current = getStartTime;
  });

  const isCurrentResolve = useCallback(
    (attempt: SelectorResolveAttempt) =>
      mountedRef.current &&
      openRef.current &&
      attempt.attemptId === resolveAttemptIdRef.current &&
      attempt.sessionKey === latestSessionKeyRef.current,
    [mountedRef],
  );

  // The selector only exposes the in-flight resolve for its own session — a
  // resolve started before a session switch stays hidden until invalidated.
  const sessionResolve = activeResolve?.sessionKey === selectorSessionKey ? activeResolve : null;

  const resetActiveResolveState = useCallback(() => {
    resolveInFlightRef.current = false;
    setActiveResolve(null);
  }, []);

  // Cancel affordance: invalidate the attempt so its late winner can't
  // navigate, and release the UI lock.
  const cancelResolve = useCallback(() => {
    resolveAttemptIdRef.current += 1;
    resetActiveResolveState();
  }, [resetActiveResolveState]);

  const closeSelector = useCallback(() => {
    cancelResolve();
    onClose();
  }, [cancelResolve, onClose]);

  // Every open/session transition invalidates outstanding attempts — a stale
  // resolve can never act on the new session.
  useEffect(() => {
    cancelResolve();
  }, [cancelResolve, open, selectorSessionKey]);

  const resolveStream = async (attempt: SelectorResolveAttempt) => {
    const { stream } = attempt;
    // A pack-episode pick overrides every coordinate with the chosen
    // episode's own; a plain row resolves the selector's target.
    const override = attempt.episodeOverride;
    const coords = {
      streamLookupId: override?.streamLookupId ?? lookupId,
      streamSeason: override?.streamSeason ?? season,
      streamEpisode: override?.streamEpisode ?? episode,
      absoluteSeason: override?.absoluteSeason ?? absoluteSeason,
      absoluteEpisode: override?.absoluteEpisode ?? absoluteEpisode,
    };
    try {
      // Resolve by identity: `preferredStreamKey` keeps the raw stream
      // payload (proxy secrets included) out of JS. Source/family ride along
      // so a re-digested key still soft-matches the same stream.
      const data = await resolvePlayerStream({
        mediaType: streamMediaType,
        mediaId: id,
        streamLookupId: coords.streamLookupId,
        streamSeason: coords.streamSeason,
        streamEpisode: coords.streamEpisode,
        absoluteSeason: coords.absoluteSeason,
        absoluteEpisode: coords.absoluteEpisode,
        title,
        preferred: {
          streamKey: stream.streamKey,
          sourceId: stream.sourceId,
          sourceName: stream.sourceName,
          streamFamily: stream.streamFamily,
        },
      });

      // A cancelled or superseded attempt must never navigate — the user may
      // have closed, switched titles, or unmounted meanwhile.
      if (!isCurrentResolve(attempt)) {
        return;
      }
      const feedback = attempt.feedback;

      // One request object feeds the prime and the route state: the
      // canonical-season fold must match or the player's replay misses the
      // primed entry.
      const resolvedRequest = {
        mediaId: id,
        mediaType: streamMediaType,
        absoluteEpisode: coords.absoluteEpisode,
        absoluteSeason: coords.absoluteSeason ?? coords.streamSeason,
        streamEpisode: coords.streamEpisode,
        streamLookupId: coords.streamLookupId,
        streamSeason: coords.streamSeason,
        title,
      };

      const routeExtras = {
        backdrop,
        from,
        originFrom,
        logo,
        openingStreamName: feedback.title,
        openingStreamSource: feedback.subtitle,
        poster,
        // An undefined pack resume point means start fresh, not the current
        // episode's live position. Plain stream swaps retain the live getter.
        startTime: override ? override.startTime : getStartTimeRef.current?.(),
      };

      await Promise.resolve()
        .then(() => onBeforePlayerNavigation?.())
        .catch(() => undefined);
      // The pre-navigation hook can be async — re-check the attempt so a
      // cancel that landed while awaiting can't navigate.
      if (!isCurrentResolve(attempt)) {
        return;
      }
      // The pick supplies the replayed key plus the identity fallback for a
      // failover winner.
      launchResolvedStream(navigate, resolvedRequest, data, routeExtras, stream);
      closeSelector();
    } catch (error) {
      if (isDev) console.error('[player] stream resolution failed:', error);
      if (isCurrentResolve(attempt)) {
        const message = getErrorMessage(error);
        switch (getErrorKind(error)) {
          case 'no_direct_url':
            toast.error('Stream needs a direct-link source', {
              description: message,
              duration: 6000,
            });
            break;
          case 'rate_limited':
            toast.warning('Stream source is rate-limiting', {
              description:
                'The stream source is rate-limiting requests. Wait 30 s then retry, or try another stream.',
              duration: 7000,
            });
            break;
          default:
            toast.error('Failed to resolve stream', { description: message, duration: 5000 });
        }
      }
    } finally {
      if (isCurrentResolve(attempt)) {
        resetActiveResolveState();
      }
    }
  };

  useEffect(() => {
    resolveStreamRef.current = resolveStream;
  });

  // Derived from session UI state: a cancelled resolve may still be settling,
  // but the user must be able to pick again.
  const isAnyResolving = sessionResolve !== null;

  const handleSelectStream = useCallback(
    (stream: AddonStream, episodeOverride?: SelectorEpisodeOverride) => {
      if (resolveInFlightRef.current) {
        return;
      }

      // P2P rows are shown for parity, but there's no peer-to-peer engine —
      // explain instead of paying a doomed resolve.
      if (!stream.presentation.isInstantlyPlayable) {
        toast.info('P2P source — not playable in this build', {
          description:
            'Peer-to-peer streams need a direct link or cached source. Pick a Cached or HTTP row instead.',
          duration: 5000,
        });
        return;
      }

      // Claim the attempt synchronously — a same-tick second click can't slip
      // past the in-flight guard.
      const feedback = buildResolveFeedback(stream);
      const attempt: SelectorResolveAttempt = {
        feedback,
        stream,
        attemptId: ++resolveAttemptIdRef.current,
        sessionKey: selectorSessionKey,
        episodeOverride,
      };
      resolveInFlightRef.current = true;
      setActiveResolve({ feedback, key: stream.streamKey, sessionKey: selectorSessionKey });
      void resolveStreamRef.current?.(attempt);
    },
    [selectorSessionKey],
  );

  return {
    activeResolveFeedback: sessionResolve?.feedback ?? null,
    activeResolveKey: sessionResolve?.key ?? null,
    cancelResolve,
    handleRequestClose: closeSelector,
    handleSelectStream,
    isAnyResolving,
  };
}
