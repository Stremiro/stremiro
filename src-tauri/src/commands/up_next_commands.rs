use super::calendar_commands::date_ordinal;
use super::media_commands::{fetch_media_schedules, MediaSchedule, MediaScheduleRequest};
use super::playback_state::PlaybackStateService;
use super::watch_history_commands::load_up_next_sources;
use super::WatchProgress;
use crate::providers::addon_resource::AddonResourceClient;
use serde::Serialize;
use std::collections::HashMap;
use tauri::{command, AppHandle, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpNextCandidate {
    pub(crate) row: WatchProgress,
    pub(crate) release_date: String,
}

pub(crate) fn build_up_next_entries(
    sources: Vec<WatchProgress>,
    schedules: Vec<MediaSchedule>,
    local_today: &str,
) -> Vec<UpNextCandidate> {
    let schedules_by_id: HashMap<_, _> = schedules
        .into_iter()
        .map(|schedule| (schedule.id.clone(), schedule))
        .collect();
    sources
        .into_iter()
        .filter_map(|mut source| {
            let season = source.absolute_season.or(source.season)?;
            let episode = source.absolute_episode.or(source.episode)?;
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
    Ok(build_up_next_entries(sources, schedules, &local_today))
}
