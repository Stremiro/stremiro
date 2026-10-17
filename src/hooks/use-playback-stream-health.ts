import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import type { PlayerStreamSession } from '@/hooks/use-player-stream-session';
import { api, type PlaybackStreamOutcome } from '@/lib/api';
import { invalidateStreamQueries } from '@/lib/query-invalidation';
import { isLocalMediaId, nonBlank } from '@/lib/utils';

interface UsePlaybackStreamHealthArgs {
  mediaId?: string;
  mediaType?: string;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  stream: PlayerStreamSession;
}

export function usePlaybackStreamHealth({
  mediaId,
  mediaType,
  absoluteSeason,
  absoluteEpisode,
  stream,
}: UsePlaybackStreamHealthArgs) {
  const { activeStreamUrl, activeStreamKey, activeStreamSourceIdRef, activeStreamFamilyRef } =
    stream;
  const queryClient = useQueryClient();
  const lastVerifiedRequestRef = useRef<string | null>(null);
  const reportedFailureKeysRef = useRef<Set<string>>(new Set());
  // A failure can dispatch after failover to the next stream — reading the
  // identity refs live would pin the failed request onto the new source. Bind
  // each active URL + stream key to its identity when the session adopts it.
  const identityByRequestRef = useRef(
    new Map<string, { sourceId?: string; streamFamily?: string }>(),
  );

  useEffect(() => {
    lastVerifiedRequestRef.current = null;
    reportedFailureKeysRef.current.clear();
    identityByRequestRef.current.clear();
  }, [mediaId, mediaType, absoluteSeason, absoluteEpisode]);

  useEffect(() => {
    lastVerifiedRequestRef.current = null;
    reportedFailureKeysRef.current.clear();

    const url = activeStreamUrl?.trim();
    if (url) {
      identityByRequestRef.current.set(`${url}\n${activeStreamKey ?? ''}`, {
        sourceId: activeStreamSourceIdRef.current ?? undefined,
        streamFamily: activeStreamFamilyRef.current ?? undefined,
      });
    }
  }, [activeStreamUrl, activeStreamKey, activeStreamSourceIdRef, activeStreamFamilyRef]);

  const reportOutcome = useCallback(
    async (outcome: PlaybackStreamOutcome, streamUrl: string, streamKey?: string) => {
      const normalizedMediaId = nonBlank(mediaId);
      const normalizedMediaType = nonBlank(mediaType);
      const normalizedStreamUrl = nonBlank(streamUrl);

      if (!normalizedMediaId || !normalizedMediaType || isLocalMediaId(normalizedMediaId)) {
        return;
      }
      if (!normalizedStreamUrl) {
        return;
      }

      const requestKey = `${normalizedStreamUrl}\n${streamKey ?? ''}`;
      const identity = identityByRequestRef.current.get(requestKey);
      if (!identity) return;

      await api.reportPlaybackStreamOutcome({
        id: normalizedMediaId,
        type: normalizedMediaType,
        season: absoluteSeason,
        episode: absoluteEpisode,
        // Instance id is the health key of record.
        sourceId: identity.sourceId,
        streamFamily: identity.streamFamily,
        outcome,
      });
      // A failure just re-ranked the backend's stream ordering; the selector
      // data in React Query must not keep serving the failed ranking.
      if (outcome !== 'verified') {
        void invalidateStreamQueries(queryClient);
      }
    },
    [absoluteEpisode, absoluteSeason, mediaId, mediaType, queryClient],
  );

  const reportVerified = useCallback(() => {
    const normalizedStreamUrl = activeStreamUrl?.trim();
    if (!normalizedStreamUrl) return;

    const requestKey = `${normalizedStreamUrl}\n${activeStreamKey ?? ''}`;
    if (lastVerifiedRequestRef.current === requestKey) {
      return;
    }

    lastVerifiedRequestRef.current = requestKey;
    reportedFailureKeysRef.current.clear();
    void reportOutcome('verified', normalizedStreamUrl, activeStreamKey).catch(() => {
      // Best-effort telemetry only.
    });
  }, [activeStreamUrl, activeStreamKey, reportOutcome]);

  const reportFailure = useCallback(
    (
      outcome: Exclude<PlaybackStreamOutcome, 'verified'>,
      streamUrl?: string,
      streamKey?: string,
    ) => {
      const normalizedStreamUrl = nonBlank(streamUrl) || nonBlank(activeStreamUrl);
      if (!normalizedStreamUrl) {
        return;
      }

      const failedStreamKey = streamUrl === undefined ? activeStreamKey : streamKey;
      const requestKey = `${normalizedStreamUrl}\n${failedStreamKey ?? ''}`;
      const failureKey = `${requestKey}|${outcome}`;
      if (reportedFailureKeysRef.current.has(failureKey)) {
        return;
      }

      reportedFailureKeysRef.current.add(failureKey);
      void reportOutcome(outcome, normalizedStreamUrl, failedStreamKey).catch(() => {
        // Best-effort telemetry only.
      });
    },
    [activeStreamUrl, activeStreamKey, reportOutcome],
  );

  return {
    reportFailure,
    reportVerified,
  };
}
