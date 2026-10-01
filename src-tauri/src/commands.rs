use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{command, AppHandle, State};

mod addon_registry;
pub(crate) mod app_update_commands;
pub(crate) mod backup_commands;
pub(crate) mod config_commands;
pub(crate) mod config_store;
mod durable_store;
mod episode_navigation;
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
mod probe_pool;
mod resume_store;
pub(crate) mod search_commands;
mod startup_validation;
mod store_helpers;
pub(crate) mod stream_commands;
mod stream_coordinator;
mod stream_fetcher;
mod stream_resolver;
mod streaming_helpers;
#[cfg(test)]
mod tests;
pub(crate) mod watch_history_commands;
pub(crate) mod watch_status_commands;

use list_helpers::{load_lists_order, LISTS_ORDER_KEY, LIST_ITEM_KEY_PREFIX, LIST_META_KEY_PREFIX};
use playback_state::PlaybackStateService;

/// Serializes blocking store work: every JSON-store/SQLite command is a
/// read-modify-write, and two ops interleaving load→mutate→save let a stale
/// snapshot silently drop the other command's write (e.g. a library add
/// racing a status clear, or a backup import racing a progress tick). One
/// lock covers every store — ops are milliseconds and a single lock cannot
/// deadlock.
static STORE_OP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Run a closure that performs blocking SQLite/store/filesystem work on the
/// dedicated blocking pool instead of an async runtime worker. `Send + 'static`
/// inputs cross the boundary by value; the closure itself runs synchronously
/// off-thread and returns its result. Bounded by a timeout so a wedged store
/// never blocks navigation or shutdown; callers treat a timeout as
/// best-effort failure and proceed.
/// Shared budget for blocking hops off the async runtime (store ops, native
/// plugin IPC, user-path file IO): a wedged callee must fail instead of
/// pinning its IPC promise and blocking-pool thread forever.
pub(crate) const BLOCKING_OP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

pub(crate) async fn run_blocking_store_op<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let join_handle = tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::providers::lock_or_recover(&STORE_OP_LOCK);
        operation()
    });
    let join_result = tokio::time::timeout(BLOCKING_OP_TIMEOUT, join_handle)
        .await
        .map_err(|_| "Background persistence timed out.".to_string())?;
    join_result.map_err(|error| format!("Background persistence task failed: {}", error))?
}

pub(crate) use durable_store::{
    open_store, resolve_store_path, write_atomic_file, DurableStore, DurableStoreRegistry,
};
pub(crate) use media_type::{normalize_stream_media_type, normalize_watch_progress_type};
pub(crate) use startup_validation::validate_startup_stores;
use store_helpers::{load_library_index, load_watch_status_index};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WatchProgress {
    pub id: String,    // imdb_id
    pub type_: String, // "movie" or "series"
    // `None` fields omit instead of emitting `null`: the TS contract is
    // `field?: T`, and absent keeps `=== undefined` guards truthful.
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
    /// Credential-bearing and short-lived: never accepted from IPC, never
    /// serialized to the webview, never written to durable state. The field
    /// only exists so the positional SQLite read can drop legacy values.
    #[serde(skip)]
    pub last_stream_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_stream_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_stream_lookup_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_stream_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    /// Stable addon-instance id (`AddonConfig.id`): the source-health and
    /// resume-binding identity of record, independent of the display name.
    /// `None` on rows written before instance-id plumbing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_start_time: Option<f64>,
}

const LIBRARY_INDEX_KEY: &str = "library_index";
const LIBRARY_ITEM_PREFIX: &str = "library_item:";
const WATCH_STATUS_INDEX_KEY: &str = "watch_status_index";
const WATCH_STATUS_ITEM_PREFIX: &str = "watch_status:";
const MAX_SEARCH_QUERY_CHARS: usize = 120;
/// Char bounds for media identity fields crossing IPC into durable state:
/// ids are addon-owned opaque strings, titles feed the webview.
pub(crate) const MEDIA_ID_MAX_CHARS: usize = 256;
pub(crate) const MEDIA_TITLE_MAX_CHARS: usize = 512;
/// Poster/backdrop/logo URLs are rendered by the webview: bounded so
/// `data:`/`file:` payloads and unbounded strings never persist.
const MEDIA_IMAGE_URL_MAX_CHARS: usize = 2_048;
const SETTINGS_STORE_FILE: &str = "settings.json";
const LIBRARY_STORE_FILE: &str = "library.json";
const LISTS_STORE_FILE: &str = "lists.json";
const WATCH_STATUS_STORE_FILE: &str = "watch_status.json";

