use super::media_commands::{fetch_media_schedules, MediaSchedule, MediaScheduleRequest};
use super::media_normalization::days_in_month;
use super::playback_state::PlaybackStateService;
use super::store_helpers::{load_library_map, load_watch_statuses_map};
use super::WatchProgress;
use crate::providers::{addon_resource::AddonResourceClient, MediaItem};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::{command, AppHandle, State};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarRange {
    visible_start: String,
    visible_end: String,
    upcoming_start: String,
    upcoming_end: String,
}

// Gregorian day ordinal, independent of UTC offsets and daylight saving.
// The caller sends local calendar dates, rather than timestamps.
pub(crate) fn date_ordinal(value: &str) -> Option<u32> {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        return None;
    }
    let year: u32 = value[..4].parse().ok()?;
    let month: u32 = value[5..7].parse().ok()?;
    let day: u32 = value[8..].parse().ok()?;
    if !(1..=days_in_month(year, month)?).contains(&day) {
        return None;
    }
    let before_year = year * 365 + year.div_ceil(4) - year.div_ceil(100) + year.div_ceil(400);
    let before_month: u32 = (1..month)
        .filter_map(|month| days_in_month(year, month))
        .sum();
    Some(before_year + before_month + day - 1)
}

impl CalendarRange {
    fn validate(&self) -> Result<(), String> {
        for (start, end, max_days) in [
            (&self.visible_start, &self.visible_end, 42),
            (&self.upcoming_start, &self.upcoming_end, 14),
        ] {
            let span = date_ordinal(start)
                .zip(date_ordinal(end))
                .and_then(|(start, end)| end.checked_sub(start));
            if span.is_none_or(|span| span >= max_days) {
                return Err("Invalid calendar date range.".to_string());
            }
        }
        Ok(())
    }

