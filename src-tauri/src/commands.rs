use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{command, AppHandle, State};

mod addon_registry;
pub(crate) mod app_shell_commands;
pub(crate) mod app_update_commands;
pub(crate) mod avatar_commands;
pub(crate) mod backup_commands;
pub(crate) mod browse_genre_commands;
pub(crate) mod calendar_commands;
pub(crate) mod config_commands;
pub(crate) mod config_store;
mod durable_store;
pub(crate) mod episode_navigation;
mod history_helpers;
pub(crate) mod history_playback_commands;
mod language;
pub(crate) mod library_commands;
pub(crate) mod list_commands;
mod list_helpers;
pub(crate) mod media_commands;
mod media_normalization;
mod media_type;
pub(crate) mod playback_preferences_commands;
pub(crate) mod playback_state;
pub(crate) mod playback_state_commands;
pub(crate) mod player_mpv_commands;
pub(crate) mod player_track_commands;
pub(crate) mod player_window_commands;
mod probe_pool;
mod resume_store;
pub(crate) mod search_commands;
pub(crate) mod similar_titles_commands;
mod startup_validation;
mod store_helpers;
pub(crate) mod stream_commands;
mod stream_coordinator;
mod stream_fetcher;
mod stream_resolver;
mod streaming_helpers;
#[cfg(test)]
mod tests;
pub(crate) mod up_next_commands;
pub(crate) mod watch_history_commands;
pub(crate) mod watch_status_commands;

use list_helpers::{load_lists_order, LISTS_ORDER_KEY, LIST_ITEM_KEY_PREFIX, LIST_META_KEY_PREFIX};
use playback_state::PlaybackStateService;

/// Serializes blocking store work — interleaved load→mutate→save would let a stale
/// snapshot silently drop the other's write. One lock covers every store; ops are
/// milliseconds and a single lock cannot deadlock.
static STORE_OP_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Shared budget for blocking hops off the async runtime (store ops, plugin IPC,
/// file IO). A timeout releases the caller; running blocking work can't be cancelled.
pub(crate) const BLOCKING_OP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
pub(crate) const PERSISTENCE_TIMEOUT_MESSAGE: &str = "Background persistence timed out.";

/// Serialize store work without blocking a worker while it waits in the queue.
pub(crate) async fn run_blocking_store_op<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    run_typed_store_op(operation).await
}

pub(crate) async fn run_typed_store_op<T, E, F>(operation: F) -> Result<T, E>
where
    T: Send + 'static,
    E: From<String> + Send + 'static,
    F: FnOnce() -> Result<T, E> + Send + 'static,
{
    run_store_op_at(tokio::time::Instant::now() + BLOCKING_OP_TIMEOUT, operation).await
}

/// Runs `operation` on one opened store inside the store gate.
pub(crate) async fn with_store<T, E, F>(
    app: AppHandle,
    file: &'static str,
    operation: F,
) -> Result<T, E>
where
    T: Send + 'static,
    E: From<String> + Send + 'static,
    F: FnOnce(DurableStore) -> Result<T, E> + Send + 'static,
{
    run_typed_store_op(move || operation(open_store(&app, file)?)).await
}

pub(crate) async fn run_store_op_at<T, E, F>(
    deadline: tokio::time::Instant,
    operation: F,
) -> Result<T, E>
where
    T: Send + 'static,
    E: From<String> + Send + 'static,
    F: FnOnce() -> Result<T, E> + Send + 'static,
{
    // Wait before entering the blocking pool so expired waiters never submit a mutation after their caller failed.
    let guard = tokio::time::timeout_at(deadline, STORE_OP_LOCK.lock())
        .await
        .map_err(|_| PERSISTENCE_TIMEOUT_MESSAGE.to_string())?;
    run_blocking_op(deadline, PERSISTENCE_TIMEOUT_MESSAGE, move || {
        let _guard = guard;
        Ok(operation())
    })
    .await?
}

/// Bounds worker execution without taking the store gate for external file IO.
pub(crate) async fn run_blocking_op<T, F>(
    deadline: tokio::time::Instant,
    timeout_message: &'static str,
    operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let mut task = tauri::async_runtime::spawn_blocking(move || {
        // Abort can race a queued worker starting; expired work must not mutate stores.
        if tokio::time::Instant::now() >= deadline {
            return Err(timeout_message.to_string());
        }
        operation()
    });
    match tokio::time::timeout_at(deadline, &mut task).await {
        Ok(result) => {
            result.map_err(|error| format!("Background persistence task failed: {}", error))?
        }
        Err(_) => {
            // Abort cancels queued work; running blocking work cannot be cancelled.
            task.abort();
            Err(timeout_message.to_string())
        }
    }
}

