use super::config_store::AddonConfig;
use super::playback_preferences_commands::read_playback_language_preferences_from_store;
use super::playback_state::PlaybackStateService;
use super::probe_pool::{
    is_probeable_stream, StreamExclusions, BEST_STREAM_CANDIDATE_TIMEOUT_SECS,
};
use super::stream_coordinator::{
    rank_stream_by_recommendation, sort_streams_by_recommendation, StreamMatchContext,
    StreamRecommendationInputs, StreamRecommendationKey, StreamSignalCache,
    DEFAULT_SOURCE_HEALTH_PRIORITY,
};
use super::streaming_helpers::{
    build_addon_source_priority_map, build_stream_query_ids, merge_unique_streams,
    normalize_source_id, normalize_source_key, prepare_addon_streams, push_bounded_error,
    stream_absolute_episode_targets,
};
use super::{
    normalize_media_id, normalize_stream_media_type, PlaybackLanguagePreferences,
    MEDIA_TITLE_MAX_CHARS,
};
use crate::operational_log::{field, log_warn};
use crate::providers::addon_manifest::snapshot_supports_request;
use crate::providers::addons::{
    stream_conflicts_with_episode_targets, AddonStream, AddonTransport, StreamDeliveryKind,
    StreamResolution,
};
use crate::providers::trim_to_max;
use futures_util::stream::{self, StreamExt};
use serde::{ser::SerializeStruct, Serialize, Serializer};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager};

// Bounded so one unhealthy source cannot dominate selector open time; matches the
// resource request budget so a slow-but-alive source avoids the failure cooldown.
const ADDON_STREAM_FETCH_TIMEOUT_SECS: u64 = 20;
// Fallbacks fail fast — the first ID already produced nothing usable.
const ADDON_STREAM_FALLBACK_QUERY_TIMEOUT_SECS: u64 = 5;
const DEGRADED_SOURCE_LATENCY_MS: u64 = 4_500;
const ADDON_STREAM_FETCH_CONCURRENCY_LIMIT: usize = 4;
/// Resolve/recovery callers race a frontend timeout — one hung addon cannot outlive
/// the caller. Past the deadline the merge runs on whatever landed.
const RESOLVE_FETCH_DEADLINE: Duration = Duration::from_secs(14);

fn resolve_fetch_deadline(
    now: tokio::time::Instant,
    request_deadline: Option<tokio::time::Instant>,
) -> tokio::time::Instant {
    (now + RESOLVE_FETCH_DEADLINE).min(resolve_ranking_deadline(now, request_deadline))
}

fn resolve_ranking_deadline(
    now: tokio::time::Instant,
    request_deadline: Option<tokio::time::Instant>,
) -> tokio::time::Instant {
    let ranking_budget = request_deadline.map_or(RESOLVE_FETCH_DEADLINE, |deadline| {
        let remaining = deadline.saturating_duration_since(now);
        let probe_reserve =
            Duration::from_secs(BEST_STREAM_CANDIDATE_TIMEOUT_SECS).min(remaining / 2);
        remaining.saturating_sub(probe_reserve)
    });
    now + ranking_budget
}

/// Resolve/recovery fan-out options (bounded by `RESOLVE_FETCH_DEADLINE`).
#[derive(Clone, Copy, Default)]
pub(crate) struct ResolveFetch<'a> {
    /// Prepared key of the stream the probe pool tries first — once an addon
    /// returns it, slower addons are not awaited.
    pub settle_on_stream_key: Option<&'a str>,
    pub settled_early: Option<&'a AtomicBool>,
    pub preferred_source_id: Option<&'a str>,
    /// Recovery's current failure overlays the snapshot even before async persistence lands.
    pub failed_source_id: Option<&'a str>,
    pub failed_stream_family: Option<&'a str>,
    pub exclusions: Option<&'a StreamExclusions<'a>>,
    pub not_before: Option<Instant>,
}

impl ResolveFetch<'_> {
    fn apply_source_failure(
        self,
        priorities: &mut HashMap<String, u8>,
        preferred_title_source_id: &mut Option<String>,
    ) {
        let Some(source_id) = self.failed_source_id.and_then(normalize_source_id) else {
            return;
        };
        // A first failure demotes, but must not lift an already active cooldown.
        priorities
            .entry(source_id.clone())
            .and_modify(|priority| *priority = (*priority).min(1))
            .or_insert(1);
        if preferred_title_source_id.as_deref() == Some(source_id.as_str()) {
            *preferred_title_source_id = None;
        }
    }

    fn initial_family_priorities(self) -> HashMap<String, u8> {
        // Families cool down on the first failure; seed before store-backed scores
        // are filled so a stale positive snapshot cannot overwrite this failure.
        self.failed_stream_family
            .and_then(normalize_source_key)
            .map(|family| (family, 0))
            .into_iter()
            .collect()
    }
}
const ACTIVE_SOURCE_COOLDOWN_PRIORITY: u8 = 0;
const SOURCE_COOLDOWN_ERROR_MESSAGE: &str =
    "Temporarily cooling down after recent playback failures.";
