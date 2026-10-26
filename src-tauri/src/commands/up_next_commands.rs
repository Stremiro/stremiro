use super::calendar_commands::date_ordinal;
use super::episode_navigation::coordinate_neighbours;
use super::history_helpers::{
    compare_continue_watching, is_series_like_watch_progress, resume_rows,
    watch_progress_absolute_episode, watch_progress_absolute_season,
};
use super::media_commands::{
    fetch_media_schedules_with_response_timeout, MediaSchedule, MediaScheduleRequest,
};
use super::playback_state::PlaybackStateService;
use super::store_helpers::load_watch_statuses_map;
use super::watch_history_commands::{
    annotate_watch_progress_list, build_continue_watching_entries, build_up_next_sources,
};
use super::{now_unix_millis, WatchProgress};
use crate::providers::addon_resource::AddonResourceClient;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{command, AppHandle, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpNextCandidate {
    pub(crate) row: WatchProgress,
    /// Aired within the past week and after the last watched timestamp — the
    /// "New episode" badge decision; the label vocabulary stays in the UI.
    pub(crate) is_new_episode: bool,
}

/// One merged home-rail row: `is_new_episode` present marks an Up Next row and
/// carries its badge flag; absent marks a continue-watching resume row.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeRailEntry<T = WatchProgress> {
    pub row: T,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_new_episode: Option<bool>,
}

/// A successor episode badges "New episode" for a week past its air date.
const NEW_EPISODE_WINDOW_MS: u64 = 1000 * 60 * 60 * 24 * 7;
const MS_PER_DAY: u64 = 86_400_000;
const UP_NEXT_SCHEDULE_RESPONSE_TIMEOUT: Duration = Duration::from_secs(8);

pub(crate) fn build_up_next_entries(
    sources: Vec<WatchProgress>,
    schedules: Vec<MediaSchedule>,
    local_today: &str,
    local_today_ms: u64,
    now_ms: u64,
) -> Vec<UpNextCandidate> {
    let today_ordinal = date_ordinal(local_today);
    let schedules_by_title: HashMap<(&str, &str), &MediaSchedule> = schedules
        .iter()
        .map(|schedule| ((schedule.type_.as_str(), schedule.id.as_str()), schedule))
        .collect();
    sources
        .into_iter()
        .filter_map(|mut source| {
            let season = watch_progress_absolute_season(&source)?;
            let episode = watch_progress_absolute_episode(&source)?;
            let schedule = schedules_by_title.get(&(source.type_.as_str(), source.id.as_str()))?;
            let (_, next) =
                coordinate_neighbours(schedule.episodes.iter(), (season, episode), |candidate| {
                    (candidate.season, candidate.episode)
                });
            let next = next?;
            // Choose by episode coordinates first: an unaired, undated or
            // malformed successor must not skip forward to a later aired one.
            let release_date = next.release_date.as_deref()?;
            let release_ordinal = date_ordinal(release_date)?;
            if release_date > local_today {
                return None;
            }
            // Released-local-midnight on the epoch timeline — same day math the card
            // used. A DST gap can skew the instant an hour; harmless at badge scale.
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
            source.is_watched = false;
            source.has_started_watching = false;
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
            })
        })
        .collect()
}

/// Up Next shares the resume ordering, including startup-stub demotion.
/// Ties keep continue-watching first; a resumable title never renders twice.
pub(crate) fn build_resume_rail(
    continue_watching: Vec<WatchProgress>,
    mut up_next: Vec<UpNextCandidate>,
) -> Vec<ResumeRailEntry> {
    let resumable: HashSet<(&str, &str)> = continue_watching
        .iter()
        .map(|row| (row.type_.as_str(), row.id.as_str()))
        .collect();
    up_next.retain(|candidate| {
        !resumable.contains(&(candidate.row.type_.as_str(), candidate.row.id.as_str()))
    });
    up_next.sort_by_key(|candidate| std::cmp::Reverse(candidate.row.last_watched));
    let capacity = continue_watching.len() + up_next.len();
    let mut up_next = up_next.into_iter().peekable();
    let mut rail = Vec::with_capacity(capacity);
    for row in continue_watching {
        while let Some(candidate) =
            up_next.next_if(|next| compare_continue_watching(&next.row, &row).is_lt())
        {
            rail.push(ResumeRailEntry {
                row: candidate.row,
                is_new_episode: Some(candidate.is_new_episode),
            });
        }
        rail.push(ResumeRailEntry {
            row,
            is_new_episode: None,
        });
    }
    rail.extend(up_next.map(|candidate| ResumeRailEntry {
        row: candidate.row,
        is_new_episode: Some(candidate.is_new_episode),
    }));
    rail
}

