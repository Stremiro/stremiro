use super::{
    normalize_media_id, normalize_opaque_field, normalize_watch_progress_type, now_unix_millis,
    playback_state::{PlaybackStateService, PlaybackStreamOutcomeKind, StreamOutcomeReport},
    probe_pool::{
        is_probeable_stream, resolve_ranked_best_stream_candidate, retain_unexcluded_streams,
        PreferredStreamHint, StreamPoolQuery,
    },
    stream_fetcher::{
        fetch_stream_for_link, fetch_stream_selector_data, ResolveFetch, StreamRankingOverrides,
        StreamSelectorData,
    },
    stream_resolver::{
        BestResolvedStream, ResolveStreamError, ResolveStreamErrorKind, MISSING_DIRECT_URL_MESSAGE,
    },
    streaming_helpers::normalize_http_url,
};
use crate::operational_log::{field, log_warn};
use crate::providers::addon_resource::{is_fetchable_http_url, is_magnet_url};
use crate::providers::addons::{AddonStream, AddonTransport};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{command, AppHandle, State};

/// A recovery chain fails over a handful of times at most; anything larger
/// is malformed input.
const RECOVERY_EXCLUDED_STREAM_KEYS_MAX: usize = 16;
const STREAM_LINK_CHANGED_MESSAGE: &str =
    "This stream changed — reopen the stream list and try again.";

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
    if !super::streaming_helpers::is_prepared_stream_key(&stream_key) {
        return Err(STREAM_LINK_CHANGED_MESSAGE.to_string());
    }
    let stream = fetch_stream_for_link(
        &app,
        &provider,
        &query.request(&query.id),
        &stream_key,
        source_id.as_deref(),
    )
    .await
    .map_err(|_| "Could not retrieve this stream link. Try again.".to_string())?
    .ok_or_else(|| STREAM_LINK_CHANGED_MESSAGE.to_string())?;
    stream_link(&stream)
}

fn normalize_recovery_text(value: Option<String>) -> Option<String> {
    value.as_deref().and_then(normalize_opaque_field)
}

fn normalize_recovery_url(value: Option<String>) -> Option<String> {
    // Recovery URLs feed the player without the probe's landed-URL recheck — apply
    // the shared fetchable-URL gate so a malicious/stale payload can't aim libmpv
    // at loopback, LAN, metadata, or userinfo targets.
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
) -> Result<BestResolvedStream, ResolveStreamError> {
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

    let preferred_stream_key = preferred_stream_key.and_then(|key| normalize_opaque_field(&key));
    let mut streams = query
        .fetch_pool(
            &app,
            &playback_state,
            &addon_transport,
            &query.id,
            ResolveFetch {
                settle_on_stream_key: preferred_stream_key.as_deref(),
            },
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

    // Best-stream plays direct http(s) only — non-http rows list in the selector
    // but have no probeable URL, so fail fast with the direct-link guidance.
    streams.retain(is_probeable_stream);
    if streams.is_empty() {
        return Err(ResolveStreamError::new(
            ResolveStreamErrorKind::NoDirectUrl,
            MISSING_DIRECT_URL_MESSAGE,
        ));
    }

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
    excluded_stream_keys: Option<Vec<String>>,
    outcome: String,
    ranking_media_id: Option<String>,
    ranking_media_type: Option<String>,
    ranking_title: Option<String>,
    ranking_season: Option<u32>,
    ranking_episode: Option<u32>,
) -> Result<Option<BestResolvedStream>, String> {
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
    let excluded_stream_keys: Vec<String> = excluded_stream_keys
        .unwrap_or_default()
        .iter()
        .take(RECOVERY_EXCLUDED_STREAM_KEYS_MAX)
        .filter_map(|key| normalize_opaque_field(key))
        .collect();
    // Recovery must query the same ID space the initial resolve used: on mapped
    // titles (kitsu: → tt…) the media id is not what addons index streams under.
    // The lookup id becomes the outbound path segment — same bound as the media id.
    let stream_lookup_id = stream_lookup_id.as_deref().and_then(normalize_media_id);
    let fetch_id = stream_lookup_id.unwrap_or_else(|| normalized_id.clone());

    // Blocking store/file IO on the blocking pool, matching `report_playback_stream_outcome`.
    // Best-effort telemetry — detached so a wedged store cannot delay the re-resolve.
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

    let mut streams = match query
        .fetch_pool(
            &app,
            &playback_state,
            &addon_transport,
            &fetch_id,
            ResolveFetch::default(),
        )
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

    // Streams arrive pre-filtered by `prepare_addon_streams`; only earlier
    // recovery-chain failures leave before the candidate fan-out.
    retain_unexcluded_streams(&mut streams, &excluded_stream_keys);
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
            let summary: String = error.message.chars().take(160).collect();
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