const ALL_SOURCES_COOLDOWN_FATAL_ERROR: &str =
    "All enabled stream sources are temporarily cooling down after recent playback failures.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StreamSourceStatus {
    Healthy,
    #[serde(rename = "no_results")]
    NoResults,
    Degraded,
    Offline,
    /// Still in flight on a progressive snapshot — renders as searching, not offline.
    Pending,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamSourceSummary {
    pub id: String,
    pub name: String,
    pub status: StreamSourceStatus,
    pub stream_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct StreamSelectorData {
    pub streams: Vec<AddonStream>,
    pub source_summaries: Vec<StreamSourceSummary>,
    pub fatal_error_message: Option<String>,
}

#[derive(Default, Serialize)]
struct StreamResolutionCounts {
    #[serde(rename = "4k")]
    p2160: usize,
    #[serde(rename = "1080p")]
    p1080: usize,
    #[serde(rename = "720p")]
    p720: usize,
    sd: usize,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamSourceHealthSummary {
    degraded: usize,
    offline: usize,
    pending: usize,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamSelectorStats {
    res_counts: StreamResolutionCounts,
    playable_count: usize,
    p2p_count: usize,
    cached_count: usize,
    batch_count: usize,
    episode_like_count: usize,
    source_health: StreamSourceHealthSummary,
}

impl StreamSelectorStats {
    fn from_snapshot<'a>(
        streams: impl IntoIterator<Item = &'a AddonStream>,
        sources: impl IntoIterator<Item = &'a StreamSourceSummary>,
    ) -> Self {
        let mut stats = Self::default();
        for stream in streams {
            let presentation = &stream.presentation;
            if !presentation.is_instantly_playable {
                stats.p2p_count += 1;
                continue;
            }
            stats.playable_count += 1;
            match presentation.resolution {
                StreamResolution::P2160 => stats.res_counts.p2160 += 1,
                StreamResolution::P1080 => stats.res_counts.p1080 += 1,
                StreamResolution::P720 => stats.res_counts.p720 += 1,
                StreamResolution::Sd => stats.res_counts.sd += 1,
            }
            if presentation.delivery_kind == StreamDeliveryKind::Cached {
                stats.cached_count += 1;
            }
            if presentation.is_batch {
                stats.batch_count += 1;
            }
        }
        stats.episode_like_count = stats.playable_count - stats.batch_count;
        for source in sources {
            match source.status {
                StreamSourceStatus::Degraded => stats.source_health.degraded += 1,
                StreamSourceStatus::Offline => stats.source_health.offline += 1,
                StreamSourceStatus::Pending => stats.source_health.pending += 1,
                StreamSourceStatus::Healthy | StreamSourceStatus::NoResults => {}
            }
        }
        stats
    }
}

impl Serialize for StreamSelectorData {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Only selector payloads serialize; counts derive from prepared presentation facts.
        let mut data = serializer.serialize_struct(
            "StreamSelectorData",
            if self.fatal_error_message.is_some() {
                4
            } else {
                3
            },
        )?;
        data.serialize_field("streams", &self.streams)?;
        data.serialize_field("sourceSummaries", &self.source_summaries)?;
        data.serialize_field(
            "stats",
            &StreamSelectorStats::from_snapshot(&self.streams, &self.source_summaries),
        )?;
        if let Some(message) = &self.fatal_error_message {
            data.serialize_field("fatalErrorMessage", message)?;
        }
        data.end()
    }
}

/// Borrowed serialize view of `StreamSelectorData` for progressive snapshots:
/// identical wire shape, zero clones. Lockstep pinned by `selector_snapshot_serializes_like_selector_data`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamSelectorSnapshot<'a> {
    streams: Vec<&'a AddonStream>,
    stats: StreamSelectorStats,
    source_summaries: Vec<&'a StreamSourceSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fatal_error_message: Option<&'a str>,
}

fn send_selector_snapshot<'a>(
    channel: &Channel,
    streams: Vec<&'a AddonStream>,
    source_summaries: Vec<&'a StreamSourceSummary>,
) {
    // Progressive snapshots never carry a fatal error — the settled result owns that field.
    // Straight to the wire string: a `serde_json::Value` detour builds and drops a full tree per snapshot.
    if let Ok(payload) = serde_json::to_string(&StreamSelectorSnapshot {
        stats: StreamSelectorStats::from_snapshot(
            streams.iter().copied(),
            source_summaries.iter().copied(),
        ),
        streams,
        source_summaries,
        fatal_error_message: None,
    }) {
        let _ = channel.send(InvokeResponseBody::Json(payload));
    }
}

#[derive(Debug)]
struct AddonStreamFetchOutcome {
    id: String,
    name: String,
    streams: Vec<AddonStream>,
    latency_ms: u64,
    error_message: Option<String>,
}

fn source_health_priority_for_addon(
    addon: &AddonConfig,
    source_health: &HashMap<String, u8>,
) -> u8 {
    normalize_source_id(&addon.id)
        .and_then(|id| source_health.get(&id).copied())
        .unwrap_or(DEFAULT_SOURCE_HEALTH_PRIORITY)
}

fn summarize_cooldown_skipped_addon(addon: &AddonConfig) -> StreamSourceSummary {
    StreamSourceSummary {
        id: addon.id.clone(),
        name: addon.name.clone(),
        status: StreamSourceStatus::Offline,
        stream_count: 0,
        latency_ms: None,
        error_message: Some(SOURCE_COOLDOWN_ERROR_MESSAGE.to_string()),
    }
}

fn addon_declares_stream(addon: &AddonConfig, media_type: &str, query_ids: &[String]) -> bool {
    query_ids.iter().any(|query_id| {
        addon.capabilities.as_ref().is_none_or(|snapshot| {
            snapshot_supports_request(snapshot, "stream", media_type, query_id)
        })
    })
}

fn load_effective_playback_language_preferences(
    defaults: PlaybackLanguagePreferences,
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    media_id: &str,
    media_type: &str,
) -> PlaybackLanguagePreferences {
    playback_state
        .get_effective_playback_language_preferences(
            app,
            Some(media_id),
            Some(media_type),
            defaults.clone(),
        )
        .unwrap_or_else(|error| {
            log_warn(
                "stream-fetcher",
                "load_effective_playback_language_preferences",
                "language-preferences-fallback",
                &[field("error", &error)],
            );
            defaults
        })
}

pub(crate) struct StreamQueryRequest<'a> {
    pub media_type: &'a str,
    pub id: &'a str,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub absolute_episode: Option<u32>,
}

