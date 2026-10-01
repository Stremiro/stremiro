mod episode_mapping;
mod language_preferences;
mod stream_health;
#[cfg(test)]
mod tests;

pub(crate) use self::episode_mapping::PlaybackEpisodeMappingSnapshot;
pub(crate) use self::language_preferences::PlaybackLanguagePreferencesSnapshot;
pub(crate) use self::stream_health::StreamOutcomeReport;

use self::episode_mapping::{
    PLAYBACK_EPISODE_MAPPING_DIGEST_ITEM_PREFIX, PLAYBACK_EPISODE_MAPPING_INDEX_KEY,
    PLAYBACK_EPISODE_MAPPING_ITEM_PREFIX,
};
use self::language_preferences::{
    PLAYBACK_LANGUAGE_PREFERENCES_INDEX_KEY, PLAYBACK_LANGUAGE_PREFERENCES_ITEM_PREFIX,
};
use self::stream_health::{
    PLAYBACK_SOURCE_HEALTH_INDEX_KEY, PLAYBACK_SOURCE_HEALTH_ITEM_PREFIX,
    PLAYBACK_STREAM_FAMILY_INDEX_KEY, PLAYBACK_STREAM_FAMILY_ITEM_PREFIX,
};
use super::history_helpers::should_skip_watch_progress_save;
use super::resume_store::ResumeStore;
use super::store_helpers::decode_string_list;
use super::{normalize_media_id, normalize_watch_progress_type, DurableStore, WatchProgress};
use crate::providers::lock_or_recover;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub(super) const PLAYBACK_STATE_STORE_FILE: &str = "playback_state.json";
/// Health-index prunes scan every indexed entry against the store, so they
/// run at most once per window instead of on every outcome write; entries
/// only become stale after ≥30 minutes anyway.
const HEALTH_PRUNE_MIN_INTERVAL_MS: u64 = 60_000;
/// Trailing-flush delay for stream-outcome writes: a failover chain records
/// several outcomes in seconds, and each `save()` serializes the whole
/// `playback_state.json`. The data is advisory reputation, so the writes
/// coalesce into one disk flush per burst.
const OUTCOME_SAVE_DEBOUNCE_MS: u64 = 750;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlaybackStreamOutcomeKind {
    Verified,
    StartupTimeout,
    LoadFailed,
    Disconnected,
}

impl PlaybackStreamOutcomeKind {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "verified" => Some(Self::Verified),
            "startup-timeout" => Some(Self::StartupTimeout),
            "load-failed" => Some(Self::LoadFailed),
            "disconnected" => Some(Self::Disconnected),
            _ => None,
        }
    }
}

#[derive(Default)]
struct PlaybackRuntimeState {
    persisted_history: HashMap<String, WatchProgress>,
}

/// State shared across Tauri commands. `Clone` shares the same underlying
/// mutexes, so owned copies can cross into `spawn_blocking` closures while the
/// async command future keeps its own `State` guard.
#[derive(Default, Clone)]
pub(crate) struct PlaybackStateService {
    runtime: std::sync::Arc<Mutex<PlaybackRuntimeState>>,
    resume_store: std::sync::Arc<Mutex<Option<ResumeStore>>>,
    history_generation: std::sync::Arc<AtomicU64>,
    source_health_prune_at: std::sync::Arc<AtomicU64>,
    stream_family_prune_at: std::sync::Arc<AtomicU64>,
    /// `playback_state.json` is a shared in-memory map, so `set()`-then-`save()`
    /// sequences are only atomic against each other under this lock. Writers
    /// must take it before checking `history_generation` and hold it until
    /// after `save()`, or a racing `clear`/`remove_keys` can delete the
    /// entries first and then be resurrected by the in-flight writer's save.
    /// Never held across `.await`.
    state_file_write_lock: std::sync::Arc<Mutex<()>>,
    /// One pending deferred `playback_state.json` flush at a time.
    state_save_pending: std::sync::Arc<AtomicBool>,
}

impl PlaybackStateService {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn history_generation(&self) -> u64 {
        self.history_generation.load(Ordering::SeqCst)
    }

    fn bump_history_generation(&self) {
        self.history_generation.fetch_add(1, Ordering::SeqCst);
    }

