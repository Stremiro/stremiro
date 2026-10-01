import {
  BEST_STREAM_CACHE_TTL_MS,
  createRequestCache,
  MEDIA_SCHEDULE_CACHE_TTL_MS,
  SEARCH_CACHE_TTL_MS,
} from '@/lib/api-cache';
import { safeInvoke } from '@/lib/api-core';
import { createDiscoveryApi } from '@/lib/api-discovery';
import { createPlaybackApi } from '@/lib/api-playback';
import { createStoreApi } from '@/lib/api-store';
import type { PlayerRouteState } from '@/lib/player-navigation';
import type { StreamRankingOptions } from '@/lib/stream-ranking';

export { getErrorMessage } from '@/lib/api-core';
export { toMediaItem } from '@/lib/api-store';

export interface MediaItem {
  id: string;
  title: string;
  poster?: string;
  backdrop?: string;
  logo?: string;
  description?: string;
  year?: string;
  displayYear?: string;
  genres?: string[];
  type: 'movie' | 'series';
}

export interface Episode {
  id: string;
  title?: string;
  season: number;
  episode: number;
  released?: string;
  releaseDate?: string;
  overview?: string;
  thumbnail?: string;
  /** Backend-normalized playback lookup ID for this episode. */
  streamLookupId?: string;
  /** Backend-normalized source season for stream resolution. */
  streamSeason?: number;
  /** Backend-normalized source episode for stream resolution. */
  streamEpisode?: number;
}

export interface Trailer {
  id: string;
  source: string;
  url: string;
}

export interface MediaDetails extends MediaItem {
  imdbId?: string;
  rating?: string;
  cast?: string[];
  trailers?: Trailer[];
  /** Backend-ordered by (season, episode); coordinate ties preserve addon
      order. */
  episodes?: Episode[];
}

export interface MediaScheduleEpisode {
  id: string;
  title?: string;
  season: number;
  episode: number;
  releaseDate: string;
}

export interface MediaSchedule {
  id: string;
  title: string;
  poster?: string;
  type: 'movie' | 'series' | 'anime';
  releaseDate?: string;
  episodes: MediaScheduleEpisode[];
}

export interface UserList {
  id: string;
  name: string;
  icon: string;
  item_ids: string[];
  // Absent on the `create_list` response (metadata only); populated by
  // list-with-items reads.
  items?: MediaItem[];
}

export type WatchStatus = 'watching' | 'watched' | 'plan_to_watch' | 'dropped';

export const WATCH_STATUSES: readonly WatchStatus[] = [
  'watching',
  'watched',
  'plan_to_watch',
  'dropped',
];

export const WATCH_STATUS_LABELS: Record<WatchStatus, string> = {
  watching: 'Watching',
  watched: 'Watched',
  plan_to_watch: 'Plan to Watch',
  dropped: 'Dropped',
};

export const WATCH_STATUS_COLORS: Record<
  WatchStatus,
  { text: string; bg: string; border: string }
> = {
  watching: { text: 'text-blue-400', bg: 'bg-blue-500/[0.08]', border: 'border-blue-500/20' },
  watched: { text: 'text-green-400', bg: 'bg-green-500/[0.08]', border: 'border-green-500/20' },
  plan_to_watch: {
    text: 'text-yellow-400',
    bg: 'bg-yellow-500/[0.08]',
    border: 'border-yellow-500/20',
  },
  dropped: { text: 'text-red-400', bg: 'bg-red-500/[0.08]', border: 'border-red-500/20' },
};