pub(crate) use durable_store::{
    open_store, resolve_store_path, write_atomic_file, DurableStore, DurableStoreRegistry,
};
pub(crate) use media_type::{normalize_stream_media_type, normalize_watch_progress_type};
pub(crate) use startup_validation::validate_startup_stores;
use store_helpers::{load_library_index, read_watch_status_snapshot};

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct WatchProgress {
    pub id: String,    // opaque addon id (e.g. `tt…`, `kitsu:…`)
    pub type_: String, // "movie" or "series"
    // `None` fields omit rather than emit `null`: the TS contract is `field?: T`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absolute_season: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absolute_episode: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_season: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_episode: Option<u32>,
    pub position: f64,     // in seconds
    pub duration: f64,     // in seconds
    pub last_watched: u64, // timestamp
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backdrop: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_stream_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_stream_lookup_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_stream_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    /// Stable addon-instance id (`AddonConfig.id`): the source-health and
    /// resume-binding identity of record. `None` on pre-instance-id rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_start_time: Option<f64>,
    /// Read-side annotation: derived on the way out, never persisted or trusted inbound.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_watched: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub has_started_watching: bool,
}

const LIBRARY_INDEX_KEY: &str = "library_index";
const LIBRARY_ITEM_PREFIX: &str = "library_item:";
/// Titles a watch status added to the Library; clearing that status removes them again.
const LIBRARY_STATUS_ADDED_KEY: &str = "library_status_added";
const WATCH_STATUS_INDEX_KEY: &str = "watch_status_index";
const WATCH_STATUS_ITEM_PREFIX: &str = "watch_status:";
const MAX_SEARCH_QUERY_CHARS: usize = 120;
/// Char bounds for media identity fields crossing IPC into durable state.
pub(crate) const MEDIA_ID_MAX_CHARS: usize = 256;
pub(crate) const MEDIA_TITLE_MAX_CHARS: usize = 512;
const SETTINGS_STORE_FILE: &str = "settings.json";
const LIBRARY_STORE_FILE: &str = "library.json";
const LISTS_STORE_FILE: &str = "lists.json";
const WATCH_STATUS_STORE_FILE: &str = "watch_status.json";
const PROFILE_AVATAR_STORE_FILE: &str = "profile_avatar.json";

const JS_WHITESPACE: &str =
    "\u{0009}\u{000a}\u{000b}\u{000c}\u{000d} \u{00a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

/// JavaScript `trim()`: includes BOM and excludes NEXT LINE from Unicode whitespace.
pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(|character| JS_WHITESPACE.contains(character))
}

fn normalize_non_empty(input: &str) -> Option<String> {
    crate::providers::trim_to_max(input, usize::MAX)
}

/// Media ids become store keys and addon request path segments — reject overlong
/// input rather than truncate, so two hostile ids can't collide onto one key.
pub(crate) fn normalize_media_id(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.chars().nth(MEDIA_ID_MAX_CHARS).is_some() {
        return None;
    }
    normalize_opaque_field(trimmed)
}

/// Normalize a persisted media image URL: trimmed, char-bounded, gated by the
/// addon-ingress artwork policy — http(s) only, no credentials, no non-routable
/// host. Anything else degrades to "no artwork" instead of persisting.
pub(crate) fn normalize_media_image_url(input: &str) -> Option<String> {
    crate::providers::addon_resource::normalize_image_url(input.trim())
}