    fn contains(&self, date: &str) -> bool {
        (date >= self.visible_start.as_str() && date <= self.visible_end.as_str())
            || (date >= self.upcoming_start.as_str() && date <= self.upcoming_end.as_str())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarScheduleEvent {
    id: String,
    media_id: String,
    media_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    series_title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    season: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    episode: Option<u32>,
    release_date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    poster: Option<String>,
    #[serde(rename = "type")]
    type_: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSchedule {
    tracked_count: usize,
    events: Vec<CalendarScheduleEvent>,
}

fn calendar_requests(
    library: impl IntoIterator<Item = MediaItem>,
    history: Vec<WatchProgress>,
    statuses: &HashMap<String, String>,
) -> Vec<MediaScheduleRequest> {
    let mut requests = HashMap::new();
    for item in library {
        if matches!(item.type_.as_str(), "movie" | "series")
            && statuses
                .get(&item.id)
                .is_none_or(|status| status != "dropped")
        {
            requests.insert(
                (item.type_.clone(), item.id.clone()),
                MediaScheduleRequest {
                    media_type: item.type_,
                    id: item.id,
                },
            );
        }
    }
    // Calendar needs only identity and recency, so skip donor hydration,
    // source-health reads and the full history wire payload.
    let mut latest_by_id: HashMap<&str, &WatchProgress> = HashMap::new();
    for row in &history {
        if latest_by_id
            .get(row.id.as_str())
            .is_none_or(|existing| row.last_watched > existing.last_watched)
        {
            latest_by_id.insert(&row.id, row);
        }
    }
    for (id, status) in statuses {
        if status != "watching" {
            continue;
        }
        let Some(row) = latest_by_id.get(id.as_str()) else {
            continue;
        };
        let canonical_type = match row.type_.as_str() {
            "movie" => "movie",
            "series" | "anime" => "series",
            _ => continue,
        };
        requests.insert(
            (canonical_type.to_string(), row.id.clone()),
            MediaScheduleRequest {
                media_type: row.type_.clone(),
                id: row.id.clone(),
            },
        );
    }
    let mut requests: Vec<_> = requests.into_values().collect();
    requests.sort_by_cached_key(|request| format!("{}:{}", request.media_type, request.id));
    requests
}

fn calendar_events(
    schedules: Vec<MediaSchedule>,
    range: &CalendarRange,
) -> Vec<CalendarScheduleEvent> {
    let mut events = Vec::new();
    let mut seen = HashSet::new();
    for schedule in schedules {
        let is_movie = schedule.type_ == "movie";
        if is_movie {
            let Some(date) = schedule
                .release_date
                .as_deref()
                .and_then(|date| date.trim().get(..10))
            else {
                continue;
            };
            if date_ordinal(date).is_none()
                || !seen.insert(("movie", schedule.id.clone(), String::new()))
                || !range.contains(date)
            {
                continue;
            }
            events.push(CalendarScheduleEvent {
                id: schedule.id.clone(),
                media_id: schedule.id,
                media_type: schedule.type_,
                title: Some(schedule.title.clone()),
                series_title: schedule.title,
                season: None,
                episode: None,
                release_date: date.to_string(),
                poster: schedule.poster,
                type_: "movie",
            });
            continue;
        }
        for episode in schedule.episodes {
            let Some(date) = episode
                .release_date
                .as_deref()
                .and_then(|date| date.trim().get(..10))
            else {
                continue;
            };
            // Claim valid identities before filtering, preserving alias precedence.
            if date_ordinal(date).is_none()
                || !seen.insert(("episode", schedule.id.clone(), episode.id.clone()))
                || !range.contains(date)
            {
                continue;
            }
            events.push(CalendarScheduleEvent {
                id: episode.id,
                media_id: schedule.id.clone(),
                media_type: schedule.type_.clone(),
                title: episode.title,
                series_title: schedule.title.clone(),
                season: Some(episode.season),
                episode: Some(episode.episode),
                release_date: date.to_string(),
                poster: schedule.poster.clone(),
                type_: "episode",
            });
        }
    }
    events
}

#[command]
pub async fn get_calendar_events(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    client: State<'_, AddonResourceClient>,
    range: CalendarRange,
) -> Result<CalendarSchedule, String> {
    range.validate()?;
    let store_app = app.clone();
    let service = playback_state.inner().clone();
    let requests = super::run_blocking_store_op(move || {
        let library = load_library_map(&super::open_store(&store_app, super::LIBRARY_STORE_FILE)?)?;
        let statuses = load_watch_statuses_map(&super::open_store(
            &store_app,
            super::WATCH_STATUS_STORE_FILE,
        )?)?;
        let history = if statuses.values().any(|status| status == "watching") {
            service
                .load_resume_entries(&store_app)?
                .into_iter()
                .map(|(_, row)| row)
                .collect()
        } else {
            Vec::new()
        };
        Ok(calendar_requests(library.into_values(), history, &statuses))
    })
    .await?;
    let tracked_count = requests.len();
    let schedules = fetch_media_schedules(&app, client.inner(), requests).await?;
    Ok(CalendarSchedule {
        tracked_count,
        events: calendar_events(schedules, &range),
    })
}

#[cfg(test)]
mod tests {
    use super::super::media_commands::MediaScheduleEpisode;
    use super::*;
    use crate::test_helpers::{test_media_item, test_progress};

    fn range() -> CalendarRange {
        CalendarRange {
            visible_start: "2025-12-28".into(),
            visible_end: "2026-02-07".into(),
            upcoming_start: "2026-01-01".into(),
            upcoming_end: "2026-01-14".into(),
        }
    }

    #[test]
    fn calendar_ranges_validate_local_days_and_bound_both_windows() {
        assert!(range().validate().is_ok());
        assert!(date_ordinal("2024-02-29").is_some());
        assert!(date_ordinal("2025-02-29").is_none());
        assert!(date_ordinal("1900-02-29").is_none());
        assert!(date_ordinal("2000-02-29").is_some());
        assert!(date_ordinal("2026-01-01Z").is_none());
        assert_eq!(
            date_ordinal("2026-01-01").unwrap() - date_ordinal("2025-12-31").unwrap(),
            1
        );
        let mut invalid = range();
        invalid.visible_end = "2026-02-08".into();
        assert!(invalid.validate().is_err());
        invalid = range();
        invalid.upcoming_end = "2026-01-15".into();
        assert!(invalid.validate().is_err());
        invalid = range();
        invalid.upcoming_end = "2025-12-31".into();
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn calendar_requests_preserve_watching_alias_and_skip_dropped_titles() {
        let statuses = HashMap::from([
            ("tt123".into(), "watching".into()),
            ("ttdrop".into(), "dropped".into()),
            ("ttold".into(), "watched".into()),
        ]);
        let history = vec![
            WatchProgress {
                type_: "anime".into(),
                last_watched: 10,
                ..test_progress()
            },
            WatchProgress {
                type_: "series".into(),
                last_watched: 9,
                ..test_progress()
            },
            WatchProgress {
                id: "ttold".into(),
                type_: "series".into(),
                ..test_progress()
            },
        ];
        let requests = calendar_requests(
            vec![
                test_media_item("tt123", "series"),
                test_media_item("ttdrop", "series"),
                test_media_item("ttmovie", "movie"),
            ],
            history,
            &statuses,
        );
        assert_eq!(
            requests
                .iter()
                .map(|request| (request.media_type.as_str(), request.id.as_str()))
                .collect::<Vec<_>>(),
            vec![("anime", "tt123"), ("movie", "ttmovie")]
        );
    }

    #[test]
    fn calendar_events_keep_year_boundaries_dates_and_alias_precedence() {
        let episode = |id: &str, date: &str| MediaScheduleEpisode {
            id: id.into(),
            title: None,
            season: 1,
            episode: 1,
            release_date: Some(date.into()),
        };
        let schedule = |kind: &str, episodes| MediaSchedule {
            id: "tt123".into(),
            type_: kind.into(),
            title: "Series".into(),
            poster: None,
            release_date: None,
            episodes,
        };
        let events = calendar_events(
            vec![
                schedule(
                    "anime",
                    vec![
                        episode("outside", "2025-12-27"),
                        episode("valid", "2026-01-01T00:00:00Z"),
                        episode("bad", "2026-02-30"),
                        episode("edge", "2026-02-07"),
                    ],
                ),
                schedule(
                    "series",
                    vec![
                        episode("outside", "2026-01-02"),
                        episode("valid", "2026-01-01"),
                        episode("bad", "2026-01-02"),
                    ],
                ),
                MediaSchedule {
                    id: "ttmovie".into(),
                    type_: "movie".into(),
                    title: "Movie".into(),
                    poster: None,
                    release_date: Some("2025-12-31".into()),
                    episodes: vec![],
                },
            ],
            &range(),
        );
        assert_eq!(
            events
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec!["valid", "edge", "bad", "ttmovie"]
        );
        assert_eq!(events[0].release_date, "2026-01-01");
        assert_eq!(events[0].media_type, "anime");
        assert_eq!(events[2].media_type, "series");

        let other_month = CalendarRange {
            visible_start: "2025-10-01".into(),
            visible_end: "2025-10-31".into(),
            ..range()
        };
        assert!(other_month.validate().is_ok());
        let upcoming_only = calendar_events(
            vec![schedule("series", vec![episode("today", "2026-01-01")])],
            &other_month,
        );
        assert_eq!(upcoming_only.len(), 1);
        assert_eq!(upcoming_only[0].id, "today");
    }
}
