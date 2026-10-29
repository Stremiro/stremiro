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
    remove_legacy_stream_family_reputation, PLAYBACK_SOURCE_HEALTH_INDEX_KEY,
    PLAYBACK_SOURCE_HEALTH_ITEM_PREFIX, PLAYBACK_STREAM_FAMILY_INDEX_KEY,
    PLAYBACK_STREAM_FAMILY_ITEM_PREFIX,
};
use super::history_helpers::should_skip_watch_progress_save;
use super::resume_store::{
    ContinueWatchingDismissal, HistoryMergeError, ProgressWrite, ResumeStore, ResumeTitleIdentity,
};
use super::store_helpers::{clear_index_domain, decode_string_list};
use super::{normalize_media_id, normalize_watch_progress_type, DurableStore, WatchProgress};
use crate::providers::lock_or_recover;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub(super) const PLAYBACK_STATE_STORE_FILE: &str = "playback_state.json";
pub(super) const PLAYBACK_RESUME_STORE_FILE: &str = "playback_resume.sqlite3";
/// Health-index prunes scan every indexed entry, so they run at most once per
/// window instead of on every outcome write.
const HEALTH_PRUNE_MIN_INTERVAL_MS: u64 = 60_000;
/// Trailing-flush delay for stream-outcome writes: a failover chain records several
/// outcomes in seconds and each `save()` serializes the whole `playback_state.json` —
/// advisory reputation data, so bursts coalesce into one flush.
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

/// Shared state carried by `PlaybackStateService` clones — one `Arc` bump shares
/// every primitive. `pub(crate)` only as the `Deref` target; fields stay private.
#[derive(Default)]
pub(crate) struct PlaybackStateInner {
    /// Coalescing cache of snapshots already persisted to SQLite; generation-gated
    /// so a clear/remove can never be resurrected by a late writer.
    persisted_history: Mutex<HashMap<String, WatchProgress>>,
    resume_store: Mutex<Option<ResumeStore>>,
    history_generation: AtomicU64,
    /// Advanced only by clear and backup import: explicit restores and watched marks
    /// must not be dropped by unrelated merges, which bump `history_generation`.
    history_reset_epoch: AtomicU64,
    source_health_prune_at: AtomicU64,
    stream_family_prune_at: AtomicU64,
    /// `set()`-then-`save()` on the shared in-memory map is only atomic under this
    /// lock: writers must hold it from the `history_generation` check until after
    /// `save()`, or a racing `clear`/`remove_keys` gets resurrected by the save.
    /// Never held across `.await`.
    state_file_write_lock: Mutex<()>,
    /// One pending deferred `playback_state.json` flush at a time.
    state_save_pending: AtomicBool,
    stream_family_keys_migrated: AtomicBool,
}

/// State shared across Tauri commands. `Clone` shares the underlying state so owned
/// copies can cross into `spawn_blocking` closures. Deref reaches the inner primitives
/// directly (`service.resume_store`, not `service.inner.*`).
#[derive(Default, Clone)]
pub(crate) struct PlaybackStateService {
    inner: Arc<PlaybackStateInner>,
}

impl std::ops::Deref for PlaybackStateService {
    type Target = PlaybackStateInner;

    fn deref(&self) -> &PlaybackStateInner {
        &self.inner
    }
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

    pub(crate) fn history_reset_epoch(&self) -> u64 {
        self.history_reset_epoch.load(Ordering::SeqCst)
    }

    fn bump_history_reset_epoch(&self) {
        self.history_reset_epoch.fetch_add(1, Ordering::SeqCst);
    }