impl StreamQueryRequest<'_> {
    fn query_ids(&self, video_id: Option<&str>) -> Vec<String> {
        let mut ids = build_stream_query_ids(
            self.media_type,
            self.id,
            self.season,
            self.episode,
            self.absolute_episode,
        );
        if self.media_type != "movie" && self.season.zip(self.episode).is_some() {
            if let Some(id) = video_id.and_then(|id| normalize_media_id(super::js_trim(id))) {
                if !ids.contains(&id) {
                    // Keep the working primary, then try Stremio's video.id before heuristic fallbacks.
                    ids.insert(1, id);
                }
            }
        }
        ids
    }

    fn episode_targets_with_video_id(
        &self,
        ranking: &StreamRankingScope,
        video_id: Option<&str>,
    ) -> Vec<(u32, u32)> {
        let mut targets = self.episode_targets(ranking);
        if self.media_type != "movie" {
            let target = video_id.and_then(|id| {
                let id = normalize_media_id(super::js_trim(id))?;
                let (base, episode) = id.rsplit_once(':')?;
                let (base, season) = base.rsplit_once(':')?;
                // kitsu:{title}:{episode} is flat, not season/episode numbering.
                if base.is_empty() || base == "kitsu" {
                    return None;
                }
                Some((season.parse().ok()?, episode.parse().ok()?))
            });
            if let Some(target) = target.filter(|target| !targets.contains(target)) {
                targets.push(target);
            }
        }
        targets
    }

    pub(crate) fn episode_targets(&self, ranking: &StreamRankingScope) -> Vec<(u32, u32)> {
        if self.media_type == "movie" {
            return Vec::new();
        }
        let mut targets = Vec::new();
        for target in [
            self.season.zip(self.episode),
            ranking.season.zip(ranking.episode),
        ]
        .into_iter()
        .flatten()
        .chain(
            stream_absolute_episode_targets(
                self.media_type,
                self.id,
                self.season,
                self.episode,
                self.absolute_episode,
            )
            .into_iter()
            .flatten(),
        ) {
            if !targets.contains(&target) {
                targets.push(target);
            }
        }
        targets
    }
}

pub(crate) struct StreamRankingScope {
    pub media_type: String,
    pub media_id: String,
    pub title: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
}

/// Ranking overrides: the frontend can rank against a different title/id than the fetch query uses.
pub(crate) struct StreamRankingOverrides {
    pub media_type: Option<String>,
    pub media_id: Option<String>,
    pub title: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
}

/// One builder for the coordinator's match context — progressive snapshot and final
/// merge must rank on identical coordinates. `is_final_season` lets the episode
/// battery resolve numberless "final season" naming claims.
fn stream_match_context<'a>(
    episode_targets: &'a [(u32, u32)],
    ranking: &'a StreamRankingScope,
    is_final_season: bool,
) -> StreamMatchContext<'a> {
    StreamMatchContext {
        media_type: &ranking.media_type,
        title: ranking.title.as_deref(),
        episode_targets,
        canonical_season: ranking.season,
        is_final_season,
    }
}

pub(crate) fn resolve_stream_ranking_scope(
    query_media_type: &str,
    query_id: &str,
    fallback_season: Option<u32>,
    fallback_episode: Option<u32>,
    overrides: StreamRankingOverrides,
) -> Result<StreamRankingScope, String> {
    let media_id = match overrides.media_id.as_deref() {
        Some(value) => normalize_media_id(value)
            .ok_or_else(|| "Media ID is required for stream ranking.".to_string())?,
        None => query_id.to_string(),
    };
    let media_type = match overrides.media_type.as_deref() {
        Some(value) => normalize_stream_media_type(value, Some(media_id.as_str()))
            .ok_or_else(|| "Invalid media type for stream ranking.".to_string())?
            .to_string(),
        None => query_media_type.to_string(),
    };

    Ok(StreamRankingScope {
        media_type,
        media_id,
        title: overrides
            .title
            .as_deref()
            .and_then(|title| trim_to_max(title, MEDIA_TITLE_MAX_CHARS)),
        season: overrides.season.or(fallback_season),
        episode: overrides.episode.or(fallback_episode),
    })
}

#[derive(Clone, Copy)]
struct EpisodeEligibility<'a> {
    targets: &'a [(u32, u32)],
    final_season: Option<u32>,
    exclusions: Option<&'a StreamExclusions<'a>>,
}

async fn fetch_prepared_streams_for_addon(
    provider: &AddonTransport,
    effective_type: &str,
    query_ids: &[String],
    addon: &AddonConfig,
    episode_eligibility: Option<EpisodeEligibility<'_>>,
    not_before: Option<Instant>,
) -> Result<Vec<AddonStream>, String> {
    let source_name = addon.name.as_str();
    let resolve = episode_eligibility.is_some();
    let mut last_error: Option<String> = None;
    let mut any_succeeded = false;
    let mut unprobeable_streams = Vec::new();
    let mut attempted_queries = 0;

    for (index, query_id) in query_ids.iter().enumerate() {
        if !addon_declares_stream(addon, effective_type, std::slice::from_ref(query_id)) {
            continue;
        }
        let primary_attempt = attempted_queries == 0;
        attempted_queries += 1;
        let timeout_secs = if primary_attempt {
            ADDON_STREAM_FETCH_TIMEOUT_SECS
        } else {
            ADDON_STREAM_FALLBACK_QUERY_TIMEOUT_SECS
        };

        // Snapshot before spawning: a `clear_cache` landing mid-flight revokes this attempt's cooldown right.
        let generation = provider.cache_generation();
        let attempt = tokio::time::timeout(Duration::from_secs(timeout_secs), async {
            provider
                .get_streams_fresh(effective_type, query_id, &addon.url, not_before)
                .await
        })
        .await;

        match attempt {
            Ok(Ok(streams)) => {
                any_succeeded = true;
                let mut prepared = prepare_addon_streams(streams, source_name, &addon.id);
                if let Some(eligibility) = episode_eligibility {
                    if let Some(exclusions) = eligibility.exclusions {
                        exclusions.retain(&mut prepared);
                    }
                    prepared.retain(|stream| {
                        !stream_conflicts_with_episode_targets(
                            stream.match_texts(),
                            eligibility.targets,
                            eligibility.final_season,
                        )
                    });
                }
                if prepared.is_empty() {
                    continue;
                }
                if resolve && !prepared.iter().any(is_probeable_stream) {
                    if unprobeable_streams.is_empty() {
                        unprobeable_streams = prepared;
                    }
                    continue;
                }

                return Ok(prepared);
            }
            Ok(Err(error)) => {
                log_warn(
                    "stream-fetcher",
                    "fetch_addon_streams",
                    "addon-query-failed",
                    &[
                        field("source", source_name),
                        field("media_type", effective_type),
                        field("query_index", index + 1),
                        field("query_id", query_id),
                        field("error", &error),
                    ],
                );
                last_error = Some(format!("{}: {}", source_name, error));
            }
            Err(_) => {
                let error = format!("{} timed out after {}s", source_name, timeout_secs);
                // The dropped get_streams future can't record its own failure — a hung
                // host would re-pay the timeout on every selector open. Only the primary
                // attempt may cool the host: a fallback id's timeout proves nothing.
                if primary_attempt {
                    provider.note_fetch_failure_for_url(&addon.url, generation);
                }
                log_warn(
                    "stream-fetcher",
                    "fetch_addon_streams",
                    "addon-query-timeout",
                    &[
                        field("source", source_name),
                        field("media_type", effective_type),
                        field("query_index", index + 1),
                        field("query_id", query_id),
                        field("timeout_secs", timeout_secs),
                    ],
                );
                if primary_attempt {
                    // The recorded cooldown would reject remaining ids and mask the
                    // timeout error — return the real failure.
                    return Err(error);
                }
                last_error = Some(error);
            }
        }
    }

    if !any_succeeded {
        if let Some(error) = last_error {
            return Err(error);
        }
    }

    Ok(unprobeable_streams)
}

