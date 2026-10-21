use super::{
    config_store::{
        StreamSelectorBatch, StreamSelectorPreferences, StreamSelectorQuality, StreamSelectorSort,
        StreamSelectorSource,
    },
    js_trim, normalize_media_id, normalize_opaque_field, normalize_watch_progress_type,
    now_unix_millis,
    playback_state::{PlaybackStateService, PlaybackStreamOutcomeKind, StreamOutcomeReport},
    probe_pool::{
        is_probeable_stream, resolve_ranked_best_stream_candidate, PreferredStreamHint,
        ProbeRequestIdentity, StreamExclusions, StreamPoolQuery,
    },
    stream_fetcher::{
        fetch_stream_for_link, fetch_stream_selector_data, ResolveFetch, StreamRankingOverrides,
        StreamSelectorData,
    },
    stream_resolver::{
        BestResolvedStream, ResolveStreamError, ResolveStreamErrorKind, MISSING_DIRECT_URL_MESSAGE,
    },
    streaming_helpers::{is_prepared_stream_key, normalize_stream_key},
};
use crate::operational_log::{field, log_warn};
use crate::providers::addon_resource::{
    is_fetchable_http_url, is_magnet_url, parse_fetchable_http_url,
};
use crate::providers::addons::{AddonStream, AddonTransport, StreamPackCoverage};
use crate::providers::lock_or_recover;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{command, AppHandle, State};
use tokio::sync::watch;
use tokio::time::Instant;

/// A recovery chain fails over a handful of times at most; anything larger
/// is malformed input.
const RECOVERY_EXCLUDED_STREAM_KEYS_MAX: usize = 16;
const STREAM_RESOLVE_TIMEOUT: Duration = Duration::from_secs(30);
const STREAM_LINK_CHANGED_MESSAGE: &str =
    "This stream changed — reopen the stream list and try again.";
const PACK_EPISODES_MAX: usize = 2_000;
const PACK_COVERAGE_CLAIMS_MAX: usize = 2_000;
/// Shared by resolves and recoveries; one per open player/selector plus overlap.
const STREAM_REQUESTS_MAX: usize = 32;
const STREAM_EARLY_CANCELS_MAX: usize = 32;

#[derive(Default)]
pub(crate) struct StreamRequestRegistry {
    requests: Mutex<StreamRequests>,
}

#[derive(Default)]
struct StreamRequests {
    live: HashMap<String, watch::Sender<bool>>,
    early_cancels: VecDeque<String>,
}

struct StreamRequestGuard<'a> {
    registry: &'a StreamRequestRegistry,
    request_id: String,
}

fn validate_stream_request_id(request_id: &str) -> Result<(), String> {
    if request_id.is_empty()
        || request_id.len() > 64
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid stream request ID.".to_string());
    }
    Ok(())
}

impl StreamRequestRegistry {
    fn register(
        &self,
        request_id: String,
    ) -> Result<(StreamRequestGuard<'_>, watch::Receiver<bool>), String> {
        validate_stream_request_id(&request_id)?;
        let mut requests = lock_or_recover(&self.requests);
        if requests.live.len() >= STREAM_REQUESTS_MAX || requests.live.contains_key(&request_id) {
            return Err("Stream request limit reached or duplicate ID.".to_string());
        }
        let cancelled = requests
            .early_cancels
            .iter()
            .position(|id| id == &request_id)
            .and_then(|index| requests.early_cancels.remove(index))
            .is_some();
        let (sender, receiver) = watch::channel(cancelled);
        requests.live.insert(request_id.clone(), sender);
        Ok((
            StreamRequestGuard {
                registry: self,
                request_id,
            },
            receiver,
        ))
    }

    fn cancel(&self, request_id: String) -> Result<(), String> {
        validate_stream_request_id(&request_id)?;
        let mut requests = lock_or_recover(&self.requests);
        if let Some(sender) = requests.live.get(&request_id) {
            sender.send_replace(true);
        } else if !requests.early_cancels.contains(&request_id) {
            if requests.early_cancels.len() == STREAM_EARLY_CANCELS_MAX {
                requests.early_cancels.pop_front();
            }
            requests.early_cancels.push_back(request_id);
        }
        Ok(())
    }
}

