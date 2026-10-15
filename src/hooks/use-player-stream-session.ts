import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ResolvedStreamSession } from '@/lib/resolve-player-stream';
import { nonBlank } from '@/lib/utils';

/** Stream-identity bundle one playback session owns — passed downstream as a single arg so new identity state can't drift across signatures. */
export interface PlayerStreamSession extends ResolvedStreamSession {
  activeStreamUrl?: string;
  activeStreamMpvHttpHeaderFields?: string;
  activeStreamKey?: string;
  /** Resolved winner's source name (route pick pre-resolve) — reactive counterpart of `activeStreamSourceNameRef`. */
  activeStreamSourceName?: string;
  streamLookupIdRef: RefObject<string | undefined>;
  committedStreamUrlRef: RefObject<string | undefined>;
}

interface UsePlayerStreamSessionArgs {
  routeSourceId?: string;
  routeSourceName?: string;
  routeStreamFamily?: string;
  routeSelectedStreamKey?: string;
  streamLookupId?: string;
  mediaId?: string;
  season?: number;
  episode?: number;
}

// Signed URL + headers stay in a ref, never React state — keeps them off inspection/serialization surfaces.
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
  routeSourceId,
  routeSourceName,
  routeStreamFamily,
  routeSelectedStreamKey,
  streamLookupId,
  mediaId,
  season,
  episode,
}: UsePlayerStreamSessionArgs): PlayerStreamSession {
  // Routes carry identities only (URLs stripped); seed includes episode coordinates so advancing drops prior secrets.
  const routeSeed = JSON.stringify([
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
  // Winner key from the last resolve/recovery; falls back to the route pick on a fresh session.
  const activeStreamKey = activeOverride?.streamKey ?? routeSelectedStreamKey?.trim();
  // Same lifecycle as `activeStreamSourceNameRef` — the seeding effect re-arms the route name with no active URL.
  const activeStreamSourceName =
    activeStreamUrl === undefined ? nonBlank(routeSourceName) : activeOverride?.sourceName;
  const committedStreamUrlRef = useRef(activeStreamUrl);
  const activeStreamSourceIdRef = useRef<string | undefined>(routeSourceId);
  const activeStreamSourceNameRef = useRef<string | undefined>(routeSourceName);
  const activeStreamFamilyRef = useRef<string | undefined>(routeStreamFamily);
  // Seeded from route only — the player.tsx effect is the sole writer once details land.
  const streamLookupIdRef = useRef<string | undefined>(streamLookupId || mediaId || undefined);
  const selectedStreamKeyRef = useRef<string | undefined>(routeSelectedStreamKey);

  useEffect(() => {
    routeSeedRef.current = routeSeed;
    // A new seed is a new session — drop held secrets so a stale signed URL can't replay under new coordinates.
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
      // Fresh object each call — a same-seed re-resolve with a new URL must still re-render.
      setSessionStreamOverride({
        streamKey: nextStreamKey,
        sourceName: nonBlank(nextSourceName),
        routeSeed: seed,
      });
    },
    [],
  );

  useEffect(() => {
    committedStreamUrlRef.current = activeStreamUrl;
  }, [activeStreamUrl]);

  useEffect(() => {
    // Route identity seeds the refs only until a stream activates; after resolve, `applyResolvedStreamToSession` owns them.
    if (activeStreamUrl !== undefined) return;
    activeStreamSourceIdRef.current = nonBlank(routeSourceId);
    activeStreamSourceNameRef.current = nonBlank(routeSourceName);
    activeStreamFamilyRef.current = nonBlank(routeStreamFamily);
  }, [activeStreamUrl, routeSourceId, routeSourceName, routeStreamFamily]);

  useEffect(() => {
    if (!routeSelectedStreamKey) {
      selectedStreamKeyRef.current = undefined;
      return;
    }

    // Selector choice survives resolving for failure reports.
    selectedStreamKeyRef.current = nonBlank(routeSelectedStreamKey) || selectedStreamKeyRef.current;
  }, [routeSelectedStreamKey]);

  // Memoized so `stream` stays dep-safe — identity changes only with a state-derived field.
  return useMemo(
    () => ({
      activeStreamUrl,
      activeStreamMpvHttpHeaderFields,
      activeStreamKey,
      activeStreamSourceName,
      setActiveStreamUrl,
      activeStreamSourceIdRef,
      activeStreamSourceNameRef,
      activeStreamFamilyRef,
      streamLookupIdRef,
      selectedStreamKeyRef,
      committedStreamUrlRef,
    }),
    [
      activeStreamUrl,
      activeStreamMpvHttpHeaderFields,
      activeStreamKey,
      activeStreamSourceName,
      setActiveStreamUrl,
      activeStreamSourceIdRef,
      activeStreamSourceNameRef,
      activeStreamFamilyRef,
      streamLookupIdRef,
      selectedStreamKeyRef,
      committedStreamUrlRef,
    ],
  );
}