pub(crate) async fn fetch_stream_for_link(
    app: &AppHandle,
    provider: &AddonTransport,
    query: &StreamQueryRequest<'_>,
    ranking: &StreamRankingScope,
    stream_key: &str,
    source_id: Option<&str>,
) -> Result<Option<AddonStream>, String> {
    let effective_type = super::media_type::addon_episode_lookup_type(query.media_type);
    let video_id =
        cached_episode_video_id(app, &app.state::<PlaybackStateService>(), ranking, None).await;
    let query_ids = query.query_ids(video_id.as_deref());
    let addons = super::addon_registry::load_enabled_addons_snapshot(app).await?;
    let stream_addons = addons
        .iter()
        .filter(|addon| addon_declares_stream(addon, effective_type, &query_ids))
        .collect();
    fetch_stream_for_link_from_addons(
        provider,
        effective_type,
        &query_ids,
        stream_addons,
        stream_key,
        source_id,
    )
    .await
}

async fn fetch_stream_for_link_from_addons(
    provider: &AddonTransport,
    effective_type: &str,
    query_ids: &[String],
    mut stream_addons: Vec<&AddonConfig>,
    stream_key: &str,
    source_id: Option<&str>,
) -> Result<Option<AddonStream>, String> {
    // The hint can only select an enabled, stream-capable addon from this snapshot.
    let hinted = if let Some(index) =
        source_id.and_then(|id| stream_addons.iter().position(|addon| addon.id == id))
    {
        let addon = stream_addons.remove(index);
        Some(
            fetch_prepared_streams_for_addon(
                provider,
                effective_type,
                query_ids,
                addon,
                None,
                None,
            )
            .await,
        )
    } else {
        None
    };
    let remaining = stream::iter((0..stream_addons.len()).map(|index| {
        fetch_prepared_streams_for_addon(
            provider,
            effective_type,
            query_ids,
            stream_addons[index],
            None,
            None,
        )
    }))
    .buffer_unordered(ADDON_STREAM_FETCH_CONCURRENCY_LIMIT);
    let mut pending = stream::iter(hinted).chain(remaining);
    let mut first_error = None;
    while let Some(result) = pending.next().await {
        match result {
            Ok(streams) => {
                if let Some(stream) = streams
                    .into_iter()
                    .find(|stream| stream.stream_key == stream_key)
                {
                    return Ok(Some(stream));
                }
            }
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    first_error.map_or(Ok(None), Err)
}

async fn cached_episode_video_id(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    ranking: &StreamRankingScope,
    deadline: Option<tokio::time::Instant>,
) -> Option<String> {
    if ranking.media_type == "movie" {
        return None;
    }
    let (season, episode) = ranking.season.zip(ranking.episode)?;
    let app = app.clone();
    let service = playback_state.clone();
    let media_type = ranking.media_type.clone();
    let media_id = ranking.media_id.clone();
    let read = super::run_blocking_store_op(move || {
        service.get_episode_video_id(&app, &media_type, &media_id, season, episode)
    });
    let result = match deadline {
        Some(deadline) => tokio::time::timeout_at(deadline, read)
            .await
            .unwrap_or_else(|error| Err(error.to_string())),
        None => read.await,
    };
    result.unwrap_or_else(|error| {
        log_warn(
            "stream-fetcher",
            "cached_episode_video_id",
            "episode-video-id-fallback",
            &[field("error", &error)],
        );
        None
    })
}

/// Batched single-store read, off the async worker: health, title affinities, language
/// prefs, and the final-season fact — fixed inputs the progressive snapshots reuse.
/// Family priorities depend on the streams and are fetched incrementally per addon.
async fn snapshot_selector_inputs(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    ranking: &StreamRankingScope,
    stream_addons: &[(usize, &AddonConfig)],
    deadline: Option<tokio::time::Instant>,
) -> Result<
    (
        HashMap<String, u8>,
        Option<String>,
        PlaybackLanguagePreferences,
        bool,
    ),
    String,
> {
    if deadline.is_some_and(|deadline| deadline <= tokio::time::Instant::now()) {
        return Ok(Default::default());
    }
    let app_owned = app.clone();
    let service = playback_state.clone();
    let media_id_owned = ranking.media_id.clone();
    let media_type_owned = ranking.media_type.clone();
    let season_owned = ranking.season;
    let addon_source_ids: Vec<String> = stream_addons
        .iter()
        .map(|(_, addon)| addon.id.clone())
        .collect();
    let snapshot = super::run_blocking_store_op(move || {
        let store = super::open_store(&app_owned, super::SETTINGS_STORE_FILE)?;
        let language_preferences = read_playback_language_preferences_from_store(&store);
        let source_health = service
            .source_health_priorities_for_ids(
                &app_owned,
                addon_source_ids.iter().map(|id| Some(id.as_str())),
            )
            .unwrap_or_default();
        let preferred_title_source_id = service
            .preferred_title_source_id(&app_owned, &media_id_owned, &media_type_owned)
            .unwrap_or_default();
        // Final-season fact rides the same blocking read — one keyed lookup, no extra hop.
        let is_final_season = service.episode_is_final_season(
            &app_owned,
            &media_type_owned,
            &media_id_owned,
            season_owned,
        );
        Ok((
            source_health,
            preferred_title_source_id,
            load_effective_playback_language_preferences(
                language_preferences,
                &app_owned,
                &service,
                &media_id_owned,
                &media_type_owned,
            ),
            is_final_season,
        ))
    });
    match deadline {
        Some(deadline) => tokio::time::timeout_at(deadline, snapshot)
            .await
            .unwrap_or_else(|_| Ok(Default::default())),
        None => snapshot.await,
    }
}

/// Fixed ranking inputs snapshot once per fetch — previews and the settled merge
/// rank against the same maps so the two orderings can't drift.
struct SelectorFetchContext<'a> {
    app: &'a AppHandle,
    playback_state: &'a PlaybackStateService,
    provider: &'a AddonTransport,
    query: &'a StreamQueryRequest<'a>,
    ranking: &'a StreamRankingScope,
    episode_targets: Vec<(u32, u32)>,
    addon_source_priorities: HashMap<String, u32>,
    source_health_priorities: HashMap<String, u8>,
    preferred_title_source_id: Option<String>,
    language_preferences: PlaybackLanguagePreferences,
    is_final_season: bool,
    fetch_deadline: Option<tokio::time::Instant>,
    deadline: Option<tokio::time::Instant>,
}

impl SelectorFetchContext<'_> {
    fn recommendation_inputs<'a>(
        &'a self,
        stream_family_priorities: &'a HashMap<String, u8>,
    ) -> StreamRecommendationInputs<'a> {
        StreamRecommendationInputs {
            addon_source_priorities: &self.addon_source_priorities,
            source_health_priorities: &self.source_health_priorities,
            stream_family_priorities,
            preferred_title_source_id: self.preferred_title_source_id.as_deref(),
            match_context: stream_match_context(
                &self.episode_targets,
                self.ranking,
                self.is_final_season,
            ),
            preferred_audio_language: self
                .language_preferences
                .preferred_audio_language
                .as_deref(),
            preferred_subtitle_language: self
                .language_preferences
                .preferred_subtitle_language
                .as_deref(),
        }
    }
}

