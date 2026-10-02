use super::history_helpers::{
    build_history_key, choose_entry, choose_up_next_source, compare_continue_watching,
    hydrate_watch_progress_lookup_id, normalize_episode_coordinate, sanitize_watch_progress,
    with_progress_annotations, HistoryEntryQuery, WATCH_PROGRESS_MIN_RESUME_POSITION_SECS,
};
use super::playback_state::PlaybackStateService;
use super::store_helpers::load_watch_statuses_map;
use super::{normalize_media_id, normalize_watch_progress_type, now_unix_millis, WatchProgress};
use crate::providers::MediaItem;
use std::collections::{HashMap, HashSet};
use tauri::{command, AppHandle, State};

/// Shared "load rows, then score their sources" blocking op: every resume
/// loader returns `(key, item)` pairs the health lookup doesn't need, so
/// this unwraps the items and scores `source_id`s in the same store op.
async fn load_entries_with_source_health<F>(
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
        let priorities = service
            .source_health_priorities_for_ids(&app, items.iter().map(|i| i.source_id.as_deref()))?;
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

/// Plain row loader for views that order without source health — the
/// continue-watching chooser never consulted it and per-episode history rows
/// hydrate without it, so these reads skip the priorities lookup the global
/// history query pays for. One generic body: callers pass the store load.
async fn load_resume_rows<F>(
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

/// One grouping pass for every title-scoped history view: unique-history and
/// continue-watching both fan rows out by title before the per-title choose
/// runs. Groups come back in first-seen order — the loader's deterministic
/// `ORDER BY last_watched DESC, history_key DESC` — so downstream stable
/// sorts keep that order on recency ties instead of riding HashMap
/// iteration order.
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

/// Title-scoped history returns every hydrated row, not the collapsed
/// one-entry-per-title view: the details episode-progress map, the
/// selector's exact-episode `last_stream_key` match, and the
/// remove-from-continue-watching undo snapshot all need per-episode
/// fidelity. Each row gets the same lookup/coordinate hydration
/// `choose_latest_entry` applies, and the explicit recency sort keeps
/// `history[0]` as the latest row — the head the collapsed view produced.
pub(crate) fn build_title_watch_history_rows(items: Vec<WatchProgress>) -> Vec<WatchProgress> {
    let mut items = items;
    for item in &mut items {
        hydrate_watch_progress_lookup_id(item);
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.last_watched));
    items
}

/// Continue-watching picks rows by resume state alone — the chooser never
/// consulted source health (its donor scan was a self-merge no-op) — so the
/// entries build takes no health map and the global query skips the read.
fn build_continue_watching_entries(items: Vec<WatchProgress>) -> Vec<WatchProgress> {
    let mut list = group_watch_progress_by_title(items)
        .into_iter()
        .filter_map(|items| choose_entry(items, HistoryEntryQuery::ContinueWatching, None))
        .collect::<Vec<_>>();

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

fn annotate_watch_progress_list(items: Vec<WatchProgress>) -> Vec<WatchProgress> {
    items.into_iter().map(with_progress_annotations).collect()
}

/// Season/episode params build store keys; an out-of-range coordinate is
/// malformed input (real catalogs never reach it), not a valid lookup.
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
    // Sanitize owns id/type/title validation: a `Some` result always carries
    // a non-empty bounded id, a canonical type, and a non-empty title.
    let mut progress = sanitize_watch_progress(progress)
        .ok_or_else(|| "Invalid media id or type for watch progress.".to_string())?;
    // Startup stubs would regress Continue Watching to ~0; synthetic watched
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
    // Cheap in-memory coalescing first; only a surviving write pays for a
    // blocking SQLite round-trip off the async worker.
    if playback_state.should_skip_history_write(&key, &progress, None) {
        return Ok(());
    }

    // One blocking round-trip for read-check-write; the SQL recency guard
    // plus the in-transaction checks below keep the single op safe.
    let service = playback_state.inner().clone();
    let persisted_key = key.clone();
    let persisted_progress = progress.clone();
    let app_for_persisted = app.clone();
    let start_generation = service.history_generation();
    let wrote = super::run_blocking_store_op(move || {
        // Drop stale writes that raced a concurrent clear/remove: without
        // this, an in-flight save can resurrect history after logout/clear.
        if service.history_generation() != start_generation {
            return Ok(false);
        }
        let persisted = service.get_resume_entry(&app_for_persisted, &persisted_key)?;
        if service.should_skip_history_write(
            &persisted_key,
            &persisted_progress,
            persisted.as_ref(),
        ) {
            return Ok(false);
        }
        // Re-check after the read: a clear that landed between capture and
        // the DB read must still win over this write. The guarded save
        // re-checks under the resume lock and before the health-file write
        // so neither store can resurrect cleared rows.
        if service.history_generation() != start_generation {
            return Ok(false);
        }
        service.track_progress_guarded(
            &app_for_persisted,
            &persisted_key,
            &persisted_progress,
            Some(start_generation),
        )
    })
    .await?;
    if wrote {
        playback_state.mark_history_persisted(key, progress, start_generation);
    }

    Ok(())
}

/// Undo restore writes a whole title back at once: one bounded command +
/// one blocking store round-trip instead of N commands each paying a
/// spawn_blocking hop. Sanitize/build guards match `save_watch_progress`,
/// and the merge path's single transaction + SQL recency guard mean a
/// partial restore cannot resurrect cleared rows.
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
        // Same contract as the single-row save: an unsanitizable row fails
        // the batch rather than silently dropping history.
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

    // One transaction for the whole restore. The merge bumps the generation
    // before writing so a racing per-title save drops instead of
    // interleaving, and a racing clear either wins the resume mutex first or
    // runs after the committed merge.
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

#[command]
pub async fn get_continue_watching(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
) -> Result<Vec<WatchProgress>, String> {
    let items = load_resume_rows(&app, playback_state.inner(), |service, app| {
        service.load_resume_entries(app)
    })
    .await?;

    Ok(annotate_watch_progress_list(
        build_continue_watching_entries(items),
    ))
}

pub(crate) async fn load_up_next_sources(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
) -> Result<Vec<WatchProgress>, String> {
    let app = app.clone();
    let service = playback_state.clone();
    super::run_blocking_store_op(move || {
        let rows: Vec<_> = service
            .load_resume_entries(&app)?
            .into_iter()
            .map(|(_, row)| row)
            .collect();
        let source_health_priorities = service.source_health_priorities_for_ids(
            &app,
            rows.iter().map(|row| row.source_id.as_deref()),
        )?;
        let status_store = super::open_store(&app, super::WATCH_STATUS_STORE_FILE)?;
        let statuses = load_watch_statuses_map(&status_store)?;
        Ok(build_up_next_sources(
            rows,
            &statuses,
            &source_health_priorities,
            now_unix_millis(),
        ))
    })
    .await
}

/// Per-title resume snapshot for details pages and card hover: one indexed
/// `media_id` read instead of the full-table scans behind
/// `get_watch_history`/`get_continue_watching`. `continue_watching` is built
/// by the same grouping chooser as the global query; `history` instead keeps
/// every per-episode row (recency-sorted, hydrated) because episode-level
/// consumers key on coordinates the collapsed unique view drops.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleWatchProgress {
    pub history: Vec<WatchProgress>,
    pub continue_watching: Vec<WatchProgress>,
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
    let mut stamp = now;
    for (key, row) in existing {
        stamp = stamp.max(row.last_watched);
        if let (Some(season), Some(episode)) = (
            row.absolute_season.or(row.season),
            row.absolute_episode.or(row.episode),
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
                title: item.title.clone(),
                poster: item.poster.clone(),
                backdrop: item.backdrop.clone(),
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
            matches.push((
                build_history_key(&item.type_, &item.id, row.season, row.episode),
                row,
            ));
        }
        for (key, mut row) in matches {
            // Preserve a real runtime; an unknown runtime uses the existing
            // max(position, 1s) completion convention without a resume offer.
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
        Ok(TitleWatchProgress {
            history: annotate_watch_progress_list(build_title_watch_history_rows(rows.clone())),
            continue_watching: annotate_watch_progress_list(build_continue_watching_entries(rows)),
        })
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

    let items = load_resume_rows(&app, playback_state.inner(), move |service, app| {
        service.load_resume_entries_for_media_id(app, &id)
    })
    .await?;

    Ok(TitleWatchProgress {
        history: annotate_watch_progress_list(build_title_watch_history_rows(items.clone())),
        continue_watching: annotate_watch_progress_list(build_continue_watching_entries(items)),
    })
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
    let (items, source_health_priorities) =
        load_entries_with_source_health(&app, playback_state.inner(), move |service, app| {
            service.load_resume_entries_for_title(app, &title_type, &title_media_id)
        })
        .await?;

    Ok(choose_entry(
        items,
        HistoryEntryQuery::Exact {
            media_id: &id,
            media_type: &type_,
            season,
            episode,
        },
        Some(&source_health_priorities),
    )
    .map(with_progress_annotations))
}

/// "Hours watched" sums the raw per-episode rows — the collapsed history
/// queries would undercount. The aggregate runs in SQL so the stat costs one
/// query, not a full-table decode on every profile mount.
#[command]
pub async fn get_total_watch_time_secs(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
) -> Result<u64, String> {
    let service = playback_state.inner().clone();
    super::run_blocking_store_op(move || service.total_watch_time_secs(&app)).await
}

/// Returns the rows it deleted: the scan already loaded them to scope the
/// keys, so the caller's Undo snapshot needs no second read and no
/// key-tuple dedupe — store keys are unique, so removed rows can't repeat.
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
        // `sanitize_watch_progress` folds anime onto `series:` keys, so only
        // one namespace ever exists; unknown types already failed above
        // instead of scanning here.
        vec![format!("series:{}:", id)]
    };

    // One blocking round-trip for the scan plus the delete; see above.
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
