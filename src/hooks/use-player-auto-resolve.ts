import { type RefObject, useEffect, useEffectEvent, useRef, useState } from 'react';

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
  const [resolveAttemptNonce, setResolveAttemptNonce] = useState(0);
  const lastAutoResolveLookupIdRef = useRef<string | null>(null);
  // Ref, not state — `isResolving` as a dep made each attempt cancel itself (infinite resolve loop).
  const resolveInFlightRef = useRef(false);
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
    if (resolveInFlightRef.current) return;

    let cancelled = false;
    const attemptGen = ++autoResolveGenRef.current;
    resolveInFlightRef.current = true;

    const isCurrent = () =>
      !cancelled && attemptGen === autoResolveGenRef.current && mountedRef.current;

    const resolve = async () => {
      setResolveStatus('');
      setError(null);
      const lookupId = streamLookupId || id;
      lastAutoResolveLookupIdRef.current = lookupId;

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
            preferred: {
              // Replay the clicked key verbatim; otherwise source/family hints soft-match
              // the prior stream (`uh:` keys rot). Hints fork the cache key — omitted when a replay key exists.
              streamKey: routeRequestedStreamKey ?? routeSelectedStreamKey,
              sourceId: routeRequestedStreamKey
                ? undefined
                : stream.activeStreamSourceIdRef.current,
              sourceName: routeRequestedStreamKey
                ? undefined
                : stream.activeStreamSourceNameRef.current,
              streamFamily: routeRequestedStreamKey
                ? undefined
                : stream.activeStreamFamilyRef.current,
            },
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
          return;
        }
      } catch (err: unknown) {
        if (isCurrent()) {
          if (import.meta.env.DEV) console.warn('[player] auto-resolve failed');
          setError(err instanceof Error ? err.message : 'Failed to resolve stream automatically.');
          setResolveStatus(null);
          stopLoading();
          return;
        }
      } finally {
        // Release the latch and bump the nonce so the guards re-run once — a mid-attempt cleanup can't strand the next attempt.
        resolveInFlightRef.current = false;
        if (mountedRef.current) setResolveAttemptNonce((nonce) => nonce + 1);
      }
      // Late winners/timeouts must not clobber a newer pick, but the newest attempt still releases `isResolving`.
      if (mountedRef.current && attemptGen === autoResolveGenRef.current) {
        setResolveStatus(null);
      }
    };

    void resolve();

    return () => {
      cancelled = true;
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
    resolveAttemptNonce,
    stopLoading,
    autoResolveGenRef,
    mountedRef,
    setError,
    setResolveStatus,
  ]);
}