async fn fetch_addon_stream_outcome(
    provider: &AddonTransport,
    effective_type: &str,
    query_ids: &[String],
    addon: &AddonConfig,
    episode_eligibility: Option<EpisodeEligibility<'_>>,
    not_before: Option<Instant>,
) -> AddonStreamFetchOutcome {
    let started_at = Instant::now();
    let result = fetch_prepared_streams_for_addon(
        provider,
        effective_type,
        query_ids,
        addon,
        episode_eligibility,
        not_before,
    )
    .await;
    // Exact cast: `min` caps the u128 at u64::MAX, so `as` cannot wrap.
    let latency_ms = started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;

    let (streams, error_message) = match result {
        Ok(streams) => (streams, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    AddonStreamFetchOutcome {
        id: addon.id.clone(),
        name: addon.name.clone(),
        streams,
        latency_ms,
        error_message,
    }
}

fn summarize_addon_outcome(outcome: &AddonStreamFetchOutcome) -> StreamSourceSummary {
    let status = if outcome.error_message.is_some() {
        StreamSourceStatus::Offline
    } else if outcome.streams.is_empty() {
        StreamSourceStatus::NoResults
    } else if outcome.latency_ms > DEGRADED_SOURCE_LATENCY_MS {
        StreamSourceStatus::Degraded
    } else {
        StreamSourceStatus::Healthy
    };

    StreamSourceSummary {
        id: outcome.id.clone(),
        name: outcome.name.clone(),
        status,
        stream_count: outcome.streams.len(),
        latency_ms: outcome
            .error_message
            .is_none()
            .then_some(outcome.latency_ms),
        error_message: outcome.error_message.clone(),
    }
}

fn build_fatal_stream_error(errors: &[String]) -> Option<String> {
    if errors.is_empty() {
        None
    } else {
        Some(errors.join(" | "))
    }
}

/// Fetch priority scores for stream families not yet in `priorities`. Called per addon
/// arrival — most calls find every family already scored and skip the store read.
async fn ensure_stream_family_priorities(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    ranking: &StreamRankingScope,
    merged: &[AddonStream],
    priorities: &mut HashMap<String, u8>,
    deadline: Option<tokio::time::Instant>,
) -> Result<(), String> {
    let mut missing: HashSet<&str> = HashSet::new();
    for stream in merged {
        let Some(family) = stream.stream_family.as_deref() else {
            continue;
        };
        if !priorities.contains_key(family) {
            missing.insert(family);
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    if deadline.is_some_and(|deadline| deadline <= tokio::time::Instant::now()) {
        return Err("Background persistence timed out.".to_string());
    }

    let missing: Vec<String> = missing.into_iter().map(str::to_string).collect();
    let app_owned = app.clone();
    let service = playback_state.clone();
    let media_id_owned = ranking.media_id.clone();
    let media_type_owned = ranking.media_type.clone();
    let season_owned = ranking.season;
    let episode_owned = ranking.episode;
    let fetched = super::run_blocking_store_op(move || {
        service.stream_family_priorities_for_names(
            &app_owned,
            &media_id_owned,
            &media_type_owned,
            season_owned,
            episode_owned,
            missing.iter().map(String::as_str),
        )
    });
    let fetched = match deadline {
        Some(deadline) => tokio::time::timeout_at(deadline, fetched)
            .await
            .map_err(|_| "Background persistence timed out.".to_string())??,
        None => fetched.await?,
    };
    priorities.extend(fetched);
    Ok(())
}

/// `resolve` bounds the fan-out for resolve/recovery.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn fetch_stream_selector_data(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    provider: &AddonTransport,
    query: &StreamQueryRequest<'_>,
    ranking: &StreamRankingScope,
    progress: Option<&Channel>,
    resolve: Option<ResolveFetch<'_>>,
    deadline: Option<tokio::time::Instant>,
) -> Result<StreamSelectorData, String> {
    let effective_type = super::media_type::addon_episode_lookup_type(query.media_type);

    let enabled_addons = async {
        let snapshot = super::addon_registry::load_enabled_addons_snapshot(app);
        match deadline {
            Some(deadline) => tokio::time::timeout_at(deadline, snapshot)
                .await
                .map_err(|_| "Stream resolution timed out.".to_string())?,
            None => snapshot.await,
        }
    };
    let (video_id, enabled_addons) = tokio::join!(
        cached_episode_video_id(app, playback_state, ranking, deadline),
        enabled_addons
    );
    let enabled_addons = enabled_addons?;
    let query_ids = query.query_ids(video_id.as_deref());

    if enabled_addons.is_empty() {
        return Ok(StreamSelectorData {
            streams: Vec::new(),
            source_summaries: Vec::new(),
            fatal_error_message: None,
        });
    }

    let stream_addons: Vec<(usize, &AddonConfig)> = enabled_addons
        .iter()
        .enumerate()
        .filter(|(_, addon)| addon_declares_stream(addon, effective_type, &query_ids))
        .collect();

    let (
        mut source_health_priorities,
        mut preferred_title_source_id,
        language_preferences,
        is_final_season,
    ) = snapshot_selector_inputs(app, playback_state, ranking, &stream_addons, deadline).await?;
    if let Some(resolve) = resolve {
        resolve.apply_source_failure(
            &mut source_health_priorities,
            &mut preferred_title_source_id,
        );
    }

    let stream_addons: Vec<(usize, &AddonConfig, u8)> = stream_addons
        .into_iter()
        .map(|(index, addon)| {
            let priority = source_health_priority_for_addon(addon, &source_health_priorities);
            if priority == ACTIVE_SOURCE_COOLDOWN_PRIORITY {
                log_warn(
                    "stream-fetcher",
                    "fetch_stream_selector_data",
                    "addon-query-skipped-cooldown",
                    &[
                        field("source", &addon.name),
                        field("media_type", query.media_type),
                        field("media_id", query.id),
                    ],
                );
            }
            (index, addon, priority)
        })
        .collect();

    // One "can query" view — fetch targets and the source-priority map both derive from it.
    let mut active_stream_addons: Vec<(usize, &AddonConfig)> = stream_addons
        .iter()
        .filter(|(_, _, priority)| *priority > ACTIVE_SOURCE_COOLDOWN_PRIORITY)
        .map(|(index, addon, _)| (*index, *addon))
        .collect();

    if active_stream_addons.is_empty() {
        // Metadata-only addons (e.g. pinned Cinemeta) are not stream sources — listing
        // them "offline" is noise. No stream addons = empty streams, no fatal error.
        let source_summaries = stream_addons
            .iter()
            .map(|(_, addon, _)| summarize_cooldown_skipped_addon(addon))
            .collect();
        let fatal_error_message = if stream_addons.is_empty() {
            None
        } else {
            Some(ALL_SOURCES_COOLDOWN_FATAL_ERROR.to_string())
        };

        return Ok(StreamSelectorData {
            streams: Vec::new(),
            source_summaries,
            fatal_error_message,
        });
    }

    let now = tokio::time::Instant::now();
    let ctx = SelectorFetchContext {
        app,
        playback_state,
        provider,
        query,
        ranking,
        episode_targets: query.episode_targets_with_video_id(ranking, video_id.as_deref()),
        addon_source_priorities: build_addon_source_priority_map(
            active_stream_addons.iter().map(|(_, addon)| *addon),
        ),
        source_health_priorities,
        preferred_title_source_id,
        language_preferences,
        is_final_season,
        fetch_deadline: resolve.map(|_| resolve_fetch_deadline(now, deadline)),
        deadline,
    };

    if let Some(index) = resolve
        .and_then(|resolve| resolve.preferred_source_id)
        .and_then(|id| {
            active_stream_addons
                .iter()
                .position(|(_, addon)| addon.id == id)
        })
    {
        active_stream_addons[..=index].rotate_right(1);
    }

    let (outcomes, stream_family_priorities, signal_cache) = run_progressive_fetch(
        &ctx,
        &stream_addons,
        &active_stream_addons,
        &query_ids,
        effective_type,
        progress,
        resolve,
    )
    .await;

    let data = merge_selector_outcomes(
        &ctx,
        &stream_addons,
        outcomes,
        stream_family_priorities,
        signal_cache,
        resolve.is_some(),
    )
    .await;
    Ok(data)
}

/// Fans out to prioritized addons (bounded concurrency); with a progress channel,
/// emits a merged+ranked snapshot per addon landing. Preview merges arrive in
/// completion order; the final merge walks declaration order — deterministic.
async fn run_progressive_fetch(
    ctx: &SelectorFetchContext<'_>,
    stream_addons: &[(usize, &AddonConfig, u8)],
    prioritized_addons: &[(usize, &AddonConfig)],
    query_ids: &[String],
    effective_type: &str,
    progress: Option<&Channel>,
    resolve: Option<ResolveFetch<'_>>,
) -> (
    BTreeMap<usize, AddonStreamFetchOutcome>,
    HashMap<String, u8>,
    StreamSignalCache,
) {
    // Outcomes own the rows; preview ordering never changes their declaration ordinals.
    let mut preview_rows: Vec<(StreamRecommendationKey, usize, usize)> = Vec::new();
    let mut preview_seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Preview buffers exist only for channel callers — resolve/recovery passes no channel.
    let mut preview_summaries: BTreeMap<usize, StreamSourceSummary> = if progress.is_some() {
        stream_addons
            .iter()
            .map(|(index, addon, priority)| {
                let summary = if *priority == ACTIVE_SOURCE_COOLDOWN_PRIORITY {
                    summarize_cooldown_skipped_addon(addon)
                } else {
                    StreamSourceSummary {
                        id: addon.id.clone(),
                        name: addon.name.clone(),
                        status: StreamSourceStatus::Pending,
                        stream_count: 0,
                        latency_ms: None,
                        error_message: None,
                    }
                };
                (*index, summary)
            })
            .collect()
    } else {
        BTreeMap::new()
    };
    let mut stream_family_priorities = resolve
        .map(ResolveFetch::initial_family_priorities)
        .unwrap_or_default();
    let mut signal_cache = StreamSignalCache::default();
    let mut family_priorities_incomplete = false;
    let mut outcomes: BTreeMap<usize, AddonStreamFetchOutcome> = BTreeMap::new();

    if let Some(channel) = progress {
        // Ship the declared-source roster first: the selector's "searching N sources"
        // count and filter ids come from these summaries, not per-addon responses.
        send_selector_snapshot(channel, Vec::new(), preview_summaries.values().collect());
    }

    let provider = ctx.provider;
    let final_season = ctx.ranking.season.filter(|_| ctx.is_final_season);
    let episode_eligibility = resolve.map(|resolve| EpisodeEligibility {
        targets: &ctx.episode_targets,
        final_season,
        exclusions: resolve.exclusions,
    });
    let not_before = resolve.and_then(|resolve| resolve.not_before);
    // Index iteration keeps this borrowed future factory Send without boxing.
    let mut pending = stream::iter((0..prioritized_addons.len()).map(|position| async move {
        let (index, addon) = prioritized_addons[position];
        (
            index,
            fetch_addon_stream_outcome(
                provider,
                effective_type,
                query_ids,
                addon,
                episode_eligibility,
                not_before,
            )
            .await,
        )
    }))
    .buffer_unordered(ADDON_STREAM_FETCH_CONCURRENCY_LIMIT);

    // No deadline keeps the full selector wait; resolve/recovery bounds the fan-out.
    let fetch_deadline = ctx.fetch_deadline;
    let settle_on_stream_key = resolve.and_then(|resolve| resolve.settle_on_stream_key);

    loop {
        let next = match fetch_deadline {
            Some(deadline) => match tokio::time::timeout_at(deadline, pending.next()).await {
                Ok(next) => next,
                Err(_) => {
                    log_warn(
                        "stream-fetcher",
                        "fetch_stream_selector_data",
                        "resolve-fetch-deadline-reached",
                        &[
                            field("media_type", ctx.query.media_type),
                            field("media_id", ctx.query.id),
                        ],
                    );
                    break;
                }
            },
            None => pending.next().await,
        };
        let Some((index, outcome)) = next else {
            break;
        };
        outcomes.insert(index, outcome);
        let outcome = &outcomes[&index];
        let settled = settle_on_stream_key.is_some_and(|key| {
            outcome.streams.iter().any(|stream| {
                stream.stream_key == key
                    && is_probeable_stream(stream)
                    && !stream_conflicts_with_episode_targets(
                        stream.match_texts(),
                        &ctx.episode_targets,
                        final_season,
                    )
            })
        });
        if let Some(channel) = progress {
            // A store error only costs this snapshot its family signal. Score only the
            // arriving batch; earlier arrivals already covered the merged set.
            if let Err(error) = ensure_stream_family_priorities(
                ctx.app,
                ctx.playback_state,
                ctx.ranking,
                &outcome.streams,
                &mut stream_family_priorities,
                ctx.deadline,
            )
            .await
            {
                family_priorities_incomplete = true;
                log_warn(
                    "stream-fetcher",
                    "fetch_stream_selector_data",
                    "family-priority-fetch-failed",
                    &[field("error", &error)],
                );
            }

            let has_streams = !outcome.streams.is_empty();
            preview_summaries.insert(index, summarize_addon_outcome(outcome));

            if has_streams {
                let inputs = ctx.recommendation_inputs(&stream_family_priorities);
                // Only failed lookups leave earlier rows with family scores a later batch can fill.
                if family_priorities_incomplete {
                    for (key, index, row) in &mut preview_rows {
                        let stream = &mut outcomes
                            .get_mut(index)
                            .expect("preview addon outcome")
                            .streams[*row];
                        *key = rank_stream_by_recommendation(stream, inputs, &mut signal_cache);
                    }
                }
                let outcome = outcomes.get_mut(&index).expect("arriving addon outcome");
                for (row, stream) in outcome.streams.iter_mut().enumerate() {
                    let key = &stream.stream_key;
                    if !key.is_empty() && !preview_seen.contains(key) {
                        preview_seen.insert(key.clone());
                        let key = rank_stream_by_recommendation(stream, inputs, &mut signal_cache);
                        preview_rows.push((key, index, row));
                    }
                }
                preview_rows.sort_by_key(|(key, _, _)| std::cmp::Reverse(*key));
            }
            send_selector_snapshot(
                channel,
                preview_rows
                    .iter()
                    .map(|(_, index, row)| &outcomes[index].streams[*row])
                    .collect(),
                preview_summaries.values().collect(),
            );
        }
        if settled {
            if let Some(settled_early) = resolve.and_then(|resolve| resolve.settled_early) {
                settled_early.store(outcomes.len() < prioritized_addons.len(), Ordering::Relaxed);
            }
            break;
        }
    }

    drop(pending);
    if let Some(exclusions) = resolve.and_then(|resolve| resolve.exclusions) {
        loop {
            let retries =
                recovery_addons_needing_fallback(&mut outcomes, prioritized_addons, exclusions);
            if retries.is_empty()
                || fetch_deadline.is_some_and(|deadline| deadline <= tokio::time::Instant::now())
            {
                break;
            }
            let retries = &retries;
            let mut pending = stream::iter((0..retries.len()).map(|position| async move {
                let (index, addon) = retries[position];
                (
                    index,
                    fetch_addon_stream_outcome(
                        provider,
                        effective_type,
                        query_ids,
                        addon,
                        episode_eligibility,
                        not_before,
                    )
                    .await,
                )
            }))
            .buffer_unordered(ADDON_STREAM_FETCH_CONCURRENCY_LIMIT);
            loop {
                let next = match fetch_deadline {
                    Some(deadline) => tokio::time::timeout_at(deadline, pending.next())
                        .await
                        .unwrap_or(None),
                    None => pending.next().await,
                };
                let Some((index, outcome)) = next else {
                    break;
                };
                outcomes.insert(index, outcome);
            }
        }
    }

    (outcomes, stream_family_priorities, signal_cache)
}

fn recovery_addons_needing_fallback<'a>(
    outcomes: &mut BTreeMap<usize, AddonStreamFetchOutcome>,
    addons: &[(usize, &'a AddonConfig)],
    exclusions: &StreamExclusions<'_>,
) -> Vec<(usize, &'a AddonConfig)> {
    addons
        .iter()
        .filter_map(|&(index, addon)| {
            let outcome = outcomes.get_mut(&index)?;
            let previous_len = outcome.streams.len();
            exclusions.retain(&mut outcome.streams);
            // Another addon may have identified this batch as an excluded request after it settled.
            (outcome.streams.len() < previous_len
                && !outcome.streams.iter().any(is_probeable_stream))
            .then_some((index, addon))
        })
        .collect()
}

/// Merge per-addon outcomes in declaration order, rank once against the
/// fixed inputs, and build the settled payload.
async fn merge_selector_outcomes(
    ctx: &SelectorFetchContext<'_>,
    stream_addons: &[(usize, &AddonConfig, u8)],
    mut outcomes: BTreeMap<usize, AddonStreamFetchOutcome>,
    mut stream_family_priorities: HashMap<String, u8>,
    mut signal_cache: StreamSignalCache,
    resolve_only: bool,
) -> StreamSelectorData {
    let mut merged: Vec<AddonStream> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut source_summaries = Vec::with_capacity(stream_addons.len());
    let mut fatal_errors = Vec::new();

    for (index, addon, priority) in stream_addons {
        if *priority == ACTIVE_SOURCE_COOLDOWN_PRIORITY {
            source_summaries.push(summarize_cooldown_skipped_addon(addon));
            continue;
        }

        let Some(outcome) = outcomes.remove(index) else {
            let error_message = format!("{} did not respond in time.", addon.name);
            push_bounded_error(&mut fatal_errors, error_message.as_str());
            source_summaries.push(StreamSourceSummary {
                id: addon.id.clone(),
                name: addon.name.clone(),
                status: StreamSourceStatus::Offline,
                stream_count: 0,
                latency_ms: None,
                error_message: Some(error_message),
            });
            continue;
        };

        let summary = summarize_addon_outcome(&outcome);
        if let Some(error_message) = outcome.error_message.as_deref() {
            push_bounded_error(&mut fatal_errors, error_message);
        }

        merge_unique_streams(&mut merged, &mut seen, outcome.streams);
        source_summaries.push(summary);
    }

    retain_rankable_streams(&mut merged, resolve_only);

    // The merged set moves through the ranking snapshot and comes back ranked.
    let streams = if merged.is_empty() {
        merged
    } else {
        // Progressive-pass scores are reused; a non-channel caller finds them all
        // missing and pays the same store read. A wedged store costs the family
        // signal, not the pool — unscored families rank on the default.
        let ranking_deadline = ctx
            .deadline
            .map(|deadline| resolve_ranking_deadline(tokio::time::Instant::now(), Some(deadline)));
        if let Err(error) = ensure_stream_family_priorities(
            ctx.app,
            ctx.playback_state,
            ctx.ranking,
            &merged,
            &mut stream_family_priorities,
            ranking_deadline,
        )
        .await
        {
            log_warn(
                "stream-fetcher",
                "fetch_stream_selector_data",
                "family-priority-fetch-failed",
                &[field("error", &error)],
            );
        }
        let mut ranked = merged;
        sort_streams_by_recommendation(
            &mut ranked,
            ctx.recommendation_inputs(&stream_family_priorities),
            &mut signal_cache,
        );
        ranked
    };

    StreamSelectorData {
        fatal_error_message: if streams.is_empty() {
            build_fatal_stream_error(&fatal_errors)
        } else {
            None
        },
        source_summaries,
        streams,
    }
}

fn retain_rankable_streams(streams: &mut Vec<AddonStream>, resolve_only: bool) {
    if resolve_only && streams.iter().any(is_probeable_stream) {
        streams.retain(is_probeable_stream);
    }
}

pub(crate) async fn fetch_ranked_streams(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    provider: &AddonTransport,
    query: &StreamQueryRequest<'_>,
    ranking: &StreamRankingScope,
    resolve: ResolveFetch<'_>,
    deadline: tokio::time::Instant,
) -> Result<Vec<AddonStream>, String> {
    let data = fetch_stream_selector_data(
        app,
        playback_state,
        provider,
        query,
        ranking,
        None,
        Some(resolve),
        Some(deadline),
    )
    .await?;

    if data.streams.is_empty() {
        if let Some(error) = data.fatal_error_message {
            return Err(error);
        }
    }

    Ok(data.streams)
}

#[cfg(test)]
mod tests;