    /// Serializes `playback_state.json` mutation sections — the
    /// generation-check-to-save contract lives on `state_file_write_lock`.
    fn lock_state_file_write(&self) -> std::sync::MutexGuard<'_, ()> {
        lock_or_recover(&self.state_file_write_lock)
    }

    /// Trailing flush for `record_stream_outcome`: mutations already live in
    /// the shared in-memory map, so one pending timer collapses an outcome
    /// burst into a single disk write. The flush re-opens the store and
    /// serializes the *current* map — including any clear that landed since —
    /// under the same write lock, so it can never resurrect stale entries.
    fn schedule_state_file_save(&self, app: &AppHandle) {
        if self.state_save_pending.swap(true, Ordering::SeqCst) {
            return;
        }

        let app = app.clone();
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(OUTCOME_SAVE_DEBOUNCE_MS)).await;
            service.state_save_pending.store(false, Ordering::SeqCst);
            tauri::async_runtime::spawn_blocking(move || {
                let _guard = service.lock_state_file_write();
                let save_result = crate::commands::open_store(&app, PLAYBACK_STATE_STORE_FILE)
                    .and_then(|store| store.save());
                if let Err(error) = &save_result {
                    crate::operational_log::log_warn(
                        "playback-state",
                        "deferred-state-save",
                        "failed",
                        &[crate::operational_log::field("error", error)],
                    );
                }
            });
        });
    }

    /// Admits one index prune per `HEALTH_PRUNE_MIN_INTERVAL_MS`. A lost CAS
    /// race double-prunes, which is idempotent.
    fn claim_health_prune(gate: &AtomicU64, now_ms: u64) -> bool {
        let last = gate.load(Ordering::Relaxed);
        now_ms.saturating_sub(last) >= HEALTH_PRUNE_MIN_INTERVAL_MS
            && gate
                .compare_exchange(last, now_ms, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
    }

    fn with_resume_store<T>(
        &self,
        app: &AppHandle,
        operation: impl FnOnce(&mut ResumeStore) -> Result<T, String>,
    ) -> Result<T, String> {
        // rusqlite is blocking: keep the critical section to open + one
        // operation. The 5s busy_timeout plus WAL serializes writers, and the
        // connection never crosses an `.await` boundary. All callers run on the
        // dedicated blocking pool via `run_blocking_store_op`, never a bare
        // async worker.
        let mut guard = lock_or_recover(&self.resume_store);

        // `initialize_resume_store` does blocking filesystem + SQLite work;
        // every caller is a Tauri command routed through
        // `run_blocking_store_op`, never a bare async worker.
        let resume_store = match guard.as_mut() {
            Some(store) => store,
            None => guard.insert(self.initialize_resume_store(app)?),
        };

        operation(resume_store)
    }

    fn initialize_resume_store(&self, app: &AppHandle) -> Result<ResumeStore, String> {
        let app_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&app_dir)
            .map_err(|error| format!("Failed to create app data directory: {}", error))?;

        ResumeStore::open(&app_dir.join("playback_resume.sqlite3"))
    }

    /// Generation-guarded save: when `expected_generation` is set, the write
    /// is dropped if a clear/remove/import bumped the generation after the
    /// caller captured it. The check runs inside `with_resume_store` (under
    /// the resume mutex, next to the SQLite write) so a clear racing the
    /// read/write gap cannot resurrect rows; the health-file write is gated
    /// on the same check so the JSON snapshot cannot resurrect either.
    pub(crate) fn track_progress_guarded(
        &self,
        app: &AppHandle,
        key: &str,
        progress: &WatchProgress,
        expected_generation: Option<u64>,
    ) -> Result<bool, String> {
        if expected_generation.is_some_and(|expected| self.history_generation() != expected) {
            return Ok(false);
        }

        self.with_resume_store(app, |resume_store| {
            if expected_generation.is_some_and(|expected| self.history_generation() != expected) {
                return Ok(false);
            }
            // `false` also means the upsert's recency guard suppressed the
            // write: callers must not mark the in-memory snapshot persisted.
            resume_store.upsert_progress(key, progress)
        })
    }

    pub(crate) fn should_skip_history_write(
        &self,
        key: &str,
        incoming: &WatchProgress,
        persisted_history: Option<&WatchProgress>,
    ) -> bool {
        let runtime = lock_or_recover(&self.runtime);

        if let Some(existing) = runtime.persisted_history.get(key) {
            return should_skip_watch_progress_save(existing, incoming);
        }

        persisted_history
            .map(|existing| should_skip_watch_progress_save(existing, incoming))
            .unwrap_or(false)
    }

    pub(crate) fn mark_history_persisted(
        &self,
        key: String,
        progress: WatchProgress,
        expected_generation: u64,
    ) {
        let mut runtime = lock_or_recover(&self.runtime);
        // A clear/remove can finish between the SQLite write and this lock.
        // Never reinstall its deleted snapshot into the coalescing cache.
        if self.history_generation() != expected_generation {
            return;
        }
        runtime.persisted_history.insert(key, progress);
        Self::prune_cached_history(&mut runtime.persisted_history);
    }

    fn prune_cached_history(cached: &mut HashMap<String, WatchProgress>) {
        // Bound in-memory coalescing cache alongside the SQLite global cap so
        // long sessions cannot grow it without limit. Eviction matches the DB
        // order (newest `last_watched`, then `history_key`) and only runs on
        // overflow; a dropped entry self-heals via an extra DB read.
        const MAX_CACHED_HISTORY: usize = 2_000;
        if cached.len() <= MAX_CACHED_HISTORY {
            return;
        }
        let mut ordered: Vec<(u64, String)> = cached
            .iter()
            .map(|(key, item)| (item.last_watched, key.clone()))
            .collect();
        ordered.sort();
        let overflow = cached.len() - MAX_CACHED_HISTORY;
        for (_, key) in ordered.into_iter().take(overflow) {
            cached.remove(&key);
        }
    }

    pub(crate) fn load_resume_entries(
        &self,
        app: &AppHandle,
    ) -> Result<Vec<(String, WatchProgress)>, String> {
        self.with_resume_store(app, |resume_store| resume_store.load_entries())
    }

    pub(crate) fn count_resume_entries(&self, app: &AppHandle) -> Result<usize, String> {
        self.with_resume_store(app, |resume_store| resume_store.count_entries())
    }

    pub(crate) fn total_watch_time_secs(&self, app: &AppHandle) -> Result<u64, String> {
        self.with_resume_store(app, |resume_store| resume_store.total_watch_time_secs())
    }

    pub(crate) fn load_resume_entries_for_media_id(
        &self,
        app: &AppHandle,
        media_id: &str,
    ) -> Result<Vec<(String, WatchProgress)>, String> {
        self.with_resume_store(app, |resume_store| {
            resume_store.load_entries_for_media_id(media_id)
        })
    }

    pub(crate) fn load_resume_entries_for_title(
        &self,
        app: &AppHandle,
        media_type: &str,
        media_id: &str,
    ) -> Result<Vec<(String, WatchProgress)>, String> {
        self.with_resume_store(app, |resume_store| {
            resume_store.load_entries_for_title(media_type, media_id)
        })
    }

    pub(crate) fn merge_history_entries(
        &self,
        app: &AppHandle,
        entries: Vec<(String, WatchProgress)>,
    ) -> Result<usize, String> {
        if entries.is_empty() {
            return Ok(0);
        }

        // Bump before the merge so a save racing the import either lands
        // fully before (recency-guarded) or drops on the generation check,
        // and after so saves starting during the slow merge drop instead of
        // resurrecting cleared rows. Mirrors remove_keys/clear.
        self.bump_history_generation();
        let start_generation = self.history_generation();
        let imported_entries = self.with_resume_store(app, |resume_store| {
            if self.history_generation() != start_generation {
                return Ok(Vec::new());
            }
            resume_store.merge_entries(entries)
        })?;
        let imported = imported_entries.len();
        if imported == 0 {
            self.bump_history_generation();
            return Ok(0);
        }

        // Mark only rows actually written: skipped-by-recency entries must
        // not pollute the coalescing cache, or future saves compare against
        // a snapshot that never reached the database. Bulk insert with a
        // single prune so a 10k import does not pay per-row scans.
        {
            let mut runtime = lock_or_recover(&self.runtime);
            // A racing clear/remove bumps the generation before it takes
            // this lock to wipe `persisted_history`, so an unchanged
            // generation here proves no wipe ran since the merge — without
            // the check, ghost "persisted" snapshots would make
            // `should_skip_history_write` drop post-clear re-saves.
            if self.history_generation() == start_generation {
                for (key, progress) in imported_entries {
                    runtime.persisted_history.insert(key, progress);
                }
                Self::prune_cached_history(&mut runtime.persisted_history);
            }
        }
        // The post-merge bump runs after marking so the check above still
        // sees `start_generation`; it lands before this call returns,
        // dropping saves that started mid-merge.
        self.bump_history_generation();

        Ok(imported)
    }

    pub(crate) fn get_resume_entry(
        &self,
        app: &AppHandle,
        key: &str,
    ) -> Result<Option<WatchProgress>, String> {
        self.with_resume_store(app, |resume_store| resume_store.get_entry(key))
    }

    pub(crate) fn remove_keys(&self, app: &AppHandle, keys: &[String]) -> Result<(), String> {
        if keys.is_empty() {
            return Ok(());
        }

        // Bump before the delete so a save that already passed its generation
        // check cannot slip a write between the check and this delete.
        self.bump_history_generation();
        self.with_resume_store(app, |resume_store| resume_store.remove_keys(keys))?;
        // Fence writes that captured the generation while the delete was running.
        self.bump_history_generation();

        // Source-health pruning belongs to the outcome writers — no health
        // record is keyed to these history rows, and a failed `playback_state.json`
        // open here would have left the deleted snapshots suppressing re-saves.
        let mut runtime = lock_or_recover(&self.runtime);
        for key in keys {
            runtime.persisted_history.remove(key);
        }

        Ok(())
    }

    pub(crate) fn clear(&self, app: &AppHandle) -> Result<(), String> {
        // Double-bump around the delete: the post-delete bump runs before the
        // slow file/store work so a save starting during that IO still drops.
        self.bump_history_generation();
        self.with_resume_store(app, |resume_store| resume_store.clear())?;
        self.bump_history_generation();

        // Wipe the coalescing cache in a scoped lock before the JSON work: a
        // store open/save failure must not leave deleted snapshots in place
        // to suppress re-saves. Never held across store IO.
        {
            let mut runtime = lock_or_recover(&self.runtime);
            runtime.persisted_history.clear();
        }

        let store = crate::commands::open_store(app, PLAYBACK_STATE_STORE_FILE)?;
        // Writers hold this lock across their generation check + mutation +
        // save, so these deletes can't be raced by an in-flight writer that
        // already passed its check.
        let _state_file_guard = self.lock_state_file_write();

        // Item deletes sweep the keyspace by prefix, not by index: a corrupt
        // index parses as empty, which would orphan rows that direct-key
        // reads still resolve — cleared data must not resurrect.
        for key in store.keys() {
            if key.starts_with(PLAYBACK_SOURCE_HEALTH_ITEM_PREFIX)
                || key.starts_with(PLAYBACK_STREAM_FAMILY_ITEM_PREFIX)
                || key.starts_with(PLAYBACK_EPISODE_MAPPING_ITEM_PREFIX)
                || key.starts_with(PLAYBACK_EPISODE_MAPPING_DIGEST_ITEM_PREFIX)
                || key.starts_with(PLAYBACK_LANGUAGE_PREFERENCES_ITEM_PREFIX)
            {
                store.delete(key);
            }
        }

        store.set(
            PLAYBACK_SOURCE_HEALTH_INDEX_KEY,
            json!(Vec::<String>::new()),
        );
        store.set(
            PLAYBACK_STREAM_FAMILY_INDEX_KEY,
            json!(Vec::<String>::new()),
        );
        store.set(
            PLAYBACK_EPISODE_MAPPING_INDEX_KEY,
            json!(Vec::<String>::new()),
        );
        store.set(
            PLAYBACK_LANGUAGE_PREFERENCES_INDEX_KEY,
            json!(Vec::<String>::new()),
        );
        store.save()?;

        Ok(())
    }
}

