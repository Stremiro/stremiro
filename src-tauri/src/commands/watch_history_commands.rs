use super::history_helpers::{
    build_history_key, choose_entry, choose_up_next_source, compare_continue_watching,
    continue_watching_candidates, hydrate_watch_progress_lookup_id, is_series_like_watch_progress,
    merge_watch_progress_donors, normalize_episode_coordinate, prepare_live_watch_progress,
    resume_rows, sanitize_watch_progress, watch_progress_absolute_episode,
    watch_progress_absolute_season, with_progress_annotations, HistoryEntryQuery,
};
use super::playback_state::PlaybackStateService;
use super::resume_store::{HistoryMergeError, MAX_RESUME_TOTAL_ENTRIES};
use super::{normalize_media_id, normalize_watch_progress_type, now_unix_millis, WatchProgress};
use crate::providers::MediaItem;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use tauri::{command, AppHandle, State};

/// Loads rows and source-health priorities in one store operation.
pub(super) async fn load_entries_with_source_health<F>(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    load: F,
) -> Result<(Vec<WatchProgress>, HashMap<String, u8>), String>
where
    F: FnOnce(&PlaybackStateService, &AppHandle) -> Result<Vec<(String, WatchProgress)>, String>
        + Send
        + 'static,
{
    let app = app.clone();
    let service = playback_state.clone();
    super::run_blocking_store_op(move || {
        entries_with_source_health(&app, &service, load(&service, &app)?)
    })
    .await
}

fn entries_with_source_health(
    app: &AppHandle,
    service: &PlaybackStateService,
    entries: Vec<(String, WatchProgress)>,
) -> Result<(Vec<WatchProgress>, HashMap<String, u8>), String> {
    let items = resume_rows(entries);
    let priorities = service.source_health_priorities_for_ids(
        app,
        items
            .iter()
            .filter(|item| is_series_like_watch_progress(item))
            .map(|item| item.source_id.as_deref()),
    )?;
    Ok((items, priorities))
}

/// Loads rows without reading source health.
pub(super) async fn load_resume_rows<F>(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    load: F,
) -> Result<Vec<WatchProgress>, String>
where
    F: FnOnce(&PlaybackStateService, &AppHandle) -> Result<Vec<(String, WatchProgress)>, String>
        + Send
        + 'static,
{
    let app = app.clone();
    let service = playback_state.clone();
    super::run_blocking_store_op(move || load(&service, &app).map(resume_rows)).await
}

/// Preserves first-seen title order so stable sorts retain loader recency ties.
fn group_watch_progress_by_title(items: Vec<WatchProgress>) -> Vec<Vec<WatchProgress>> {
    let mut positions: HashMap<(&str, &str), usize> = HashMap::new();
    let group_indices: Vec<usize> = items
        .iter()
        .map(|item| {
            let next = positions.len();
            *positions
                .entry((item.type_.as_str(), item.id.as_str()))
                .or_insert(next)
        })
        .collect();
    let mut grouped: Vec<Vec<WatchProgress>> = (0..positions.len()).map(|_| Vec::new()).collect();
    for (item, index) in items.into_iter().zip(group_indices) {
        grouped[index].push(item);
    }
    grouped
}

fn build_unique_watch_history_entries(
    items: Vec<WatchProgress>,
    source_health_priorities: &HashMap<String, u8>,
) -> Vec<WatchProgress> {
    let mut list: Vec<WatchProgress> = group_watch_progress_by_title(items)
        .into_iter()
        .filter_map(|items| {
            choose_entry(
                items,
                HistoryEntryQuery::Latest,
                Some(source_health_priorities),
            )
        })
        .collect();
    list.sort_by_key(|item| std::cmp::Reverse(item.last_watched));
    list
}

/// Returns every hydrated episode row, newest first.
pub(crate) fn build_title_watch_history_rows(items: Vec<WatchProgress>) -> Vec<WatchProgress> {
    let mut items = items;
    for item in &mut items {
        hydrate_watch_progress_lookup_id(item);
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.last_watched));
    items
}