impl Drop for StreamRequestGuard<'_> {
    fn drop(&mut self) {
        lock_or_recover(&self.registry.requests)
            .live
            .remove(&self.request_id);
    }
}

#[command]
pub fn cancel_stream_request(
    registry: State<'_, StreamRequestRegistry>,
    request_id: String,
) -> Result<(), String> {
    registry.cancel(request_id)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackEpisodeCoordinates {
    season: Option<u32>,
    episode: Option<u32>,
    stream_season: Option<u32>,
    stream_episode: Option<u32>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum StreamPackRow {
    Header {
        season: u32,
    },
    /// Index into the submitted episode list.
    Episode {
        index: u32,
    },
}

#[command]
pub fn get_stream_pack_rows(
    coverage: Option<StreamPackCoverage>,
    episodes: Vec<PackEpisodeCoordinates>,
) -> Result<Vec<StreamPackRow>, String> {
    if episodes.len() > PACK_EPISODES_MAX {
        return Err("Too many pack episodes.".to_string());
    }
    if coverage.as_ref().is_some_and(|coverage| {
        coverage.seasons.len() > PACK_COVERAGE_CLAIMS_MAX
            || coverage
                .episode_ranges
                .as_ref()
                .is_some_and(|ranges| ranges.len() > PACK_COVERAGE_CLAIMS_MAX)
    }) {
        return Err("Too many pack coverage claims.".to_string());
    }
    let covered: Vec<(u32, Option<u32>)> = episodes
        .iter()
        .enumerate()
        .filter_map(|(index, episode)| {
            coverage
                .as_ref()
                .is_none_or(|coverage| {
                    coverage.covers(
                        episode.stream_season.or(episode.season),
                        episode.stream_episode.or(episode.episode),
                    ) || coverage.covers(episode.season, episode.episode)
                })
                .then_some((index as u32, episode.season))
        })
        .collect();
    // Episodes arrive (season, episode)-sorted; headers mark each boundary only when seasons differ.
    let multi_season = covered
        .first()
        .is_some_and(|(_, first)| covered.iter().any(|(_, season)| season != first));
    let mut rows = Vec::with_capacity(covered.len());
    let mut last_season = None;
    for (index, season) in covered {
        if multi_season && season != last_season {
            if let Some(season) = season {
                rows.push(StreamPackRow::Header { season });
            }
            last_season = season;
        }
        rows.push(StreamPackRow::Episode { index });
    }
    Ok(rows)
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StreamLinkKind {
    Http,
    Magnet,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamLink {
    url: String,
    kind: StreamLinkKind,
}

fn validated_info_hash(hash: &str) -> Option<String> {
    if hash.len() == 40 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Some(hash.to_ascii_lowercase());
    }
    if hash.len() == 32
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic() || (b'2'..=b'7').contains(&byte))
    {
        return Some(hash.to_ascii_uppercase());
    }
    None
}

fn stream_link(stream: &AddonStream) -> Result<StreamLink, String> {
    if let Some(url) = stream.url.as_ref() {
        let kind = if is_fetchable_http_url(url) {
            Some(StreamLinkKind::Http)
        } else if is_magnet_url(url) {
            Some(StreamLinkKind::Magnet)
        } else {
            None
        };
        if let Some(kind) = kind {
            return Ok(StreamLink {
                url: url.clone(),
                kind,
            });
        }
    }
    let hash = stream
        .info_hash
        .as_deref()
        .and_then(validated_info_hash)
        .ok_or_else(|| "This stream has no shareable link.".to_string())?;
    let mut url = format!("magnet:?xt=urn:btih:{hash}");
    let name = stream
        .behavior_hints
        .as_ref()
        .and_then(|hints| hints.filename.as_deref())
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            stream
                .title
                .as_deref()
                .and_then(|title| title.lines().next())
        })
        .map(str::trim)
        .filter(|name| !name.is_empty());
    if let Some(name) = name {
        url.push_str("&dn=");
        url.push_str(&urlencoding::encode(name));
    }
    for tracker in stream
        .sources
        .iter()
        .filter_map(|source| source.strip_prefix("tracker:"))
    {
        url.push_str("&tr=");
        url.push_str(&urlencoding::encode(tracker));
    }
    Ok(StreamLink {
        url,
        kind: StreamLinkKind::Magnet,
    })
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn get_stream_link(
    app: AppHandle,
    provider: State<'_, AddonTransport>,
    media_type: String,
    id: String,
    season: Option<u32>,
    episode: Option<u32>,
    absolute_episode: Option<u32>,
    stream_key: String,
    source_id: Option<String>,
    ranking_media_id: Option<String>,
    ranking_media_type: Option<String>,
    ranking_title: Option<String>,
    ranking_season: Option<u32>,
    ranking_episode: Option<u32>,
) -> Result<StreamLink, String> {
    let query = StreamPoolQuery::new(
        &media_type,
        &id,
        season,
        episode,
        absolute_episode,
        StreamRankingOverrides {
            media_type: ranking_media_type,
            media_id: ranking_media_id,
            title: ranking_title,
            season: ranking_season,
            episode: ranking_episode,
        },
        "stream lookup",
    )?;
    let stream_key = normalize_stream_key(&stream_key)
        .filter(|key| is_prepared_stream_key(key))
        .ok_or_else(|| STREAM_LINK_CHANGED_MESSAGE.to_string())?;
    let stream = fetch_stream_for_link(
        &app,
        &provider,
        &query.request(&query.id),
        &query.ranking,
        &stream_key,
        source_id.as_deref(),
    )
    .await
    .map_err(|_| "Could not retrieve this stream link. Try again.".to_string())?
    .ok_or_else(|| STREAM_LINK_CHANGED_MESSAGE.to_string())?;
    stream_link(&stream)
}

fn normalize_recovery_url(value: Option<String>) -> Option<String> {
    // Recovery URLs feed the player without the probe's landed-URL recheck — apply
    // the shared fetchable-URL gate so a malicious/stale payload can't aim libmpv
    // at loopback, LAN, metadata, or userinfo targets.
    value
        .as_deref()
        .and_then(|value| parse_fetchable_http_url(value.trim()))
        .map(|parsed| parsed.to_string())
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn get_stream_selector_data(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    provider: State<'_, AddonTransport>,
    on_progress: Channel,
    media_type: String,
    id: String,
    season: Option<u32>,
    episode: Option<u32>,
    absolute_episode: Option<u32>,
    ranking_media_id: Option<String>,
    ranking_media_type: Option<String>,
    ranking_title: Option<String>,
    ranking_season: Option<u32>,
    ranking_episode: Option<u32>,
) -> Result<StreamSelectorData, String> {
    let query = StreamPoolQuery::new(
        &media_type,
        &id,
        season,
        episode,
        absolute_episode,
        StreamRankingOverrides {
            media_type: ranking_media_type,
            media_id: ranking_media_id,
            title: ranking_title,
            season: ranking_season,
            episode: ranking_episode,
        },
        "stream lookup",
    )?;

    fetch_stream_selector_data(
        &app,
        &playback_state,
        &provider,
        &query.request(&query.id),
        &query.ranking,
        Some(&on_progress),
        // Selector opens keep the full per-addon budgets.
        None,
        None,
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamSelectorRow {
    source_id: Option<String>,
    resolution: StreamSelectorQuality,
    delivery_kind: String,
    is_batch: bool,
    is_playable: bool,
    seeders: Option<u32>,
    size_bytes: Option<f64>,
    search_fields: Vec<Option<String>>,
}

#[command]
pub async fn get_stream_selector_indices(
    rows: Vec<StreamSelectorRow>,
    filters: StreamSelectorPreferences,
    search_query: String,
) -> Vec<usize> {
    let query = search_query.to_lowercase();
    let terms: Vec<&str> = query
        .split(|character: char| {
            character == '\u{feff}' || (character.is_whitespace() && character != '\u{85}')
        })
        .filter(|term| !term.is_empty())
        .collect();
    let mut search_text = String::new();
    let (mut playable, mut p2p): (Vec<usize>, Vec<usize>) = rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| {
            if (filters.quality != StreamSelectorQuality::All && row.resolution != filters.quality)
                || (filters.source == StreamSelectorSource::Cached && row.delivery_kind != "cached")
                || (filters.addon != "all" && row.source_id.as_deref() != Some(&filters.addon))
                || (filters.batch == StreamSelectorBatch::Episodes && row.is_batch)
                || (filters.batch == StreamSelectorBatch::Packs && !row.is_batch)
            {
                return None;
            }
            if !terms.is_empty() {
                search_text.clear();
                for field in &row.search_fields {
                    if let Some(field) = field {
                        search_text.push_str(match field.as_str() {
                            "Dolby Vision" => "Dolby Vision DV DoVi HDR",
                            _ => field,
                        });
                    }
                    search_text.push(' ');
                }
                let lowered = search_text.to_lowercase();
                if !terms.iter().all(|term| lowered.contains(term)) {
                    return None;
                }
            }
            Some(index)
        })
        .partition(|&index| rows[index].is_playable);
    let resolution_rank = |resolution| match resolution {
        StreamSelectorQuality::P2160 => 4,
        StreamSelectorQuality::P1080 => 3,
        StreamSelectorQuality::P720 => 2,
        StreamSelectorQuality::Sd => 1,
        StreamSelectorQuality::All => 0,
    };
    if filters.sort != StreamSelectorSort::Smart {
        let compare = |&left: &usize, &right: &usize| {
            let left = &rows[left];
            let right = &rows[right];
            match filters.sort {
                StreamSelectorSort::Smart => std::cmp::Ordering::Equal,
                StreamSelectorSort::Quality => resolution_rank(right.resolution)
                    .cmp(&resolution_rank(left.resolution))
                    .then_with(|| {
                        right
                            .size_bytes
                            .unwrap_or(0.0)
                            .total_cmp(&left.size_bytes.unwrap_or(0.0))
                    }),
                StreamSelectorSort::Seeds => {
                    right.seeders.unwrap_or(0).cmp(&left.seeders.unwrap_or(0))
                }
            }
        };
        // Stable ties retain the submitted backend order within each partition.
        playable.sort_by(compare);
        p2p.sort_by(compare);
    }
    playable.extend(p2p);
    playable
}

fn retain_unprobed_streams(streams: &mut Vec<AddonStream>, requests: &[ProbeRequestIdentity]) {
    if requests.is_empty() {
        return;
    }
    streams.retain(|stream| {
        !ProbeRequestIdentity::from_stream(stream)
            .is_some_and(|request| requests.contains(&request))
    });
}

fn preferred_probe_error(
    first: ResolveStreamError,
    fallback: ResolveStreamError,
) -> ResolveStreamError {
    if first.kind != ResolveStreamErrorKind::RateLimited
        && fallback.kind == ResolveStreamErrorKind::RateLimited
    {
        fallback
    } else {
        first
    }
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn resolve_best_stream(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    addon_transport: State<'_, AddonTransport>,
    media_type: String,
    id: String,
    season: Option<u32>,
    episode: Option<u32>,
    absolute_episode: Option<u32>,
    preferred_stream_key: Option<String>,
    preferred_source_id: Option<String>,
    preferred_source_name: Option<String>,
    preferred_stream_family: Option<String>,
    ranking_media_id: Option<String>,
    ranking_media_type: Option<String>,
    ranking_title: Option<String>,
    ranking_season: Option<u32>,
    ranking_episode: Option<u32>,
    registry: State<'_, StreamRequestRegistry>,
    request_id: Option<String>,
) -> Result<BestResolvedStream, ResolveStreamError> {
    // Probes run inside this future, so dropping it on cancel stops them.
    let work = async move {
        let deadline = Instant::now() + STREAM_RESOLVE_TIMEOUT;
        let query = StreamPoolQuery::new(
            &media_type,
            &id,
            season,
            episode,
            absolute_episode,
            StreamRankingOverrides {
                media_type: ranking_media_type,
                media_id: ranking_media_id,
                title: ranking_title,
                season: ranking_season,
                episode: ranking_episode,
            },
            "stream lookup",
        )?;

        let preferred_stream_key = preferred_stream_key.and_then(|key| normalize_stream_key(&key));
        let settled_early = AtomicBool::new(false);
        let streams = query
            .fetch_pool(
                &app,
                &playback_state,
                &addon_transport,
                &query.id,
                ResolveFetch {
                    settle_on_stream_key: preferred_stream_key.as_deref(),
                    settled_early: Some(&settled_early),
                    preferred_source_id: preferred_source_id.as_deref(),
                    ..ResolveFetch::default()
                },
                deadline,
            )
            .await?;

        // `prepare_addon_streams` already dropped placeholders and rows with no
        // playable source during ingress; no second filter pass is needed here.
        if streams.is_empty() {
            return Err(ResolveStreamError::new(
                ResolveStreamErrorKind::NoStreams,
                "No streams found for this content.",
            ));
        }

        // The fetcher already retains only probeable rows when any exist.
        if !streams.iter().any(is_probeable_stream) {
            return Err(ResolveStreamError::new(
                ResolveStreamErrorKind::NoDirectUrl,
                MISSING_DIRECT_URL_MESSAGE,
            ));
        }

        let preferred = PreferredStreamHint {
            stream_key: preferred_stream_key.as_deref(),
            source_id: preferred_source_id.as_deref(),
            source_name: preferred_source_name.as_deref(),
            stream_family: preferred_stream_family.as_deref(),
        };
        let retry_unrestricted = preferred_stream_key
            .as_deref()
            .filter(|_| settled_early.load(Ordering::Relaxed))
            .is_some_and(|key| streams.iter().any(|stream| stream.stream_key == key));
        let mut started_requests = Vec::new();
        let error = match resolve_ranked_best_stream_candidate(
            streams,
            None,
            None,
            preferred,
            deadline,
            retry_unrestricted.then_some(&mut started_requests),
        )
        .await
        {
            Ok(resolved) => return Ok(resolved),
            Err(error) => error,
        };
        if !retry_unrestricted || Instant::now() >= deadline {
            return Err(error);
        }

        // A preferred row can expire after listing; retry the unrestricted fan-out on the original budget.
        let Ok(mut streams) = query
            .fetch_pool(
                &app,
                &playback_state,
                &addon_transport,
                &query.id,
                ResolveFetch::default(),
                deadline,
            )
            .await
        else {
            return Err(error);
        };
        retain_unprobed_streams(&mut streams, &started_requests);
        streams.retain(is_probeable_stream);
        if streams.is_empty() {
            return Err(error);
        }
        resolve_ranked_best_stream_candidate(streams, None, None, preferred, deadline, None)
            .await
            .map_err(|fallback| preferred_probe_error(error, fallback))
    };
    let Some(request_id) = request_id else {
        return work.await;
    };
    let (_guard, mut cancellation) = registry.register(request_id)?;
    tokio::select! {
        biased;
        _ = cancellation.wait_for(|cancelled| *cancelled) => Err(ResolveStreamError::new(
            ResolveStreamErrorKind::Cancelled,
            "Stream resolve cancelled.",
        )),
        result = work => result,
    }
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn recover_playback_stream(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    addon_transport: State<'_, AddonTransport>,
    registry: State<'_, StreamRequestRegistry>,
    request_id: String,
    media_type: String,
    id: String,
    season: Option<u32>,
    episode: Option<u32>,
    absolute_season: Option<u32>,
    absolute_episode: Option<u32>,
    stream_lookup_id: Option<String>,
    failed_stream_url: Option<String>,
    failed_source_id: Option<String>,
    failed_stream_family: Option<String>,
    failed_stream_key: Option<String>,
    excluded_stream_keys: Option<Vec<String>>,
    outcome: String,
    ranking_media_id: Option<String>,
    ranking_media_type: Option<String>,
    ranking_title: Option<String>,
    ranking_season: Option<u32>,
    ranking_episode: Option<u32>,
) -> Result<Option<BestResolvedStream>, ResolveStreamError> {
    let (_guard, mut cancellation) = registry.register(request_id)?;
    // Work polls first: its first poll spawns the failed stream's outcome report,
    // which must land even when the cancel arrived before this command started.
    tokio::select! {
        biased;
        result = recover_playback_stream_work(
            app, playback_state, addon_transport, media_type, id, season, episode,
            absolute_season, absolute_episode, stream_lookup_id, failed_stream_url,
            failed_source_id, failed_stream_family, failed_stream_key, excluded_stream_keys,
            outcome, ranking_media_id, ranking_media_type, ranking_title, ranking_season,
            ranking_episode,
        ) => result.map_err(ResolveStreamError::from),
        _ = cancellation.wait_for(|cancelled| *cancelled) => Err(ResolveStreamError::new(
            ResolveStreamErrorKind::Cancelled,
            "Playback recovery cancelled.",
        )),
    }
}

#[allow(clippy::too_many_arguments)]
async fn recover_playback_stream_work(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    addon_transport: State<'_, AddonTransport>,
    media_type: String,
    id: String,
    season: Option<u32>,
    episode: Option<u32>,
    absolute_season: Option<u32>,
    absolute_episode: Option<u32>,
    stream_lookup_id: Option<String>,
    failed_stream_url: Option<String>,
    failed_source_id: Option<String>,
    failed_stream_family: Option<String>,
    failed_stream_key: Option<String>,
    excluded_stream_keys: Option<Vec<String>>,
    outcome: String,
    ranking_media_id: Option<String>,
    ranking_media_type: Option<String>,
    ranking_title: Option<String>,
    ranking_season: Option<u32>,
    ranking_episode: Option<u32>,
) -> Result<Option<BestResolvedStream>, String> {
    let recovery_started = Instant::now();
    let deadline = recovery_started + STREAM_RESOLVE_TIMEOUT;
    let expected_generation = playback_state.history_generation();
    let timestamp_ms = now_unix_millis();
    let query = StreamPoolQuery::new(
        &media_type,
        &id,
        season,
        episode,
        absolute_episode,
        StreamRankingOverrides {
            media_type: ranking_media_type,
            media_id: ranking_media_id,
            title: ranking_title,
            season: ranking_season,
            episode: ranking_episode,
        },
        "stream recovery",
    )?;
    let normalized_id = query.id.as_str();
    let normalized_media_type = query.media_type.as_str();
    let normalized_history_type = normalize_watch_progress_type(js_trim(&media_type))
        .ok_or_else(|| "Invalid media type for stream recovery.".to_string())?;
    let normalized_outcome = PlaybackStreamOutcomeKind::parse(&outcome)
        .ok_or_else(|| "Invalid playback stream outcome.".to_string())?;
    let failed_stream_url = normalize_recovery_url(failed_stream_url);
    let failed_source_id = failed_source_id.as_deref().and_then(normalize_opaque_field);
    let failed_stream_family = failed_stream_family
        .as_deref()
        .and_then(normalize_opaque_field);
    let failed_stream_key = failed_stream_key.and_then(|key| normalize_stream_key(&key));
    let excluded_stream_keys: Vec<String> = excluded_stream_keys
        .unwrap_or_default()
        .iter()
        .take(RECOVERY_EXCLUDED_STREAM_KEYS_MAX)
        .filter_map(|key| normalize_stream_key(key))
        .collect();
    // Recovery must query the same ID space the initial resolve used: on mapped
    // titles (kitsu: → tt…) the media id is not what addons index streams under.
    // The lookup id becomes the outbound path segment — same bound as the media id.
    let stream_lookup_id = stream_lookup_id.as_deref().and_then(normalize_media_id);
    let fetch_id = stream_lookup_id.as_deref().unwrap_or(normalized_id);

    // Blocking store/file IO on the blocking pool, matching `report_playback_stream_outcome`.
    // Best-effort telemetry — detached so a wedged store cannot delay the re-resolve.
    {
        let outcome_app = app.clone();
        let outcome_service = playback_state.inner().clone();
        let outcome_normalized_id = normalized_id.to_string();
        let outcome_source_id = failed_source_id.clone();
        let outcome_stream_family = failed_stream_family.clone();
        tauri::async_runtime::spawn(async move {
            let outcome_result = super::run_blocking_store_op(move || {
                outcome_service.record_stream_outcome(
                    &outcome_app,
                    StreamOutcomeReport {
                        media_id: outcome_normalized_id,
                        media_type: normalized_history_type,
                        season: absolute_season,
                        episode: absolute_episode,
                        source_id: outcome_source_id,
                        stream_family: outcome_stream_family,
                        outcome: normalized_outcome,
                        timestamp_ms,
                    },
                    expected_generation,
                )
            })
            .await;
            if let Err(error) = outcome_result {
                log_warn(
                    "stream-recovery",
                    "recover_playback_stream",
                    "outcome-persist-failed",
                    &[field("error", &error)],
                );
            }
        });
    }

    let exclusions = StreamExclusions::new(
        &excluded_stream_keys,
        failed_stream_key.as_deref(),
        failed_stream_url.as_deref(),
    );
    let mut recovery_fetch = ResolveFetch {
        exclusions: Some(&exclusions),
        ..ResolveFetch::default()
    };
    if !matches!(normalized_outcome, PlaybackStreamOutcomeKind::Verified) {
        recovery_fetch.failed_source_id = failed_source_id.as_deref();
        recovery_fetch.failed_stream_family = failed_stream_family.as_deref();
    }
    let warn_recovery = |event: &str, error: &str| {
        // Error text is a bounded summary, never a URL or header.
        let summary: String = error.chars().take(160).collect();
        log_warn(
            "stream-recovery",
            "recover_playback_stream",
            event,
            &[
                field("media_type", normalized_media_type),
                field("media_id", normalized_id),
                field("outcome", &outcome),
                field("error", &summary),
            ],
        );
    };
    loop {
        let refresh_claim = if recovery_fetch.not_before.is_some() {
            let refresh_key = format!(
                "{}|{}|{:?}|{:?}|{:?}",
                normalized_media_type,
                fetch_id,
                query.season,
                query.episode,
                query.absolute_episode
            );
            let Some(claim) = addon_transport.claim_stream_refresh(&refresh_key) else {
                return Ok(None);
            };
            Some(claim)
        } else {
            None
        };
        let fetched = query
            .fetch_pool(
                &app,
                &playback_state,
                &addon_transport,
                fetch_id,
                recovery_fetch,
                deadline,
            )
            .await;
        if let Some(claim) = refresh_claim {
            claim.complete();
        }
        let mut streams = match fetched {
            Ok(streams) => streams,
            Err(error) => {
                // Contract stays Ok(None) for compat; observability only.
                warn_recovery("fetch-failed", &error);
                return Ok(None);
            }
        };

        exclusions.retain(&mut streams);
        if streams.is_empty() {
            warn_recovery("empty-pool", "");
        } else {
            match resolve_ranked_best_stream_candidate(
                streams,
                failed_stream_key.as_deref(),
                failed_stream_url.as_deref(),
                PreferredStreamHint::default(),
                deadline,
                None,
            )
            .await
            {
                Ok(resolved) => return Ok(Some(resolved)),
                Err(error) => warn_recovery("resolve-failed", &error.message),
            }
        }

        if recovery_fetch.not_before.is_some()
            || matches!(normalized_outcome, PlaybackStreamOutcomeKind::Verified)
            || Instant::now() >= deadline
        {
            return Ok(None);
        }
        recovery_fetch.not_before = Some(recovery_started.into_std());
    }
}

#[cfg(test)]
mod tests;
