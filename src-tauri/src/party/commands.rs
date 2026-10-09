use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::commands::{
    playback_state::PlaybackStateService,
    probe_pool::StreamPoolQuery,
    resolved_content_key, stream_dedup_key,
    stream_fetcher::{fetch_stream_selector_data, StreamRankingOverrides},
};
use crate::providers::addons::AddonTransport;

use super::{
    protocol,
    room::{Operation, Report, Snapshot},
    sync::Correction,
    transport::Invite,
    PartyService,
};

#[tauri::command]
pub async fn party_create(
    app: AppHandle,
    service: State<'_, PartyService>,
    name: String,
) -> Result<Snapshot, String> {
    service.start(app, name.trim().to_string(), None).await
}

#[tauri::command]
pub async fn party_join(
    app: AppHandle,
    service: State<'_, PartyService>,
    name: String,
    invite: String,
) -> Result<Snapshot, String> {
    service
        .start(app, name.trim().to_string(), Some(Invite::parse(&invite)?))
        .await
}

#[tauri::command]
pub fn party_inspect_invite(invite: String) -> Result<(), String> {
    Invite::parse(&invite).map(|_| ())
}

#[tauri::command]
pub fn party_snapshot(service: State<'_, PartyService>) -> Snapshot {
    service.snapshots.borrow().clone()
}

#[tauri::command]
pub async fn party_invite(
    service: State<'_, PartyService>,
    session_id: String,
) -> Result<String, String> {
    let session = service.session.lock().await;
    service.require_current(&session_id)?;
    session
        .as_ref()
        .map(|s| s.invite.clone())
        .ok_or_else(|| "No active party.".into())
}

#[tauri::command]
pub async fn party_leave(
    service: State<'_, PartyService>,
    session_id: String,
) -> Result<(), String> {
    service.leave(&session_id).await
}

#[tauri::command]
pub async fn party_send_chat(
    service: State<'_, PartyService>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if !protocol::valid_text(&text, protocol::MAX_CHAT_CHARS) {
        return Err("Messages must be 1–500 characters of plain text.".into());
    }
    service.request(&session_id, Operation::Chat(text)).await
}

#[tauri::command]
pub async fn party_set_display_name(
    service: State<'_, PartyService>,
    session_id: String,
    name: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if !protocol::valid_name(&name) {
        return Err("Use a display name of 1–32 plain characters.".into());
    }
    service.request(&session_id, Operation::Name(name)).await
}

#[tauri::command]
pub async fn party_set_lock(
    service: State<'_, PartyService>,
    session_id: String,
    locked: bool,
) -> Result<(), String> {
    service.request(&session_id, Operation::Lock(locked)).await
}

/// Starts syncing; `share` makes local playback the next authority. Returns
/// the room's live position in milliseconds for launching the shared media.
#[tauri::command]
pub async fn party_follow(
    service: State<'_, PartyService>,
    session_id: String,
    share: bool,
) -> Result<Option<u64>, String> {
    service
        .ask(&session_id, |reply| Operation::Follow(share, reply))
        .await
}

#[tauri::command]
pub async fn party_report_playback(
    service: State<'_, PartyService>,
    session_id: String,
    mut report: Report,
) -> Result<Correction, String> {
    // Fingerprint the file rather than the addon-specific selector key, so a
    // member whose own addons serve the same file can match it.
    report.stream_key = report
        .stream_key
        .map(|key| resolved_content_key(&key).unwrap_or(key));
    service
        .ask(&session_id, |reply| Operation::Report(report, reply))
        .await?
}

/// `PlayerStreamRequest` mirror: the shared source's stream lookup arrives
/// as one typed payload instead of a webview-computed key list.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MatchStreamRequest {
    media_id: String,
    media_type: String,
    stream_lookup_id: Option<String>,
    stream_season: Option<u32>,
    stream_episode: Option<u32>,
    absolute_season: Option<u32>,
    absolute_episode: Option<u32>,
    title: Option<String>,
}

impl MatchStreamRequest {
    /// The addon lookup id drives the fetch; canonical identity and
    /// coordinates rank independently of it.
    pub(super) fn into_query(self) -> Result<StreamPoolQuery, String> {
        let fetch_id = self
            .stream_lookup_id
            .unwrap_or_else(|| self.media_id.clone());
        StreamPoolQuery::new(
            &self.media_type,
            &fetch_id,
            self.stream_season,
            self.stream_episode,
            self.absolute_episode,
            StreamRankingOverrides {
                media_type: Some(self.media_type.clone()),
                media_id: Some(self.media_id),
                title: self.title,
                season: self.absolute_season.or(self.stream_season),
                episode: self.absolute_episode.or(self.stream_episode),
            },
            "stream lookup",
        )
    }
}

/// Finds this device's candidate for the shared source by room-scoped digest:
/// the local pool is enumerated here so peers only ever see key digests.
#[tauri::command]
pub async fn party_match_stream(
    app: AppHandle,
    service: State<'_, PartyService>,
    playback_state: State<'_, PlaybackStateService>,
    provider: State<'_, AddonTransport>,
    session_id: String,
    request: MatchStreamRequest,
) -> Result<Option<String>, String> {
    service.require_current(&session_id)?;
    let query = request.into_query()?;
    // No progress channel, no budget: matching keeps the full selector waits.
    let (data, _) = fetch_stream_selector_data(
        &app,
        &playback_state,
        &provider,
        &query.request(&query.id),
        &query.ranking,
        None,
        None,
    )
    .await?;
    let candidates: Vec<(String, Option<String>)> = data
        .streams
        .into_iter()
        // Oversized keys cannot ride the room's packet bound — skip them
        // rather than failing the whole match, and skip before the dedup
        // digest work.
        .filter(|stream| stream.stream_key.len() <= protocol::MAX_STREAM_KEY)
        .take(512)
        .map(|stream| {
            let content_key = stream_dedup_key(&stream);
            (stream.stream_key, content_key)
        })
        .collect();
    // `ask` rechecks the session under the lock after the async fetch.
    service
        .ask(&session_id, |reply| Operation::Match(candidates, reply))
        .await
}
