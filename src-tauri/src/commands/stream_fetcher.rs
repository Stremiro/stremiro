use super::config_store::{get_trimmed_store_string, AddonConfig};
use super::playback_preferences_commands::{
    sanitize_language_pref, PREFERRED_AUDIO_LANGUAGE_STORE_KEY,
    PREFERRED_SUBTITLE_LANGUAGE_STORE_KEY,
};
use super::playback_state::PlaybackStateService;
use super::stream_coordinator::{
    sort_streams_by_recommendation, StreamMatchContext, StreamRecommendationInputs,
    StreamSignalCache, DEFAULT_SOURCE_HEALTH_PRIORITY,
};
use super::streaming_helpers::{
    build_addon_source_priority_map, build_stream_query_ids, merge_unique_streams,
    normalize_source_id, normalize_source_key, prepare_addon_streams,
};
use super::{
    normalize_media_id, normalize_non_empty, normalize_stream_media_type,
    PlaybackLanguagePreferences,
};
use crate::operational_log::{field, log_warn};
use crate::providers::addon_manifest::snapshot_supports_request;
use crate::providers::addons::{AddonStream, AddonTransport};
use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::AppHandle;

// Primary addon lookups get the most budget, bounded so one unhealthy source
// cannot dominate selector open time.
const ADDON_STREAM_FETCH_TIMEOUT_SECS: u64 = 14;
// Lookup fallbacks are best-effort and fail fast — the first ID already
// produced nothing usable.
const ADDON_STREAM_FALLBACK_QUERY_TIMEOUT_SECS: u64 = 5;
const DEGRADED_SOURCE_LATENCY_MS: u64 = 4_500;
const ADDON_STREAM_FETCH_CONCURRENCY_LIMIT: usize = 4;
/// Resolve/recovery callers race a frontend timeout: bound the fan-out so one
/// hung addon cannot outlive the caller. Past the deadline the merge still
/// runs on whatever landed; missing addons get the "did not return" summary.
const RESOLVE_FETCH_DEADLINE: Duration = Duration::from_secs(14);
const ACTIVE_SOURCE_COOLDOWN_PRIORITY: u8 = 0;
const SOURCE_COOLDOWN_ERROR_MESSAGE: &str =
    "Temporarily cooling down after recent playback failures.";
const ALL_SOURCES_COOLDOWN_FATAL_ERROR: &str =
    "All enabled stream sources are temporarily cooling down after recent playback failures.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StreamSourceStatus {
    Healthy,
    Degraded,
    Offline,
    /// Still in flight on a progressive snapshot — the chip renders as a
    /// searching placeholder instead of a red offline dot.
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamSelectorData {
    pub streams: Vec<AddonStream>,
    pub source_summaries: Vec<StreamSourceSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fatal_error_message: Option<String>,
    /// False on progressive channel snapshots; the command result itself is
    /// always complete. Older consumers can ignore the flag entirely.
    pub complete: bool,
}

/// Borrowed serialize view of `StreamSelectorData` for progressive channel
/// snapshots: identical wire shape, zero stream clones. Mirrored fields stay
/// in lockstep via the `selector_snapshot_serializes_like_selector_data` pin.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamSelectorSnapshot<'a> {
    streams: &'a [AddonStream],
    source_summaries: Vec<&'a StreamSourceSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fatal_error_message: Option<&'a str>,
    complete: bool,
}

