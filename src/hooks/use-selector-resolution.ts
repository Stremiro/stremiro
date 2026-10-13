import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { getErrorKind, getErrorMessage, type AddonStream } from '@/lib/api';
import type { NextEpisodeStreamCoordinates } from '@/lib/episode-stream-target';
import { launchResolvedStream } from '@/lib/player-navigation';
import { resolvePlayerStream } from '@/lib/resolve-player-stream';
import type { StreamSelectorTarget } from '@/lib/stream-selector-target';
import { RESOLUTION_LABELS } from '@/lib/stream-selector-utils';

const isDev = import.meta.env.DEV;

interface ActiveResolveFeedback {
  subtitle: string;
  title: string;
}

/** Episode-in-pack pick: pack row supplies the stream, the pick supplies episode coords + resume point. */
interface SelectorEpisodeOverride extends NextEpisodeStreamCoordinates {
  getStartTime?: () => number | undefined;
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

// Short facts only — the release filename is unreadable once truncated.
function buildResolveFeedback(stream: AddonStream): ActiveResolveFeedback {
  const { presentation } = stream;
  const title = stream.sourceName?.trim() || presentation.sourceName.trim() || 'Selected stream';
  const subtitle = [
    RESOLUTION_LABELS[presentation.resolution],
    presentation.hdrLabel,
    presentation.deliveryLabel,
    presentation.sizeLabel,
  ]
    .filter(Boolean)
    .join(' · ');

  return { subtitle, title };
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
  // Key/session/feedback move as one unit — a single nullable state can't tear mid-update.
  const [activeResolve, setActiveResolve] = useState<{
    feedback: ActiveResolveFeedback;
    key: string;
    sessionKey: string;
  } | null>(null);
  // Synchronous in-flight guard: `isPending` is render-time state — two
  // same-tick selects would both spawn a resolve IPC.
  const resolveInFlightRef = useRef(false);
  // A slow resolve can outlive the close click and the component.
  const openRef = useRef(open);
  const latestSessionKeyRef = useRef(selectorSessionKey);
  // Read at resolve time so the selector never subscribes to the playback clock.
  const getStartTimeRef = useRef(getStartTime);
  // Per-attempt identity: a superseded resolve's late winner can't navigate.
  const resolveAttemptIdRef = useRef(0);
  // Latest-render binding for the resolve body — `handleSelectStream` is an
  // event handler, so a per-render ref gives latest-closure semantics.
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

  // Only expose the in-flight resolve for its own session.
  const sessionResolve = activeResolve?.sessionKey === selectorSessionKey ? activeResolve : null;

  const resetActiveResolveState = useCallback(() => {
    resolveInFlightRef.current = false;
    setActiveResolve(null);
  }, []);

  // Invalidate the attempt so its late winner can't navigate; release the UI lock.
  const cancelResolve = useCallback(() => {
    resolveAttemptIdRef.current += 1;
    resetActiveResolveState();
  }, [resetActiveResolveState]);

  const closeSelector = useCallback(() => {
    cancelResolve();
    onClose();
  }, [cancelResolve, onClose]);

  // Open/session transitions invalidate outstanding attempts.
  useEffect(() => {
    cancelResolve();
  }, [cancelResolve, open, selectorSessionKey]);

  const resolveStream = async (attempt: SelectorResolveAttempt) => {
    const { stream } = attempt;
    // A pack-episode pick overrides every coordinate with the episode's own.
    const override = attempt.episodeOverride;
    const coords = {
      streamLookupId: override?.streamLookupId ?? lookupId,
      streamSeason: override?.streamSeason ?? season,
      streamEpisode: override?.streamEpisode ?? episode,
      absoluteSeason: override?.absoluteSeason ?? absoluteSeason,
      absoluteEpisode: override?.absoluteEpisode ?? absoluteEpisode,
    };
    try {
      // Resolve by identity: `preferredStreamKey` keeps the raw stream payload
      // (proxy secrets included) out of JS; source/family soft-match on re-digest.
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

      // A cancelled or superseded attempt must never navigate.
      if (!isCurrentResolve(attempt)) {
        return;
      }
      const feedback = attempt.feedback;

      // One request object feeds the prime and the route state — the
      // canonical-season fold must match or the replay misses the primed entry.
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
        // Fresh pack episodes must not inherit the target's live position.
        startTime: override ? override.getStartTime?.() : getStartTimeRef.current?.(),
      };

      await Promise.resolve()
        .then(() => onBeforePlayerNavigation?.())
        .catch(() => undefined);
      // The pre-navigation hook can be async — re-check so a cancel that landed
      // while awaiting can't navigate.
      if (!isCurrentResolve(attempt)) {
        return;
      }
      // The pick supplies the replayed key plus identity fallback for a failover winner.
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

  // A cancelled resolve may still be settling, but the user must be able to pick again.
  const isAnyResolving = sessionResolve !== null;

  const handleSelectStream = useCallback(
    (stream: AddonStream, episodeOverride?: SelectorEpisodeOverride) => {
      if (resolveInFlightRef.current) {
        return;
      }

      // No peer-to-peer engine — explain instead of paying a doomed resolve.
      if (!stream.presentation.isInstantlyPlayable) {
        toast.info('P2P source — not playable in this build', {
          description:
            'Peer-to-peer streams need a direct link or cached source. Pick a Cached or HTTP row instead.',
          duration: 5000,
        });
        return;
      }

      // Claim the attempt synchronously so a same-tick second click can't slip past.
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
