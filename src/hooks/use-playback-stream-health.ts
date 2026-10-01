import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import type { PlayerStreamSession } from '@/hooks/use-player-stream-session';
import { api, type PlaybackStreamOutcome } from '@/lib/api';
import { invalidateStreamQueries } from '@/lib/query-invalidation';
import { nonBlank } from '@/lib/utils';

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
  const { activeStreamUrl, activeStreamSourceIdRef, activeStreamFamilyRef } = stream;
  const queryClient = useQueryClient();
  const lastVerifiedUrlRef = useRef<string | null>(null);
  const reportedFailureKeysRef = useRef<Set<string>>(new Set());
  // A failure can dispatch after failover to the next stream — reading the
  // identity refs live would pin the failed URL onto the new source. Bind
  // each active URL to its identity when the session adopts it.
  const identityByUrlRef = useRef(new Map<string, { sourceId?: string; streamFamily?: string }>());

  useEffect(() => {
    lastVerifiedUrlRef.current = null;
    reportedFailureKeysRef.current.clear();
    identityByUrlRef.current.clear();
  }, [mediaId, mediaType, absoluteSeason, absoluteEpisode]);

  useEffect(() => {
    lastVerifiedUrlRef.current = null;
    reportedFailureKeysRef.current.clear();

    const url = activeStreamUrl?.trim();
    if (url) {
      identityByUrlRef.current.set(url, {
        sourceId: activeStreamSourceIdRef.current ?? undefined,
        streamFamily: activeStreamFamilyRef.current ?? undefined,
      });
    }
  }, [activeStreamUrl, activeStreamSourceIdRef, activeStreamFamilyRef]);

  const reportOutcome = useCallback(
    async (outcome: PlaybackStreamOutcome, streamUrl?: string) => {
      const normalizedMediaId = nonBlank(mediaId);
      const normalizedMediaType = nonBlank(mediaType);
      const normalizedStreamUrl = nonBlank(streamUrl) || nonBlank(activeStreamUrl);

      if (!normalizedMediaId || !normalizedMediaType || normalizedMediaId === 'local') {
        return;
      }
      if (!normalizedStreamUrl) {
        return;
      }

      const identity = identityByUrlRef.current.get(normalizedStreamUrl);
      await api.reportPlaybackStreamOutcome({
        id: normalizedMediaId,
        type: normalizedMediaType,
        season: absoluteSeason,
        episode: absoluteEpisode,
        // Instance id is the health key of record.
        sourceId: identity?.sourceId ?? activeStreamSourceIdRef.current,
        streamFamily: identity?.streamFamily ?? activeStreamFamilyRef.current,
        outcome,
      });
      // A failure just re-ranked the backend's stream ordering; the selector
      // data in React Query must not keep serving the failed ranking.
      if (outcome !== 'verified') {
        void invalidateStreamQueries(queryClient);
      }
    },
    [
      activeStreamFamilyRef,
      activeStreamSourceIdRef,
      absoluteEpisode,
      absoluteSeason,
      activeStreamUrl,
      mediaId,
      mediaType,
      queryClient,
    ],
  );

  const reportVerified = useCallback(() => {
    const normalizedStreamUrl = activeStreamUrl?.trim();
    if (!normalizedStreamUrl || lastVerifiedUrlRef.current === normalizedStreamUrl) {
      return;
    }

    lastVerifiedUrlRef.current = normalizedStreamUrl;
    reportedFailureKeysRef.current.clear();
    void reportOutcome('verified', normalizedStreamUrl).catch(() => {
      // Best-effort telemetry only.
    });
  }, [activeStreamUrl, reportOutcome]);

  const reportFailure = useCallback(
    (outcome: Exclude<PlaybackStreamOutcome, 'verified'>, streamUrl?: string) => {
      const normalizedStreamUrl = nonBlank(streamUrl) || nonBlank(activeStreamUrl);
      if (!normalizedStreamUrl) {
        return;
      }

      const failureKey = `${normalizedStreamUrl}|${outcome}`;
      if (reportedFailureKeysRef.current.has(failureKey)) {
        return;
      }

      reportedFailureKeysRef.current.add(failureKey);
      void reportOutcome(outcome, normalizedStreamUrl).catch(() => {
        // Best-effort telemetry only.
      });
    },
    [activeStreamUrl, reportOutcome],
  );

  return {
    reportFailure,
    reportVerified,
  };
}