/// Borrows the rows and copies only the selected resume entries.
pub(super) fn build_continue_watching_entries(items: &[WatchProgress]) -> Vec<WatchProgress> {
    let mut positions: HashMap<(&str, &str), usize> = HashMap::new();
    let mut winners: Vec<Option<&WatchProgress>> = Vec::new();
    for row in items {
        positions
            .entry((row.type_.as_str(), row.id.as_str()))
            .or_insert_with(|| {
                winners.push(None);
                winners.len() - 1
            });
    }
    for row in continue_watching_candidates(items) {
        let index = positions[&(row.type_.as_str(), row.id.as_str())];
        if winners[index].is_none_or(|winner| compare_continue_watching(row, winner).is_lt()) {
            winners[index] = Some(row);
        }
    }
    let mut list: Vec<WatchProgress> = winners.into_iter().flatten().cloned().collect();
    for item in &mut list {
        hydrate_watch_progress_lookup_id(item);
    }
    list.sort_by(compare_continue_watching);
    list
}

const UP_NEXT_MAX_TITLES: usize = 12;
const UP_NEXT_LOOKBACK_MS: u64 = 1000 * 60 * 60 * 24 * 90;

pub(crate) fn build_up_next_sources(
    mut items: Vec<WatchProgress>,
    statuses: &HashMap<String, String>,
    source_health_priorities: &HashMap<String, u8>,
    now: u64,
) -> Vec<WatchProgress> {
    items.retain(|row| {
        is_series_like_watch_progress(row)
            && statuses
                .get(&row.id)
                .is_none_or(|status| status != "dropped")
    });
    let mut sources: Vec<_> = group_watch_progress_by_title(items)
        .into_iter()
        .filter(|items| {
            items
                .iter()
                .any(|row| now.saturating_sub(row.last_watched) <= UP_NEXT_LOOKBACK_MS)
        })
        .filter_map(|items| choose_up_next_source(items, source_health_priorities))
        .collect();
    sources.sort_by_key(|source| std::cmp::Reverse(source.last_watched));
    sources.truncate(UP_NEXT_MAX_TITLES);
    sources
}

pub(crate) fn annotate_watch_progress_list(items: Vec<WatchProgress>) -> Vec<WatchProgress> {
    items.into_iter().map(with_progress_annotations).collect()
}

/// Season/episode params build store keys; out-of-range coordinates are malformed input.
fn require_episode_coordinates(
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<(Option<u32>, Option<u32>), String> {
    if normalize_episode_coordinate(season) != season
        || normalize_episode_coordinate(episode) != episode
    {
        return Err("Invalid episode coordinates.".to_string());
    }
    Ok((season, episode))
}

#[derive(serde::Deserialize)]
pub(crate) struct SaveWatchProgress {
    #[serde(flatten)]
    pub(crate) progress: WatchProgress,
    #[serde(default)]
    pub(crate) completed: bool,
}

#[command]
pub async fn save_watch_progress(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    progress: SaveWatchProgress,
) -> Result<(), String> {
    let Some(mut progress) = prepare_live_watch_progress(progress.progress, progress.completed)?
    else {
        return Ok(());
    };
    if progress.last_watched == 0 {
        progress.last_watched = now_unix_millis();
    }

    let key = build_history_key(
        &progress.type_,
        &progress.id,
        progress.season,
        progress.episode,
    );
    // Cheap in-memory coalescing first; only a surviving write pays a blocking SQLite round-trip.
    if playback_state.should_skip_history_write(&key, &progress, None) {
        return Ok(());
    }

    // One blocking round-trip for read-check-write; the SQL recency guard keeps it safe.
    let service = playback_state.inner().clone();
    let start_generation = service.history_generation();
    super::run_blocking_store_op(move || {
        // Drop writes that raced a clear/remove — else an in-flight save can resurrect history.
        if service.history_generation() != start_generation {
            return Ok(());
        }
        let skip = match service.cached_history_write_decision(&key, &progress) {
            Some(skip) => skip,
            None => {
                let persisted = service.get_resume_entry(&app, &key)?;
                service.should_skip_history_write(&key, &progress, persisted.as_ref())
            }
        };
        if skip {
            return Ok(());
        }
        // Re-checks this generation under the resume lock and marks the coalescing cache there.
        service.track_progress_guarded(&app, key, progress, start_generation)
    })
    .await
}

/// Bounds Undo restores before sanitizing or merging rows.
pub(super) fn validate_history_batch<'a>(
    rows: impl ExactSizeIterator<Item = &'a WatchProgress>,
) -> Result<(), String> {
    if rows.len() > MAX_RESUME_TOTAL_ENTRIES as usize {
        return Err("Watch progress batch exceeds the maximum row count.".to_string());
    }
    Ok(())
}