export interface AddonStream {
  // Raw addon fields (name, title, infoHash, url, fileIdx, behaviorHints)
  // stay Rust-side: resolution runs by `streamKey`, so proxy-header secrets
  // and opaque addon data never cross into the webview.
  streamKey: string;
  seeders?: number;
  sizeBytes?: number;
  /** Addon/source that returned this stream (set by the backend). */
  sourceName?: string;
  /** Backend addon-config id — matches `StreamSourceSummary.id` so filter chips key on config identity, not display text. */
  sourceId?: string;
  /** Stable backend-derived release family used for adjacent-episode ranking. */
  streamFamily?: string;
  /** Backend coordinator explanation for why this stream ranks where it does. */
  recommendationReasons?: string[];
  /** Structured episode/title match tiers for the selector badges. */
  matchSummary?: AddonStreamMatchSummary;
  /** Dev-only sort-key dump for the ranking inspector — only present in debug builds. */
  rankDebug?: string;
  /** Backend-prepared presentation facts so the UI can render without reparsing stream text. */
  presentation: AddonStreamPresentation;
}

export type AddonStreamEpisodeMatch = 'exact' | 'episode_range' | 'season_pack';
export type AddonStreamTitleMatch = 'close' | 'partial';

export interface AddonStreamMatchSummary {
  episode?: AddonStreamEpisodeMatch;
  title?: AddonStreamTitleMatch;
}

export type AddonStreamResolution = '4k' | '1080p' | '720p' | 'sd';
export type AddonStreamDeliveryKind = 'cached' | 'http' | 'p2p';

export interface AddonStreamPresentation {
  sourceName: string;
  streamTitle: string;
  resolution: AddonStreamResolution;
  deliveryKind: AddonStreamDeliveryKind;
  deliveryLabel: string;
  isInstantlyPlayable: boolean;
  hdrLabel?: string;
  audioLabel?: string;
  codecLabel?: string;
  multiAudioLabel?: string;
  sizeLabel?: string;
  isBatch: boolean;
}

export type StreamSourceHealthStatus = 'healthy' | 'degraded' | 'offline' | 'pending';

export interface StreamSourceSummary {
  id: string;
  name: string;
  status: StreamSourceHealthStatus;
  streamCount: number;
  latencyMs?: number;
  errorMessage?: string;
}

export interface StreamSelectorData {
  streams: AddonStream[];
  sourceSummaries: StreamSourceSummary[];
  fatalErrorMessage?: string | null;
  /**
   * False on progressive channel snapshots (some sources still in flight);
   * true on the settled command result. Missing on mocked/legacy payloads.
   */
  complete?: boolean;
}

export interface AddonSubtitle {
  id: string;
  url: string;
  lang?: string;
  /** Provider-supplied display hint (filename/release name/title) when present. */
  label?: string;
  sourceId: string;
  sourceName: string;
}

export interface BestResolvedStream {
  url: string;
  format: string;
  /** Bounded addon `proxyHeaders.request` entries, in-memory only. Never persisted or routed. */
  requestHeaders?: [string, string][];
  /** Stable addon-instance id (`AddonConfig.id`) of the resolved winner. */
  sourceId?: string;
  sourceName?: string;
  streamFamily?: string;
  /** Identity of the resolved winner: differs from the pick on failover. */
  streamKey?: string;
}

export interface ResolveBestStreamOptions extends StreamRankingOptions {
  // Opaque identity of a user-picked or saved stream: probed first, ahead of
  // ranked candidates. Not a ranking input — kept out of the ranking payload.
  preferredStreamKey?: string;
  // Saved stream identity for soft-matching when the exact key rotted:
  // signed URLs re-digest across sessions, so `uh:` keys miss even when the
  // same stream is still listed under the same source/release. The instance
  // id beats the display name: duplicate addon names must never soft-match
  // a sibling instance's stream.
  preferredSourceId?: string;
  preferredSourceName?: string;
  preferredStreamFamily?: string;
}

export type PlaybackStreamOutcome = 'verified' | 'startup-timeout' | 'load-failed' | 'disconnected';

export interface PlaybackStreamOutcomeReport {
  id: string;
  type: string;
  season?: number;
  episode?: number;
  /** Stable addon-instance id: the health key of record. */
  sourceId?: string;
  streamFamily?: string;
  outcome: PlaybackStreamOutcome;
}

