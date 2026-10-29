import { discoveryApi } from '@/lib/api-discovery';
import { playbackApi } from '@/lib/api-playback';
import { storeApi } from '@/lib/api-store';
import type { PlayerRouteMediaType, PlayerRouteState } from '@/lib/player-navigation';
import type { PlayerStreamRequest, PreferredStreamIdentity } from '@/lib/resolve-player-stream';
import type { StreamRankingOptions } from '@/lib/stream-ranking-cache-key';

export {
  getBackupImportErrorMessage,
  getErrorKind,
  getErrorMessage,
  getListErrorMessage,
  getWatchStatusErrorMessage,
  isNoCapableAddonError,
} from '@/lib/api-core';
export { toMediaItem } from '@/lib/api-store';

export interface MediaItem {
  id: string;
  title: string;
  poster?: string;
  backdrop?: string;
  logo?: string;
  description?: string;
  year?: string;
  /** Backend-extracted sort year from `year`; absent when none is valid. */
  primaryYear?: number;
  displayYear?: string;
  genres?: string[];
  type: 'movie' | 'series';
}

export interface Episode {
  id: string;
  title?: string;
  season: number;
  episode: number;
  /** Backend-normalized local air day (`YYYY-MM-DD`). */
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

/** Pack picker row from Rust; `index` points into the submitted episode list. */
export type StreamPackRow = { type: 'header'; season: number } | { type: 'episode'; index: number };

export interface EpisodeNavigationRequest {
  episodes: Pick<Episode, 'season' | 'episode' | 'releaseDate'>[];
  season: number;
  episode: number;
  today: string;
}

export interface UnairedEpisodesRequest {
  releaseDates: (string | null)[];
  today: string;
}

interface MediaSeason {
  number: number;
  episodeCount: number;
}

export interface MediaDetails extends MediaItem {
  imdbId?: string;
  rating?: string;
  ratingPercent?: number;
  runtime?: string;
  cast?: string[];
  directors?: string[];
  /** Backend-validated 11-char YouTube video ids. */
  trailers?: { id: string; name?: string }[];
  /** Backend-ordered by (season, episode); coordinate ties preserve addon
      order. */
  episodes?: Episode[];
  /** Backend summary of `episodes`' sorted season runs; absent iff
      `episodes` is (card payloads drop both). */
  seasons?: MediaSeason[];
}

export interface CalendarRange {
  visibleStart: string;
  visibleEnd: string;
  upcomingStart: string;
  hideWatched: boolean;
}

export interface CalendarScheduleEvent {
  id: string;
  mediaId: string;
  mediaType: 'movie' | 'series' | 'anime';
  title: string;
  seriesTitle: string;
  season?: number;
  episode?: number;
  releaseDate: string;
  poster?: string;
  type: 'movie' | 'episode';
  watched?: boolean;
  /** Started, or at/before the furthest watched episode: safe to name under spoiler protection. */
  seen?: boolean;
}

export interface CalendarSchedule {
  trackedCount: number;
  missingCount: number;
  /** Days ascending; each day's events backend-sorted (episodes by
      season/episode, then movies by title). */
  days: { date: string; events: CalendarScheduleEvent[] }[];
  /** Date-ascending slice of the upcoming window, capped by the backend. */
  upcoming: CalendarScheduleEvent[];
}

export interface SmartListRules {
  media_type?: 'movie' | 'series' | null;
  genres: string[];
  statuses: WatchStatus[];
  year_from?: number | null;
  year_to?: number | null;
}

export interface UserList {
  id: string;
  name: string;
  icon: string;
  item_ids: string[];
  rules?: SmartListRules | null;
  // Absent on `create_list` (metadata only); populated by list-with-items reads.
  items?: MediaItem[];
}

export interface RemovedListItem {
  item: MediaItem;
  index: number;
  after?: string | null;
}

export interface UserListSummary {
  id: string;
  name: string;
  icon: string;
  item_count: number;
  contains_item: boolean;
  is_smart: boolean;
}

export type WatchStatus = 'watching' | 'watched' | 'plan_to_watch' | 'dropped';

export interface LibraryFilters {
  query?: string;
  type?: 'all' | 'movie' | 'series';
  status?: WatchStatus | 'all' | 'none';
  sort?: 'default' | 'title-asc' | 'title-desc' | 'year-desc' | 'year-asc';
}

export interface ProfileLibrary {
  items: MediaItem[];
  allIds: string[];
  statusCounts: Record<WatchStatus | 'none', number>;
}

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
  // Raw addon fields stay Rust-side — resolution runs by `streamKey`, so secrets never cross into the webview.
  streamKey: string;
  seeders?: number;
  sizeBytes?: number;
  /** Addon/source that returned this stream (set by the backend). */
  sourceName?: string;
  /** Backend addon-config id — matches `StreamSourceSummary.id` so filter chips key on config identity, not display text. */
  sourceId?: string;
  /** Stable backend-derived release family used for adjacent-episode ranking. */
  streamFamily?: string;
  /** Backend coordinator ranking reasons (at most two, already distinct). */
  recommendationReasons?: AddonStreamRecommendationReason[];
  /** Structured episode/title match tiers for the selector badges. */
  matchSummary?: AddonStreamMatchSummary;
  matchBadgeKinds: StreamMatchBadgeKind[];
  matchTier: StreamMatchTier | null;
  showPackBadge: boolean;
  /** Backend-prepared presentation facts so the UI can render without reparsing stream text. */
  presentation: AddonStreamPresentation;
}