    /// Serializes `playback_state.json` mutations — the generation-check-to-save contract lives on this lock.
    fn lock_state_file_write(&self) -> std::sync::MutexGuard<'_, ()> {
        lock_or_recover(&self.state_file_write_lock)
    }

    fn open_state_store(&self, app: &AppHandle) -> Result<DurableStore, String> {
        let store = crate::commands::open_store(app, PLAYBACK_STATE_STORE_FILE)?;
        self.migrate_legacy_stream_families(&store)?;
        Ok(store)
    }

    fn migrate_legacy_stream_families(&self, store: &DurableStore) -> Result<(), String> {
        if self.stream_family_keys_migrated.load(Ordering::Acquire) {
            return Ok(());
        }
        let _guard = self.lock_state_file_write();
        if !self.stream_family_keys_migrated.load(Ordering::Relaxed) {
            remove_legacy_stream_family_reputation(store);
            stream_health::migrate_addon_source_ids(store);
            // A failed save leaves the migration retryable even after the shared map changed.
            store.save()?;
            self.stream_family_keys_migrated
                .store(true, Ordering::Release);
        }
        Ok(())
    }

    /// Trailing flush for `record_stream_outcome`: one pending timer collapses an
    /// outcome burst into a single disk write. The flush serializes the *current*
    /// map under the write lock, so it can never resurrect stale entries.
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
        // rusqlite is blocking: critical section is open + one operation, the
        // connection never crosses `.await`. All callers run on the blocking pool
        // via `run_blocking_store_op`, never a bare async worker.
        let mut guard = lock_or_recover(&self.resume_store);

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

        ResumeStore::open_or_quarantine(&app_dir.join(PLAYBACK_RESUME_STORE_FILE))
    }

    /// Drops saves superseded by clear/remove/import — re-checks the generation under
    /// the resume mutex next to the SQLite write so the read/write gap can't resurrect rows.
    pub(crate) fn track_progress_guarded(
        &self,
        app: &AppHandle,
        key: String,
        progress: WatchProgress,
        expected_generation: u64,
    ) -> Result<(), String> {
        if self.history_generation() != expected_generation {
            return Ok(());
        }

        self.with_resume_store(app, |resume_store| {
            if self.history_generation() != expected_generation {
                return Ok(());
            }
            // Mark under the resume lock to keep the cache in commit order; a recency-guarded no-op marks nothing.
            if let ProgressWrite::Written { pruned } =
                resume_store.upsert_progress(&key, &progress)?
            {
                self.mark_history_persisted([(key, progress)], pruned, expected_generation);
            }
            Ok(())
        })
    }

    pub(crate) fn should_skip_history_write(
        &self,
        key: &str,
        incoming: &WatchProgress,
        persisted_history: Option<&WatchProgress>,
    ) -> bool {
        self.cached_history_write_decision(key, incoming)
            .or_else(|| {
                persisted_history
                    .map(|existing| should_skip_watch_progress_save(existing, incoming))
            })
            .unwrap_or(false)
    }

    pub(crate) fn cached_history_write_decision(
        &self,
        key: &str,
        incoming: &WatchProgress,
    ) -> Option<bool> {
        lock_or_recover(&self.persisted_history)
            .get(key)
            .map(|existing| should_skip_watch_progress_save(existing, incoming))
    }

    pub(crate) fn mark_history_persisted(
        &self,
        entries: impl IntoIterator<Item = (String, WatchProgress)>,
        pruned: bool,
        expected_generation: u64,
    ) {
        let mut persisted = lock_or_recover(&self.persisted_history);
        // A clear/remove can land between the SQLite write and this lock — never reinstall its deleted snapshot.
        if self.history_generation() != expected_generation {
            return;
        }
        if pruned {
            // Pruning deleted rows this cache may still hold — a stale snapshot would suppress re-saves.
            persisted.clear();
            return;
        }
        persisted.extend(entries);
        Self::prune_cached_history(&mut persisted);
    }

    fn prune_cached_history(cached: &mut HashMap<String, WatchProgress>) {
        // Bound alongside the SQLite cap; eviction matches the DB order (newest
        // `last_watched`, then `history_key`). A dropped entry self-heals via an extra DB read.
        const MAX_CACHED_HISTORY: usize = 2_000;
        if cached.len() <= MAX_CACHED_HISTORY {
            return;
        }
        let mut ordered: Vec<(u64, &String)> = cached
            .iter()
            .map(|(key, item)| (item.last_watched, key))
            .collect();
        let overflow = cached.len() - MAX_CACHED_HISTORY;
        ordered.select_nth_unstable(overflow - 1);
        let victims: Vec<String> = ordered
            .into_iter()
            .take(overflow)
            .map(|(_, key)| key.clone())
            .collect();
        for key in victims {
            cached.remove(&key);
        }
    }

    pub(crate) fn load_resume_entries(
        &self,
        app: &AppHandle,
    ) -> Result<Vec<(String, WatchProgress)>, String> {
        self.with_resume_store(app, |resume_store| resume_store.load_entries())
    }

    pub(crate) fn load_continue_watching_entries(
        &self,
        app: &AppHandle,
    ) -> Result<Vec<(String, WatchProgress)>, String> {
        self.with_resume_store(app, |resume_store| {
            resume_store.load_continue_watching_entries()
        })
    }

    pub(crate) fn load_continue_watching_dismissals(
        &self,
        app: &AppHandle,
    ) -> Result<Vec<ContinueWatchingDismissal>, String> {
        self.with_resume_store(app, |resume_store| {
            resume_store.load_continue_watching_dismissals()
        })
    }

    pub(crate) fn set_continue_watching_dismissed(
        &self,
        app: &AppHandle,
        media_type: &str,
        media_id: &str,
        dismissed: bool,
    ) -> Result<(), String> {
        self.with_resume_store(app, |resume_store| {
            if dismissed {
                resume_store.dismiss_continue_watching(media_type, media_id)
            } else {
                resume_store.restore_continue_watching(media_type, media_id)
            }
        })
    }

    pub(crate) fn load_latest_resume_title_identities(
        &self,
        app: &AppHandle,
        media_ids: &[&str],
    ) -> Result<Vec<ResumeTitleIdentity>, String> {
        if media_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.with_resume_store(app, |resume_store| {
            resume_store.load_latest_title_identities(media_ids)
        })
    }

    pub(crate) fn resume_counts(&self, app: &AppHandle) -> Result<(usize, usize), String> {
        self.with_resume_store(app, |resume_store| resume_store.counts())
    }

    pub(crate) fn has_learned_playback_data(&self, app: &AppHandle) -> Result<bool, String> {
        let store = self.open_state_store(app)?;
        Ok([
            PLAYBACK_SOURCE_HEALTH_INDEX_KEY,
            PLAYBACK_STREAM_FAMILY_INDEX_KEY,
            PLAYBACK_EPISODE_MAPPING_INDEX_KEY,
            PLAYBACK_LANGUAGE_PREFERENCES_INDEX_KEY,
        ]
        .iter()
        .any(|key| {
            store.with_value(key, |value| {
                value
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|members| members.iter().any(serde_json::Value::is_string))
            })
        }))
    }

    pub(crate) fn total_watch_time_secs(&self, app: &AppHandle) -> Result<u64, String> {
        self.with_resume_store(app, |resume_store| resume_store.total_watch_time_secs())
    }

    pub(crate) fn load_resume_entries_for_media_ids(
        &self,
        app: &AppHandle,
        media_ids: &[&str],
    ) -> Result<Vec<(String, WatchProgress)>, String> {
        self.with_resume_store(app, |resume_store| {
            resume_store.load_entries_for_media_ids(media_ids)
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

    pub(crate) fn load_resume_entries_for_episode(
        &self,
        app: &AppHandle,
        media_type: &str,
        media_id: &str,
        season: u32,
        episode: u32,
    ) -> Result<Vec<(String, WatchProgress)>, String> {
        self.with_resume_store(app, |resume_store| {
            resume_store.load_entries_for_episode(media_type, media_id, season, episode)
        })
    }

    pub(crate) fn import_history_entries(
        &self,
        app: &AppHandle,
        entries: Vec<(String, WatchProgress)>,
        dismissals: Vec<ContinueWatchingDismissal>,
    ) -> Result<usize, HistoryMergeError> {
        self.bump_history_reset_epoch();
        self.merge_history_entries(app, entries, true, dismissals)
    }

    pub(crate) fn merge_history_entries(
        &self,
        app: &AppHandle,
        entries: Vec<(String, WatchProgress)>,
        is_backup_import: bool,
        dismissals: Vec<ContinueWatchingDismissal>,
    ) -> Result<usize, HistoryMergeError> {
        if entries.is_empty() {
            return Ok(0);
        }

        // Bump before the merge so a racing save lands fully before (recency-guarded)
        // or drops on the generation check. Mirrors remove_keys/clear.
        self.bump_history_generation();
        let start_generation = self.history_generation();
        // Mark only rows actually written: recency-skipped entries must not pollute
        // the coalescing cache, or future saves compare against a snapshot that
        // never reached the database.
        let imported = self.with_resume_store(app, |resume_store| {
            if self.history_generation() != start_generation {
                return Ok(Ok(0));
            }
            Ok(resume_store
                .merge_entries(entries, is_backup_import, dismissals)
                .map(|(imported_entries, pruned)| {
                    let imported = imported_entries.len();
                    self.mark_history_persisted(imported_entries, pruned, start_generation);
                    imported
                }))
        })??;
        // Post-merge bump runs after marking so the check above still sees
        // `start_generation`; it drops saves that started mid-merge.
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

        // Bump before the delete so a checked save can't slip a write in between.
        self.bump_history_generation();
        self.with_resume_store(app, |resume_store| resume_store.remove_keys(keys))?;
        // Fence writes that captured the generation while the delete was running.
        self.bump_history_generation();

        // Source-health pruning belongs to the outcome writers — no health record is
        // keyed to these history rows.
        let mut persisted = lock_or_recover(&self.persisted_history);
        for key in keys {
            persisted.remove(key);
        }

        Ok(())
    }

    pub(crate) fn clear(&self, app: &AppHandle) -> Result<(), String> {
        // A failed JSON open must not leave cached snapshots suppressing re-saves.
        {
            let mut persisted = lock_or_recover(&self.persisted_history);
            persisted.clear();
        }

        let store = self.open_state_store(app)?;
        self.bump_history_reset_epoch();
        // Double-bump around the delete so a save starting during the slow IO still drops.
        self.bump_history_generation();
        self.with_resume_store(app, |resume_store| resume_store.clear())?;
        self.bump_history_generation();
        // A save may have refilled the cache during the JSON preflight.
        lock_or_recover(&self.persisted_history).clear();

        // Writers hold this lock across check + mutation + save, so these deletes
        // can't be raced by an in-flight writer past its check.
        let _state_file_guard = self.lock_state_file_write();

        clear_index_domain(
            &store,
            &[
                PLAYBACK_SOURCE_HEALTH_ITEM_PREFIX,
                PLAYBACK_STREAM_FAMILY_ITEM_PREFIX,
                PLAYBACK_EPISODE_MAPPING_ITEM_PREFIX,
                PLAYBACK_EPISODE_MAPPING_DIGEST_ITEM_PREFIX,
                PLAYBACK_LANGUAGE_PREFERENCES_ITEM_PREFIX,
            ],
            &[
                PLAYBACK_SOURCE_HEALTH_INDEX_KEY,
                PLAYBACK_STREAM_FAMILY_INDEX_KEY,
                PLAYBACK_EPISODE_MAPPING_INDEX_KEY,
                PLAYBACK_LANGUAGE_PREFERENCES_INDEX_KEY,
            ],
        )
    }
}

fn playback_title_scope_key(media_type: Option<&str>, media_id: Option<&str>) -> Option<String> {
    let media_type = normalize_watch_progress_type(media_type?)?;
    let media_id = normalize_media_id(media_id?)?;

    Some(format!("{}:{}", media_type, media_id))
}

/// Evicts oldest index entries past `cap` by each snapshot's `updated_at` — keeps
/// the freshest entries so browsing can't grow the store without bound.
fn prune_index_to_cap(
    store: &DurableStore,
    index: &mut Vec<String>,
    cap: usize,
    updated_at: impl Fn(&DurableStore, &str) -> u64,
    item_key: impl Fn(&str) -> String,
) -> HashSet<String> {
    let overflow = index.len().saturating_sub(cap);
    if overflow == 0 {
        return HashSet::new();
    }
    let scored: Vec<(String, u64, usize)> = index
        .iter()
        .enumerate()
        .map(|(ordinal, key)| (key.clone(), updated_at(store, key), ordinal))
        .collect();
    evict_least_active(store, index, scored, overflow, item_key)
}

/// Drop the `overflow` lowest-scored keys from `index`, deleting their store
/// items, and return them. `scored` is `(key, recency, ordinal)` tuples over index members.
fn evict_least_active(
    store: &DurableStore,
    index: &mut Vec<String>,
    mut scored: Vec<(String, u64, usize)>,
    overflow: usize,
    item_key: impl Fn(&str) -> String,
) -> HashSet<String> {
    if overflow == 0 {
        return HashSet::new();
    }
    if overflow < scored.len() {
        scored.select_nth_unstable_by(
            overflow,
            |(_, left_score, left_ordinal), (_, right_score, right_ordinal)| {
                (left_score, left_ordinal).cmp(&(right_score, right_ordinal))
            },
        );
    }
    let evicted: HashSet<String> = scored
        .into_iter()
        .take(overflow)
        .map(|(key, _, _)| key)
        .collect();
    for key in &evicted {
        store.delete(item_key(key));
    }
    index.retain(|key| !evicted.contains(key));
    evicted
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

fn merge_sorted_unique(index: &mut Vec<String>, mut values: Vec<String>) -> bool {
    values.sort_unstable();
    values.dedup();
    merge_presorted_unique(index, values)
}

fn merge_presorted_unique(index: &mut Vec<String>, values: Vec<String>) -> bool {
    let previous_len = index.len();
    let mut merged = Vec::with_capacity(previous_len + values.len());
    let mut values = values.into_iter().peekable();
    for key in index.drain(..) {
        while let Some(value) = values.next_if(|value| value < &key) {
            merged.push(value);
        }
        let _ = values.next_if(|value| value == &key);
        merged.push(key);
    }
    merged.extend(values);
    let changed = merged.len() != previous_len;
    *index = merged;
    changed
}

/// Read-only index load: mutation paths re-set the index they changed, so a read
/// must not pay a store write to materialize an empty index. Advisory data degrades
/// to empty rather than erroring; `store_helpers::load_index` is the strict counterpart.
fn load_advisory_index(store: &DurableStore, index_key: &str) -> Vec<String> {
    store
        .get(index_key)
        .and_then(decode_string_list)
        .unwrap_or_default()
}
