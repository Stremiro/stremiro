import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ResolvedStreamSession } from '@/lib/resolve-player-stream';
import { nonBlank } from '@/lib/utils';

/**
 * The stream-identity bundle one playback session owns: the resolved URL and
 * headers, the winner key, and the identity refs resolve/recovery/persist
 * read or write. Downstream hooks take the session as a single arg so new
 * identity state can't drift across their signatures.
 */
export interface PlayerStreamSession extends ResolvedStreamSession {
  activeStreamUrl?: string;
  activeStreamMpvHttpHeaderFields?: string;
  activeStreamKey?: string;
  /** Resolved winner's source name, or the route-carried pick pre-resolve —
      the reactive counterpart of `activeStreamSourceNameRef` for render. */
  activeStreamSourceName?: string;
  streamLookupIdRef: RefObject<string | undefined>;
  lastStreamUrlRef: RefObject<string | undefined>;
}

interface UsePlayerStreamSessionArgs {
  routeFormat?: string;
  routeSourceId?: string;
  routeSourceName?: string;
  routeStreamFamily?: string;
  routeSelectedStreamKey?: string;
  streamLookupId?: string;
  mediaId?: string;
  season?: number;
  episode?: number;
}

// Signed URL + headers stay in a ref, never React state — that removes them
// from inspection/serialization surfaces entirely.
interface StreamSecrets {
  url?: string;
  mpvHttpHeaderFields?: string;
  routeSeed: string;
}

interface SessionStreamOverride {
  streamKey?: string;
  sourceName?: string;
  routeSeed: string;
}

export function usePlayerStreamSession({
  routeFormat,
  routeSourceId,
  routeSourceName,
  routeStreamFamily,
  routeSelectedStreamKey,
  streamLookupId,
  mediaId,
  season,
  episode,
}: UsePlayerStreamSessionArgs): PlayerStreamSession {
  // Routes carry identities only (URLs stripped); the seed is lookup identity
  // plus episode coordinates so advancing drops the previous episode's secrets.
  const routeSeed = JSON.stringify([
    routeFormat ?? '',
    routeSourceId?.trim() ?? '',
    routeSourceName?.trim() ?? '',
    routeStreamFamily?.trim() ?? '',
    routeSelectedStreamKey?.trim() ?? '',
    streamLookupId ?? '',
    mediaId ?? '',
    season ?? '',
    episode ?? '',
  ]);
  const routeSeedRef = useRef(routeSeed);
  const secretsRef = useRef<StreamSecrets | null>(null);
  const [sessionStreamOverride, setSessionStreamOverride] = useState<SessionStreamOverride | null>(
    null,
  );
  const activeOverride =
    sessionStreamOverride && sessionStreamOverride.routeSeed === routeSeed
      ? sessionStreamOverride
      : null;
  const heldSecrets = secretsRef.current;
  const activeSecrets =
    activeOverride && heldSecrets && heldSecrets.routeSeed === routeSeed ? heldSecrets : null;
  const activeStreamUrl = activeSecrets?.url;
  const activeStreamMpvHttpHeaderFields = activeSecrets?.mpvHttpHeaderFields;
  // Winner key from the last resolve/recovery; falls back to the route-carried
  // selector pick on a fresh session.
  const activeStreamKey = activeOverride?.streamKey ?? routeSelectedStreamKey?.trim();
  // Same lifecycle as `activeStreamSourceNameRef` — the seeding effect re-arms
  // the route name whenever no stream URL is active.
  const activeStreamSourceName =
    activeStreamUrl === undefined ? nonBlank(routeSourceName) : activeOverride?.sourceName;
  const lastStreamUrlRef = useRef(activeStreamUrl);
  const activeStreamFormatRef = useRef<string | undefined>(routeFormat);
  const activeStreamSourceIdRef = useRef<string | undefined>(routeSourceId);
  const activeStreamSourceNameRef = useRef<string | undefined>(routeSourceName);
  const activeStreamFamilyRef = useRef<string | undefined>(routeStreamFamily);
  // First render seeds the route value only — the player.tsx effect is the
  // sole writer after that, persisting the richer lookup id once details land.
  const streamLookupIdRef = useRef<string | undefined>(streamLookupId || mediaId || undefined);
  const selectedStreamKeyRef = useRef<string | undefined>(routeSelectedStreamKey);

  useEffect(() => {
    routeSeedRef.current = routeSeed;
    // A new seed is a new session — drop held secrets so a stale signed URL
    // can't replay under different coordinates.
    secretsRef.current = null;
    setSessionStreamOverride(null);
  }, [routeSeed]);

  const setActiveStreamUrl = useCallback(
    (
      nextUrl?: string,
      nextMpvHttpHeaderFields?: string,
      nextStreamKey?: string,
      nextSourceName?: string,
    ) => {
      const seed = routeSeedRef.current;
      secretsRef.current = {
        url: nextUrl,
        mpvHttpHeaderFields: nextMpvHttpHeaderFields,
        routeSeed: seed,
      };
      // Fresh object every call — recovery can re-resolve under the same seed
      // with a different URL and consumers must still re-render.
      setSessionStreamOverride({
        streamKey: nextStreamKey,
        sourceName: nonBlank(nextSourceName),
        routeSeed: seed,
      });
    },
    [],
  );

  useEffect(() => {
    lastStreamUrlRef.current = activeStreamUrl;
  }, [activeStreamUrl]);

  useEffect(() => {
    // Route identity seeds the refs only until a stream URL is active — after
    // a resolve lands, `applyResolvedStreamToSession` owns them.
    if (activeStreamUrl !== undefined) return;
    activeStreamFormatRef.current = routeFormat;
    activeStreamSourceIdRef.current = nonBlank(routeSourceId);
    activeStreamSourceNameRef.current = nonBlank(routeSourceName);
    activeStreamFamilyRef.current = nonBlank(routeStreamFamily);
  }, [activeStreamUrl, routeFormat, routeSourceId, routeSourceName, routeStreamFamily]);

  useEffect(() => {
    if (!routeSelectedStreamKey) {
      selectedStreamKeyRef.current = undefined;
      return;
    }

    // Selector choice survives resolving for failure reports.
    selectedStreamKeyRef.current = nonBlank(routeSelectedStreamKey) || selectedStreamKeyRef.current;
  }, [routeSelectedStreamKey]);

  // Memoized so `stream` is dep-safe downstream — the bundle only changes
  // identity when a state-derived field does.
  return useMemo(
    () => ({
      activeStreamUrl,
      activeStreamMpvHttpHeaderFields,
      activeStreamKey,
      activeStreamSourceName,
      setActiveStreamUrl,
      activeStreamFormatRef,
      activeStreamSourceIdRef,
      activeStreamSourceNameRef,
      activeStreamFamilyRef,
      streamLookupIdRef,
      selectedStreamKeyRef,
      lastStreamUrlRef,
    }),
    [
      activeStreamUrl,
      activeStreamMpvHttpHeaderFields,
      activeStreamKey,
      activeStreamSourceName,
      setActiveStreamUrl,
      activeStreamFormatRef,
      activeStreamSourceIdRef,
      activeStreamSourceNameRef,
      activeStreamFamilyRef,
      streamLookupIdRef,
      selectedStreamKeyRef,
      lastStreamUrlRef,
    ],
  );
}
