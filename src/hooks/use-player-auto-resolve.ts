import { type RefObject, useEffect, useRef, useState } from 'react';

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
  setIsResolving: (value: boolean) => void;
  setResolveStatus: (value: string) => void;
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
  setIsResolving,
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
  // Ref, not state: `isResolving` in the dep array made each attempt cancel
  // itself — setting it true re-ran the effect, cleanup flipped `cancelled`,
  // and the settled IPC result was discarded forever (infinite resolve loop).
  const resolveInFlightRef = useRef(false);

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
      setIsResolving(true);
      setError(null);
      setResolveStatus('Selecting the best stream');
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
            title,
            preferred: {
              // Replay the clicked key verbatim; for generic resolves the
              // source/family soft-match hints identify the user's prior
              // stream when its `uh:` key rotted between sessions. Hints fork
              // the cache key, so they're omitted when a replay key exists.
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
          // Backend worst case is ~14s fetch + 10s parallel probe. Keep the
          // frontend above that so slow addons resolve instead of
          // false-timing-out and orphaning backend work.
          25_000,
          () => {
            throw new Error('Stream resolution timed out. The addon may be unreachable.');
          },
        );
        if (isCurrent()) {
          applyResolvedStreamToSession(stream, result);
          setIsResolving(false);
          setResolveStatus('');
          return;
        }
      } catch (err: unknown) {
        if (isCurrent()) {
          if (import.meta.env.DEV) console.warn('[player] auto-resolve failed');
          setError(err instanceof Error ? err.message : 'Failed to resolve stream automatically.');
          setIsResolving(false);
          stopLoading();
          return;
        }
      } finally {
        // Every terminal path releases the latch and bumps the nonce so the
        // guards re-run once — a dep-change cleanup mid-attempt cannot strand
        // the next attempt behind a stale in-flight flag.
        resolveInFlightRef.current = false;
        if (mountedRef.current) setResolveAttemptNonce((nonce) => nonce + 1);
      }
      // Cancelled or superseded: late winners and timeouts must never clobber
      // a newer pick, but the newest attempt still releases `isResolving`.
      if (mountedRef.current && attemptGen === autoResolveGenRef.current) {
        setIsResolving(false);
        setResolveStatus('');
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
    title,
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
    setIsResolving,
    setResolveStatus,
  ]);
}