#[command]
pub async fn save_watch_progress_batch(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    rows: Vec<WatchProgress>,
) -> Result<(), String> {
    let start_epoch = playback_state.history_reset_epoch();
    validate_history_batch(rows.iter())?;

    let mut prepared: Vec<(String, WatchProgress)> = Vec::with_capacity(rows.len());
    for row in rows {
        // Same contract as single-row save: an unsanitizable row fails the batch.
        let mut progress = sanitize_watch_progress(row)
            .ok_or_else(|| "Invalid media id or type for watch progress.".to_string())?;
        if progress.last_watched == 0 {
            progress.last_watched = now_unix_millis();
        }
        let key = build_history_key(
            &progress.type_,
            &progress.id,
            progress.season,
            progress.episode,
        );
        prepared.push((key, progress));
    }

    // Cheap in-memory coalescing first; only surviving rows pay the write.
    prepared
        .retain(|(key, progress)| !playback_state.should_skip_history_write(key, progress, None));
    if prepared.is_empty() {
        return Ok(());
    }

    // The store gate serializes the epoch check and merge against clear/import.
    let service = playback_state.inner().clone();
    super::run_blocking_store_op(move || {
        if service.history_reset_epoch() != start_epoch {
            return Ok(());
        }
        service
            .merge_history_entries(&app, prepared, false)
            .map(|_| ())
    })
    .await
}

#[command]
pub async fn get_watch_history(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
) -> Result<Vec<WatchProgress>, String> {
    let (items, source_health_priorities) =
        load_entries_with_source_health(&app, playback_state.inner(), |service, app| {
            service.load_resume_entries(app)
        })
        .await?;

    Ok(annotate_watch_progress_list(
        build_unique_watch_history_entries(items, &source_health_priorities),
    ))
}

/// Per-title resume snapshot for details pages and card hover: one indexed `media_id`
/// read instead of full-table scans. Resume picks use the global grouping chooser;
/// episode rows and selected history heads avoid duplicating full lists on the wire.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleWatchProgress {
    /// Per-episode rows keyed `id:season:episode`, shared by the details/player/selector progress lookups.
    pub episode_progress: HashMap<String, WatchProgress>,
    /// Furthest canonical episode per season for spoiler masking — highest started
    /// episode, seeded by the latest series row's resume-target coordinates.
    pub watched_episode_ceiling: HashMap<u32, u32>,
    /// Per-kind resumable picks, folded once (`is_series_like` = series|anime).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_resume_entry: Option<WatchProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub movie_resume_entry: Option<WatchProgress>,
    /// Home's Up Next anchor: set only when nothing is resumable, with the
    /// furthest watched episode's coordinates (the successor is picked from the schedule).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub up_next_source: Option<WatchProgress>,
    /// Latest per-kind history heads and latest overall (`last_watched` DESC).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_series_entry: Option<WatchProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_movie_entry: Option<WatchProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_entry: Option<WatchProgress>,
}

/// Only canonical coordinates claim episode keys; legacy rows fall back to their
/// raw coordinates when no mapping is saved. Series rows only, keyed by their own id.
fn build_title_episode_progress(
    history: &[WatchProgress],
    source_health_priorities: Option<&HashMap<String, u8>>,
) -> HashMap<String, WatchProgress> {
    let mut claimants: HashMap<String, Vec<&WatchProgress>> = HashMap::new();
    for row in history.iter().filter(|row| row.type_ == "series") {
        if let Some((season, episode)) =
            watch_progress_absolute_season(row).zip(watch_progress_absolute_episode(row))
        {
            claimants
                .entry(format!("{}:{}:{}", row.id, season, episode))
                .or_default()
                .push(row);
        }
    }
    claimants
        .into_iter()
        .map(|(key, rows)| {
            // History is newest-first; merge only the same canonical episode's donors.
            let chosen = rows[0].clone();
            let merged = merge_watch_progress_donors(
                chosen,
                rows.into_iter().map(Cow::Borrowed),
                source_health_priorities,
            );
            (key, with_progress_annotations(merged))
        })
        .collect()
}

