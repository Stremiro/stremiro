use super::history_helpers::{
    build_history_key, choose_entry, choose_up_next_source, compare_continue_watching,
    hydrate_watch_progress_lookup_id, is_continue_watching_candidate,
    is_series_like_watch_progress, merge_watch_progress_donors, normalize_episode_coordinate,
    sanitize_watch_progress, watch_progress_absolute_episode, watch_progress_absolute_season,
    with_progress_annotations, HistoryEntryQuery, WATCH_PROGRESS_MIN_RESUME_POSITION_SECS,
};
use super::playback_state::PlaybackStateService;
use super::{normalize_media_id, normalize_watch_progress_type, now_unix_millis, WatchProgress};
use crate::providers::MediaItem;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use tauri::{command, AppHandle, State};

/// Shared "load rows, then score their sources" blocking op: unwraps the loader's
/// `(key, item)` pairs and scores `source_id`s in the same store op.
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
        let items: Vec<WatchProgress> = load(&service, &app)?
            .into_iter()
            .map(|(_, item)| item)
            .collect();
        let priorities = service.source_health_priorities_for_ids(
            &app,
            items
                .iter()
                .filter(|item| is_series_like_watch_progress(item))
                .map(|item| item.source_id.as_deref()),
        )?;
        Ok((items, priorities))
    })
    .await
}

async fn load_resume_entries_with_source_health(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
) -> Result<(Vec<WatchProgress>, HashMap<String, u8>), String> {
    load_entries_with_source_health(app, playback_state, |service, app| {
        service.load_resume_entries(app)
    })
    .await
}

/// Plain row loader for views that order without source health — skips the priorities
/// lookup the global history query pays for. Callers pass the store load.
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
    super::run_blocking_store_op(move || {
        load(&service, &app).map(|rows| rows.into_iter().map(|(_, item)| item).collect())
    })
    .await
}