/// The home rail is one snapshot: both halves derive from the same loaded rows so
/// the merged order can't skew. The local continue-watching half ships over the
/// channel before the schedule fetch.
#[command]
pub async fn get_resume_rail(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    client: State<'_, AddonResourceClient>,
    local_today: String,
    local_today_ms: u64,
    on_progress: Channel<InvokeResponseBody>,
) -> Result<Vec<ResumeRailEntry>, String> {
    if date_ordinal(&local_today).is_none() || local_today_ms == 0 {
        return Err("Invalid local schedule date.".to_string());
    }
    let service = playback_state.inner().clone();
    let store_app = app.clone();
    let (continue_watching, sources) = super::run_blocking_store_op(move || {
        let rows = resume_rows(service.load_continue_watching_entries(&store_app)?);
        let continue_watching =
            annotate_watch_progress_list(build_continue_watching_entries(&rows));
        if !rows.iter().any(is_series_like_watch_progress) {
            return Ok((continue_watching, Vec::new()));
        }
        let statuses = match super::open_store(&store_app, super::WATCH_STATUS_STORE_FILE)
            .and_then(|store| load_watch_statuses_map(&store))
        {
            Ok(statuses) => statuses,
            Err(error) => {
                crate::operational_log::log_warn(
                    "resume-rail",
                    "load-watch-statuses",
                    "degraded",
                    &[crate::operational_log::field("error", error)],
                );
                return Ok((continue_watching, Vec::new()));
            }
        };
        let resumable: HashSet<(&str, &str)> = continue_watching
            .iter()
            .map(|row| (row.type_.as_str(), row.id.as_str()))
            .collect();
        let source_health_priorities = service.source_health_priorities_for_ids(
            &store_app,
            rows.iter()
                .filter(|row| {
                    is_series_like_watch_progress(row)
                        && !resumable.contains(&(row.type_.as_str(), row.id.as_str()))
                        && statuses
                            .get(&row.id)
                            .is_none_or(|status| status != "dropped")
                })
                .map(|row| row.source_id.as_deref()),
        );
        let sources = build_up_next_sources(
            rows,
            &statuses,
            &source_health_priorities,
            now_unix_millis(),
        );
        Ok((continue_watching, sources))
    })
    .await?;
    if sources.is_empty() {
        return Ok(build_resume_rail(continue_watching, Vec::new()));
    }
    if let Ok(snapshot) = serde_json::to_string(
        &continue_watching
            .iter()
            .map(|row| ResumeRailEntry {
                row,
                is_new_episode: None,
            })
            .collect::<Vec<_>>(),
    ) {
        let _ = on_progress.send(InvokeResponseBody::Json(snapshot));
    }
    let requests = sources
        .iter()
        .map(|source| MediaScheduleRequest {
            media_type: source.type_.clone(),
            id: source.id.clone(),
        })
        .collect();
    let schedules = fetch_media_schedules_with_response_timeout(
        &app,
        client.inner(),
        requests,
        Some(UP_NEXT_SCHEDULE_RESPONSE_TIMEOUT),
    )
    .await?;
    let up_next = build_up_next_entries(
        sources,
        schedules,
        &local_today,
        local_today_ms,
        now_unix_millis(),
    );
    Ok(build_resume_rail(continue_watching, up_next))
}