fn send_selector_snapshot(
    channel: &Channel<serde_json::Value>,
    streams: &[AddonStream],
    source_summaries: Vec<&StreamSourceSummary>,
) {
    // Progressive snapshots never carry a fatal error — the settled command
    // result owns that field.
    if let Ok(payload) = serde_json::to_value(StreamSelectorSnapshot {
        streams,
        source_summaries,
        fatal_error_message: None,
        complete: false,
    }) {
        let _ = channel.send(payload);
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

fn addon_declares_stream(addon: &AddonConfig, media_type: &str, media_id: &str) -> bool {
    addon
        .capabilities
        .as_ref()
        .is_none_or(|snapshot| snapshot_supports_request(snapshot, "stream", media_type, media_id))
}

fn load_effective_playback_language_preferences(
    preferred_audio_language: Option<String>,
    preferred_subtitle_language: Option<String>,
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    media_id: &str,
    media_type: &str,
) -> PlaybackLanguagePreferences {
    let defaults = PlaybackLanguagePreferences {
        preferred_audio_language: sanitize_language_pref(preferred_audio_language, false),
        preferred_subtitle_language: sanitize_language_pref(preferred_subtitle_language, true),
    };

    playback_state
        .get_effective_playback_language_preferences(
            app,
            Some(media_id),
            Some(media_type),
            defaults.clone(),
        )
        .unwrap_or(defaults)
}

pub(crate) struct StreamQueryRequest<'a> {
    pub media_type: &'a str,
    pub id: &'a str,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub absolute_episode: Option<u32>,
}

pub(crate) struct StreamRankingScope {
    pub media_type: String,
    pub media_id: String,
    pub title: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
}

/// Optional ranking overrides every stream command accepts: the frontend
/// can rank against a different title/id than the fetch query uses.
pub(crate) struct StreamRankingOverrides {
    pub media_type: Option<String>,
    pub media_id: Option<String>,
    pub title: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
}

/// One builder for the coordinator's match context — the progressive
/// snapshot and the final merge must rank on identical coordinates.
/// `is_final_season` is the mapping-index fact that lets the episode
/// battery resolve numberless "final season" naming claims.
fn stream_match_context<'a>(
    query: &StreamQueryRequest<'_>,
    ranking: &'a StreamRankingScope,
    is_final_season: bool,
) -> StreamMatchContext<'a> {
    StreamMatchContext {
        media_type: &ranking.media_type,
        title: ranking.title.as_deref(),
        query_season: query.season,
        query_episode: query.episode,
        canonical_season: ranking.season,
        canonical_episode: ranking.episode,
        is_final_season,
    }
}

/// Snapshot of the two global language defaults. Read once on the blocking
/// pool before fan-out so no `Store` handle is held across network awaits.
async fn snapshot_global_language_defaults(
    app: &AppHandle,
) -> Result<(Option<String>, Option<String>), String> {
    let app = app.clone();
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        Ok((
            get_trimmed_store_string(&store, PREFERRED_AUDIO_LANGUAGE_STORE_KEY),
            get_trimmed_store_string(&store, PREFERRED_SUBTITLE_LANGUAGE_STORE_KEY),
        ))
    })
    .await
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
        title: overrides.title.as_deref().and_then(normalize_non_empty),
        season: overrides.season.or(fallback_season),
        episode: overrides.episode.or(fallback_episode),
    })
}

async fn fetch_prepared_streams_for_addon(
    provider: &AddonTransport,
    effective_type: &str,
    query_ids: &[String],
    addon: &AddonFetchTarget,
) -> Result<Vec<AddonStream>, String> {
    let source_name = addon.name.as_str();
    let mut last_error: Option<String> = None;

    for (index, query_id) in query_ids.iter().enumerate() {
        let timeout_secs = if index == 0 {
            ADDON_STREAM_FETCH_TIMEOUT_SECS
        } else {
            ADDON_STREAM_FALLBACK_QUERY_TIMEOUT_SECS
        };

        // Snapshot before spawning: a `clear_cache` landing mid-flight
        // revokes this attempt's right to record a cooldown on timeout.
        let generation = provider.cache_generation();
        let attempt = tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            provider.get_streams(effective_type, query_id, &addon.url),
        )
        .await;

        match attempt {
            Ok(Ok(streams)) => {
                let prepared = prepare_addon_streams(streams, source_name, &addon.id);
                if prepared.is_empty() {
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
                // The dropped get_streams future can't record its own
                // failure — without this, a hung host re-pays the full
                // timeout on every selector open. Only the primary attempt
                // may cool the host: a fallback id's timeout proves nothing
                // about reachability.
                if index == 0 {
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
                last_error = Some(error);
            }
        }
    }

    if let Some(error) = last_error {
        return Err(error);
    }

    Ok(Vec::new())
}

/// Batched single-store read, off the async worker: health, title
/// affinities, language prefs, and the final-season fact are fixed inputs
/// the progressive snapshots reuse. Stream-family priorities depend on the
/// streams themselves and are fetched incrementally as addons land.
async fn snapshot_selector_inputs(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    ranking: &StreamRankingScope,
    stream_addons: &[(usize, &AddonConfig)],
    preferred_audio_language: Option<String>,
    preferred_subtitle_language: Option<String>,
) -> Result<
    (
        HashMap<String, u8>,
        Option<String>,
        PlaybackLanguagePreferences,
        bool,
    ),
    String,
> {
    let app_owned = app.clone();
    let service = playback_state.clone();
    let media_id_owned = ranking.media_id.clone();
    let media_type_owned = ranking.media_type.clone();
    let season_owned = ranking.season;
    let addon_source_ids: Vec<String> = stream_addons
        .iter()
        .map(|(_, addon)| addon.id.clone())
        .collect();
    super::run_blocking_store_op(move || {
        let source_health = service
            .source_health_priorities_for_ids(
                &app_owned,
                addon_source_ids.iter().map(|id| Some(id.as_str())),
            )
            .unwrap_or_default();
        let preferred_title_source_id = service
            .preferred_title_source_id(&app_owned, &media_id_owned, &media_type_owned)
            .unwrap_or_default();
        // The episode battery's final-season fact rides the same blocking
        // read (see `PlaybackStateService::episode_is_final_season`): one
        // more keyed lookup, no extra store hop.
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
                preferred_audio_language,
                preferred_subtitle_language,
                &app_owned,
                &service,
                &media_id_owned,
                &media_type_owned,
            ),
            is_final_season,
        ))
    })
    .await
}