fn build_watched_episode_ceiling(history: &[WatchProgress]) -> HashMap<u32, u32> {
    let mut ceiling = HashMap::new();
    for row in history.iter().filter(|row| row.has_started_watching).chain(
        history
            .iter()
            .find(|row| is_series_like_watch_progress(row)),
    ) {
        if let (Some(season), Some(episode)) = (
            watch_progress_absolute_season(row),
            watch_progress_absolute_episode(row),
        ) {
            ceiling
                .entry(season)
                .and_modify(|max: &mut u32| *max = (*max).max(episode))
                .or_insert(episode);
        }
    }
    ceiling
}

/// Title command paths join source-health priorities up front; tests pass `None` —
/// the donor merge still runs, only its source-priority weights default.
pub(super) fn build_title_watch_progress_with_priorities(
    items: Vec<WatchProgress>,
    source_health_priorities: Option<&HashMap<String, u8>>,
) -> TitleWatchProgress {
    let continue_watching = annotate_watch_progress_list(build_continue_watching_entries(&items));
    let history = annotate_watch_progress_list(build_title_watch_history_rows(items));
    // Keep only the per-kind picks; full lists are internal to this fold.
    let mut series_resume_entry = None;
    let mut movie_resume_entry = None;
    for row in continue_watching {
        if series_resume_entry.is_none() && is_series_like_watch_progress(&row) {
            series_resume_entry = Some(row);
        } else if movie_resume_entry.is_none() && row.type_ == "movie" {
            movie_resume_entry = Some(row);
        }
    }
    let latest_series_entry = history
        .iter()
        .find(|row| is_series_like_watch_progress(row))
        .cloned();
    let latest_movie_entry = history.iter().find(|row| row.type_ == "movie").cloned();
    let latest_entry = history.first().cloned();
    let up_next_source = choose_up_next_source(
        history
            .iter()
            .filter(|row| is_series_like_watch_progress(row))
            .cloned()
            .collect(),
        source_health_priorities.unwrap_or(&HashMap::new()),
    );
    TitleWatchProgress {
        episode_progress: build_title_episode_progress(&history, source_health_priorities),
        watched_episode_ceiling: build_watched_episode_ceiling(&history),
        series_resume_entry,
        movie_resume_entry,
        up_next_source,
        latest_series_entry,
        latest_movie_entry,
        latest_entry,
    }
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct WatchedEpisode {
    pub season: u32,
    pub episode: u32,
}

type EpisodeWatchChanges = (Vec<(String, WatchProgress)>, Vec<String>);

/// Canonical coordinates select rows; the original key and raw coordinates
/// remain their storage identity, including remapped addon episodes.
pub(super) fn prepare_episode_watch_changes(
    item: &MediaItem,
    episodes: &[WatchedEpisode],
    existing: Vec<(String, WatchProgress)>,
    watched: bool,
    now: u64,
) -> Result<EpisodeWatchChanges, String> {
    let mut by_episode: HashMap<(u32, u32), Vec<(String, WatchProgress)>> = HashMap::new();
    let mut occupied_keys = HashSet::with_capacity(existing.len());
    let mut stamp = now;
    for (key, row) in existing {
        stamp = stamp.max(row.last_watched);
        occupied_keys.insert(key.clone());
        if let (Some(season), Some(episode)) = (
            watch_progress_absolute_season(&row),
            watch_progress_absolute_episode(&row),
        ) {
            by_episode
                .entry((season, episode))
                .or_default()
                .push((key, row));
        }
    }
    let mut writes = Vec::new();
    let mut deletes = Vec::new();
    let mut seen = HashSet::new();
    for episode in episodes {
        if !seen.insert((episode.season, episode.episode)) {
            continue;
        }
        let mut matches = by_episode
            .remove(&(episode.season, episode.episode))
            .unwrap_or_default();
        if !watched {
            deletes.extend(matches.into_iter().map(|(key, _)| key));
            continue;
        }
        stamp = stamp.saturating_add(1);
        if matches.is_empty() {
            let key = build_history_key(
                &item.type_,
                &item.id,
                Some(episode.season),
                Some(episode.episode),
            );
            // A remapped row can own the raw key of a different canonical episode.
            if occupied_keys.contains(&key) {
                return Err(
                    "Some episodes couldn't be marked because of a conflicting saved episode."
                        .to_string(),
                );
            }
            let row = WatchProgress {
                id: item.id.clone(),
                type_: item.type_.clone(),
                season: Some(episode.season),
                episode: Some(episode.episode),
                absolute_season: Some(episode.season),
                absolute_episode: Some(episode.episode),
                last_watched: stamp,
                ..WatchProgress::default()
            };
            matches.push((key, row));
        }
        for (key, mut row) in matches {
            // Unknown runtime falls back to the max(position, 1s) completion convention.
            row.duration = if row.duration > 0.0 {
                row.duration
            } else {
                row.position.max(1.0)
            };
            row.position = row.duration;
            row.last_watched = stamp;
            row.title = item.title.clone();
            row.poster = item.poster.clone();
            row.backdrop = item.backdrop.clone();
            row.resume_start_time = None;
            writes.push((key, row));
        }
    }
    Ok((writes, deletes))
}

#[command]
pub async fn set_episodes_watched(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    item: MediaItem,
    episodes: Vec<WatchedEpisode>,
    watched: bool,
) -> Result<TitleWatchProgress, String> {
    let start_epoch = playback_state.history_reset_epoch();
    let item = super::store_helpers::normalize_library_item(item)
        .filter(|item| item.type_ == "series")
        .ok_or_else(|| "Invalid series item for watch history.".to_string())?;
    if episodes.len() > MAX_RESUME_TOTAL_ENTRIES as usize {
        return Err("Episode list exceeds the maximum row count.".to_string());
    }
    for episode in &episodes {
        require_episode_coordinates(Some(episode.season), Some(episode.episode))?;
    }
    let service = playback_state.inner().clone();
    super::run_blocking_store_op(move || {
        if !watched || service.history_reset_epoch() == start_epoch {
            let existing = service.load_resume_entries_for_title(&app, &item.type_, &item.id)?;
            let (writes, deletes) =
                prepare_episode_watch_changes(&item, &episodes, existing, watched, now_unix_millis())?;
            if watched {
                service
                    .merge_history_entries_checked(&app, writes, false)
                    .map_err(|error| match error {
                        HistoryMergeError::CapacityExceeded(_) => format!(
                            "Watch history is full ({MAX_RESUME_TOTAL_ENTRIES} entries). Remove some entries to mark more episodes watched."
                        ),
                        error => String::from(error),
                    })?;
            } else {
                service.remove_keys(&app, &deletes)?;
            }
        }
        let (rows, source_health_priorities) = entries_with_source_health(
            &app,
            &service,
            service.load_resume_entries_for_media_id(&app, &item.id)?,
        )?;
        Ok(build_title_watch_progress_with_priorities(
            rows,
            Some(&source_health_priorities),
        ))
    })
    .await
}

#[command]
pub async fn get_title_watch_progress(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    id: String,
) -> Result<TitleWatchProgress, String> {
    let id = normalize_media_id(&id)
        .ok_or_else(|| "Invalid media id for watch progress.".to_string())?;

    let (items, source_health_priorities) =
        load_entries_with_source_health(&app, playback_state.inner(), move |service, app| {
            service.load_resume_entries_for_media_id(app, &id)
        })
        .await?;

    Ok(build_title_watch_progress_with_priorities(
        items,
        Some(&source_health_priorities),
    ))
}

#[command]
pub async fn get_watch_progress(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    id: String,
    type_: String,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<Option<WatchProgress>, String> {
    let normalized_type = normalize_watch_progress_type(&type_)
        .ok_or_else(|| "Invalid media type.".to_string())?
        .to_string();
    let id = normalize_media_id(&id)
        .ok_or_else(|| "Invalid media id for watch progress.".to_string())?;
    let (season, episode) = require_episode_coordinates(season, episode)?;

    let title_media_id = id.clone();
    let title_type = normalized_type;
    // The donor merge only runs for series-like rows (`choose_latest_entry`
    // early-returns otherwise), so a movie resume lookup skips the health read.
    let (items, source_health_priorities) = if title_type == "series" {
        let (items, priorities) =
            load_entries_with_source_health(&app, playback_state.inner(), move |service, app| {
                service.load_resume_entries_for_title(app, &title_type, &title_media_id)
            })
            .await?;
        (items, Some(priorities))
    } else {
        (
            load_resume_rows(&app, playback_state.inner(), move |service, app| {
                service.load_resume_entries_for_title(app, &title_type, &title_media_id)
            })
            .await?,
            None,
        )
    };

    Ok(choose_entry(
        items,
        HistoryEntryQuery::Exact {
            media_id: &id,
            media_type: &type_,
            season,
            episode,
        },
        source_health_priorities.as_ref(),
    )
    .map(with_progress_annotations))
}

/// Sums saved progress across canonical episodes in SQL — collapsed title history would omit episodes.
#[command]
pub async fn get_total_watch_time_secs(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
) -> Result<u64, String> {
    let service = playback_state.inner().clone();
    super::run_blocking_store_op(move || service.total_watch_time_secs(&app)).await
}

#[derive(serde::Deserialize)]
pub struct HistoryRemovalItem {
    pub id: String,
    #[serde(rename = "type")]
    pub type_: String,
}

pub(super) fn normalize_history_removals(
    items: Vec<HistoryRemovalItem>,
) -> Result<HashMap<String, u8>, String> {
    if items.len() > MAX_RESUME_TOTAL_ENTRIES as usize {
        return Err("Too many history titles.".to_string());
    }
    let mut targets = HashMap::with_capacity(items.len());
    for item in items {
        let id = normalize_media_id(&item.id)
            .ok_or_else(|| "Invalid media id for watch history.".to_string())?;
        let media_type = normalize_watch_progress_type(&item.type_)
            .ok_or_else(|| "Invalid media type.".to_string())?;
        *targets.entry(id).or_insert(0) |= if media_type == "movie" { 1 } else { 2 };
    }
    Ok(targets)
}

pub(super) fn select_history_removals(
    rows: Vec<(String, WatchProgress)>,
    targets: &HashMap<String, u8>,
) -> (Vec<String>, Vec<WatchProgress>) {
    rows.into_iter()
        .filter(|(key, row)| {
            let Some(kinds) = targets.get(&row.id) else {
                return false;
            };
            // Must match the `build_history_key` movie and series formats.
            let series_coordinates = key
                .strip_prefix("series:")
                .and_then(|rest| rest.strip_prefix(row.id.as_str()))
                .and_then(|rest| rest.strip_prefix(':'));
            (kinds & 1 != 0
                && (key.strip_prefix("movie:") == Some(row.id.as_str())
                    || series_coordinates == Some("0:0")))
                || (kinds & 2 != 0 && series_coordinates.is_some())
        })
        .unzip()
}

async fn remove_history_items(
    app: AppHandle,
    service: PlaybackStateService,
    items: Vec<HistoryRemovalItem>,
) -> Result<Vec<WatchProgress>, String> {
    let targets = normalize_history_removals(items)?;
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    super::run_blocking_store_op(move || {
        let rows = match targets.keys().next() {
            Some(id) if targets.len() == 1 => service.load_resume_entries_for_media_id(&app, id)?,
            _ => service.load_resume_entries(&app)?,
        };
        let (keys, removed) = select_history_removals(rows, &targets);
        // remove_keys fences periodic saves without advancing the clear/import reset epoch.
        service.remove_keys(&app, &keys)?;
        Ok(removed)
    })
    .await
}

#[command]
pub async fn bulk_remove_from_watch_history(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    items: Vec<HistoryRemovalItem>,
) -> Result<Vec<WatchProgress>, String> {
    remove_history_items(app, playback_state.inner().clone(), items).await
}

#[command]
pub async fn remove_all_from_watch_history(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    id: String,
    type_: String,
) -> Result<Vec<WatchProgress>, String> {
    remove_history_items(
        app,
        playback_state.inner().clone(),
        vec![HistoryRemovalItem { id, type_ }],
    )
    .await
}