/// Opaque free-text fields crossing IPC (source names, stream metadata, skip-segment
/// types): trim, reject empty and the `null`/`undefined` sentinels JSON callers leak.
pub(crate) fn normalize_opaque_field(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("null")
        || trimmed.eq_ignore_ascii_case("undefined")
    {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_query(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.chars().take(MAX_SEARCH_QUERY_CHARS).collect())
}

/// Pre-tokenization normalization shared by coordinator/language/search paths:
/// lowercase ASCII alphanumerics, every other char becomes a space.
pub(crate) fn normalize_token_text(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect()
}

fn now_unix_millis() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => u64::try_from(duration.as_millis()).unwrap_or(u64::MAX),
        Err(_) => 0,
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackLanguagePreferences {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_audio_language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_subtitle_language: Option<String>,
}

/// Fetch skippable segment data (intro/recap/outro/preview) from SkipDB.
/// SkipDB keys on the first valid IMDb id: metadata, media id, then stream lookup id.
/// Unkeyable input and missing data return empty; only transient upstream failures are errors.
#[command]
#[allow(clippy::too_many_arguments)]
pub async fn get_skip_times(
    skip_provider: State<'_, crate::providers::skip_times::SkipTimesProvider>,
    media_type: String,
    id: String,
    imdb_id: Option<String>,
    stream_lookup_id: Option<String>,
    season: Option<u32>,
    episode: Option<u32>,
    duration_secs: Option<f64>,
) -> Result<crate::providers::skip_times::SkipTimesResult, String> {
    let imdb_id = [
        imdb_id.as_deref(),
        Some(id.as_str()),
        stream_lookup_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    .find_map(crate::providers::skip_times::normalize_imdb_id);
    let Some(imdb_id) = imdb_id else {
        return Ok(crate::providers::skip_times::SkipTimesResult::default());
    };

    // SkipDB wants both coordinates for an episode, neither for a movie. A lone
    // coordinate can't name an episode — never silently default to S1.
    let Some((season, episode)) = skip_times_coordinates(&media_type, season, episode) else {
        return Ok(crate::providers::skip_times::SkipTimesResult::default());
    };

    // Bound duration so a malformed value never reaches the outbound query (24h covers any stream).
    const MAX_STREAM_DURATION_SECS: f64 = 24.0 * 60.0 * 60.0;
    let duration_secs = duration_secs
        .filter(|d| d.is_finite() && *d > 0.0 && *d <= MAX_STREAM_DURATION_SECS)
        .map(|d| d.round());

    skip_provider
        .get_segments(&imdb_id, season, episode, duration_secs)
        .await
}

fn skip_times_coordinates(
    media_type: &str,
    season: Option<u32>,
    episode: Option<u32>,
) -> Option<(Option<u32>, Option<u32>)> {
    if js_trim(media_type).trim().eq_ignore_ascii_case("movie") {
        Some((None, None))
    } else {
        Some((Some(season?), Some(episode?)))
    }
}

#[derive(Debug, Serialize)]
pub struct DataStats {
    pub history_count: usize,
    pub history_title_count: usize,
    pub has_learned_playback_data: bool,
    pub library_count: usize,
    pub library_status_counts: HashMap<String, usize>,
    pub lists_count: usize,
    pub watch_statuses_count: usize,
}

/// Returns record counts for each persisted data store — used by the Data Manager UI.
#[command]
pub async fn get_data_stats(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
) -> Result<DataStats, String> {
    run_blocking_store_op({
        let service = playback_state.inner().clone();
        move || {
            let history_count = service.count_resume_entries(&app)?;
            let history_title_count = service.count_resume_titles(&app)?;
            let has_learned_playback_data = service.has_learned_playback_data(&app)?;

            // Index headers alone answer the count — `load_*_map` parses every record
            // and can repair-write inside a read-only endpoint.
            let library_store = open_store(&app, LIBRARY_STORE_FILE)?;
            let library_index = load_library_index(&library_store)?;
            let library_count = library_index.len();

            let lists_store = open_store(&app, LISTS_STORE_FILE)?;
            let lists_count = load_lists_order(&lists_store)?.len();

            let status_store = open_store(&app, WATCH_STATUS_STORE_FILE)?;
            let statuses = read_watch_status_snapshot(&status_store)?;
            let watch_statuses_count = statuses.index.len();
            let library_status_counts = library_commands::library_status_counts(
                library_index.iter().map(String::as_str),
                &statuses.items,
            );

            Ok(DataStats {
                history_count,
                history_title_count,
                has_learned_playback_data,
                library_count,
                library_status_counts,
                lists_count,
                watch_statuses_count,
            })
        }
    })
    .await
}

/// Wipes all watch history entries and resets the index.
#[command]
pub async fn clear_watch_history(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
) -> Result<(), String> {
    let service = playback_state.inner().clone();
    run_blocking_store_op(move || service.clear(&app)).await
}

/// Wipes all library entries and their watch statuses — a leftover status row would
/// let the details self-heal re-add a cleared title. Statuses clear first: orphaned
/// `id → status` rows are benign and self-repair; the reverse order isn't.
#[command]
pub async fn clear_library(app: AppHandle) -> Result<(), String> {
    run_blocking_store_op(move || {
        let status_store = open_store(&app, WATCH_STATUS_STORE_FILE)?;
        // Parse-validate the library before mutating statuses — a corrupt file must not fail after statuses cleared.
        let store = open_store(&app, LIBRARY_STORE_FILE)?;
        store_helpers::clear_index_domain(
            &status_store,
            &[WATCH_STATUS_ITEM_PREFIX],
            &[WATCH_STATUS_INDEX_KEY],
        )?;
        store_helpers::clear_index_domain(
            &store,
            &[LIBRARY_ITEM_PREFIX],
            &[LIBRARY_INDEX_KEY, LIBRARY_STATUS_ADDED_KEY],
        )
    })
    .await
}

/// Removes every custom list and all their items.
#[command]
pub async fn clear_all_lists(app: AppHandle) -> Result<(), String> {
    with_store(app, LISTS_STORE_FILE, |store| {
        store_helpers::clear_index_domain(
            &store,
            &[LIST_META_KEY_PREFIX, LIST_ITEM_KEY_PREFIX],
            &[LISTS_ORDER_KEY],
        )
    })
    .await
}

/// Clears all watch statuses (Watching / Watched / Plan to Watch / Dropped).
#[command]
pub async fn clear_all_watch_statuses(app: AppHandle) -> Result<(), String> {
    run_blocking_store_op(move || {
        let store = open_store(&app, WATCH_STATUS_STORE_FILE)?;
        let library_store = open_store(&app, LIBRARY_STORE_FILE)?;
        store_helpers::clear_index_domain(
            &store,
            &[WATCH_STATUS_ITEM_PREFIX],
            &[WATCH_STATUS_INDEX_KEY],
        )?;
        if store_helpers::retain_status_added_ids(&library_store, |_| false) {
            library_store.save()?;
        }
        Ok(())
    })
    .await
}
