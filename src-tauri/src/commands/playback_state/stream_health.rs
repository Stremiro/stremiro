use super::{
    evict_least_active, insert_sorted_unique, load_advisory_index, playback_title_scope_key,
    PlaybackStateService, PlaybackStreamOutcomeKind,
};
use crate::commands::history_helpers::normalize_episode_coordinate;
use crate::commands::stream_coordinator::{
    DEFAULT_SOURCE_HEALTH_PRIORITY, DEFAULT_STREAM_FAMILY_PRIORITY,
};
use crate::commands::streaming_helpers::{
    is_current_stream_family, normalize_source_id, normalize_source_key, source_health_key,
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
const SOURCE_HEALTH_MAX_COOLDOWN_MS: u64 = 1000 * 60 * 15;
const STREAM_FAMILY_RECENT_FAILURE_WINDOW_MS: u64 = 1000 * 60 * 60 * 18;
const STREAM_FAMILY_RECENT_SUCCESS_WINDOW_MS: u64 = 1000 * 60 * 60 * 24 * 7;
const STREAM_FAMILY_MAX_COOLDOWN_MS: u64 = 1000 * 60 * 12;
const REPUTATION_FUTURE_SKEW_MS: u64 = 1000 * 60 * 5;
// Hard count bound on top of the recency windows: a 7-day success window alone
// still lets a heavy session grow the index without limit.
const STREAM_FAMILY_INDEX_MAX_ENTRIES: usize = 512;
/// Same bound for the source-health index: IPC-supplied source identities plus
/// recency-only pruning would grow the index (and every prune's reads) without limit.
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
    /// Owning `type:id` scope: `|` is legal inside a media id, so the `{scope}|{family}`
    /// key's prefix alone can't prove title ownership. `None` on pre-field snapshots.
    #[serde(default)]
    pub scope_key: Option<String>,
    /// Instance id of the last verified addon; `None` on pre-instance-id snapshots.
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

/// One playback stream outcome report: normalized title scope plus the resolved
/// stream's identity fields feeding the source-health and family reputation snapshots.
pub(crate) struct StreamOutcomeReport {
    pub media_id: String,
    /// Canonical history-namespace type (`movie`/`series`) — `anime` folds to `series` upstream.
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

pub(super) fn remove_legacy_stream_family_reputation(store: &DurableStore) {
    let current_snapshot_key = |key: &str| {
        // Read from the right because media ids can contain `|`.
        key.rmatch_indices('|')
            .nth(1)
            .is_some_and(|(separator, _)| is_current_stream_family(&key[separator + 1..]))
    };
    store.delete_matching(|key| {
        key.strip_prefix(PLAYBACK_STREAM_FAMILY_ITEM_PREFIX)
            .is_some_and(|key| !current_snapshot_key(key))
    });
    let mut index = load_advisory_index(store, PLAYBACK_STREAM_FAMILY_INDEX_KEY);
    let previous_len = index.len();
    index.retain(|key| current_snapshot_key(key));
    if index.len() != previous_len {
        store.set(PLAYBACK_STREAM_FAMILY_INDEX_KEY, json!(index));
    }
}

pub(super) fn load_playback_stream_family_snapshot(
    store: &DurableStore,
    key: &str,
) -> Option<PlaybackStreamFamilySnapshot> {
    store.get_typed(playback_stream_family_item_key(key))
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
    // Pre-`source_id` snapshots contribute no affinity — guessing an instance from a shared display name could misattribute it.
    Some((
        snapshot
            .source_id
            .as_deref()
            .and_then(normalize_source_id)?
            .to_string(),
        last_success_at,
    ))
}

pub(super) fn preferred_title_source_id_from_success(
    store: &DurableStore,
    scope_key: &str,
    now_ms: u64,
) -> Option<String> {
    // Collect only this scope's keys: snapshot loads re-lock the store, so they
    // cannot run inside `with_value`.
    let scope_snapshot_keys: Vec<String> =
        store.with_value(PLAYBACK_STREAM_FAMILY_INDEX_KEY, |value| {
            value
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str)
                .filter(|snapshot_key| playback_snapshot_belongs_to_scope(snapshot_key, scope_key))
                .map(str::to_string)
                .collect()
        });

    scope_snapshot_keys
        .into_iter()
        .filter_map(|snapshot_key| {
            let snapshot = load_playback_stream_family_snapshot(store, &snapshot_key)?;
            // A `|` in the media id can fool the prefix check; the body-written
            // scope is authoritative, legacy snapshots pass.
            snapshot
                .scope_key
                .as_deref()
                .is_none_or(|scope| scope == scope_key)
                .then_some(snapshot)
        })
        .filter_map(|snapshot| recent_successful_source(snapshot, now_ms))
        .max_by_key(|(_, last_success_at)| *last_success_at)
        .map(|(source_id, _)| source_id)
}

pub(super) fn load_source_health_snapshot(
    store: &DurableStore,
    key: &str,
) -> Option<PlaybackSourceHealthSnapshot> {
    store.get_typed(playback_source_health_item_key(key))
}

pub(super) fn score_source_health_priority(
    snapshot: Option<&PlaybackSourceHealthSnapshot>,
    now_ms: u64,
) -> u8 {
    let Some(snapshot) = snapshot else {
        return DEFAULT_SOURCE_HEALTH_PRIORITY;
    };

    if snapshot.cooldown_until.is_some_and(|cooldown_until| {
        cooldown_until > now_ms
            && cooldown_until
                <= now_ms.saturating_add(SOURCE_HEALTH_MAX_COOLDOWN_MS + REPUTATION_FUTURE_SKEW_MS)
    }) {
        return 0;
    }

    if snapshot.last_failure_at.is_some_and(|last_failure_at| {
        last_failure_at <= now_ms.saturating_add(REPUTATION_FUTURE_SKEW_MS)
            && now_ms.saturating_sub(last_failure_at) <= SOURCE_HEALTH_RECENT_FAILURE_WINDOW_MS
            && snapshot.consecutive_failures >= 1
    }) {
        return 1;
    }

    if snapshot.last_success_at.is_some_and(|last_success_at| {
        last_success_at <= now_ms.saturating_add(REPUTATION_FUTURE_SKEW_MS)
            && now_ms.saturating_sub(last_success_at) <= SOURCE_HEALTH_RECENT_SUCCESS_WINDOW_MS
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
        (None, None, None, None) => true,
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
        last_failure_at <= now_ms.saturating_add(REPUTATION_FUTURE_SKEW_MS)
            && now_ms.saturating_sub(last_failure_at) <= STREAM_FAMILY_RECENT_FAILURE_WINDOW_MS
            && is_nearby_episode(
                season,
                episode,
                snapshot.last_failure_season,
                snapshot.last_failure_episode,
            )
    });

    if snapshot.cooldown_until.is_some_and(|cooldown_until| {
        cooldown_until > now_ms
            && cooldown_until
                <= now_ms.saturating_add(STREAM_FAMILY_MAX_COOLDOWN_MS + REPUTATION_FUTURE_SKEW_MS)
    }) && recent_nearby_failure
    {
        return 0;
    }

    if recent_nearby_failure && snapshot.consecutive_failures >= 1 {
        return 1;
    }

    if snapshot.last_success_at.is_some_and(|last_success_at| {
        last_success_at <= now_ms.saturating_add(REPUTATION_FUTURE_SKEW_MS)
            && now_ms.saturating_sub(last_success_at) <= STREAM_FAMILY_RECENT_SUCCESS_WINDOW_MS
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
    last_success_at.max(last_failure_at).is_none_or(|latest| {
        timestamp_ms >= latest
            || latest > now_unix_millis().saturating_add(REPUTATION_FUTURE_SKEW_MS)
    })
}

/// Shared upsert skeleton for the outcome-driven snapshot indexes: recency guard
/// first, then index insert → item write → prune → index write so a new key can't
/// evict itself and the index never names a missing item.
#[allow(clippy::too_many_arguments)]
fn upsert_outcome_snapshot<S: Default + Serialize>(
    store: &DurableStore,
    key: &str,
    timestamp_ms: u64,
    allow_prune: bool,
    load_snapshot: impl Fn(&DurableStore, &str) -> Option<S>,
    outcome_times: impl Fn(&S) -> (Option<u64>, Option<u64>),
    apply_outcome: impl FnOnce(&mut S),
    item_key: impl Fn(&str) -> String,
    index_key: &str,
    max_entries: usize,
    prune_index: impl Fn(&DurableStore, &mut Vec<String>),
) {
    let mut snapshot = load_snapshot(store, key).unwrap_or_default();
    let (last_success_at, last_failure_at) = outcome_times(&snapshot);
    if !accepts_outcome(last_success_at, last_failure_at, timestamp_ms) {
        return;
    }
    // Only an invalid future snapshot can accept an older outcome.
    if last_success_at
        .max(last_failure_at)
        .is_some_and(|latest| timestamp_ms < latest)
    {
        snapshot = S::default();
    }

    let mut index = load_advisory_index(store, index_key);
    apply_outcome(&mut snapshot);
    insert_sorted_unique(&mut index, key);

    store.set(item_key(key), json!(snapshot));
    // Hard bound: IPC-supplied identities could grow the index between the cadence-gated sweeps.
    if allow_prune || index.len() > max_entries {
        prune_index(store, &mut index);
    }
    store.set(index_key, json!(index));
}

pub(super) fn upsert_source_health_snapshot(
    store: &DurableStore,
    health_key: &str,
    outcome: PlaybackStreamOutcomeKind,
    timestamp_ms: u64,
    allow_prune: bool,
) {
    upsert_outcome_snapshot(
        store,
        health_key,
        timestamp_ms,
        allow_prune,
        load_source_health_snapshot,
        |snapshot| (snapshot.last_success_at, snapshot.last_failure_at),
        |snapshot| match outcome {
            PlaybackStreamOutcomeKind::Verified => {
                snapshot.last_success_at = Some(timestamp_ms);
                snapshot.last_failure_at = None;
                snapshot.consecutive_failures = 0;
                snapshot.cooldown_until = None;
            }
            _ => {
                if snapshot.last_failure_at.is_none_or(|last_failure_at| {
                    timestamp_ms.saturating_sub(last_failure_at)
                        > SOURCE_HEALTH_RECENT_FAILURE_WINDOW_MS
                }) {
                    snapshot.consecutive_failures = 0;
                }
                snapshot.last_failure_at = Some(timestamp_ms);
                snapshot.consecutive_failures = snapshot.consecutive_failures.saturating_add(1);
                // A single blip must not bench a source — the fetcher skips score-0
                // sources entirely, so cooldown requires a repeat failure.
                snapshot.cooldown_until = (snapshot.consecutive_failures >= 2).then(|| {
                    timestamp_ms.saturating_add(match outcome {
                        PlaybackStreamOutcomeKind::StartupTimeout => 1000 * 60 * 12,
                        PlaybackStreamOutcomeKind::LoadFailed => SOURCE_HEALTH_MAX_COOLDOWN_MS,
                        PlaybackStreamOutcomeKind::Disconnected => 1000 * 60 * 6,
                        // The outer `_` arm already excludes Verified.
                        PlaybackStreamOutcomeKind::Verified => unreachable!(),
                    })
                });
            }
        },
        playback_source_health_item_key,
        PLAYBACK_SOURCE_HEALTH_INDEX_KEY,
        SOURCE_HEALTH_INDEX_MAX_ENTRIES,
        prune_stale_source_health_entries,
    )
}

/// Failed outcomes keep the family's verified attribution; a verified outcome with no resolvable instance clears it.
pub(super) fn update_verified_family_source_id(
    snapshot: &mut PlaybackStreamFamilySnapshot,
    resolved_source_id: Option<String>,
    outcome: PlaybackStreamOutcomeKind,
) {
    if matches!(outcome, PlaybackStreamOutcomeKind::Verified) {
        snapshot.source_id = resolved_source_id
            .as_deref()
            .and_then(normalize_source_id)
            .map(str::to_string);
    }
}

/// `stream_family` and `resolved_source_id` arrive normalized by the caller;
/// remaining raw fields come straight off the report.
pub(super) fn upsert_stream_family_snapshot(
    store: &DurableStore,
    scope_key: &str,
    stream_family: &str,
    resolved_source_id: Option<String>,
    report: &StreamOutcomeReport,
    allow_prune: bool,
) {
    let snapshot_key = playback_stream_family_snapshot_key(scope_key, stream_family);
    upsert_outcome_snapshot(
        store,
        &snapshot_key,
        report.timestamp_ms,
        allow_prune,
        load_playback_stream_family_snapshot,
        |snapshot| (snapshot.last_success_at, snapshot.last_failure_at),
        |snapshot| {
            // `|` is legal inside a media id, so the body records the owning scope — key-prefix checks can't prove title.
            snapshot.scope_key = Some(scope_key.to_string());
            update_verified_family_source_id(snapshot, resolved_source_id, report.outcome);

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
                            PlaybackStreamOutcomeKind::LoadFailed => STREAM_FAMILY_MAX_COOLDOWN_MS,
                            PlaybackStreamOutcomeKind::Disconnected => 1000 * 60 * 6,
                            // The outer `_` arm already excludes Verified.
                            PlaybackStreamOutcomeKind::Verified => unreachable!(),
                        }));
                }
            }
        },
        playback_stream_family_item_key,
        PLAYBACK_STREAM_FAMILY_INDEX_KEY,
        STREAM_FAMILY_INDEX_MAX_ENTRIES,
        prune_stale_stream_family_entries,
    )
}

