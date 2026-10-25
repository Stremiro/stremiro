use super::config_store::addon_configs_generation;
use super::media_commands::{fetch_media_schedules, MediaSchedule, MediaScheduleRequest};
use super::media_normalization::days_in_month;
use super::playback_state::PlaybackStateService;
use super::resume_store::ResumeTitleIdentity;
use super::store_helpers::{load_library_item_identities, load_watch_statuses_map};
use crate::providers::{addon_resource::AddonResourceClient, ttl_cache::TtlCache, MediaItem};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Range;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{command, ipc::Channel, AppHandle, State};

// List members usually overlap the library; one full list of headroom keeps
// list-only titles cached without sizing for every list at its cap.
const CALENDAR_SCHEDULE_CACHE_MAX_ENTRIES: usize = super::library_commands::MAX_LIBRARY_ITEMS
    + super::watch_status_commands::MAX_WATCH_STATUS_ITEMS
    + super::list_helpers::MAX_LIST_ITEMS;
const CALENDAR_SCHEDULE_CACHE_TTL: Duration = Duration::from_secs(30 * 60);

pub(crate) struct CalendarScheduleCache {
    entries: TtlCache<Arc<MediaSchedule>>,
    generation: AtomicU64,
}

impl Default for CalendarScheduleCache {
    fn default() -> Self {
        Self {
            entries: TtlCache::new(
                CALENDAR_SCHEDULE_CACHE_MAX_ENTRIES,
                CALENDAR_SCHEDULE_CACHE_TTL,
                CALENDAR_SCHEDULE_CACHE_TTL,
            ),
            generation: AtomicU64::new(0),
        }
    }
}

impl CalendarScheduleCache {
    pub(crate) fn clear_cache(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.entries.clear();
    }

    pub(crate) fn purge_expired(&self) {
        self.entries.purge_expired();
    }

