use super::{
    insert_sorted_unique, load_index, playback_title_scope_key, PlaybackStateService,
    PlaybackStreamOutcomeKind, PLAYBACK_STATE_STORE_FILE,
};
use crate::commands::stream_coordinator::{
    DEFAULT_SOURCE_HEALTH_PRIORITY, DEFAULT_STREAM_FAMILY_PRIORITY,
};
use crate::commands::streaming_helpers::{
    normalize_source_id, normalize_source_key, source_health_key,
};
use crate::commands::{now_unix_millis, DurableStore};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use tauri::AppHandle;

pub(super) const PLAYBACK_SOURCE_HEALTH_INDEX_KEY: &str = "playback_source_health_index";
pub(super) const PLAYBACK_STREAM_FAMILY_INDEX_KEY: &str = "playback_stream_family_index";
pub(super) const PLAYBACK_SOURCE_HEALTH_ITEM_PREFIX: &str = "playback_source_health_item:";
pub(super) const PLAYBACK_STREAM_FAMILY_ITEM_PREFIX: &str = "playback_stream_family_item:";
const SOURCE_HEALTH_RECENT_FAILURE_WINDOW_MS: u64 = 1000 * 60 * 30;
const SOURCE_HEALTH_RECENT_SUCCESS_WINDOW_MS: u64 = 1000 * 60 * 60 * 6;
const STREAM_FAMILY_RECENT_FAILURE_WINDOW_MS: u64 = 1000 * 60 * 60 * 18;
const STREAM_FAMILY_RECENT_SUCCESS_WINDOW_MS: u64 = 1000 * 60 * 60 * 24 * 7;
// Hard count bound on top of the recency windows: a 7-day success window
// alone still lets a heavy session grow the index without limit.
const STREAM_FAMILY_INDEX_MAX_ENTRIES: usize = 512;
/// Same hard bound for the source-health index: `record_stream_outcome`
/// indexes IPC-supplied source identities, and recency-only pruning lets N
/// distinct ids grow the index — and every prune's store-read count —
/// without limit.
const SOURCE_HEALTH_INDEX_MAX_ENTRIES: usize = 512;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlaybackSourceHealthSnapshot {
    pub last_success_at: Option<u64>,
    pub last_failure_at: Option<u64>,
    pub consecutive_failures: u32,
    pub cooldown_until: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlaybackStreamFamilySnapshot {
    /// Instance id of the addon that produced the last verified outcome;
    /// `None` on snapshots written before instance-id health keys.
    #[serde(default)]
    pub source_id: Option<String>,
    pub last_success_at: Option<u64>,
    pub last_success_season: Option<u32>,
    pub last_success_episode: Option<u32>,
    pub last_failure_at: Option<u64>,
    pub last_failure_season: Option<u32>,
    pub last_failure_episode: Option<u32>,
    pub consecutive_failures: u32,
    pub cooldown_until: Option<u64>,
}

/// One playback stream outcome report: the normalized title scope plus the
/// resolved stream's identity fields that feed the source-health and
/// stream-family reputation snapshots.
pub(crate) struct StreamOutcomeReport {
    pub media_id: String,
    /// Canonical history-namespace type (`movie`/`series`) — `anime` folds to
    /// `series` before the report is built.
    pub media_type: &'static str,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub source_id: Option<String>,
    pub stream_family: Option<String>,
    pub outcome: PlaybackStreamOutcomeKind,
    pub timestamp_ms: u64,
}

pub(super) fn playback_source_health_item_key(key: &str) -> String {
    format!("{}{}", PLAYBACK_SOURCE_HEALTH_ITEM_PREFIX, key)
}

pub(super) fn playback_stream_family_item_key(key: &str) -> String {
    format!("{}{}", PLAYBACK_STREAM_FAMILY_ITEM_PREFIX, key)
}

pub(super) fn playback_stream_family_snapshot_key(scope_key: &str, stream_family: &str) -> String {
    format!("{}|{}", scope_key, stream_family)
}

pub(super) fn load_playback_stream_family_snapshot(
    store: &DurableStore,
    key: &str,
) -> Option<PlaybackStreamFamilySnapshot> {
    store
        .get(playback_stream_family_item_key(key))
        .and_then(|value| serde_json::from_value::<PlaybackStreamFamilySnapshot>(value).ok())
}

fn playback_snapshot_belongs_to_scope(snapshot_key: &str, scope_key: &str) -> bool {
    snapshot_key
        .strip_prefix(scope_key)
        .is_some_and(|suffix| suffix.starts_with('|'))
}

pub(super) fn recent_successful_source(
    snapshot: PlaybackStreamFamilySnapshot,
    now_ms: u64,
) -> Option<(String, u64)> {
    let last_success_at = snapshot.last_success_at?;
    if snapshot
        .last_failure_at
        .is_some_and(|failed| failed >= last_success_at)
    {
        return None;
    }
    if last_success_at > now_ms || now_ms - last_success_at > STREAM_FAMILY_RECENT_SUCCESS_WINDOW_MS
    {
        return None;
    }
    // Snapshots written before `source_id` existed contribute no
    // affinity — guessing an instance from a shared display name
    // could attribute the preference to the wrong addon.
    Some((
        snapshot
            .source_id
            .as_deref()
            .and_then(normalize_source_id)?,
        last_success_at,
    ))
}

pub(super) fn preferred_title_source_id_from_success(
    store: &DurableStore,
    scope_key: &str,
    now_ms: u64,
) -> Option<String> {
    let stream_family_index = load_index(store, PLAYBACK_STREAM_FAMILY_INDEX_KEY);

    stream_family_index
        .into_iter()
        .filter(|snapshot_key| playback_snapshot_belongs_to_scope(snapshot_key, scope_key))
        .filter_map(|snapshot_key| load_playback_stream_family_snapshot(store, &snapshot_key))
        .filter_map(|snapshot| recent_successful_source(snapshot, now_ms))
        .max_by_key(|(_, last_success_at)| *last_success_at)
        .map(|(source_id, _)| source_id)
}

pub(super) fn load_source_health_snapshot(
    store: &DurableStore,
    key: &str,
) -> Option<PlaybackSourceHealthSnapshot> {
    store
        .get(playback_source_health_item_key(key))
        .and_then(|value| serde_json::from_value::<PlaybackSourceHealthSnapshot>(value).ok())
}

pub(super) fn score_source_health_priority(
    snapshot: Option<&PlaybackSourceHealthSnapshot>,
    now_ms: u64,
) -> u8 {
    let Some(snapshot) = snapshot else {
        return DEFAULT_SOURCE_HEALTH_PRIORITY;
    };

    if snapshot
        .cooldown_until
        .is_some_and(|cooldown_until| cooldown_until > now_ms)
    {
        return 0;
    }

    if snapshot.last_failure_at.is_some_and(|last_failure_at| {
        now_ms.saturating_sub(last_failure_at) <= SOURCE_HEALTH_RECENT_FAILURE_WINDOW_MS
            && snapshot.consecutive_failures >= 1
    }) {
        return 1;
    }

    if snapshot.last_success_at.is_some_and(|last_success_at| {
        now_ms.saturating_sub(last_success_at) <= SOURCE_HEALTH_RECENT_SUCCESS_WINDOW_MS
    }) {
        return 3;
    }

    DEFAULT_SOURCE_HEALTH_PRIORITY
}

fn is_nearby_episode(
    target_season: Option<u32>,
    target_episode: Option<u32>,
    candidate_season: Option<u32>,
    candidate_episode: Option<u32>,
) -> bool {
    match (
        target_season,
        target_episode,
        candidate_season,
        candidate_episode,
    ) {
        (Some(ts), Some(te), Some(cs), Some(ce)) => ts == cs && te.abs_diff(ce) <= 2,
        _ => false,
    }
}

pub(super) fn score_stream_family_priority(
    snapshot: Option<&PlaybackStreamFamilySnapshot>,
    season: Option<u32>,
    episode: Option<u32>,
    now_ms: u64,
) -> u8 {
    let Some(snapshot) = snapshot else {
        return DEFAULT_STREAM_FAMILY_PRIORITY;
    };

    let recent_nearby_failure = snapshot.last_failure_at.is_some_and(|last_failure_at| {
        now_ms.saturating_sub(last_failure_at) <= STREAM_FAMILY_RECENT_FAILURE_WINDOW_MS
            && is_nearby_episode(
                season,
                episode,
                snapshot.last_failure_season,
                snapshot.last_failure_episode,
            )
    });

    if snapshot
        .cooldown_until
        .is_some_and(|cooldown_until| cooldown_until > now_ms)
        && recent_nearby_failure
    {
        return 0;
    }

    if recent_nearby_failure && snapshot.consecutive_failures >= 1 {
        return 1;
    }

    if snapshot.last_success_at.is_some_and(|last_success_at| {
        now_ms.saturating_sub(last_success_at) <= STREAM_FAMILY_RECENT_SUCCESS_WINDOW_MS
            && is_nearby_episode(
                season,
                episode,
                snapshot.last_success_season,
                snapshot.last_success_episode,
            )
    }) {
        return 4;
    }

    DEFAULT_STREAM_FAMILY_PRIORITY
}

pub(super) fn accepts_outcome(
    last_success_at: Option<u64>,
    last_failure_at: Option<u64>,
    timestamp_ms: u64,
) -> bool {
    [last_success_at, last_failure_at]
        .into_iter()
        .flatten()
        .max()
        .is_none_or(|latest| timestamp_ms >= latest)
}

pub(super) fn upsert_source_health_snapshot(
    store: &DurableStore,
    health_key: &str,
    outcome: PlaybackStreamOutcomeKind,
    timestamp_ms: u64,
    allow_prune: bool,
) -> Result<(), String> {
    let mut snapshot = load_source_health_snapshot(store, health_key).unwrap_or_default();

    if !accepts_outcome(
        snapshot.last_success_at,
        snapshot.last_failure_at,
        timestamp_ms,
    ) {
        return Ok(());
    }

    let mut source_health_index = load_index(store, PLAYBACK_SOURCE_HEALTH_INDEX_KEY);

    match outcome {
        PlaybackStreamOutcomeKind::Verified => {
            snapshot.last_success_at = Some(timestamp_ms);
            snapshot.last_failure_at = None;
            snapshot.consecutive_failures = 0;
            snapshot.cooldown_until = None;
        }
        _ => {
            snapshot.last_failure_at = Some(timestamp_ms);
            snapshot.consecutive_failures = snapshot.consecutive_failures.saturating_add(1);
            // A single blip must not bench a whole source: the fetcher skips
            // score-0 sources entirely, so cooldown requires a repeat
            // failure. The first failure still demotes ranking above.
            snapshot.cooldown_until = (snapshot.consecutive_failures >= 2).then(|| {
                timestamp_ms.saturating_add(match outcome {
                    PlaybackStreamOutcomeKind::StartupTimeout => 1000 * 60 * 12,
                    PlaybackStreamOutcomeKind::LoadFailed => 1000 * 60 * 15,
                    PlaybackStreamOutcomeKind::Disconnected => 1000 * 60 * 6,
                    // The outer `_` arm already excludes Verified.
                    PlaybackStreamOutcomeKind::Verified => unreachable!(),
                })
            });
        }
    }

    insert_sorted_unique(&mut source_health_index, health_key);

    store.set(playback_source_health_item_key(health_key), json!(snapshot));
    // The count cap is a hard bound: IPC-supplied identities could otherwise
    // grow the index between the cadence-gated sweeps.
    if allow_prune || source_health_index.len() > SOURCE_HEALTH_INDEX_MAX_ENTRIES {
        prune_stale_source_health_entries(store, &mut source_health_index);
    }
    store.set(PLAYBACK_SOURCE_HEALTH_INDEX_KEY, json!(source_health_index));

    Ok(())
}

/// Failed outcomes must not erase the family's verified attribution; a
/// verified outcome with no resolvable instance clears it.
pub(super) fn update_verified_family_source_id(
    snapshot: &mut PlaybackStreamFamilySnapshot,
    resolved_source_id: Option<String>,
    outcome: PlaybackStreamOutcomeKind,
) {
    if matches!(outcome, PlaybackStreamOutcomeKind::Verified) {
        snapshot.source_id = resolved_source_id.and_then(|value| normalize_source_id(&value));
    }
}

/// `stream_family` and `resolved_source_id` arrive already normalized by the
/// caller (the family key and the health-attributed instance); the remaining
/// raw fields come straight off the report.
pub(super) fn upsert_stream_family_snapshot(
    store: &DurableStore,
    scope_key: &str,
    stream_family: &str,
    resolved_source_id: Option<String>,
    report: &StreamOutcomeReport,
    allow_prune: bool,
) -> Result<(), String> {
    let snapshot_key = playback_stream_family_snapshot_key(scope_key, stream_family);
    let mut snapshot =
        load_playback_stream_family_snapshot(store, &snapshot_key).unwrap_or_default();

    if !accepts_outcome(
        snapshot.last_success_at,
        snapshot.last_failure_at,
        report.timestamp_ms,
    ) {
        return Ok(());
    }

    let mut stream_family_index = load_index(store, PLAYBACK_STREAM_FAMILY_INDEX_KEY);
    update_verified_family_source_id(&mut snapshot, resolved_source_id, report.outcome);

    match report.outcome {
        PlaybackStreamOutcomeKind::Verified => {
            snapshot.last_success_at = Some(report.timestamp_ms);
            snapshot.last_success_season = report.season;
            snapshot.last_success_episode = report.episode;
            snapshot.last_failure_at = None;
            snapshot.last_failure_season = None;
            snapshot.last_failure_episode = None;
            snapshot.consecutive_failures = 0;
            snapshot.cooldown_until = None;
        }
        _ => {
            snapshot.last_failure_at = Some(report.timestamp_ms);
            snapshot.last_failure_season = report.season;
            snapshot.last_failure_episode = report.episode;
            snapshot.consecutive_failures = snapshot.consecutive_failures.saturating_add(1);
            snapshot.cooldown_until =
                Some(report.timestamp_ms.saturating_add(match report.outcome {
                    PlaybackStreamOutcomeKind::StartupTimeout => 1000 * 60 * 10,
                    PlaybackStreamOutcomeKind::LoadFailed => 1000 * 60 * 12,
                    PlaybackStreamOutcomeKind::Disconnected => 1000 * 60 * 6,
                    // The outer `_` arm already excludes Verified.
                    PlaybackStreamOutcomeKind::Verified => unreachable!(),
                }));
        }
    }

    insert_sorted_unique(&mut stream_family_index, &snapshot_key);

    store.set(
        playback_stream_family_item_key(&snapshot_key),
        json!(snapshot),
    );
    // Same hard bound as the source-health index above.
    if allow_prune || stream_family_index.len() > STREAM_FAMILY_INDEX_MAX_ENTRIES {
        prune_stale_stream_family_entries(store, &mut stream_family_index);
    }
    store.set(PLAYBACK_STREAM_FAMILY_INDEX_KEY, json!(stream_family_index));

    Ok(())
}

/// Activity timestamps shared by the recency-pruned snapshot indexes.
struct SnapshotActivity {
    last_success_at: Option<u64>,
    last_failure_at: Option<u64>,
    cooldown_until: Option<u64>,
}

/// Window-filter + recency-cap prune shared by the source-health and
/// stream-family indexes: drop entries whose snapshot is missing or has no
/// activity inside the success/failure windows, then evict the least recently
/// active survivors past `max_entries`.
fn prune_by_recency(
    store: &DurableStore,
    index: &mut Vec<String>,
    max_entries: usize,
    recent_success_window_ms: u64,
    recent_failure_window_ms: u64,
    load_activity: impl Fn(&DurableStore, &str) -> Option<SnapshotActivity>,
    item_key: impl Fn(&str) -> String,
) {
    let now_ms = now_unix_millis();
    let mut survivors: Vec<(String, u64)> = Vec::with_capacity(index.len());
    index.retain(|key| {
        let Some(activity) = load_activity(store, key) else {
            return false;
        };

        let keep = activity
            .cooldown_until
            .is_some_and(|cooldown_until| cooldown_until > now_ms)
            || activity.last_success_at.is_some_and(|last_success_at| {
                now_ms.saturating_sub(last_success_at) <= recent_success_window_ms
            })
            || activity.last_failure_at.is_some_and(|last_failure_at| {
                now_ms.saturating_sub(last_failure_at) <= recent_failure_window_ms
            });

        if !keep {
            store.delete(item_key(key));
        } else {
            let last_activity = [
                activity.last_success_at,
                activity.last_failure_at,
                activity.cooldown_until,
            ]
            .into_iter()
            .flatten()
            .max()
            .unwrap_or(0);
            survivors.push((key.clone(), last_activity));
        }

        keep
    });

    // Index order is key-sorted, so truncation would evict arbitrarily; drop
    // the least recently active entries instead.
    if survivors.len() > max_entries {
        survivors.sort_by_key(|(_, last_activity)| *last_activity);
        let evicted: HashSet<String> = survivors
            .iter()
            .take(survivors.len() - max_entries)
            .map(|(key, _)| key.clone())
            .collect();
        for key in &evicted {
            store.delete(item_key(key));
        }
        index.retain(|key| !evicted.contains(key));
    }
}

pub(super) fn prune_stale_source_health_entries(
    store: &DurableStore,
    source_health_index: &mut Vec<String>,
) {
    prune_by_recency(
        store,
        source_health_index,
        SOURCE_HEALTH_INDEX_MAX_ENTRIES,
        SOURCE_HEALTH_RECENT_SUCCESS_WINDOW_MS,
        SOURCE_HEALTH_RECENT_FAILURE_WINDOW_MS,
        |store, key| {
            load_source_health_snapshot(store, key).map(|snapshot| SnapshotActivity {
                last_success_at: snapshot.last_success_at,
                last_failure_at: snapshot.last_failure_at,
                cooldown_until: snapshot.cooldown_until,
            })
        },
        playback_source_health_item_key,
    );
}

fn prune_stale_stream_family_entries(store: &DurableStore, stream_family_index: &mut Vec<String>) {
    prune_by_recency(
        store,
        stream_family_index,
        STREAM_FAMILY_INDEX_MAX_ENTRIES,
        STREAM_FAMILY_RECENT_SUCCESS_WINDOW_MS,
        STREAM_FAMILY_RECENT_FAILURE_WINDOW_MS,
        |store, key| {
            load_playback_stream_family_snapshot(store, key).map(|snapshot| SnapshotActivity {
                last_success_at: snapshot.last_success_at,
                last_failure_at: snapshot.last_failure_at,
                cooldown_until: snapshot.cooldown_until,
            })
        },
        playback_stream_family_item_key,
    );
}

impl PlaybackStateService {
    /// Records an outcome against the source-health and stream-family
    /// reputations. Generation-guarded like `track_progress_guarded`: a
    /// clear/remove/import racing this write must not let a stale outcome
    /// repopulate indexes the user just wiped.
    pub(crate) fn record_stream_outcome(
        &self,
        app: &AppHandle,
        report: StreamOutcomeReport,
    ) -> Result<(), String> {
        let start_generation = self.history_generation();
        let store = crate::commands::open_store(app, PLAYBACK_STATE_STORE_FILE)?;
        // Instance identity for health attribution: outcomes always carry
        // the resolved stream's `source_id`; a name-only report (legacy
        // route state) skips the health write rather than guessing an
        // instance onto a shared display name.
        let resolved_source_id = report.source_id.as_deref().and_then(normalize_source_id);
        // `set` mutates the shared in-memory map immediately, so the guard
        // must run before the first mutation — not only before `save` — or a
        // clear that already landed leaves resurrected entries for the next
        // writer's save. The lock serializes the whole section so a
        // `clear`/`remove_keys` bump+delete can't interleave between this
        // check and the writes.
        let _state_file_guard = self.lock_state_file_write();
        if self.history_generation() != start_generation {
            return Ok(());
        }

        if let Some(source_id) = resolved_source_id.as_deref() {
            upsert_source_health_snapshot(
                &store,
                &source_health_key(source_id),
                report.outcome,
                report.timestamp_ms,
                Self::claim_health_prune(&self.source_health_prune_at, report.timestamp_ms),
            )?;
        }

        if let Some(scope_key) =
            playback_title_scope_key(Some(report.media_type), Some(report.media_id.as_str()))
        {
            if let Some(stream_family) = report
                .stream_family
                .as_deref()
                .and_then(normalize_source_key)
            {
                upsert_stream_family_snapshot(
                    &store,
                    &scope_key,
                    &stream_family,
                    resolved_source_id,
                    &report,
                    Self::claim_health_prune(&self.stream_family_prune_at, report.timestamp_ms),
                )?;
            }
        }

        // No second generation check here: the `set()` mutations already
        // landed in the shared map, so an early return would only skip this
        // command's flush and strand outcome data in memory. The
        // anti-resurrection guard is the pre-mutation check under the file
        // lock; whatever landed gets flushed.
        self.schedule_state_file_save(app);

        Ok(())
    }

    /// Single-open batch source-health view: one store handle serves every
    /// unique instance id, so selector ranking (N unique sources) pays one
    /// open instead of N. Rows without a `source_id` (pre-v3 history) skip
    /// to the neutral default downstream rather than sharing a name bucket.
    pub(crate) fn source_health_priorities_for_ids<'a>(
        &self,
        app: &AppHandle,
        source_ids: impl IntoIterator<Item = Option<&'a str>>,
    ) -> Result<HashMap<String, u8>, String> {
        let store = crate::commands::open_store(app, PLAYBACK_STATE_STORE_FILE)?;
        let now_ms = now_unix_millis();
        let mut priorities = HashMap::new();

        for source_id in source_ids {
            let Some(source_id) = source_id.and_then(normalize_source_id) else {
                continue;
            };
            if priorities.contains_key(&source_id) {
                continue;
            }

            let snapshot = load_source_health_snapshot(&store, &source_health_key(&source_id));
            priorities.insert(
                source_id,
                score_source_health_priority(snapshot.as_ref(), now_ms),
            );
        }

        Ok(priorities)
    }

    /// Single-open batch variant for stream families: one store handle
    /// serves every unique family for the title scope instead of one open
    /// per family.
    pub(crate) fn stream_family_priorities_for_names<'a>(
        &self,
        app: &AppHandle,
        media_id: &str,
        media_type: &str,
        season: Option<u32>,
        episode: Option<u32>,
        stream_families: impl IntoIterator<Item = &'a str>,
    ) -> Result<HashMap<String, u8>, String> {
        let Some(scope_key) = playback_title_scope_key(Some(media_type), Some(media_id)) else {
            return Ok(HashMap::new());
        };
        let store = crate::commands::open_store(app, PLAYBACK_STATE_STORE_FILE)?;
        let now_ms = now_unix_millis();
        let mut priorities = HashMap::new();

        for stream_family in stream_families {
            let Some(stream_family) = normalize_source_key(stream_family) else {
                continue;
            };
            // `priorities` holds the same normalized keyspace — no second set.
            if priorities.contains_key(&stream_family) {
                continue;
            }

            let snapshot_key = playback_stream_family_snapshot_key(&scope_key, &stream_family);
            let snapshot = load_playback_stream_family_snapshot(&store, &snapshot_key);
            priorities.insert(
                stream_family,
                score_stream_family_priority(snapshot.as_ref(), season, episode, now_ms),
            );
        }

        Ok(priorities)
    }

    /// Single-open read of the title scope's preferred source: the last
    /// addon instance that succeeded on this title recently. Affinity is a
    /// single-instance fact, so callers get the id rather than a per-source
    /// score map.
    pub(crate) fn preferred_title_source_id(
        &self,
        app: &AppHandle,
        media_id: &str,
        media_type: &str,
    ) -> Result<Option<String>, String> {
        let Some(scope_key) = playback_title_scope_key(Some(media_type), Some(media_id)) else {
            return Ok(None);
        };
        let store = crate::commands::open_store(app, PLAYBACK_STATE_STORE_FILE)?;
        Ok(preferred_title_source_id_from_success(
            &store,
            &scope_key,
            now_unix_millis(),
        ))
    }
}