export interface RecoverPlaybackStreamOptions extends StreamRankingOptions {
  mediaType: string;
  mediaId: string;
  streamSeason?: number;
  streamEpisode?: number;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  streamLookupId?: string;
  failedStreamUrl?: string;
  failedSourceId?: string;
  failedStreamFamily?: string;
  failedStreamKey?: string;
  outcome: Exclude<PlaybackStreamOutcomeReport['outcome'], 'verified'>;
}

export interface AddonResourceCapability {
  name: string;
  types: string[];
  idPrefixes: string[];
}

export interface AddonCatalogExtra {
  name: string;
  isRequired: boolean;
  options?: string[];
}

export interface AddonCatalogCapability {
  type: string;
  id: string;
  extras?: AddonCatalogExtra[];
}

/** Parsed Stremio manifest snapshot used for capability routing. */
export interface AddonManifest {
  name: string;
  resources: AddonResourceCapability[];
  catalogs: AddonCatalogCapability[];
}

/** The addon-source fields the renderer supplies when saving. */
export interface AddonConfigInput {
  id: string;
  url: string;
  name: string;
  enabled: boolean;
}

/**
 * A user-configured addon source compatible with Stremiro's addon pipeline.
 * `displayUrl` is the credential-masked URL computed by the Rust sanitizer —
 * always present on IPC responses, absent from renderer-supplied input.
 */
export interface AddonConfig extends AddonConfigInput {
  capabilities?: AddonManifest;
  displayUrl: string;
}

const apiCaches = {
  bestStream: createRequestCache<BestResolvedStream>(BEST_STREAM_CACHE_TTL_MS),
  mediaSchedule: createRequestCache<MediaSchedule>(MEDIA_SCHEDULE_CACHE_TTL_MS),
  searchCatalog: createRequestCache<SearchCatalogPage>(SEARCH_CACHE_TTL_MS),
};

export interface PlaybackLanguagePreferences {
  preferredAudioLanguage?: string;
  preferredSubtitleLanguage?: string;
}

export interface SupportedLanguage {
  code: string;
  label: string;
}

/** Which UI surfaces follow the accent color — off surfaces render neutral. */
export interface AccentTargets {
  navigation: boolean;
  actions: boolean;
  progress: boolean;
  artwork: boolean;
}

export interface LocalProfile {
  username: string;
  accentColor: string;
  accentIntensity: number;
  accentTargets: AccentTargets;
  /** Base64 image data URL; absent renders the initial-letter fallback. */
  avatar?: string;
}

export type ProfileViewMode = 'grid' | 'list';

export interface ProfilePreferences {
  profile: LocalProfile;
  viewMode: ProfileViewMode;
}

export interface AppUiPreferences {
  playerVolume: number;
  playerSpeed: number;
  spoilerProtection: boolean;
  /** Subtitle tuning persists across the per-episode player remount. */
  subtitleDelay: number;
  subtitlePos: number;
  subtitleScale: number;
  /** Opt-in: the EOF Up Next card auto-plays after a countdown. */
  autoPlayNext: boolean;
  /** Opt-OUT: muted trailer embed on hover-expanded media cards. */
  trailerPreviews: boolean;
  /**
   * Opt-in: SkipDB intro/recap segments seek to the segment end on entry.
   * Outros/previews and the next-episode tail stay manual (auto-advancing is
   * `autoPlayNext`'s job).
   */
  autoSkipIntro: boolean;
}

export interface AppUiPreferencesPatch {
  playerVolume?: number;
  playerSpeed?: number;
  spoilerProtection?: boolean;
  subtitleDelay?: number;
  subtitlePos?: number;
  subtitleScale?: number;
  autoPlayNext?: boolean;
  trailerPreviews?: boolean;
  autoSkipIntro?: boolean;
}

export type StreamSelectorQuality = 'all' | '4k' | '1080p' | '720p' | 'sd';
export type StreamSelectorSource = 'all' | 'cached';
export type StreamSelectorSort = 'smart' | 'quality' | 'seeds';
export type StreamSelectorBatch = 'all' | 'episodes' | 'packs';

