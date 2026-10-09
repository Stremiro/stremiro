use super::calendar_commands::date_ordinal;
use super::history_helpers::{watch_progress_absolute_episode, watch_progress_absolute_season};
use super::media_commands::{fetch_media_schedules, MediaSchedule, MediaScheduleRequest};
use super::playback_state::PlaybackStateService;
use super::watch_history_commands::load_up_next_sources;
use super::{now_unix_millis, WatchProgress};
use crate::providers::addon_resource::AddonResourceClient;
use serde::Serialize;
use std::collections::HashMap;
use tauri::{command, AppHandle, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpNextCandidate {
    pub(crate) row: WatchProgress,
    pub(crate) release_date: String,
    /// Aired within the past week and after the last watched timestamp — the
    /// "New episode" badge decision; the label vocabulary stays in the UI.
    pub(crate) is_new_episode: bool,
}

/// A successor episode badges "New episode" for a week past its air date.
const NEW_EPISODE_WINDOW_MS: u64 = 1000 * 60 * 60 * 24 * 7;
const MS_PER_DAY: u64 = 86_400_000;

pub(crate) fn build_up_next_entries(
    sources: Vec<WatchProgress>,
    schedules: Vec<MediaSchedule>,
    local_today: &str,
    local_today_ms: u64,
    now_ms: u64,
) -> Vec<UpNextCandidate> {
    let today_ordinal = date_ordinal(local_today);
    let schedules_by_id: HashMap<_, _> = schedules
        .into_iter()
        .map(|schedule| (schedule.id.clone(), schedule))
        .collect();
    sources
        .into_iter()
        .filter_map(|mut source| {
            let season = watch_progress_absolute_season(&source)?;
            let episode = watch_progress_absolute_episode(&source)?;
            let schedule = schedules_by_id.get(&source.id)?;
            let next = schedule
                .episodes
                .iter()
                .filter(|candidate| candidate.season != 0 || season == 0)
                .filter(|candidate| (candidate.season, candidate.episode) > (season, episode))
                .min_by_key(|candidate| (candidate.season, candidate.episode))?;
            // Choose by episode coordinates first: an unaired, undated or
            // malformed successor must not skip forward to a later aired one.
            let release_date = next
                .release_date
                .as_deref()
                .filter(|date| date_ordinal(date).is_some() && *date <= local_today)?;
            // Released-local-midnight on the epoch timeline: same day math the
            // card used, minus the per-row Date allocation. A daylight-saving
            // gap can skew the instant by an hour — harmless at badge scale.
            let release_ordinal = date_ordinal(release_date)?;
            let released_ms = today_ordinal.map_or(0, |today| {
                local_today_ms.saturating_add_signed(
                    (release_ordinal as i64 - today as i64) * MS_PER_DAY as i64,
                )
            });
            source.season = Some(next.season);
            source.episode = Some(next.episode);
            source.absolute_season = source.season;
            source.absolute_episode = source.episode;
            source.position = 0.0;
            source.duration = 0.0;
            source.stream_season = None;
            source.stream_episode = None;
            source.last_stream_format = None;
            source.last_stream_lookup_id = None;
            source.last_stream_key = None;
            source.resume_start_time = None;
            Some(UpNextCandidate {
                is_new_episode: now_ms.saturating_sub(released_ms) <= NEW_EPISODE_WINDOW_MS
                    && released_ms > source.last_watched,
                row: source,
                release_date: release_date.to_string(),
            })
        })
        .collect()
}

#[command]
pub async fn get_up_next_entries(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    client: State<'_, AddonResourceClient>,
    local_today: String,
    local_today_ms: u64,
) -> Result<Vec<UpNextCandidate>, String> {
    if date_ordinal(&local_today).is_none() {
        return Err("Invalid local schedule date.".to_string());
    }
    let sources = load_up_next_sources(&app, playback_state.inner()).await?;
    let requests = sources
        .iter()
        .map(|source| MediaScheduleRequest {
            media_type: source.type_.clone(),
            id: source.id.clone(),
        })
        .collect();
    let schedules = fetch_media_schedules(&app, client.inner(), requests).await?;
    Ok(build_up_next_entries(
        sources,
        schedules,
        &local_today,
        local_today_ms,
        now_unix_millis(),
    ))
}