/// Activity timestamps shared by the recency-pruned snapshot indexes.
struct SnapshotActivity {
    last_success_at: Option<u64>,
    last_failure_at: Option<u64>,
    cooldown_until: Option<u64>,
}

/// Window-filter + recency-cap prune shared by both indexes: drop entries whose
/// snapshot is missing or has no activity inside the windows, then evict the
/// least recently active survivors past `max_entries`.
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
    let mut survivors = (index.len() > max_entries)
        .then(|| Vec::<(String, u64, usize)>::with_capacity(index.len()));
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
        } else if let Some(survivors) = survivors.as_mut() {
            let last_activity = [
                activity.last_success_at,
                activity.last_failure_at,
                activity.cooldown_until,
            ]
            .into_iter()
            .flatten()
            .max()
            .unwrap_or(0);
            survivors.push((key.clone(), last_activity, survivors.len()));
        }

        keep
    });

    // Index order is key-sorted, so truncation would evict arbitrarily — evict least recently active instead.
    if let Some(survivors) = survivors.filter(|survivors| survivors.len() > max_entries) {
        let overflow = survivors.len() - max_entries;
        evict_least_active(store, index, survivors, overflow, item_key);
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

/// Batch score lookup shared by both read paths: normalize, dedupe (map = seen-set),
/// then one snapshot load + score per unique key under a single store handle.
fn scored_priorities<'a>(
    items: impl IntoIterator<Item = Option<&'a str>>,
    normalize: impl Fn(&'a str) -> Option<String>,
    load_and_score: impl Fn(&str) -> u8,
) -> HashMap<String, u8> {
    let mut priorities = HashMap::new();
    for item in items {
        let Some(key) = item.and_then(&normalize) else {
            continue;
        };
        priorities
            .entry(key)
            .or_insert_with_key(|key| load_and_score(key));
    }
    priorities
}

impl PlaybackStateService {
    /// Records an outcome against the source-health and stream-family reputations.
    /// The caller captures the generation at IPC entry so a racing clear/remove
    /// cannot let a stale outcome repopulate wiped indexes.
    pub(crate) fn record_stream_outcome(
        &self,
        app: &AppHandle,
        mut report: StreamOutcomeReport,
        expected_generation: u64,
    ) -> Result<(), String> {
        // IPC-supplied coordinates go straight into the family snapshot — apply the shared ingress bound first.
        report.season = normalize_episode_coordinate(report.season);
        report.episode = normalize_episode_coordinate(report.episode);
        let store = self.open_state_store(app)?;
        // Health attribution uses the resolved stream's `source_id`; a name-only
        // report (legacy route state) skips the health write rather than guessing.
        let resolved_source_id = report
            .source_id
            .as_deref()
            .and_then(normalize_source_id)
            .map(str::to_string);
        // `set` mutates the shared map immediately, so the generation guard must run
        // before the first mutation, not only before `save`. The lock serializes the
        // whole section so a `clear`/`remove_keys` bump+delete can't interleave.
        let _state_file_guard = self.lock_state_file_write();
        if self.history_generation() != expected_generation {
            return Ok(());
        }

        if let Some(source_id) = resolved_source_id.as_deref() {
            upsert_source_health_snapshot(
                &store,
                &source_health_key(source_id),
                report.outcome,
                report.timestamp_ms,
                Self::claim_health_prune(&self.source_health_prune_at, report.timestamp_ms),
            );
        }

        if let Some(scope_key) =
            playback_title_scope_key(Some(report.media_type), Some(report.media_id.as_str()))
        {
            if let Some(stream_family) = report
                .stream_family
                .as_deref()
                .and_then(normalize_source_key)
                .filter(|family| is_current_stream_family(family))
            {
                upsert_stream_family_snapshot(
                    &store,
                    &scope_key,
                    &stream_family,
                    resolved_source_id,
                    &report,
                    Self::claim_health_prune(&self.stream_family_prune_at, report.timestamp_ms),
                );
            }
        }

        // No second generation check: the `set()` mutations already landed, so an
        // early return would just strand outcome data in memory. The anti-resurrection
        // guard is the pre-mutation check under the file lock; whatever landed gets flushed.
        self.schedule_state_file_save(app);

        Ok(())
    }

    /// Single-open batch source-health view — selector ranking pays one open for N
    /// unique sources. Rows without a `source_id` (pre-v3) get the neutral default
    /// rather than sharing a name bucket.
    pub(crate) fn source_health_priorities_for_ids<'a>(
        &self,
        app: &AppHandle,
        source_ids: impl IntoIterator<Item = Option<&'a str>>,
    ) -> Result<HashMap<String, u8>, String> {
        let mut seen = HashSet::new();
        let mut priorities: HashMap<String, u8> = source_ids
            .into_iter()
            .flatten()
            .filter(|source_id| seen.insert(*source_id))
            .filter_map(normalize_source_id)
            .map(|source_id| (source_id.to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY))
            .collect();
        if priorities.is_empty() {
            return Ok(priorities);
        }
        let Some(store) = self.open_advisory_store(app, "source-health-priorities") else {
            return Ok(priorities);
        };
        let now_ms = now_unix_millis();

        for (source_id, priority) in &mut priorities {
            let snapshot = load_source_health_snapshot(&store, &source_health_key(source_id));
            *priority = score_source_health_priority(snapshot.as_ref(), now_ms);
        }
        Ok(priorities)
    }

    /// Single-open batch variant for stream families — one store handle serves every unique family in the title scope.
    pub(crate) fn stream_family_priorities_for_names<'a>(
        &self,
        app: &AppHandle,
        media_id: &str,
        media_type: &str,
        season: Option<u32>,
        episode: Option<u32>,
        stream_families: impl IntoIterator<Item = &'a str>,
    ) -> HashMap<String, u8> {
        let Some(scope_key) = playback_title_scope_key(Some(media_type), Some(media_id)) else {
            return HashMap::new();
        };
        let store = self.open_advisory_store(app, "stream-family-priorities");
        let now_ms = now_unix_millis();

        scored_priorities(
            stream_families.into_iter().map(Some),
            normalize_source_key,
            |stream_family| {
                store
                    .as_ref()
                    .map_or(DEFAULT_STREAM_FAMILY_PRIORITY, |store| {
                        let snapshot_key =
                            playback_stream_family_snapshot_key(&scope_key, stream_family);
                        let snapshot = load_playback_stream_family_snapshot(store, &snapshot_key);
                        score_stream_family_priority(snapshot.as_ref(), season, episode, now_ms)
                    })
            },
        )
    }

    /// Single-open read of the title scope's preferred source: the last addon
    /// instance that succeeded on this title recently.
    pub(crate) fn preferred_title_source_id(
        &self,
        app: &AppHandle,
        media_id: &str,
        media_type: &str,
    ) -> Option<String> {
        let scope_key = playback_title_scope_key(Some(media_type), Some(media_id))?;
        let store = self.open_advisory_store(app, "preferred-title-source")?;
        preferred_title_source_id_from_success(&store, &scope_key, now_unix_millis())
    }

    /// Reputation only orders sources, so an unreadable store ranks neutrally
    /// instead of failing history and playback reads.
    fn open_advisory_store(&self, app: &AppHandle, action: &str) -> Option<DurableStore> {
        self.open_state_store(app)
            .inspect_err(|error| {
                crate::operational_log::log_warn(
                    "playback-state",
                    action,
                    "store-unavailable",
                    &[crate::operational_log::field("error", error)],
                );
            })
            .ok()
    }
}
