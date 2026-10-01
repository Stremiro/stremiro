use super::playback_state::{PlaybackStateService, PlaybackStreamOutcomeKind, StreamOutcomeReport};
use super::{normalize_media_id, normalize_watch_progress_type, now_unix_millis};
use tauri::{command, AppHandle, State};

/// Stream identity fields (`source_id`, `stream_family`) feed the
/// source-health and family reputation snapshots; nothing else persists.
#[command]
#[allow(clippy::too_many_arguments)]
pub async fn report_playback_stream_outcome(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    id: String,
    type_: String,
    season: Option<u32>,
    episode: Option<u32>,
    source_id: Option<String>,
    stream_family: Option<String>,
    outcome: String,
) -> Result<(), String> {
    let normalized_id = normalize_media_id(&id)
        .ok_or_else(|| "Media ID is required for stream outcome reporting.".to_string())?;
    let normalized_type = normalize_watch_progress_type(&type_)
        .ok_or_else(|| "Invalid media type for stream outcome reporting.".to_string())?;
    let normalized_outcome = PlaybackStreamOutcomeKind::parse(&outcome)
        .ok_or_else(|| "Invalid playback stream outcome.".to_string())?;

    let app = app.clone();
    let service = playback_state.inner().clone();
    super::run_blocking_store_op(move || {
        service.record_stream_outcome(
            &app,
            StreamOutcomeReport {
                media_id: normalized_id,
                media_type: normalized_type,
                season,
                episode,
                source_id,
                stream_family,
                outcome: normalized_outcome,
                timestamp_ms: now_unix_millis(),
            },
        )
    })
    .await
}