export type AddonStreamRecommendationReason =
  | 'verified_source'
  | 'source_issues'
  | 'source_cooling'
  | 'proven_release_group'
  | 'release_group_issues'
  | 'release_group_cooling'
  | 'title_affinity'
  | 'language_match'
  | 'language_flexible'
  | 'top_quality'
  | 'good_quality'
  | 'preferred_source'
  | 'fallback';

export type StreamMatchBadgeKind =
  | 'episode'
  | 'range'
  | 'season'
  | 'multi_season'
  | 'title'
  | 'title_partial';
export type StreamMatchTier = 'exact' | 'episode_range' | 'season_pack' | 'title';

interface AddonStreamMatchSummary {
  packCoverage?: {
    seasons: number[];
    episodeRanges?: { season?: number; start: number; end: number }[];
  };
}

export type AddonStreamResolution = '4k' | '1080p' | '720p' | 'sd';
type AddonStreamDeliveryKind = 'cached' | 'http' | 'p2p';

interface AddonStreamPresentation {
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

type StreamSourceHealthStatus = 'healthy' | 'no_results' | 'degraded' | 'offline' | 'pending';

export interface StreamSourceSummary {
  id: string;
  name: string;
  status: StreamSourceHealthStatus;
  streamCount: number;
  latencyMs?: number;
  errorMessage?: string;
}

export interface StreamSelectorStats {
  resCounts: Record<AddonStreamResolution, number>;
  playableCount: number;
  p2pCount: number;
  cachedCount: number;
  batchCount: number;
  episodeLikeCount: number;
  sourceHealth: { degraded: number; offline: number; pending: number };
}

export interface StreamSelectorData {
  hasEnabledAddons: boolean;
  streams: AddonStream[];
  stats: StreamSelectorStats;
  sourceSummaries: StreamSourceSummary[];
  fatalErrorMessage?: string | null;
}

export interface AddonSubtitle {
  id: string;
  selectionKey: string;
  url: string;
  lang?: string;
  /** Provider-supplied display hint (filename/release name/title) when present. */
  label?: string;
  detail?: string;
  mpvTitle: string;
  sourceId: string;
  sourceName: string;
}

export interface BestResolvedStream {
  url: string;
  /** Remaining Rust stream-pool lifetime; the frontend cache never outlives it. */
  cacheTtlMs: number;
  /** Rust-encoded mpv headers, in-memory only. Never persisted or routed; empty clears. */
  mpvHttpHeaderFields: string;
  /** Stable addon-instance id (`AddonConfig.id`) of the resolved winner. */
  sourceId?: string;
  sourceName?: string;
  streamFamily?: string;
  /** Identity of the resolved winner: differs from the pick on failover. */
  streamKey?: string;
}

export interface ResolveBestStreamOptions extends StreamRankingOptions {
  // User-picked/saved stream identity, probed ahead of ranked candidates — not a ranking input.
  preferredStreamKey?: string;
  // Soft-match hints for when the exact key rotted (signed URLs re-digest, `uh:` keys
  // miss); instance id beats display name so duplicate addon names can't match a sibling.
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
  /** Streams that already failed earlier in this episode's recovery chain. */
  excludedStreamKeys?: string[];
  outcome: Exclude<PlaybackStreamOutcomeReport['outcome'], 'verified'>;
}

/** Backend genre menus per browse tab, manifest order; `all` is the movie+series union folded like `sameSearchGenre`. */
export interface BrowseGenres {
  all: string[];
  movie: string[];
  series: string[];
  anime: string[];
}

export type AddonConfigsOp =
  | { kind: 'add'; url: string }
  | { kind: 'remove'; id: string }
  | { kind: 'setEnabled'; id: string; enabled: boolean }
  | { kind: 'reorder'; ids: string[] };

/** Rust verdict for the add-addon box, from the save path's own normalizer. */
export interface AddonUrlInspection {
  displayUrl?: string;
  error?: string;
  configurePage: boolean;
  /** Installed addon name this URL already points at. */
  duplicateOf?: string;
}

export interface AddonShareLink {
  link: string;
  /** The URL carries per-user addon setup, which can include API keys. */
  includesConfig: boolean;
}

/** A `stremiro://` link Rust validated: it opens a title or prefills the addon add box. */
export type AppLink =
  | { kind: 'addon'; url: string }
  | {
      kind: 'title';
      mediaType: PlayerRouteMediaType;
      mediaId: string;
      season?: number;
      episode?: number;
    };

export type AddonResourceKind = 'catalog' | 'meta' | 'stream' | 'subtitles';

/** User-configured addon source. `displayUrl` is Rust's credential-masked URL. */
export interface AddonConfig {
  id: string;
  name: string;
  enabled: boolean;
  displayUrl: string;
  /** Backend-pinned default: fixed slot, toggle-only. */
  pinned: boolean;
  /** Rust-sanitized manifest logo URL. */
  logo?: string;
  version?: string;
  description?: string;
  /** Absent until the manifest is classified; Rust then routes every request to the addon. */
  resources?: AddonResourceKind[];
  configurable: boolean;
}

export interface PlaybackLanguagePreferences {
  preferredAudioLanguage?: string;
  preferredSubtitleLanguage?: string;
}

/** `save_selected_playback_language_preference` response: post-save global snapshot plus merged
    effective prefs when scoped — lets callers write the effective cache synchronously. */
export interface SavedPlaybackLanguagePreference {
  preferences: PlaybackLanguagePreferences;
  effective?: PlaybackLanguagePreferences;
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
  skip: boolean;
  seekbar: boolean;
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

export type LocalProfileUpdate = Partial<Omit<LocalProfile, 'accentTargets' | 'avatar'>> & {
  accentTargets?: Partial<AccentTargets>;
};

export type ProfilePreferencesPatch = LocalProfileUpdate & { viewMode?: ProfileViewMode };

export type StartupPage = 'home' | 'library' | 'calendar' | 'lastVisited';

/** Rust maps each choice to fixed mpv properties for plain-text subtitles. */
export type SubtitleFont =
  | 'default'
  | 'modern'
  | 'grotesk'
  | 'humanist'
  | 'classic'
  | 'screen'
  | 'serif'
  | 'book'
  | 'rounded'
  | 'mono';
export type SubtitleColor =
  | 'white'
  | 'ivory'
  | 'lavender'
  | 'mint'
  | 'amber'
  | 'gray'
  | 'yellow'
  | 'cyan'
  | 'green'
  | 'red'
  | 'orange'
  | 'blue'
  | 'pink';
export type SubtitleEdge = 'outline' | 'none' | 'thick' | 'shadow' | 'box';

export interface AppUiPreferences {
  playerVolume: number;
  playerSpeed: number;
  /** Seconds; positive values play audio later. */
  audioDelay: number;
  /** Opt-in volume normalization for quieter listening. */
  nightMode: boolean;
  spoilerProtection: boolean;
  calendarHideWatched: boolean;
  /** Subtitle tuning persists across the per-episode player remount. */
  subtitleDelay: number;
  subtitlePos: number;
  subtitleScale: number;
  subtitleFont: SubtitleFont;
  subtitleColor: SubtitleColor;
  subtitleEdge: SubtitleEdge;
  subtitleBold: boolean;
  subtitleItalic: boolean;
  /** Loads a preferred-language addon subtitle when no embedded track matches. */
  autoLoadAddonSubtitles: boolean;
  /** Opt-in: the EOF Up Next card auto-plays after a countdown. */
  autoPlayNext: boolean;
  nextEpisodeCountdownSecs: number;
  controlsHideDelayMs: number;
  /** Opt-OUT: muted trailer embed on hover-expanded media cards. */
  trailerPreviews: boolean;
  /**
   * Opt-in: SkipDB intro/recap segments seek to the segment end on entry.
   * Outros/previews and the next-episode tail stay manual (auto-advancing is
   * `autoPlayNext`'s job).
   */
  autoSkipIntro: boolean;
  automaticUpdateChecks: boolean;
  closeToTray: boolean;
  minimizeToTray: boolean;
  startMinimized: boolean;
  startupPage: StartupPage;
  lastLocation: string | null;
  /** Per-action overrides (`[]` = unbound); see `src/lib/player-keybindings.ts`. */
  playerKeybindings: Record<string, string[]>;
  /** Newest first; recorded through `api.recordRecentSearch`, cleared by patch. */
  recentSearches: string[];
  effectivePlayerKeybindings: Record<string, string[]>;
  defaultPlayerKeybindings: Record<string, string[]>;
}

export interface BootstrapSnapshot {
  profilePreferences: ProfilePreferences;
  appUiPreferences: AppUiPreferences;
  streamSelectorPreferences: StreamSelectorPreferencesState;
  startupRoute: string | null;
}

export const DEFAULT_APP_UI_PREFERENCES: AppUiPreferences = {
  playerVolume: 75,
  playerSpeed: 1,
  audioDelay: 0,
  nightMode: false,
  spoilerProtection: false,
  calendarHideWatched: false,
  subtitleDelay: 0,
  subtitlePos: 100,
  subtitleScale: 1.0,
  subtitleFont: 'default',
  subtitleColor: 'white',
  subtitleEdge: 'outline',
  subtitleBold: false,
  subtitleItalic: false,
  autoLoadAddonSubtitles: true,
  autoPlayNext: false,
  nextEpisodeCountdownSecs: 8,
  controlsHideDelayMs: 3000,
  trailerPreviews: true,
  autoSkipIntro: false,
  automaticUpdateChecks: true,
  closeToTray: false,
  minimizeToTray: false,
  startMinimized: false,
  startupPage: 'home',
  lastLocation: null,
  playerKeybindings: {},
  recentSearches: [],
  effectivePlayerKeybindings: {},
  defaultPlayerKeybindings: {},
};

export type AppUiPreferencesPatch = Partial<
  Omit<AppUiPreferences, 'effectivePlayerKeybindings' | 'defaultPlayerKeybindings'>
>;

export const SUBTITLE_APPEARANCE_RESET = {
  subtitleFont: DEFAULT_APP_UI_PREFERENCES.subtitleFont,
  subtitleColor: DEFAULT_APP_UI_PREFERENCES.subtitleColor,
  subtitleEdge: DEFAULT_APP_UI_PREFERENCES.subtitleEdge,
  subtitleBold: DEFAULT_APP_UI_PREFERENCES.subtitleBold,
  subtitleItalic: DEFAULT_APP_UI_PREFERENCES.subtitleItalic,
};

export function hasSubtitleAppearance(preferences: typeof SUBTITLE_APPEARANCE_RESET) {
  return Object.entries(SUBTITLE_APPEARANCE_RESET).some(
    ([key, value]) => preferences[key as keyof typeof SUBTITLE_APPEARANCE_RESET] !== value,
  );
}

export type StreamSelectorQuality = 'all' | '4k' | '1080p' | '720p' | 'sd';
type StreamSelectorSource = 'all' | 'cached';
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
  defaultPreferences: StreamSelectorPreferences;
  episodeDefaultPreferences: StreamSelectorPreferences;
}

export interface StreamSelectorPreferencesPatch extends Partial<StreamSelectorPreferences> {
  episodeContext: boolean;
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

export interface SearchCatalogContinuation {
  skip?: number;
  allCursors?: {
    movie?: number;
    series?: number;
  };
  searchCursors?: {
    key: string;
    skip: number;
    retry?: boolean;
    pageHash?: string;
  }[];
  sourcePages?: string[];
  seenKeys: string[];
}

export interface SearchCatalogQuery {
  query?: string;
  mediaType?: 'movie' | 'series' | 'anime';
  feed?: 'popular' | 'featured';
  genres?: string[];
  yearFrom?: number;
  yearTo?: number;
  continuation?: SearchCatalogContinuation;
}

export interface SearchCatalogPage {
  items: MediaItem[];
  continuation: SearchCatalogContinuation;
  exhausted: boolean;
  partial: boolean;
}

type HistoryPlaybackPlanReason = 'missing-episode-context';

interface HistoryPlaybackRouteState extends Omit<
  PlayerRouteState,
  // Frontend-only launch fields Rust never emits.
  'logo' | 'openingStreamName' | 'openingStreamSource' | 'originFrom' | 'requestedStreamKey'
> {
  season?: number;
}

export interface HistoryPlaybackPlan {
  kind: 'details' | 'player';
  reason?: HistoryPlaybackPlanReason;
  target: string;
  state: HistoryPlaybackRouteState;
  warmResolveRequest?: PlayerStreamRequest & { preferred: PreferredStreamIdentity };
}

export const api = {
  ...discoveryApi,
  ...playbackApi,
  ...storeApi,
};

export interface DataStats {
  history_count: number;
  history_title_count: number;
  has_learned_playback_data: boolean;
  library_count: number;
  library_status_counts: ProfileLibrary['statusCounts'];
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
  // Stream URLs are credential-bearing — never persisted; resume resolves via the opaque identities below.
  last_stream_lookup_id?: string;
  last_stream_key?: string;
  source_name?: string;
  /** Stable addon-instance id; rows from before instance-id plumbing omit it. */
  source_id?: string;
  stream_family?: string;
  /** Rust read-side annotations: absent means no resume offer / false. */
  resume_start_time?: number;
  is_watched?: boolean;
  has_started_watching?: boolean;
}

export interface WatchProgressSave extends WatchProgress {
  completed?: boolean;
}

/** Per-episode progress plus selected resume and latest-history rows. */
export interface TitleWatchProgress {
  /** Per-episode rows keyed `id:season:episode` (canonical coords claim first). */
  episodeProgress: Record<string, WatchProgress>;
  /** Furthest started episode per season — spoiler-mask ceiling. */
  watchedEpisodeCeiling: Record<string, number>;
  /** Per-kind resumable picks (series-like vs movie), pre-folded. */
  seriesResumeEntry?: WatchProgress;
  movieResumeEntry?: WatchProgress;
  /** Set only when nothing is resumable; carries the furthest watched episode (Home's Up Next anchor). */
  upNextSource?: WatchProgress;
  /** Latest per-kind history heads (`last_watched` DESC). */
  latestSeriesEntry?: WatchProgress;
  latestMovieEntry?: WatchProgress;
}

/** Details-route prefetch in one IPC; `details` is the card shape (no episodes), null on fetch failure. */
export interface DetailsPrefetchBundle {
  details?: MediaDetails | null;
  progress: TitleWatchProgress;
}

export interface ResumeRailEntry {
  row: WatchProgress;
  /** Present only on Up Next rows — the badge flag; absent = resume row. */
  isNewEpisode?: boolean;
}

/** A skippable playback segment from SkipDB, sorted and non-overlapping. */
export interface SkipSegment {
  type: 'intro' | 'recap' | 'outro' | 'preview';
  /** Segment start in seconds */
  start_time: number;
  /** Segment end in seconds */
  end_time: number;
}

/** SkipDB lookup payload for a title or episode. */
export interface SkipTimesResult {
  segments: SkipSegment[];
  /** Seconds a manual "skip intro ~Xs" jumps when the episode has no usable intro. */
  intro_estimate_secs?: number;
}