export interface StreamSelectorPreferences {
  quality: StreamSelectorQuality;
  source: StreamSelectorSource;
  addon: string;
  sort: StreamSelectorSort;
  batch: StreamSelectorBatch;
}

export interface StreamSelectorPreferencesState {
  preferences: StreamSelectorPreferences;
  initialized: boolean;
}

export interface TrackLanguageCandidate {
  id: number;
  lang?: string;
  title?: string;
  defaultTrack?: boolean;
  forced?: boolean;
  hearingImpaired?: boolean;
}

export interface TrackLanguageSelectionResolution {
  selectedMatches: boolean;
  matchedTrackId?: number;
}

export interface SearchCatalogQuery {
  query?: string;
  mediaType?: 'movie' | 'series' | 'anime';
  feed?: 'popular' | 'featured';
  genres?: string[];
  yearFrom?: number;
  yearTo?: number;
  skip?: number;
}

export interface SearchCatalogPage {
  items: MediaItem[];
  nextSkip?: number | null;
}

export type HistoryPlaybackPlanReason = 'missing-episode-context';

export interface HistoryPlaybackRouteState extends Omit<
  PlayerRouteState,
  // Frontend-only launch fields Rust never emits: logo/opening labels are
  // player-session presentation, `requestedStreamKey`/`originFrom` come from
  // selector/back-nav state, not the history plan.
  'logo' | 'openingStreamName' | 'openingStreamSource' | 'originFrom' | 'requestedStreamKey'
> {
  season?: number;
}

export interface HistoryPlaybackPlan {
  kind: 'details' | 'player';
  reason?: HistoryPlaybackPlanReason;
  target: string;
  state: HistoryPlaybackRouteState;
}

export const api = {
  ...createDiscoveryApi({
    safeInvoke,
    mediaScheduleCache: apiCaches.mediaSchedule,
    searchCatalogCache: apiCaches.searchCatalog,
  }),
  ...createPlaybackApi({
    safeInvoke,
    caches: apiCaches,
  }),
  ...createStoreApi({
    safeInvoke,
    caches: apiCaches,
  }),
};

export interface DataStats {
  history_count: number;
  library_count: number;
  lists_count: number;
  watch_statuses_count: number;
}

export interface ImportResult {
  history_imported: number;
  library_imported: number;
  lists_imported: number;
  statuses_imported: number;
  addons_imported: number;
  settings_restored: boolean;
}

export interface WatchProgress {
  id: string;
  type_: string;
  season?: number;
  episode?: number;
  absolute_season?: number;
  absolute_episode?: number;
  stream_season?: number;
  stream_episode?: number;
  position: number;
  duration: number;
  last_watched: number;
  title: string;
  poster?: string;
  backdrop?: string;
  // Stream URLs are credential-bearing and never persisted or sent over the
  // wire; resume resolves via the opaque identities below.
  last_stream_format?: string;
  last_stream_lookup_id?: string;
  last_stream_key?: string;
  source_name?: string;
  /** Stable addon-instance id; rows from before instance-id plumbing omit it. */
  source_id?: string;
  stream_family?: string;
  resume_start_time?: number;
}

/**
 * Per-title resume snapshot from `get_title_watch_progress`: the same
 * unique-per-title history pick and continue-watching pick as the global
 * queries, scoped to one media id so callers never pay a full-table scan.
 */
export interface TitleWatchProgress {
  history: WatchProgress[];
  continueWatching: WatchProgress[];
}

/**
 * A single skippable playback segment returned by SkipDB.
 * Types: "intro" | "recap" | "outro" | "preview"
 */
export interface SkipSegment {
  /** Segment category identifier */
  type: string;
  /** Segment start in seconds */
  start_time: number;
  /** Segment end in seconds */
  end_time: number;
}

/** SkipDB lookup payload for a title or episode. */
export interface SkipTimesResult {
  segments: SkipSegment[];
}
