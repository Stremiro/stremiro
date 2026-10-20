import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { getErrorKind, getErrorMessage, type AddonStream } from '@/lib/api';
import type { NextEpisodeStreamCoordinates } from '@/lib/episode-stream-target';
import {
  claimPlaybackLaunch,
  isCurrentPlaybackLaunch,
  launchResolvedStream,
} from '@/lib/player-navigation';
import { resolvePlayerStream } from '@/lib/resolve-player-stream';
import type { StreamSelectorTarget } from '@/lib/stream-selector-target';
import { RESOLUTION_LABELS } from '@/lib/stream-selector-utils';
import { formatSeasonEpisode } from '@/lib/utils';

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
  abort: AbortController;
  feedback: ActiveResolveFeedback;
  stream: AddonStream;
  launchGeneration: number;
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
  const [activeResolve, setActiveResolve] = useState<SelectorResolveAttempt | null>(null);
  // The attempt identity also guards same-tick picks and cancelled continuations.
  const activeResolveRef = useRef<SelectorResolveAttempt | null>(null);
  const openRef = useRef(open);
  // Read at resolve time so the selector never subscribes to the playback clock.
  const getStartTimeRef = useRef(getStartTime);
  // Latest-render binding for the resolve body — `handleSelectStream` is an
  // event handler, so a per-render ref gives latest-closure semantics.
  const resolveStreamRef = useRef<((attempt: SelectorResolveAttempt) => Promise<void>) | undefined>(
    undefined,
  );
  const isCurrentResolve = useCallback(
    (attempt: SelectorResolveAttempt) => openRef.current && activeResolveRef.current === attempt,
    [],
  );

  // Only expose the in-flight resolve for its own session.
  const sessionResolve = activeResolve?.sessionKey === selectorSessionKey ? activeResolve : null;

  const cancelResolve = useCallback(() => {
    activeResolveRef.current?.abort.abort();
    activeResolveRef.current = null;
    setActiveResolve(null);
  }, []);

  const closeSelector = () => {
    openRef.current = false;
    cancelResolve();
    onClose();
  };

  // Invalidate at commit, before a settled IPC can resume against the previous target.
  useLayoutEffect(() => {
    openRef.current = open;
    cancelResolve();
    return () => {
      openRef.current = false;
      activeResolveRef.current?.abort.abort();
      activeResolveRef.current = null;
    };
  }, [cancelResolve, open, selectorSessionKey]);

  const resolveStream = async (attempt: SelectorResolveAttempt) => {
    const { stream } = attempt;
    const isCurrentLaunch = () =>
      isCurrentResolve(attempt) && isCurrentPlaybackLaunch(attempt.launchGeneration);
    // A pack-episode pick overrides every coordinate with the episode's own.
    const override = attempt.episodeOverride;
    const coords = override ?? {
      streamLookupId: lookupId,
      streamSeason: season,
      streamEpisode: episode,
      absoluteSeason,
      absoluteEpisode,
    };
    const runResolve = async () => {
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
        signal: attempt.abort.signal,
      });
      // A cancelled or superseded attempt must never navigate.
      if (!isCurrentLaunch()) {
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
      if (!isCurrentLaunch()) {
        return;
      }
      // The pick supplies the replayed key plus identity fallback for a failover winner.
      launchResolvedStream(navigate, resolvedRequest, data, routeExtras, stream);
      closeSelector();
    };
    await runResolve()
      .catch((error: unknown) => {
        if (isCurrentLaunch()) {
          if (isDev) console.error('[player] stream resolution failed:', error);
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
      })
      .finally(() => {
        if (isCurrentResolve(attempt)) {
          cancelResolve();
        }
      });
  };

  useLayoutEffect(() => {
    getStartTimeRef.current = getStartTime;
    resolveStreamRef.current = resolveStream;
  });

  // A cancelled resolve may still be settling, but the user must be able to pick again.
  const isAnyResolving = sessionResolve !== null;

  const handleSelectStream = (stream: AddonStream, episodeOverride?: SelectorEpisodeOverride) => {
    if (!openRef.current || activeResolveRef.current) {
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
    if (episodeOverride) {
      feedback.subtitle = [
        formatSeasonEpisode(episodeOverride.absoluteSeason, episodeOverride.absoluteEpisode),
        feedback.subtitle,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    const attempt: SelectorResolveAttempt = {
      abort: new AbortController(),
      feedback,
      stream,
      launchGeneration: claimPlaybackLaunch(),
      sessionKey: selectorSessionKey,
      episodeOverride,
    };
    activeResolveRef.current = attempt;
    setActiveResolve(attempt);
    void resolveStreamRef.current?.(attempt);
  };

  return {
    activeResolveEpisode: sessionResolve?.episodeOverride,
    activeResolveFeedback: sessionResolve?.feedback ?? null,
    activeResolveKey: sessionResolve?.stream.streamKey ?? null,
    cancelResolve,
    handleRequestClose: closeSelector,
    handleSelectStream,
    isAnyResolving,
  };
}