/// Groups rows by title, preserving the loader's first-seen order
/// (`ORDER BY last_watched DESC, history_key DESC`) so downstream stable sorts
/// keep recency ties instead of HashMap iteration order.
fn group_watch_progress_by_title(items: Vec<WatchProgress>) -> Vec<Vec<WatchProgress>> {
    let mut positions: HashMap<(String, String), usize> = HashMap::new();
    let mut grouped: Vec<Vec<WatchProgress>> = Vec::new();
    for item in items {
        let key = (item.type_.clone(), item.id.clone());
        match positions.get(&key) {
            Some(&index) => grouped[index].push(item),
            None => {
                positions.insert(key, grouped.len());
                grouped.push(vec![item]);
            }
        }
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

/// Title-scoped history returns every hydrated row (per-episode fidelity for the
/// episode-progress map, exact-episode `last_stream_key` match, and undo snapshot),
/// not the collapsed one-entry-per-title view. Recency-sorted so `history[0]` is latest.
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
        let index = *positions
            .entry((row.type_.as_str(), row.id.as_str()))
            .or_insert_with(|| {
                winners.push(None);
                winners.len() - 1
            });
        if is_continue_watching_candidate(row)
            && winners[index].is_none_or(|winner| compare_continue_watching(row, winner).is_lt())
        {
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
    items: Vec<WatchProgress>,
    statuses: &HashMap<String, String>,
    source_health_priorities: &HashMap<String, u8>,
    now: u64,
) -> Vec<WatchProgress> {
    let mut sources: Vec<_> = group_watch_progress_by_title(items)
        .into_iter()
        .filter_map(|items| choose_up_next_source(items, source_health_priorities))
        .filter(|source| {
            now.saturating_sub(source.last_watched) <= UP_NEXT_LOOKBACK_MS
                && statuses
                    .get(&source.id)
                    .is_none_or(|status| status != "dropped")
        })
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

#[command]
pub async fn save_watch_progress(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    progress: WatchProgress,
) -> Result<(), String> {
    // Sanitize owns validation: `Some` carries a bounded id, canonical type, non-empty title.
    let mut progress = sanitize_watch_progress(progress)
        .ok_or_else(|| "Invalid media id or type for watch progress.".to_string())?;
    // Sub-minimum positions would regress Continue Watching to ~0; synthetic watched
    // marks go through the batch commands, not this live-playback path.
    if progress.position < WATCH_PROGRESS_MIN_RESUME_POSITION_SECS {
        return Ok(());
    }
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
        let persisted = service.get_resume_entry(&app, &key)?;
        if service.should_skip_history_write(&key, &progress, persisted.as_ref()) {
            return Ok(());
        }
        // Re-checks this generation under the resume lock and marks the coalescing cache there.
        service.track_progress_guarded(&app, key, progress, start_generation)
    })
    .await
}

/// Undo restore writes a whole title at once: one bounded command + one blocking
/// round-trip. Sanitize/build guards match `save_watch_progress`; the merge's single
/// transaction + SQL recency guard mean a partial restore can't resurrect cleared rows.
const MAX_WATCH_PROGRESS_BATCH_ROWS: usize = 500;

pub(super) fn validate_history_batch<'a>(
    mut rows: impl ExactSizeIterator<Item = &'a WatchProgress>,
) -> Result<(), String> {
    let count = rows.len();
    let single_title = rows
        .next()
        .is_none_or(|first| rows.all(|row| row.id == first.id && row.type_ == first.type_));
    if count > super::resume_store::MAX_RESUME_TOTAL_ENTRIES as usize
        || (count > MAX_WATCH_PROGRESS_BATCH_ROWS && !single_title)
    {
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
    if rows.len() > super::resume_store::MAX_RESUME_TOTAL_ENTRIES as usize {
        return Err("Watch progress batch exceeds the maximum row count.".to_string());
    }

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

    validate_history_batch(prepared.iter().map(|(_, row)| row))?;

    // Cheap in-memory coalescing first; only surviving rows pay the write.
    prepared
        .retain(|(key, progress)| !playback_state.should_skip_history_write(key, progress, None));
    if prepared.is_empty() {
        return Ok(());
    }

    // One transaction for the whole restore: the merge bumps the generation before
    // writing so a racing save drops, and a racing clear either wins the resume
    // mutex first or runs after the committed merge.
    let service = playback_state.inner().clone();
    let app_for_merge = app.clone();
    super::run_blocking_store_op(move || {
        service
            .merge_history_entries(&app_for_merge, prepared)
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
        load_resume_entries_with_source_health(&app, playback_state.inner()).await?;

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
    /// Latest per-kind history heads and latest overall (`last_watched` DESC).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_series_entry: Option<WatchProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_movie_entry: Option<WatchProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_entry: Option<WatchProgress>,
}

/// Canonical coordinates claim `id:season:episode` keys first so a remapped row can
/// never shadow a canonical claimant; co-claimants merge in as donors via
/// `choose_latest_entry`'s merge. Series rows only, keyed by each row's own id.
fn build_title_episode_progress(
    history: &[WatchProgress],
    source_health_priorities: Option<&HashMap<String, u8>>,
) -> HashMap<String, WatchProgress> {
    let mut claimants: HashMap<String, Vec<&WatchProgress>> = HashMap::new();
    for canonical in [true, false] {
        for row in history.iter().filter(|row| row.type_ == "series") {
            let canonical_coordinates =
                watch_progress_absolute_season(row).zip(watch_progress_absolute_episode(row));
            let coordinates = if canonical {
                canonical_coordinates
            } else {
                // An unremapped row's raw key is its canonical key — a second push only self-merges.
                row.season
                    .zip(row.episode)
                    .filter(|raw| Some(*raw) != canonical_coordinates)
            };
            if let Some((season, episode)) = coordinates {
                claimants
                    .entry(format!("{}:{}:{}", row.id, season, episode))
                    .or_default()
                    .push(row);
            }
        }
    }
    claimants
        .into_iter()
        .map(|(key, rows)| {
            // First claimant keeps its slot (canonical beats remapped); co-claimants
            // merge in as donors, then the merged row re-derives annotations.
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
    for row in history.iter().filter(|row| row.has_started_watching) {
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
    if let Some(latest) = history
        .iter()
        .find(|row| is_series_like_watch_progress(row))
    {
        if let (Some(season), Some(episode)) = (
            watch_progress_absolute_season(latest),
            watch_progress_absolute_episode(latest),
        ) {
            ceiling
                .entry(season)
                .and_modify(|max| *max = (*max).max(episode))
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
    let series_resume_entry = continue_watching
        .iter()
        .find(|row| is_series_like_watch_progress(row))
        .cloned();
    let movie_resume_entry = continue_watching
        .iter()
        .find(|row| row.type_ == "movie")
        .cloned();
    let latest_series_entry = history
        .iter()
        .find(|row| is_series_like_watch_progress(row))
        .cloned();
    let latest_movie_entry = history.iter().find(|row| row.type_ == "movie").cloned();
    let latest_entry = history.first().cloned();
    TitleWatchProgress {
        episode_progress: build_title_episode_progress(&history, source_health_priorities),
        watched_episode_ceiling: build_watched_episode_ceiling(&history),
        series_resume_entry,
        movie_resume_entry,
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

/// Canonical coordinates select rows; the original key and raw coordinates
/// remain their storage identity, including remapped addon episodes.
pub(super) fn prepare_episode_watch_changes(
    item: &MediaItem,
    episodes: &[WatchedEpisode],
    existing: Vec<(String, WatchProgress)>,
    watched: bool,
    now: u64,
) -> (Vec<(String, WatchProgress)>, Vec<String>) {
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
                continue;
            }
            let row = WatchProgress {
                id: item.id.clone(),
                type_: item.type_.clone(),
                season: Some(episode.season),
                episode: Some(episode.episode),
                absolute_season: Some(episode.season),
                absolute_episode: Some(episode.episode),
                stream_season: None,
                stream_episode: None,
                position: 0.0,
                duration: 0.0,
                last_watched: stamp,
                // Filled once in the common path below, before persistence sanitizes the row.
                title: String::new(),
                poster: None,
                backdrop: None,
                last_stream_format: None,
                last_stream_lookup_id: None,
                last_stream_key: None,
                source_name: None,
                source_id: None,
                stream_family: None,
                resume_start_time: None,
                is_watched: false,
                has_started_watching: false,
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
    (writes, deletes)
}

#[command]
pub async fn set_episodes_watched(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    item: MediaItem,
    episodes: Vec<WatchedEpisode>,
    watched: bool,
) -> Result<TitleWatchProgress, String> {
    let item = super::store_helpers::normalize_library_item(item)
        .filter(|item| item.type_ == "series")
        .ok_or_else(|| "Invalid series item for watch history.".to_string())?;
    if episodes.len() > super::resume_store::MAX_RESUME_TOTAL_ENTRIES as usize {
        return Err("Episode list exceeds the maximum row count.".to_string());
    }
    for episode in &episodes {
        require_episode_coordinates(Some(episode.season), Some(episode.episode))?;
    }
    let service = playback_state.inner().clone();
    super::run_blocking_store_op(move || {
        let existing = service.load_resume_entries_for_title(&app, &item.type_, &item.id)?;
        let (writes, deletes) =
            prepare_episode_watch_changes(&item, &episodes, existing, watched, now_unix_millis());
        if watched {
            service.merge_history_entries(&app, writes)?;
        } else {
            service.remove_keys(&app, &deletes)?;
        }
        let rows = service
            .load_resume_entries_for_media_id(&app, &item.id)?
            .into_iter()
            .map(|(_, row)| row)
            .collect::<Vec<_>>();
        // Same health join as `load_entries_with_source_health` — this op already holds the store.
        let source_health_priorities = service.source_health_priorities_for_ids(
            &app,
            rows.iter()
                .filter(|row| is_series_like_watch_progress(row))
                .map(|row| row.source_id.as_deref()),
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
    let title_type = normalized_type.clone();
    // The donor merge only runs for series-like rows (`choose_latest_entry`
    // early-returns otherwise), so a movie resume lookup skips the health read.
    let (items, source_health_priorities) = if normalized_type == "series" {
        let (items, priorities) =
            load_entries_with_source_health(&app, playback_state.inner(), move |service, app| {
                service.load_resume_entries_for_title(app, &title_type, &title_media_id)
            })
            .await?;
        (items, Some(priorities))
    } else {
        let title_media_id = id.clone();
        let title_type = normalized_type.clone();
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

/// Returns the deleted rows: the scan already loaded them, so the caller's Undo
/// snapshot needs no second read (store keys are unique — removed rows can't repeat).
#[command]
pub async fn remove_all_from_watch_history(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    id: String,
    type_: String,
) -> Result<Vec<WatchProgress>, String> {
    let id =
        normalize_media_id(&id).ok_or_else(|| "Invalid media id for watch history.".to_string())?;
    let Some(canonical_type) = normalize_watch_progress_type(&type_).map(str::to_string) else {
        return Err("Invalid media type.".to_string());
    };

    let prefixes: Vec<String> = if canonical_type == "movie" {
        vec![
            build_history_key("movie", &id, None, None),
            build_history_key("series", &id, Some(0), Some(0)),
        ]
    } else {
        // `sanitize_watch_progress` folds anime onto `series:` keys — only one namespace exists.
        vec![format!("series:{}:", id)]
    };

    // One blocking round-trip for scan + delete.
    let app = app.clone();
    let service = playback_state.inner().clone();
    let media_id = id.clone();
    super::run_blocking_store_op(move || {
        let mut keys_to_remove: Vec<String> = Vec::new();
        let mut removed_rows: Vec<WatchProgress> = Vec::new();
        for (key, entry) in service.load_resume_entries_for_media_id(&app, &media_id)? {
            let in_scope = if canonical_type == "movie" {
                prefixes.contains(&key)
            } else {
                prefixes
                    .iter()
                    .any(|prefix| key.starts_with(prefix.as_str()))
            };
            if in_scope {
                keys_to_remove.push(key);
                removed_rows.push(entry);
            }
        }
        if !keys_to_remove.is_empty() {
            service.remove_keys(&app, &keys_to_remove)?;
        }
        Ok(removed_rows)
    })
    .await
}