fn normalize_non_empty(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Media ids become store keys and addon request path segments: opaque-field
/// hygiene plus a char bound — reject overlong input rather than truncate so
/// two hostile ids can't collide onto one key, and unbounded strings never
/// persist or fan out into outbound URLs.
pub(crate) fn normalize_media_id(input: &str) -> Option<String> {
    normalize_opaque_field(input).filter(|id| id.chars().count() <= MEDIA_ID_MAX_CHARS)
}

/// Normalize a persisted media image URL (poster/backdrop/logo): trimmed,
/// char-bounded, and gated by the same fetch policy as addon-ingress
/// artwork — http(s) only, no credentials, no non-routable host. Anything
/// else returns `None` so hostile or corrupt input degrades to "no
/// artwork" instead of persisting.
pub(crate) fn normalize_media_image_url(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MEDIA_IMAGE_URL_MAX_CHARS {
        return None;
    }
    let normalized = streaming_helpers::normalize_http_url(trimmed)?;
    crate::providers::addon_resource::is_fetchable_http_url(&normalized).then_some(normalized)
}

/// Opaque free-text fields that cross the IPC boundary (source names, stream
/// metadata, recovery extras, skip-segment types): trim, then reject empty
/// and the literal `null`/`undefined` sentinels leaked by JSON callers.
/// Single owner.
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

// ─── Skip Times ──────────────────────────────────────────────────────────────

/// Fetch skippable segment data (intro/recap/outro/preview) from SkipDB, the
/// single skip-data provider.
///
/// SkipDB keys on the IMDb id: the supplied `imdb_id` wins, then a tt-shaped
/// media id (Cinemeta ids are IMDb ids). Legacy `kitsu:` history rows carry
/// no IMDb anchor and return an empty result. Movies omit season/episode;
/// episode rows send both. `duration_secs` is the playing stream's length —
/// it enables SkipDB's duration matching/shifting for this cut.
///
/// Always returns an empty result on errors or when no data exists — callers
/// treat missing skip times as a normal crowdsourced condition.
#[command]
pub async fn get_skip_times(
    skip_provider: State<'_, crate::providers::skip_times::SkipTimesProvider>,
    media_type: String,
    id: String,
    imdb_id: Option<String>,
    season: Option<u32>,
    episode: Option<u32>,
    duration_secs: Option<f64>,
) -> Result<crate::providers::skip_times::SkipTimesResult, String> {
    // The id bounds the IPC surface the same way other media ids are; the
    // lookup itself is keyed on the IMDb anchor.
    let Some(id) = normalize_media_id(&id) else {
        return Ok(crate::providers::skip_times::SkipTimesResult::default());
    };

    let imdb_id = imdb_id
        .as_deref()
        .and_then(crate::providers::skip_times::normalize_imdb_id)
        .or_else(|| crate::providers::skip_times::normalize_imdb_id(&id));
    let Some(imdb_id) = imdb_id else {
        return Ok(crate::providers::skip_times::SkipTimesResult::default());
    };

    // SkipDB wants both coordinates for an episode and neither for a movie.
    // A lone season or episode can't name an episode — never silently
    // default to S1, which would pull the wrong episode's segments.
    let (season, episode) = if media_type.trim().eq_ignore_ascii_case("movie") {
        (None, None)
    } else {
        match (season, episode) {
            (Some(season), Some(episode)) => (Some(season), Some(episode)),
            _ => return Ok(crate::providers::skip_times::SkipTimesResult::default()),
        }
    };

    // Duration enables SkipDB's matching/shifting; bound it so a malformed
    // value never reaches the outbound query (24h covers any stream).
    const MAX_STREAM_DURATION_SECS: f64 = 24.0 * 60.0 * 60.0;
    let duration_secs = duration_secs
        .filter(|d| d.is_finite() && *d > 0.0 && *d <= MAX_STREAM_DURATION_SECS)
        .map(|d| d.round());

    Ok(skip_provider
        .get_segments(&imdb_id, season, episode, duration_secs)
        .await)
}

// ─── Data Management ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct DataStats {
    pub history_count: usize,
    pub library_count: usize,
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
        let app = app.clone();
        let service = playback_state.inner().clone();
        move || {
            let history_count = service.count_resume_entries(&app)?;

            // Index headers alone answer the count — `load_*_map` parses
            // every record and can repair-write inside a read-only stats
            // endpoint.
            let library_store = open_store(&app, LIBRARY_STORE_FILE)?;
            let library_count = load_library_index(&library_store)?.len();

            let lists_store = open_store(&app, LISTS_STORE_FILE)?;
            let lists_count = load_lists_order(&lists_store)?.len();

            let status_store = open_store(&app, WATCH_STATUS_STORE_FILE)?;
            let watch_statuses_count = load_watch_status_index(&status_store)?.len();

            Ok(DataStats {
                history_count,
                library_count,
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
    run_blocking_store_op({
        let app = app.clone();
        let service = playback_state.inner().clone();
        move || service.clear(&app)
    })
    .await
}

/// Wipes all library entries and their watch statuses: a leftover status
/// row would let the details self-heal re-add a deliberately cleared title
/// on next open, and orphaned `id → status` rows have no render surface.
#[command]
pub async fn clear_library(app: AppHandle) -> Result<(), String> {
    run_blocking_store_op(move || {
        let store = open_store(&app, LIBRARY_STORE_FILE)?;
        store_helpers::clear_index_domain(&store, &[LIBRARY_ITEM_PREFIX], LIBRARY_INDEX_KEY)?;
        let status_store = open_store(&app, WATCH_STATUS_STORE_FILE)?;
        store_helpers::clear_index_domain(
            &status_store,
            &[WATCH_STATUS_ITEM_PREFIX],
            WATCH_STATUS_INDEX_KEY,
        )
    })
    .await
}

/// Removes every custom list and all their items.
#[command]
pub async fn clear_all_lists(app: AppHandle) -> Result<(), String> {
    run_blocking_store_op(move || {
        let store = open_store(&app, LISTS_STORE_FILE)?;
        store_helpers::clear_index_domain(
            &store,
            &[LIST_META_KEY_PREFIX, LIST_ITEM_KEY_PREFIX],
            LISTS_ORDER_KEY,
        )
    })
    .await
}

/// Clears all watch statuses (Watching / Watched / Plan to Watch / Dropped).
#[command]
pub async fn clear_all_watch_statuses(app: AppHandle) -> Result<(), String> {
    run_blocking_store_op(move || {
        let store = open_store(&app, WATCH_STATUS_STORE_FILE)?;
        store_helpers::clear_index_domain(
            &store,
            &[WATCH_STATUS_ITEM_PREFIX],
            WATCH_STATUS_INDEX_KEY,
        )
    })
    .await
}
