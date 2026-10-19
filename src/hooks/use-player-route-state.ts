import {
  type PlayerRouteMediaType,
  type PlayerRouteState,
  normalizeRouteNumber,
  resolvePlayerRouteMediaType,
  sanitizePlayerRouteState,
} from '@/lib/player-navigation';
import { usePlayerSession } from '@/lib/player-session';

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  // Season/episode 0 are valid coordinates (specials).
  return normalizeRouteNumber(parsed);
}

export function usePlayerRouteState() {
  const { session } = usePlayerSession();
  const type = session?.type;
  const id = session?.id;
  const season = session?.season;
  const episode = session?.episode;
  const launchState = session?.state;

  const state = sanitizePlayerRouteState(launchState as PlayerRouteState | null);
  const routeSeason = parseNonNegativeInt(season);
  const routeEpisode = parseNonNegativeInt(episode);
  // Sanitized state fields need no second parse.
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
    routeSourceId: state.streamSourceId,
    routeSourceName: state.streamSourceName,
    routeStreamFamily: state.streamFamily,
    routeSelectedStreamKey: state.selectedStreamKey,
    routeRequestedStreamKey: state.requestedStreamKey,
    openingStreamName: state.openingStreamName,
    openingStreamSource: state.openingStreamSource,
    title: state.title || 'Unknown Title',
    // Raw route title — the 'Unknown Title' display fallback must not enter ranking or the best-stream key.
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
}
