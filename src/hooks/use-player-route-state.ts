import { useMemo } from 'react';
import {
  type PlayerRouteMediaType,
  type PlayerRouteState,
  resolvePlayerRouteMediaType,
  sanitizePlayerRouteState,
} from '@/lib/player-navigation';
import { usePlayerSession } from '@/lib/player-session';

function parseNonNegativeInt(value: string | number | undefined): number | undefined {
  if (typeof value === 'string') {
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    // Season/episode 0 are valid coordinates (specials).
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

export function usePlayerRouteState() {
  const { session } = usePlayerSession();
  const type = session?.type;
  const id = session?.id;
  const season = session?.season;
  const episode = session?.episode;
  const launchState = session?.state;

  return useMemo(() => {
    const state = sanitizePlayerRouteState(launchState as PlayerRouteState | null);
    const routeSeason = parseNonNegativeInt(season);
    const routeEpisode = parseNonNegativeInt(episode);
    // Sanitized state fields are already number|undefined — no second parse.
    const routeAbsoluteSeason = state.absoluteSeason ?? routeSeason;
    const routeAbsoluteEpisode = state.absoluteEpisode ?? routeEpisode;
    const routeStreamSeason = state.streamSeason;
    const routeStreamEpisode = state.streamEpisode;
    const effectiveResolveMediaType: PlayerRouteMediaType = resolvePlayerRouteMediaType(type);

    return {
      id,
      type,
      seasonParam: season,
      episodeParam: episode,
      routeSeason,
      routeEpisode,
      routeAbsoluteSeason,
      routeAbsoluteEpisode,
      routeStreamSeason,
      routeStreamEpisode,
      routeStreamLookupId: state.streamLookupId,
      routeFormat: state.format,
      routeSourceId: state.streamSourceId,
      routeSourceName: state.streamSourceName,
      routeStreamFamily: state.streamFamily,
      routeSelectedStreamKey: state.selectedStreamKey,
      routeRequestedStreamKey: state.requestedStreamKey,
      openingStreamName: state.openingStreamName,
      openingStreamSource: state.openingStreamSource,
      title: state.title || 'Unknown Title',
      // Raw route title for resolve inputs — the 'Unknown Title' display
      // fallback must not enter ranking options or the best-stream key.
      resolveTitle: state.title,
      poster: state.poster,
      backdrop: state.backdrop,
      logo: state.logo,
      from: state.from,
      originFrom: state.originFrom,
      startTime: state.startTime,
      isHistoryResume: state.resumeFromHistory === true,
      effectiveResolveMediaType,
    };
  }, [launchState, type, id, season, episode]);
}
