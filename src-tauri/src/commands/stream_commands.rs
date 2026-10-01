use super::{
    normalize_media_id, normalize_opaque_field, normalize_watch_progress_type, now_unix_millis,
    playback_state::{PlaybackStateService, PlaybackStreamOutcomeKind, StreamOutcomeReport},
    probe_pool::{
        is_probeable_stream, resolve_ranked_best_stream_candidate, PreferredStreamHint,
        StreamPoolQuery,
    },
    stream_fetcher::{fetch_stream_selector_data, StreamRankingOverrides, StreamSelectorData},
    stream_resolver::{missing_direct_url_message, BestResolvedStream},
    streaming_helpers::normalize_http_url,
};
use crate::operational_log::{field, log_warn};
use crate::providers::addons::AddonTransport;
use tauri::ipc::Channel;
use tauri::{command, AppHandle, State};

fn normalize_recovery_text(value: Option<String>) -> Option<String> {
    value.as_deref().and_then(normalize_opaque_field)
}

fn normalize_recovery_url(value: Option<String>) -> Option<String> {
    // Recovery URLs feed directly into the player without the probe's
    // landed-URL recheck: apply the shared fetchable-URL gate (scheme plus
    // embedded-credential and non-routable-target rejection) so a malicious
    // or stale recovery payload cannot aim libmpv at loopback, LAN, metadata
    // endpoints, or userinfo targets.
    value.and_then(|value| {
        let normalized = normalize_http_url(&value)?;
        if crate::providers::addon_resource::is_fetchable_http_url(&normalized) {
            Some(normalized)
        } else {
            None
        }
    })
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn get_stream_selector_data(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    provider: State<'_, AddonTransport>,
    on_progress: Channel<serde_json::Value>,
    emit_progress: Option<bool>,
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
        // Tauri channels can't be Option — keepalive callers pass a channel
        // they ignore and flip this off so snapshots aren't serialized at all.
        emit_progress.unwrap_or(true).then_some(&on_progress),
    )
    .await
    .map(|(data, _is_final_season)| data)
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
) -> Result<BestResolvedStream, String> {
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

    let mut streams = query
        .fetch_pool(&app, &playback_state, &addon_transport, &query.id)
        .await?;

    // `prepare_addon_streams` already dropped placeholders and rows with no
    // playable source during ingress; no second filter pass is needed here.
    if streams.is_empty() {
        return Err("No streams found for this content.".to_string());
    }

    // Best-stream plays direct http(s) only: non-http rows list in the
    // selector but have no probeable URL. Fail fast with the direct-link
    // guidance instead of the generic unable-to-resolve wall.
    streams.retain(is_probeable_stream);
    if streams.is_empty() {
        return Err(missing_direct_url_message().to_string());
    }

    let preferred_stream_key = preferred_stream_key.and_then(|key| normalize_opaque_field(&key));
    resolve_ranked_best_stream_candidate(
        streams,
        None,
        None,
        PreferredStreamHint {
            stream_key: preferred_stream_key.as_deref(),
            source_id: preferred_source_id.as_deref(),
            source_name: preferred_source_name.as_deref(),
            stream_family: preferred_stream_family.as_deref(),
        },
    )
    .await
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn recover_playback_stream(
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
    outcome: String,
    ranking_media_id: Option<String>,
    ranking_media_type: Option<String>,
    ranking_title: Option<String>,
    ranking_season: Option<u32>,
    ranking_episode: Option<u32>,
) -> Result<Option<BestResolvedStream>, String> {
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
    let normalized_id = query.id.clone();
    let normalized_media_type = query.media_type.clone();
    let normalized_history_type = normalize_watch_progress_type(&media_type)
        .ok_or_else(|| "Invalid media type for stream recovery.".to_string())?;
    let normalized_outcome = PlaybackStreamOutcomeKind::parse(&outcome)
        .ok_or_else(|| "Invalid playback stream outcome.".to_string())?;
    let failed_stream_url = normalize_recovery_url(failed_stream_url);
    let failed_source_id = normalize_recovery_text(failed_source_id);
    let failed_stream_family = normalize_recovery_text(failed_stream_family);
    let failed_stream_key = normalize_recovery_text(failed_stream_key);
    // Recovery must query the same ID space the initial resolve used: on
    // mapped titles (e.g. kitsu: -> tt…) the media id is not the id addons
    // index streams under, so fetching by `normalized_id` would find nothing.
    // The lookup id becomes the outbound stream-request path segment, so it
    // takes the same bound as the media id it may replace.
    let stream_lookup_id = stream_lookup_id.as_deref().and_then(normalize_media_id);
    let fetch_id = stream_lookup_id.unwrap_or_else(|| normalized_id.clone());

    // Store/file IO is blocking: the outcome snapshot runs on the blocking
    // pool, matching `report_playback_stream_outcome`. It is best-effort
    // telemetry detached from the failover path — awaited inline, a wedged
    // store would delay the re-resolve below by its full timeout.
    {
        let outcome_app = app.clone();
        let outcome_service = playback_state.inner().clone();
        let outcome_normalized_id = normalized_id.clone();
        tauri::async_runtime::spawn(async move {
            let outcome_result = super::run_blocking_store_op(move || {
                outcome_service.record_stream_outcome(
                    &outcome_app,
                    StreamOutcomeReport {
                        media_id: outcome_normalized_id,
                        media_type: normalized_history_type,
                        season: absolute_season,
                        episode: absolute_episode,
                        source_id: failed_source_id,
                        stream_family: failed_stream_family,
                        outcome: normalized_outcome,
                        timestamp_ms: now_unix_millis(),
                    },
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

    let streams = match query
        .fetch_pool(&app, &playback_state, &addon_transport, &fetch_id)
        .await
    {
        Ok(streams) => streams,
        Err(error) => {
            // Contract stays Ok(None) for compat; observability only.
            // Error text is a bounded summary, never a URL or header.
            let summary: String = error.chars().take(160).collect();
            log_warn(
                "stream-recovery",
                "recover_playback_stream",
                "fetch-failed",
                &[
                    field("media_type", &normalized_media_type),
                    field("media_id", &normalized_id),
                    field("outcome", &outcome),
                    field("error", &summary),
                ],
            );
            return Ok(None);
        }
    };

    // Streams arrived already filtered by `prepare_addon_streams` (no
    // placeholders, playable source required), so the pool can feed the
    // candidate fan-out directly.
    if streams.is_empty() {
        log_warn(
            "stream-recovery",
            "recover_playback_stream",
            "empty-pool",
            &[
                field("media_type", &normalized_media_type),
                field("media_id", &normalized_id),
                field("outcome", &outcome),
            ],
        );
        return Ok(None);
    }

    match resolve_ranked_best_stream_candidate(
        streams,
        failed_stream_key.as_deref(),
        failed_stream_url.as_deref(),
        PreferredStreamHint::default(),
    )
    .await
    {
        Ok(resolved) => Ok(Some(resolved)),
        Err(error) => {
            let summary: String = error.chars().take(160).collect();
            log_warn(
                "stream-recovery",
                "recover_playback_stream",
                "resolve-failed",
                &[
                    field("media_type", &normalized_media_type),
                    field("media_id", &normalized_id),
                    field("outcome", &outcome),
                    field("error", &summary),
                ],
            );
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests;