    async fn fetch(
        &self,
        app: &AppHandle,
        client: &AddonResourceClient,
        requests: Vec<MediaScheduleRequest>,
        mut on_cached: impl FnMut(&[Arc<MediaSchedule>]),
    ) -> Result<Vec<Arc<MediaSchedule>>, String> {
        let generation = self.generation.load(Ordering::SeqCst);
        // Registry generation identifies the source URLs, order and capabilities.
        let source_generation = addon_configs_generation();
        let mut keys = Vec::with_capacity(requests.len());
        let mut schedules = HashMap::new();
        let mut missing = Vec::new();
        for mut request in requests {
            let Some(id) = super::normalize_media_id(&request.id) else {
                continue;
            };
            request.id = id;
            request.media_type = request.media_type.trim().to_string();
            let key = format!("{source_generation}:{}:{}", request.media_type, request.id);
            if let Some(schedule) = self.entries.get(&key) {
                schedules.insert(key.clone(), schedule);
            } else {
                missing.push(request);
            }
            keys.push(key);
        }
        if !missing.is_empty() {
            let cached: Vec<_> = keys
                .iter()
                .filter_map(|key| schedules.get(key).cloned())
                .collect();
            if !cached.is_empty() {
                on_cached(&cached);
            }
            let mut last_publish: Option<Instant> = None;
            if let Err(error) = fetch_media_schedules(app, client, missing, |fetched| {
                for schedule in fetched {
                    let key = format!("{source_generation}:{}:{}", schedule.type_, schedule.id);
                    let schedule = Arc::new(schedule);
                    self.entries.put(&key, schedule.clone(), false, || {
                        self.generation.load(Ordering::SeqCst) == generation
                            && addon_configs_generation() == source_generation
                    });
                    schedules.insert(key, schedule);
                }
                if last_publish.is_some_and(|last| last.elapsed() < Duration::from_millis(250)) {
                    return;
                }
                let snapshot: Vec<_> = keys
                    .iter()
                    .filter_map(|key| schedules.get(key).cloned())
                    .collect();
                on_cached(&snapshot);
                last_publish = Some(Instant::now());
            })
            .await
            {
                if schedules.is_empty() {
                    return Err(error);
                }
            }
        }
        Ok(keys
            .into_iter()
            .filter_map(|key| schedules.remove(&key))
            .collect())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarRange {
    visible_start: String,
    visible_end: String,
    upcoming_start: String,
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
    fn validate(&self) -> Result<Range<u32>, String> {
        let visible_span = date_ordinal(&self.visible_start)
            .zip(date_ordinal(&self.visible_end))
            .and_then(|(start, end)| end.checked_sub(start));
        let upcoming_start = visible_span
            .filter(|span| *span < 42)
            .and_then(|_| date_ordinal(&self.upcoming_start))
            .ok_or_else(|| "Invalid calendar date range.".to_string())?;
        Ok(upcoming_start..upcoming_start + 14)
    }

    fn contains(&self, date: &str, ordinal: u32, upcoming: &Range<u32>) -> bool {
        (date >= self.visible_start.as_str() && date <= self.visible_end.as_str())
            || upcoming.contains(&ordinal)
    }
}

fn contains_upcoming(date: &str, upcoming: &Range<u32>) -> bool {
    date_ordinal(date).is_some_and(|day| upcoming.contains(&day))
}

#[derive(Debug, Clone, Serialize)]
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

const MAX_UPCOMING_EVENTS: usize = 8;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarDay {
    date: String,
    events: Vec<CalendarScheduleEvent>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSchedule {
    tracked_count: usize,
    missing_count: usize,
    days: Vec<CalendarDay>,
    upcoming: Vec<CalendarScheduleEvent>,
}

fn calendar_requests(
    library: impl IntoIterator<Item = MediaItem>,
    history: Vec<ResumeTitleIdentity>,
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
    let mut latest_by_id: HashMap<&str, &ResumeTitleIdentity> = HashMap::new();
    for row in &history {
        latest_by_id
            .entry(row.id.as_str())
            .and_modify(|existing| {
                if row.last_watched > existing.last_watched {
                    *existing = row;
                }
            })
            .or_insert(row);
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
    requests
        .sort_by(|left, right| (&left.media_type, &left.id).cmp(&(&right.media_type, &right.id)));
    requests
}

fn calendar_event_date<'a>(
    release_date: Option<&'a str>,
    range: &CalendarRange,
    upcoming: &Range<u32>,
) -> Option<&'a str> {
    let date = release_date?.trim().get(..10)?;
    let ordinal = date_ordinal(date)?;
    range.contains(date, ordinal, upcoming).then_some(date)
}

fn calendar_events<'a>(
    schedules: impl IntoIterator<Item = &'a MediaSchedule>,
    range: &CalendarRange,
    upcoming: &Range<u32>,
) -> Vec<CalendarScheduleEvent> {
    let mut events = Vec::new();
    let mut seen = HashSet::new();
    for schedule in schedules {
        let is_movie = schedule.type_ == "movie";
        if is_movie {
            let Some(date) = calendar_event_date(schedule.release_date.as_deref(), range, upcoming)
            else {
                continue;
            };
            if !seen.insert(("movie", schedule.id.as_str(), "", 0, 0)) {
                continue;
            }
            events.push(CalendarScheduleEvent {
                id: schedule.id.clone(),
                media_id: schedule.id.clone(),
                media_type: schedule.type_.clone(),
                title: Some(schedule.title.clone()),
                series_title: schedule.title.clone(),
                season: None,
                episode: None,
                release_date: date.to_string(),
                poster: schedule.poster.clone(),
                type_: "movie",
            });
            continue;
        }
        for episode in &schedule.episodes {
            let Some(date) = calendar_event_date(episode.release_date.as_deref(), range, upcoming)
            else {
                continue;
            };
            if !seen.insert((
                "episode",
                schedule.id.as_str(),
                episode.id.as_str(),
                episode.season,
                episode.episode,
            )) {
                continue;
            }
            events.push(CalendarScheduleEvent {
                id: episode.id.clone(),
                media_id: schedule.id.clone(),
                media_type: schedule.type_.clone(),
                title: Some(
                    episode
                        .title
                        .as_deref()
                        .map(str::trim)
                        .filter(|title| !title.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("Episode {}", episode.episode)),
                ),
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

fn calendar_schedule(
    tracked_count: usize,
    missing_count: usize,
    events: Vec<CalendarScheduleEvent>,
    upcoming: &Range<u32>,
) -> CalendarSchedule {
    // `release_date` is a validated `YYYY-MM-DD` local day.
    let mut upcoming: Vec<_> = events
        .iter()
        .filter(|event| contains_upcoming(&event.release_date, upcoming))
        .collect();
    upcoming.sort_by(|left, right| left.release_date.cmp(&right.release_date));
    let upcoming = upcoming
        .into_iter()
        .take(MAX_UPCOMING_EVENTS)
        .cloned()
        .collect();
    let mut days: BTreeMap<String, Vec<CalendarScheduleEvent>> = BTreeMap::new();
    for event in events {
        days.entry(event.release_date.clone())
            .or_default()
            .push(event);
    }
    CalendarSchedule {
        tracked_count,
        missing_count,
        days: days
            .into_iter()
            .map(|(date, mut events)| {
                // Episodes first (season, episode), then movies by title.
                events.sort_by_cached_key(|event| {
                    (
                        event.type_ != "episode",
                        event.season.unwrap_or(0),
                        event.episode.unwrap_or(0),
                        event.series_title.to_lowercase(),
                    )
                });
                CalendarDay { date, events }
            })
            .collect(),
        upcoming,
    }
}

#[command]
pub async fn get_calendar_events(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    client: State<'_, AddonResourceClient>,
    cache: State<'_, CalendarScheduleCache>,
    range: CalendarRange,
    on_cached: Channel<CalendarSchedule>,
) -> Result<CalendarSchedule, String> {
    let upcoming = range.validate()?;
    let store_app = app.clone();
    let service = playback_state.inner().clone();
    let requests = super::run_blocking_store_op(move || {
        let library = load_library_item_identities(&super::open_store(
            &store_app,
            super::LIBRARY_STORE_FILE,
        )?)?;
        let statuses = load_watch_statuses_map(&super::open_store(
            &store_app,
            super::WATCH_STATUS_STORE_FILE,
        )?)?;
        let list_items = super::list_commands::read_list_item_identities(&super::open_store(
            &store_app,
            super::LISTS_STORE_FILE,
        )?)?;
        let watching_ids: Vec<_> = statuses
            .iter()
            .filter_map(|(id, status)| (status == "watching").then_some(id.as_str()))
            .collect();
        let history = service.load_latest_resume_title_identities(&store_app, &watching_ids)?;
        let tracked = library.into_iter().chain(list_items);
        Ok(calendar_requests(tracked, history, &statuses))
    })
    .await?;
    let tracked_count = requests.len();
    let schedules = cache
        .fetch(&app, client.inner(), requests, |cached| {
            let _ = on_cached.send(calendar_schedule(
                tracked_count,
                tracked_count.saturating_sub(cached.len()),
                calendar_events(cached.iter().map(Arc::as_ref), &range, &upcoming),
                &upcoming,
            ));
        })
        .await?;
    Ok(calendar_schedule(
        tracked_count,
        tracked_count.saturating_sub(schedules.len()),
        calendar_events(schedules.iter().map(Arc::as_ref), &range, &upcoming),
        &upcoming,
    ))
}

#[cfg(test)]
mod tests {
    use super::super::media_commands::MediaScheduleEpisode;
    use super::*;
    use crate::test_helpers::{test_media_item, test_store};

    fn range() -> CalendarRange {
        CalendarRange {
            visible_start: "2025-12-28".into(),
            visible_end: "2026-02-07".into(),
            upcoming_start: "2026-01-01".into(),
        }
    }

    #[test]
    fn calendar_ranges_validate_local_days_and_derive_upcoming_window() {
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
        invalid.upcoming_start = "2026-02-30".into();
        assert!(invalid.validate().is_err());
        for (start, end, after) in [
            ("2026-01-01", "2026-01-14", "2026-01-15"),
            ("2025-12-28", "2026-01-10", "2026-01-11"),
            ("2024-02-23", "2024-03-07", "2024-03-08"),
            ("2026-03-01", "2026-03-14", "2026-03-15"),
            ("2026-10-25", "2026-11-07", "2026-11-08"),
        ] {
            let range = CalendarRange {
                upcoming_start: start.into(),
                ..range()
            };
            let upcoming = range.validate().unwrap();
            assert!(contains_upcoming(start, &upcoming));
            assert!(contains_upcoming(end, &upcoming));
            assert!(!contains_upcoming(after, &upcoming));
            assert!(!contains_upcoming("2025-12-27", &upcoming));
        }
    }

    #[test]
    fn calendar_requests_dedupe_library_and_list_members_and_skip_dropped_titles() {
        let statuses = HashMap::from([("ttdrop".into(), "dropped".into())]);
        let requests = calendar_requests(
            vec![
                test_media_item("ttshared", "series"),
                test_media_item("ttlist", "series"),
                test_media_item("ttshared", "series"),
                test_media_item("ttdrop", "movie"),
                test_media_item("ttchannel", "channel"),
            ],
            Vec::new(),
            &statuses,
        );
        assert_eq!(
            requests
                .iter()
                .map(|request| (request.media_type.as_str(), request.id.as_str()))
                .collect::<Vec<_>>(),
            vec![("series", "ttlist"), ("series", "ttshared")]
        );
    }

    #[test]
    fn calendar_reads_normalized_list_only_titles_and_repairs_membership() {
        use super::super::list_helpers::{list_item_store_key, list_meta_key, LISTS_ORDER_KEY};
        use serde_json::json;

        let fixture = test_store();
        fixture
            .store
            .set(LISTS_ORDER_KEY, json!(["list_a", "ghost"]));
        fixture.store.set(
            list_meta_key("list_a"),
            json!({
                "id": "drifted", "name": "List only", "icon": "star",
                "item_ids": ["a", "b", "duplicate", "invalid", "absent"],
            }),
        );
        for (key, id, media_type) in [
            ("a", " b ", " Series "),
            ("b", " a ", " Movie "),
            ("duplicate", "b", "series"),
        ] {
            fixture.store.set(
                list_item_store_key("list_a", key),
                json!(MediaItem {
                    description: Some(format!("Snapshot for {key}")),
                    ..test_media_item(id, media_type)
                }),
            );
        }
        fixture.store.set(
            list_item_store_key("list_a", "invalid"),
            json!({"id": "bad", "title": "Bad snapshot", "type": "series", "poster": 42}),
        );
        fixture.store.save().unwrap();
        let library = load_library_item_identities(&fixture.store).unwrap();
        assert!(library.is_empty());
        let identities =
            super::super::list_commands::read_list_item_identities(&fixture.store).unwrap();
        assert!(identities.iter().all(|item| item.description.is_none()));
        let requests = calendar_requests(
            library.into_iter().chain(identities),
            Vec::new(),
            &HashMap::new(),
        );
        assert_eq!(
            requests
                .iter()
                .map(|request| (request.media_type.as_str(), request.id.as_str()))
                .collect::<Vec<_>>(),
            [("movie", "a"), ("series", "b")]
        );
        let list = super::super::list_helpers::load_list(&fixture.store, "list_a").unwrap();
        assert_eq!(list.id, "list_a");
        assert_eq!(list.item_ids, ["b", "a"]);
        for id in ["duplicate", "invalid", "absent"] {
            assert!(fixture
                .store
                .get(list_item_store_key("list_a", id))
                .is_none());
        }
        assert_eq!(fixture.store.get(LISTS_ORDER_KEY), Some(json!(["list_a"])));
        assert_eq!(fixture.store.save_count(), 2);

        let reopened = super::super::DurableStoreRegistry::default()
            .open_path(fixture.path.clone())
            .unwrap();
        let saved = super::super::list_commands::read_lists(&reopened).unwrap();
        assert_eq!(saved[0].item_ids, ["b", "a"]);
        assert_eq!(
            saved[0].items[0].description.as_deref(),
            Some("Snapshot for a")
        );
        assert_eq!(
            saved[0].items[1].description.as_deref(),
            Some("Snapshot for b")
        );
        assert_eq!(
            super::super::list_commands::read_list_item_identities(&reopened)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(reopened.save_count(), 0);
    }

    #[test]
    fn calendar_requests_preserve_watching_alias_and_skip_dropped_titles() {
        let statuses = HashMap::from([
            ("tt123".into(), "watching".into()),
            ("ttdrop".into(), "dropped".into()),
            ("ttold".into(), "watched".into()),
        ]);
        let history = vec![
            ResumeTitleIdentity {
                id: "tt123".into(),
                type_: "anime".into(),
                last_watched: 10,
            },
            ResumeTitleIdentity {
                id: "tt123".into(),
                type_: "series".into(),
                last_watched: 9,
            },
            ResumeTitleIdentity {
                id: "tt123".into(),
                type_: "series".into(),
                last_watched: 10,
            },
            ResumeTitleIdentity {
                id: "ttold".into(),
                type_: "series".into(),
                last_watched: 0,
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
            &[
                schedule(
                    "anime",
                    vec![
                        episode("outside", "2025-12-27"),
                        episode("valid", "2026-01-01T00:00:00Z"),
                        episode("bad", "2026-02-30"),
                        episode("edge", "2026-02-07"),
                        episode("reused", "2025-12-27"),
                        episode("reused", "2026-01-01"),
                        MediaScheduleEpisode {
                            episode: 2,
                            ..episode("reused", "2026-01-02")
                        },
                        MediaScheduleEpisode {
                            season: 2,
                            ..episode("reused", "2026-01-03")
                        },
                    ],
                ),
                schedule(
                    "series",
                    vec![
                        episode("outside", "2026-01-02"),
                        episode("valid", "2026-01-01"),
                        episode("bad", "2026-01-02"),
                        episode("reused", "2026-01-04"),
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
            &range().validate().unwrap(),
        );
        assert_eq!(
            events
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec!["valid", "edge", "reused", "reused", "reused", "outside", "bad", "ttmovie"]
        );
        assert_eq!(events[0].release_date, "2026-01-01");
        assert_eq!(events[0].media_type, "anime");
        assert_eq!(events[2].release_date, "2026-01-01");
        assert_eq!(events[2].media_type, "anime");
        assert_eq!(events[5].media_type, "series");
        assert_eq!(
            events
                .iter()
                .filter(|event| event.id == "reused")
                .map(|event| (event.season, event.episode))
                .collect::<Vec<_>>(),
            vec![(Some(1), Some(1)), (Some(1), Some(2)), (Some(2), Some(1))]
        );

        let other_month = CalendarRange {
            visible_start: "2025-10-01".into(),
            visible_end: "2025-10-31".into(),
            ..range()
        };
        assert!(other_month.validate().is_ok());
        let upcoming_only = calendar_events(
            &[schedule("series", vec![episode("today", "2026-01-01")])],
            &other_month,
            &other_month.validate().unwrap(),
        );
        assert_eq!(upcoming_only.len(), 1);
        assert_eq!(upcoming_only[0].id, "today");
    }

    #[test]
    fn calendar_events_normalize_missing_blank_and_padded_episode_titles() {
        let episodes = [None, Some(""), Some(" \t\n "), Some("  Finale  ")]
            .into_iter()
            .enumerate()
            .map(|(index, title)| MediaScheduleEpisode {
                id: format!("episode-{index}"),
                title: title.map(str::to_string),
                season: 2,
                episode: index as u32 + 1,
                release_date: Some("2026-01-01".into()),
            })
            .collect();
        let events = calendar_events(
            &[MediaSchedule {
                id: "tt123".into(),
                type_: "series".into(),
                title: "Series".into(),
                poster: None,
                release_date: None,
                episodes,
            }],
            &range(),
            &range().validate().unwrap(),
        );
        assert_eq!(
            events
                .iter()
                .map(|event| event.title.as_deref())
                .collect::<Vec<_>>(),
            [
                Some("Episode 1"),
                Some("Episode 2"),
                Some("Episode 3"),
                Some("Finale")
            ]
        );
    }

    fn event(
        id: &str,
        type_: &'static str,
        date: &str,
        season: Option<u32>,
        episode: Option<u32>,
        series: &str,
    ) -> CalendarScheduleEvent {
        CalendarScheduleEvent {
            id: id.into(),
            media_id: "tt1".into(),
            media_type: "series".into(),
            title: None,
            series_title: series.into(),
            season,
            episode,
            release_date: date.into(),
            poster: None,
            type_,
        }
    }

    #[test]
    fn calendar_schedule_groups_by_day_and_orders_events_within_it() {
        let schedule = calendar_schedule(
            3,
            2,
            vec![
                event("m-beta", "movie", "2026-01-02", None, None, "beta"),
                event("s1e3", "episode", "2026-01-02", Some(1), Some(3), "Show"),
                event("s2e1", "episode", "2026-01-02", Some(2), Some(1), "Show"),
                event("s1e1", "episode", "2026-01-02", Some(1), Some(1), "Show"),
                event("m-alpha", "movie", "2026-01-02", None, None, "Alpha"),
                event("prev", "episode", "2026-01-01", Some(9), Some(9), "Show"),
            ],
            &range().validate().unwrap(),
        );
        let serialized = serde_json::to_value(&schedule).unwrap();
        assert_eq!(serialized["trackedCount"], 3);
        assert_eq!(serialized["missingCount"], 2);
        assert_eq!(
            schedule
                .days
                .iter()
                .map(|day| day.date.as_str())
                .collect::<Vec<_>>(),
            vec!["2026-01-01", "2026-01-02"]
        );
        assert_eq!(
            schedule.days[1]
                .events
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec!["s1e1", "s1e3", "s2e1", "m-alpha", "m-beta"]
        );
    }

    #[test]
    fn calendar_schedule_upcoming_bounds_cap_and_within_day_stability() {
        let mut events: Vec<_> = (1..=9)
            .rev()
            .map(|episode| {
                event(
                    &format!("e{episode}"),
                    "episode",
                    "2026-01-05",
                    Some(1),
                    Some(episode),
                    "Show",
                )
            })
            .collect();
        events.extend([
            event("first", "episode", "2026-01-02", Some(1), Some(1), "Show"),
            event("edge", "episode", "2026-01-14", Some(1), Some(1), "Show"),
            event("before", "episode", "2025-12-31", Some(1), Some(1), "Show"),
            event("after", "episode", "2026-01-15", Some(1), Some(1), "Show"),
        ]);
        let schedule = calendar_schedule(0, 0, events, &range().validate().unwrap());
        assert_eq!(
            schedule
                .upcoming
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "e9", "e8", "e7", "e6", "e5", "e4", "e3"]
        );
    }

    #[test]
    fn calendar_schedule_lexical_dates_match_ordinals_across_year_boundary() {
        let range = CalendarRange {
            visible_start: "2025-12-28".into(),
            visible_end: "2026-01-07".into(),
            upcoming_start: "2025-12-28".into(),
        };
        let events = vec![
            event("later", "movie", "2026-01-07", None, None, "Later"),
            event("new-year", "movie", "2026-01-01", None, None, "New"),
            event("early", "movie", "2025-12-28", None, None, "Early"),
            event("year-end", "movie", "2025-12-31", None, None, "End"),
            event("same-day", "movie", "2026-01-01", None, None, "Same"),
        ];
        let mut expected = events.clone();
        expected.sort_by_key(|event| date_ordinal(&event.release_date));
        let schedule = calendar_schedule(0, 0, events, &range.validate().unwrap());
        assert_eq!(
            schedule
                .upcoming
                .iter()
                .map(|event| &event.id)
                .collect::<Vec<_>>(),
            expected.iter().map(|event| &event.id).collect::<Vec<_>>()
        );
    }
}