/// Fixed ranking inputs snapshot once per selector fetch — the progressive
/// previews and the settled merge rank against the same maps so the two
/// orderings can never drift.
struct SelectorFetchContext<'a> {
    app: &'a AppHandle,
    playback_state: &'a PlaybackStateService,
    provider: &'a AddonTransport,
    query: &'a StreamQueryRequest<'a>,
    ranking: &'a StreamRankingScope,
    addon_source_priorities: HashMap<String, u32>,
    source_health_priorities: HashMap<String, u8>,
    preferred_title_source_id: Option<String>,
    language_preferences: PlaybackLanguagePreferences,
    is_final_season: bool,
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
            match_context: stream_match_context(self.query, self.ranking, self.is_final_season),
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

/// The three `AddonConfig` fields the async fan-out needs — cloning the
/// full config would drag the manifest capability snapshot into every
/// per-addon future.
struct AddonFetchTarget {
    id: String,
    name: String,
    url: String,
}

async fn fetch_addon_stream_outcome(
    provider: &AddonTransport,
    effective_type: &str,
    query_ids: &[String],
    addon: AddonFetchTarget,
) -> AddonStreamFetchOutcome {
    let started_at = Instant::now();
    let result =
        fetch_prepared_streams_for_addon(provider, effective_type, query_ids, &addon).await;
    // Exact cast: `min` caps the u128 at u64::MAX, so `as` cannot wrap.
    let latency_ms = started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;

    match result {
        Ok(streams) => AddonStreamFetchOutcome {
            id: addon.id,
            name: addon.name,
            streams,
            latency_ms,
            error_message: None,
        },
        Err(error_message) => AddonStreamFetchOutcome {
            id: addon.id,
            name: addon.name,
            streams: Vec::new(),
            latency_ms,
            error_message: Some(error_message),
        },
    }
}

fn summarize_addon_outcome(outcome: &AddonStreamFetchOutcome) -> StreamSourceSummary {
    let status = if outcome.error_message.is_some() {
        StreamSourceStatus::Offline
    } else if outcome.streams.is_empty() || outcome.latency_ms > DEGRADED_SOURCE_LATENCY_MS {
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

/// Fetch priority scores for stream families not yet in `priorities`. The
/// progressive path calls this per addon arrival — most calls find every
/// family already scored and skip the store read entirely.
async fn ensure_stream_family_priorities(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    ranking: &StreamRankingScope,
    merged: &[AddonStream],
    priorities: &mut HashMap<String, u8>,
) -> Result<(), String> {
    let mut missing: HashSet<String> = HashSet::new();
    for stream in merged {
        let Some(family) = stream
            .stream_family
            .as_deref()
            .and_then(normalize_source_key)
        else {
            continue;
        };
        if !priorities.contains_key(&family) {
            missing.insert(family);
        }
    }
    if missing.is_empty() {
        return Ok(());
    }

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
    })
    .await?;
    priorities.extend(fetched);
    Ok(())
}

