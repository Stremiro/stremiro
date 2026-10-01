use super::history_helpers::{
    build_history_key, choose_entry, compare_continue_watching, hydrate_watch_progress_lookup_id,
    normalize_episode_coordinate, sanitize_watch_progress, with_resume_start_time,
    HistoryEntryQuery,
};
use super::playback_state::PlaybackStateService;
use super::{normalize_media_id, normalize_watch_progress_type, now_unix_millis, WatchProgress};
use std::collections::HashMap;
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

fn annotate_resume_metadata_list(items: Vec<WatchProgress>) -> Vec<WatchProgress> {
    items.into_iter().map(with_resume_start_time).collect()
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

#[command]
pub async fn save_watch_progress_batch(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    rows: Vec<WatchProgress>,
) -> Result<(), String> {
    if rows.len() > MAX_WATCH_PROGRESS_BATCH_ROWS {
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

    Ok(annotate_resume_metadata_list(
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

    Ok(annotate_resume_metadata_list(
        build_continue_watching_entries(items),
    ))
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
        history: annotate_resume_metadata_list(build_title_watch_history_rows(items.clone())),
        continue_watching: annotate_resume_metadata_list(build_continue_watching_entries(items)),
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
    .map(with_resume_start_time))
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

#[command]
pub async fn remove_from_watch_history(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    id: String,
    type_: String,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<(), String> {
    let id =
        normalize_media_id(&id).ok_or_else(|| "Invalid media id for watch history.".to_string())?;
    // Canonical fold so "anime"/"Anime"/padded input lands on the same
    // `series:` keys `sanitize_watch_progress` writes — and unknown types
    // fail instead of silently scanning the series namespace.
    let Some(canonical_type) = normalize_watch_progress_type(&type_).map(str::to_string) else {
        return Err("Invalid media type.".to_string());
    };
    let (season, episode) = require_episode_coordinates(season, episode)?;
    let key = build_history_key(&canonical_type, &id, season, episode);

    // One blocking round-trip for the existence check plus the delete.
    let app = app.clone();
    let service = playback_state.inner().clone();
    let fallback_key = build_history_key("series", &id, Some(0), Some(0));
    let check_fallback = canonical_type == "movie";
    let removed = super::run_blocking_store_op(move || {
        let mut removed_keys = Vec::with_capacity(2);
        if service.get_resume_entry(&app, &key)?.is_some() {
            removed_keys.push(key.clone());
        }
        if removed_keys.is_empty()
            && check_fallback
            && service.get_resume_entry(&app, &fallback_key)?.is_some()
        {
            removed_keys.push(fallback_key.clone());
        }
        if removed_keys.is_empty() {
            return Ok(false);
        }
        service.remove_keys(&app, &removed_keys)?;
        Ok(true)
    })
    .await?;

    if removed {
        return Ok(());
    }

    Err(format!(
        "Item not found in history (type={}, id={}, s={:?}, e={:?})",
        canonical_type, id, season, episode
    ))
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