fn playback_title_scope_key(media_type: Option<&str>, media_id: Option<&str>) -> Option<String> {
    let media_type = normalize_watch_progress_type(media_type?)?;
    let media_id = normalize_media_id(media_id?)?;

    Some(format!("{}:{}", media_type, media_id))
}

/// Evict oldest index entries past `cap`, by each snapshot's `updated_at`.
/// Keeps the freshest entries so active titles survive while browsing many
/// cannot grow the store without bound.
fn prune_index_to_cap(
    store: &DurableStore,
    index: &mut Vec<String>,
    cap: usize,
    updated_at: impl Fn(&DurableStore, &str) -> u64,
    item_key: impl Fn(&str) -> String,
) {
    let overflow = index.len().saturating_sub(cap);
    if overflow == 0 {
        return;
    }
    let mut by_age: Vec<(String, u64)> = index
        .iter()
        .map(|key| (key.clone(), updated_at(store, key)))
        .collect();
    by_age.sort_by_key(|(_, updated_at)| *updated_at);
    let evicted: HashSet<String> = by_age
        .into_iter()
        .take(overflow)
        .map(|(key, _)| key)
        .collect();
    for key in &evicted {
        store.delete(item_key(key));
    }
    index.retain(|key| !evicted.contains(key));
}

fn insert_sorted_unique(index: &mut Vec<String>, value: &str) -> bool {
    match index.binary_search_by(|existing| existing.as_str().cmp(value)) {
        Ok(_) => false,
        Err(position) => {
            index.insert(position, value.to_string());
            true
        }
    }
}

/// Read-only index load: every mutation path re-sets the index it changed,
/// so a read (e.g. preferred-title-source inside selector ranking) must not
/// pay a full store write to materialize an empty index.
fn load_index(store: &DurableStore, index_key: &str) -> Vec<String> {
    store
        .get(index_key)
        .and_then(decode_string_list)
        .unwrap_or_default()
}