/// Returns the selector payload plus the `is_final_season` fact the ranking
/// snapshot computed — `StreamPoolQuery::fetch_pool` reuses it for the
/// episode-conflict retain so the pool gate and the ranker read one source
/// of truth.
pub(crate) async fn fetch_stream_selector_data(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    provider: &AddonTransport,
    query: &StreamQueryRequest<'_>,
    ranking: &StreamRankingScope,
    progress: Option<&Channel<serde_json::Value>>,
) -> Result<(StreamSelectorData, bool), String> {
    let effective_type = super::media_type::addon_episode_lookup_type(query.media_type);

    let query_ids = build_stream_query_ids(
        query.media_type,
        query.id,
        query.season,
        query.episode,
        query.absolute_episode,
    );
    // Snapshot addon configs and language defaults on the blocking pool
    // before fan-out — no `Store` handle is held across network awaits.
    let (addons_snapshot, language_snapshot) = tokio::join!(
        super::addon_registry::load_enabled_addons_snapshot(app),
        snapshot_global_language_defaults(app)
    );
    let enabled_addons = addons_snapshot?;
    let (preferred_audio_language, preferred_subtitle_language) = language_snapshot?;

    if enabled_addons.is_empty() {
        return Ok((
            StreamSelectorData {
                streams: Vec::new(),
                source_summaries: Vec::new(),
                fatal_error_message: None,
                complete: true,
            },
            false,
        ));
    }

    // Single pass over enabled addons: capability predicate and health
    // priority each run once per stream-declaring addon.
    let stream_addons: Vec<(usize, &AddonConfig)> = enabled_addons
        .iter()
        .enumerate()
        .filter(|(_, addon)| addon_declares_stream(addon, effective_type, query.id))
        .collect();

    let (
        source_health_priorities,
        preferred_title_source_id,
        language_preferences,
        is_final_season,
    ) = snapshot_selector_inputs(
        app,
        playback_state,
        ranking,
        &stream_addons,
        preferred_audio_language,
        preferred_subtitle_language,
    )
    .await?;

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

    let prioritized_addons: Vec<(usize, AddonFetchTarget)> = stream_addons
        .iter()
        .filter(|(_, _, priority)| *priority > ACTIVE_SOURCE_COOLDOWN_PRIORITY)
        .map(|(index, addon, _)| {
            (
                *index,
                AddonFetchTarget {
                    id: addon.id.clone(),
                    name: addon.name.clone(),
                    url: addon.url.clone(),
                },
            )
        })
        .collect();

    if prioritized_addons.is_empty() {
        // Metadata-only addons (e.g. pinned Cinemeta) are not stream sources —
        // listing them as "offline" is noise. An empty stream-addon set
        // surfaces as empty streams with no fatal error so the UI can prompt.
        let source_summaries = stream_addons
            .iter()
            .map(|(_, addon, _)| summarize_cooldown_skipped_addon(addon))
            .collect();
        let fatal_error_message = if stream_addons.is_empty() {
            None
        } else {
            Some(ALL_SOURCES_COOLDOWN_FATAL_ERROR.to_string())
        };

        return Ok((
            StreamSelectorData {
                streams: Vec::new(),
                source_summaries,
                fatal_error_message,
                complete: true,
            },
            is_final_season,
        ));
    }

    let ctx = SelectorFetchContext {
        app,
        playback_state,
        provider,
        query,
        ranking,
        addon_source_priorities: build_addon_source_priority_map(
            stream_addons
                .iter()
                .filter(|(_, _, priority)| *priority > ACTIVE_SOURCE_COOLDOWN_PRIORITY)
                .map(|(_, addon, _)| *addon),
        ),
        source_health_priorities,
        preferred_title_source_id,
        language_preferences,
        is_final_season,
    };

    let (outcomes, stream_family_priorities, signal_cache) = run_progressive_fetch(
        &ctx,
        &stream_addons,
        prioritized_addons,
        &query_ids,
        effective_type,
        progress,
    )
    .await;

    let data = merge_selector_outcomes(
        &ctx,
        &stream_addons,
        outcomes,
        stream_family_priorities,
        signal_cache,
    )
    .await?;
    Ok((data, is_final_season))
}

