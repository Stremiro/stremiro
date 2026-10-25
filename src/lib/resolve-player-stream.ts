import type { RefObject } from 'react';
import { api, type BestResolvedStream, type PlaybackStreamOutcome } from '@/lib/api';
import type { PlayerRouteMediaType } from '@/lib/player-navigation';
import { nonBlank } from '@/lib/utils';

/** Resolve/recover/prime coordinates: commands route on source, ranking overrides are canonical, `streamLookupId` defaults to `mediaId`. */
export interface PlayerStreamRequest {
  mediaId: string;
  mediaType: PlayerRouteMediaType;
  /** Addon-side lookup id (often the IMDb id). */
  streamLookupId?: string;
  /** Stream-query (source) coordinates. */
  streamSeason?: number;
  streamEpisode?: number;
  /** Canonical episode coordinates — always win for ranking. */
  absoluteSeason?: number;
  absoluteEpisode?: number;
  title?: string;
}

/** Soft-match identity for the preferred probe (a pick or the last good stream). */
export interface PreferredStreamIdentity {
  streamKey?: string;
  sourceId?: string;
  sourceName?: string;
  streamFamily?: string;
}

/** Identity refs + URL setter a resolved winner writes through — one shared apply for auto-resolve and recovery. */
export interface ResolvedStreamSession {
  activeStreamSourceIdRef: RefObject<string | undefined>;
  activeStreamSourceNameRef: RefObject<string | undefined>;
  activeStreamFamilyRef: RefObject<string | undefined>;
  selectedStreamKeyRef: RefObject<string | undefined>;
  setActiveStreamUrl: (
    value: string | undefined,
    mpvHttpHeaderFields?: string,
    streamKey?: string,
    sourceName?: string,
  ) => void;
}

export function applyResolvedStreamToSession(
  session: ResolvedStreamSession,
  resolved: BestResolvedStream,
): void {
  session.activeStreamSourceIdRef.current = nonBlank(resolved.sourceId);
  session.activeStreamSourceNameRef.current = nonBlank(resolved.sourceName);
  session.activeStreamFamilyRef.current = nonBlank(resolved.streamFamily);
  // Keep the exclusion identity on the actual winner after failover.
  session.selectedStreamKeyRef.current = nonBlank(resolved.streamKey);
  session.setActiveStreamUrl(
    resolved.url,
    resolved.mpvHttpHeaderFields,
    resolved.streamKey,
    resolved.sourceName,
  );
}

interface FailedStreamIdentity extends PreferredStreamIdentity {
  streamUrl?: string;
}

export function playerStreamRankingOptions(request: PlayerStreamRequest) {
  const rankingMediaId = nonBlank(request.mediaId);
  if (!rankingMediaId) return undefined;
  return {
    rankingMediaId,
    rankingMediaType: nonBlank(request.mediaType),
    rankingSeason: request.absoluteSeason,
    rankingEpisode: request.absoluteEpisode,
    rankingTitle: nonBlank(request.title),
  };
}

/** `signal` cancels the backend resolve once every caller sharing it has aborted. */
export function resolvePlayerStream(
  request: PlayerStreamRequest & {
    preferred?: PreferredStreamIdentity;
    signal?: AbortSignal;
  },
): Promise<BestResolvedStream> {
  const { preferred, signal, ...coords } = request;

  return api.resolveBestStream(
    coords.mediaType,
    coords.streamLookupId || coords.mediaId,
    coords.streamSeason,
    coords.streamEpisode,
    coords.absoluteEpisode,
    {
      preferredStreamKey: preferred?.streamKey,
      preferredSourceId: preferred?.sourceId,
      preferredSourceName: preferred?.sourceName,
      preferredStreamFamily: preferred?.streamFamily,
      ...playerStreamRankingOptions(coords),
    },
    signal,
  );
}

export function recoverPlayerStream(
  request: PlayerStreamRequest & {
    requestId: string;
    outcome: Exclude<PlaybackStreamOutcome, 'verified'>;
    failed?: FailedStreamIdentity;
    excludedStreamKeys?: string[];
  },
): Promise<BestResolvedStream | null> {
  const { requestId, outcome, failed, excludedStreamKeys, ...coords } = request;

  return api.recoverPlaybackStream({
    requestId,
    mediaType: coords.mediaType,
    mediaId: coords.mediaId,
    streamLookupId: coords.streamLookupId || coords.mediaId,
    streamSeason: coords.streamSeason,
    streamEpisode: coords.streamEpisode,
    absoluteSeason: coords.absoluteSeason,
    // Always send an episode coordinate — source episode is the fallback when the canonical one never resolved.
    absoluteEpisode: coords.absoluteEpisode ?? coords.streamEpisode,
    failedStreamUrl: failed?.streamUrl,
    failedSourceId: failed?.sourceId,
    failedStreamFamily: failed?.streamFamily,
    failedStreamKey: failed?.streamKey,
    excludedStreamKeys,
    outcome,
    ...playerStreamRankingOptions(coords),
  });
}

/** Seeds under the exact key the player replays — `requestedStreamKey`: pick's key for selector resolves, winner key otherwise. */
export function primePlayerStream(
  resolved: BestResolvedStream,
  request: PlayerStreamRequest,
  requestedStreamKey?: string,
): void {
  const replayKey = nonBlank(requestedStreamKey) ?? nonBlank(resolved.streamKey);
  if (!replayKey) return;

  api.primeBestStream(
    request.mediaType,
    request.streamLookupId || request.mediaId,
    request.streamSeason,
    request.streamEpisode,
    request.absoluteEpisode,
    {
      ...playerStreamRankingOptions(request),
      preferredStreamKey: replayKey,
    },
    resolved,
  );
}
