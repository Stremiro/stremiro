import { type RefObject, useEffect, useEffectEvent, useRef } from 'react';

import type { PlayerStreamSession } from '@/hooks/use-player-stream-session';
import type { PlayerRouteMediaType } from '@/lib/player-navigation';
import { applyResolvedStreamToSession, resolvePlayerStream } from '@/lib/resolve-player-stream';
import { withTimeout } from '@/lib/utils';

interface UsePlayerAutoResolveOptions {
  autoResolveGenRef: RefObject<number>;
  effectiveResolveMediaType: PlayerRouteMediaType;
  error: string | null;
  id?: string;
  isResolving: boolean;
  mountedRef: RefObject<boolean>;
  resolvedAbsoluteEpisode?: number;
  resolvedAbsoluteSeason?: number;
  resolvedStreamEpisode?: number;
  resolvedStreamSeason?: number;
  routeSelectedStreamKey?: string;
  routeRequestedStreamKey?: string;
  stream: PlayerStreamSession;
  setError: (value: string | null) => void;
  setResolveStatus: (value: string | null) => void;
  shouldWaitForResolvedLookupId: boolean;
  showStreamSelector: boolean;
  stopLoading: (makeTransparent?: boolean) => void;
  streamLookupId?: string;
  title?: string;
  type?: string;
}

export function usePlayerAutoResolve({
  stream,
  autoResolveGenRef,
  effectiveResolveMediaType,
  error,
  id,
  isResolving,
  mountedRef,
  resolvedAbsoluteEpisode,
  resolvedAbsoluteSeason,
  resolvedStreamEpisode,
  resolvedStreamSeason,
  routeRequestedStreamKey,
  routeSelectedStreamKey,
  setError,
  setResolveStatus,
  shouldWaitForResolvedLookupId,
  showStreamSelector,
  stopLoading,
  streamLookupId,
  title,
  type,
}: UsePlayerAutoResolveOptions) {
  const lastAutoResolveLookupIdRef = useRef<string | null>(null);
  const getTitle = useEffectEvent(() => title);

  useEffect(() => {
    if (!error) return;
    if (stream.activeStreamUrl || isResolving || !type || !id || !mountedRef.current) return;

    const nextLookupId = streamLookupId || id;
    const lastAttemptedLookupId = lastAutoResolveLookupIdRef.current;
    if (!lastAttemptedLookupId || nextLookupId === lastAttemptedLookupId) return;

    setError(null);
  }, [error, stream, isResolving, type, id, streamLookupId, mountedRef, setError]);

  useEffect(() => {
    // While the manual selector is open the user owns stream choice.
    if (stream.activeStreamUrl || error || !type || !id || !mountedRef.current) return;
    if (shouldWaitForResolvedLookupId || showStreamSelector) return;

    const abort = new AbortController();
    const attemptGen = ++autoResolveGenRef.current;

    const isCurrent = () =>
      !abort.signal.aborted && attemptGen === autoResolveGenRef.current && mountedRef.current;

    const resolve = async () => {
      setResolveStatus('');
      setError(null);
      const lookupId = streamLookupId || id;
      lastAutoResolveLookupIdRef.current = lookupId;
      const preferred = {
        streamKey: routeRequestedStreamKey ?? routeSelectedStreamKey,
        sourceId: routeRequestedStreamKey ? undefined : stream.activeStreamSourceIdRef.current,
        sourceName: routeRequestedStreamKey ? undefined : stream.activeStreamSourceNameRef.current,
        streamFamily: routeRequestedStreamKey ? undefined : stream.activeStreamFamilyRef.current,
      };

      try {
        const result = await withTimeout(
          resolvePlayerStream({
            mediaType: effectiveResolveMediaType,
            mediaId: id,
            streamLookupId: lookupId,
            streamSeason: resolvedStreamSeason,
            streamEpisode: resolvedStreamEpisode,
            absoluteSeason: resolvedAbsoluteSeason,
            absoluteEpisode: resolvedAbsoluteEpisode,
            title: getTitle(),
            preferred,
            signal: abort.signal,
          }),
          // Allow store reads, ranking and IPC beyond the 14s fetch + 10s probe.
          35_000,
          () => {
            throw new Error('Stream resolution timed out. The addon may be unreachable.');
          },
        );
        if (isCurrent()) {
          applyResolvedStreamToSession(stream, result);
          setResolveStatus(null);
        }
      } catch (err: unknown) {
        if (isCurrent()) {
          if (import.meta.env.DEV) console.warn('[player] auto-resolve failed');
          setError(err instanceof Error ? err.message : 'Failed to resolve stream automatically.');
          setResolveStatus(null);
          stopLoading();
        }
      }
    };

    void resolve();

    return () => {
      abort.abort();
    };
  }, [
    stream,
    type,
    effectiveResolveMediaType,
    id,
    resolvedStreamSeason,
    resolvedStreamEpisode,
    resolvedAbsoluteSeason,
    resolvedAbsoluteEpisode,
    error,
    shouldWaitForResolvedLookupId,
    showStreamSelector,
    streamLookupId,
    routeRequestedStreamKey,
    routeSelectedStreamKey,
    stopLoading,
    autoResolveGenRef,
    mountedRef,
    setError,
    setResolveStatus,
  ]);
}