/// Fan out to prioritized addons (bounded concurrency); with a progress
/// channel attached, emit a merged+ranked snapshot per addon landing.
/// Preview merges arrive in completion order; the final merge walks
/// declaration order, so the settled list is deterministic. Returns the
/// per-addon outcomes plus the family priorities and signal memo the final
/// merge reuses.
async fn run_progressive_fetch(
    ctx: &SelectorFetchContext<'_>,
    stream_addons: &[(usize, &AddonConfig, u8)],
    prioritized_addons: Vec<(usize, AddonFetchTarget)>,
    query_ids: &[String],
    effective_type: &str,
    progress: Option<&Channel<serde_json::Value>>,
) -> (
    BTreeMap<usize, AddonStreamFetchOutcome>,
    HashMap<String, u8>,
    StreamSignalCache,
) {
    let mut preview_merged: Vec<AddonStream> = Vec::new();
    let mut preview_seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Preview buffers only exist for channel callers — resolve/recovery
    // fetches pass no channel and never read them.
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
    let mut stream_family_priorities: HashMap<String, u8> = HashMap::new();
    let mut signal_cache = StreamSignalCache::default();
    let mut outcomes: BTreeMap<usize, AddonStreamFetchOutcome> = BTreeMap::new();

    if let Some(channel) = progress {
        // Ship the declared-source roster first: the selector's "searching N
        // sources" count and filter ids come from these summaries, not from
        // per-addon responses.
        send_selector_snapshot(channel, &[], preview_summaries.values().collect());
    }

    let provider = ctx.provider;
    // Arc shares across the fan-out: N addon futures would otherwise each
    // deep-copy the same id list and media type.
    let query_ids: std::sync::Arc<[String]> = query_ids.into();
    let effective_type: std::sync::Arc<str> = effective_type.into();
    let mut pending = stream::iter(prioritized_addons.into_iter().map(|(index, addon)| {
        let query_ids = query_ids.clone();
        let effective_type = effective_type.clone();

        async move {
            (
                index,
                fetch_addon_stream_outcome(provider, &effective_type, &query_ids, addon).await,
            )
        }
    }))
    .buffer_unordered(ADDON_STREAM_FETCH_CONCURRENCY_LIMIT);

    // Progressive selector opens drive their own UI cadence and keep the
    // full wait; non-progressive callers (resolve/recovery) hit the deadline.
    let fetch_deadline = progress
        .is_none()
        .then(|| tokio::time::Instant::now() + RESOLVE_FETCH_DEADLINE);

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
        if let Some(channel) = progress {
            // A store error only costs this snapshot its family signal — the
            // fan-out and the final rank still get their own attempt. Score
            // only the arriving batch; earlier arrivals already covered the
            // merged set.
            if let Err(error) = ensure_stream_family_priorities(
                ctx.app,
                ctx.playback_state,
                ctx.ranking,
                &outcome.streams,
                &mut stream_family_priorities,
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

            merge_unique_streams(
                &mut preview_merged,
                &mut preview_seen,
                outcome.streams.iter().cloned(),
            );
            preview_summaries.insert(index, summarize_addon_outcome(&outcome));

            sort_streams_by_recommendation(
                &mut preview_merged,
                ctx.recommendation_inputs(&stream_family_priorities),
                &mut signal_cache,
            );

            send_selector_snapshot(
                channel,
                &preview_merged,
                preview_summaries.values().collect(),
            );
        }
        outcomes.insert(index, outcome);
    }

    (outcomes, stream_family_priorities, signal_cache)
}

/// Merge per-addon outcomes in declaration order, rank once against the
/// fixed inputs, and build the settled payload.
async fn merge_selector_outcomes(
    ctx: &SelectorFetchContext<'_>,
    stream_addons: &[(usize, &AddonConfig, u8)],
    mut outcomes: BTreeMap<usize, AddonStreamFetchOutcome>,
    mut stream_family_priorities: HashMap<String, u8>,
    mut signal_cache: StreamSignalCache,
) -> Result<StreamSelectorData, String> {
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
            source_summaries.push(StreamSourceSummary {
                id: addon.id.clone(),
                name: addon.name.clone(),
                status: StreamSourceStatus::Offline,
                stream_count: 0,
                latency_ms: None,
                error_message: Some("Source did not return a selector outcome.".to_string()),
            });
            continue;
        };

        let summary = summarize_addon_outcome(&outcome);
        if fatal_errors.len() < 3 {
            if let Some(error_message) = outcome.error_message.as_ref() {
                fatal_errors.push(error_message.clone());
            }
        }

        merge_unique_streams(&mut merged, &mut seen, outcome.streams);
        source_summaries.push(summary);
    }

    // The merged set moves through the ranking snapshot and comes back
    // ranked: the outer binding is consumed exactly once on each path.
    let streams = if merged.is_empty() {
        merged
    } else {
        // Families the progressive pass already scored are reused; a
        // non-channel caller finds them all missing and pays the same single
        // store read. Same tolerance as the progressive path: a wedged store
        // costs the merge its family signal, not the pool — unscored families
        // rank on the default.
        if let Err(error) = ensure_stream_family_priorities(
            ctx.app,
            ctx.playback_state,
            ctx.ranking,
            &merged,
            &mut stream_family_priorities,
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

    Ok(StreamSelectorData {
        fatal_error_message: if streams.is_empty() {
            build_fatal_stream_error(&fatal_errors)
        } else {
            None
        },
        source_summaries,
        streams,
        complete: true,
    })
}

pub(crate) async fn fetch_ranked_streams(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    provider: &AddonTransport,
    query: &StreamQueryRequest<'_>,
    ranking: &StreamRankingScope,
) -> Result<(Vec<AddonStream>, bool), String> {
    let (data, is_final_season) =
        fetch_stream_selector_data(app, playback_state, provider, query, ranking, None).await?;

    if data.streams.is_empty() {
        if let Some(error) = data.fatal_error_message {
            return Err(error);
        }
    }

    Ok((data.streams, is_final_season))
}

#[cfg(test)]
mod tests;
