#[cfg(test)]
use super::merge_sorted_unique;
use super::{
    load_advisory_index, merge_presorted_unique, prune_index_to_cap, PlaybackStateService,
};
use crate::commands::episode_navigation::{
    additional_episode_video_id, build_source_episode_coordinates, SourceEpisodeCoordinates,
};
use crate::commands::{
    normalize_media_id, normalize_watch_progress_type, now_unix_millis, DurableStore,
};
use crate::providers::Episode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use tauri::AppHandle;

pub(super) const PLAYBACK_EPISODE_MAPPING_INDEX_KEY: &str = "playback_episode_mapping_index";
pub(super) const PLAYBACK_EPISODE_MAPPING_ITEM_PREFIX: &str = "playback_episode_mapping_item:";
pub(super) const PLAYBACK_EPISODE_MAPPING_DIGEST_ITEM_PREFIX: &str =
    "playback_episode_mapping_digest_item:";
/// Hard bound for cached episode-coordinate mappings — keyed per episode, they would
/// otherwise grow without bound as the user browses.
const PLAYBACK_EPISODE_MAPPING_MAX_ENTRIES: usize = 2_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaybackEpisodeMappingSnapshot {
    pub media_id: String,
    pub media_type: String,
    pub canonical_season: u32,
    pub canonical_episode: u32,
    pub source_lookup_id: String,
    pub source_season: u32,
    pub source_episode: u32,
    pub updated_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CachedEpisodeMapping {
    #[serde(flatten)]
    snapshot: PlaybackEpisodeMappingSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    video_id: Option<String>,
}

pub(super) fn build_episode_mapping_snapshot(
    media_type: &str,
    media_id: &str,
    fallback_lookup_id: Option<&str>,
    episode: &Episode,
    updated_at: u64,
) -> PlaybackEpisodeMappingSnapshot {
    let source = build_source_episode_coordinates(episode, fallback_lookup_id.unwrap_or(media_id));

    PlaybackEpisodeMappingSnapshot {
        media_id: media_id.to_string(),
        media_type: media_type.to_string(),
        canonical_season: episode.season,
        canonical_episode: episode.episode,
        source_lookup_id: normalize_media_id(&source.lookup_id)
            .unwrap_or_else(|| media_id.to_string()),
        source_season: source.season,
        source_episode: source.episode,
        updated_at,
    }
}

pub(super) fn playback_episode_mapping_item_key(key: &str) -> String {
    format!("{}{}", PLAYBACK_EPISODE_MAPPING_ITEM_PREFIX, key)
}

pub(super) fn playback_episode_mapping_digest_item_key(scope_key: &str) -> String {
    format!(
        "{}{}",
        PLAYBACK_EPISODE_MAPPING_DIGEST_ITEM_PREFIX, scope_key
    )
}

/// Splits `{scope}:{season}:{episode}` into `(scope, season)` reading from the right — media ids may contain `:`.
fn split_episode_snapshot_key(key: &str) -> Option<(&str, &str)> {
    let episode_split = key.rfind(':')?;
    let season_split = key[..episode_split].rfind(':')?;
    Some((&key[..season_split], &key[season_split + 1..episode_split]))
}

/// Scope (`{type}:{id}`) of a `{type}:{id}:{season}:{episode}` snapshot key.
fn episode_mapping_scope_key(snapshot_key: &str) -> Option<&str> {
    split_episode_snapshot_key(snapshot_key).map(|(scope, _)| scope)
}

/// Highest canonical season the title's cached mappings cover. The episode battery
/// resolves numberless "final season" claims through it: a requested season at/beyond
/// the max is the only season such a claim can refer to. `None` → caller degrades to "not final".
pub(super) fn max_mapped_canonical_season(
    index_keys: &[String],
    media_type: &str,
    media_id: &str,
) -> Option<u32> {
    let scope_key = super::playback_title_scope_key(Some(media_type), Some(media_id))?;
    index_keys
        .iter()
        .filter_map(|key| {
            let (scope, season) = split_episode_snapshot_key(key)?;
            if scope == scope_key.as_str() {
                season.parse::<u32>().ok()
            } else {
                None
            }
        })
        .max()
}

/// Digest plus the last details-open that verified it. `seen_at` feeds the cap prune's
/// recency so actively opened titles outlive browsed-once ones.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub(super) struct EpisodeMappingDigestRecord {
    pub(super) digest: u64,
    pub(super) seen_at: u64,
}

/// Reads both the current record shape and legacy bare-u64 digests (seen_at 0 keeps them prune-able).
fn read_episode_mapping_digest(value: serde_json::Value) -> Option<(u64, u64)> {
    if let Some(digest) = value.as_u64() {
        return Some((digest, 0));
    }
    serde_json::from_value::<EpisodeMappingDigestRecord>(value)
        .ok()
        .map(|record| (record.digest, record.seen_at))
}

/// Fingerprint of every input `build_episode_mapping_snapshot` reads, so a re-open
/// with an unchanged episode list skips the per-episode read/compare loop.
/// Persisted per title; a mismatch (or eviction) costs one rescan, never a wrong result.
pub(super) fn episode_mappings_digest(
    media_type: &str,
    media_id: &str,
    fallback_lookup_id: Option<&str>,
    episodes: &[Episode],
) -> u64 {
    let mut hasher = DefaultHasher::new();
    media_type.hash(&mut hasher);
    media_id.hash(&mut hasher);
    fallback_lookup_id.hash(&mut hasher);
    for episode in episodes {
        episode.id.hash(&mut hasher);
        episode.season.hash(&mut hasher);
        episode.episode.hash(&mut hasher);
        episode.stream_lookup_id.hash(&mut hasher);
        episode.stream_season.hash(&mut hasher);
        episode.stream_episode.hash(&mut hasher);
    }
    hasher.finish()
}

/// Digest short-circuit for `cache_episode_mappings`: a matching stored digest proves every item was already written.
pub(super) fn stored_episode_mapping_digest_matches(
    store: &DurableStore,
    digest_key: &str,
    digest: u64,
    updated_at: u64,
) -> bool {
    let matches = store
        .get(digest_key)
        .and_then(read_episode_mapping_digest)
        .is_some_and(|(stored_digest, _)| stored_digest == digest);
    if matches {
        store.set(
            digest_key,
            json!(EpisodeMappingDigestRecord {
                digest,
                seen_at: updated_at,
            }),
        );
    }
    matches
}

/// Diff pass for `cache_episode_mappings`: queues changed item writes and registers
/// every snapshot key in the sorted index. The caller applies the writes only after
/// a second generation check so a racing clear can't land orphaned items.
pub(super) fn collect_episode_mapping_writes(
    store: &DurableStore,
    media_type: &str,
    media_id: &str,
    episodes: &[Episode],
    snapshots: &[PlaybackEpisodeMappingSnapshot],
    episode_mapping_index: &mut Vec<String>,
) -> (Vec<(String, CachedEpisodeMapping)>, Vec<String>, bool) {
    let mut snapshot_keys = Vec::with_capacity(episodes.len().min(snapshots.len()));
    let mut pending_writes = Vec::new();

    for (episode, next_snapshot) in episodes.iter().zip(snapshots.iter()) {
        let snapshot_key = playback_episode_mapping_snapshot_key(
            media_type,
            media_id,
            episode.season,
            episode.episode,
        );
        let video_id = additional_episode_video_id(
            episode,
            &SourceEpisodeCoordinates {
                lookup_id: next_snapshot.source_lookup_id.clone(),
                season: next_snapshot.source_season,
                episode: next_snapshot.source_episode,
            },
        );
        let existing: Option<CachedEpisodeMapping> =
            store.get_typed(playback_episode_mapping_item_key(&snapshot_key));
        let needs_write = existing.is_none_or(|existing| {
            !episode_mapping_snapshot_matches(&existing.snapshot, next_snapshot)
                || existing.video_id != video_id
        });

        if needs_write {
            pending_writes.push((
                snapshot_key.clone(),
                CachedEpisodeMapping {
                    snapshot: next_snapshot.clone(),
                    video_id,
                },
            ));
        }
        snapshot_keys.push(snapshot_key);
    }

    snapshot_keys.sort_unstable();
    snapshot_keys.dedup();
    let scope_key = format!("{media_type}:{media_id}");
    let mut pending_deletes = Vec::new();
    if !snapshot_keys.is_empty() {
        episode_mapping_index.retain(|key| {
            let stale = episode_mapping_scope_key(key) == Some(scope_key.as_str())
                && snapshot_keys.binary_search(key).is_err();
            if stale {
                pending_deletes.push(key.clone());
            }
            !stale
        });
    }
    let mut changed = !pending_deletes.is_empty();
    changed |= merge_presorted_unique(episode_mapping_index, snapshot_keys);
    (pending_writes, pending_deletes, changed)
}

/// Cap prune for `cache_episode_mappings`: evicts oldest index entries by
/// max(item `updated_at`, scope digest `seen_at`) and deletes the digest of every
/// scope that lost an item — a surviving digest would suppress the rewrite those
/// items need. Returns (index changed, own digest invalidated → caller must not re-arm it).
pub(super) fn prune_episode_mapping_index(
    store: &DurableStore,
    episode_mapping_index: &mut Vec<String>,
    own_scope_key: &str,
) -> (bool, bool) {
    if episode_mapping_index.len() <= PLAYBACK_EPISODE_MAPPING_MAX_ENTRIES {
        return (false, false);
    }

    let pre_prune = episode_mapping_index.clone();
    let mut scope_seen_at = HashMap::new();
    for scope in pre_prune
        .iter()
        .filter_map(|key| episode_mapping_scope_key(key))
    {
        scope_seen_at.entry(scope).or_insert_with(|| {
            store
                .get(playback_episode_mapping_digest_item_key(scope))
                .and_then(read_episode_mapping_digest)
                .map(|(_, seen_at)| seen_at)
                .unwrap_or(0)
        });
    }
    prune_index_to_cap(
        store,
        episode_mapping_index,
        PLAYBACK_EPISODE_MAPPING_MAX_ENTRIES,
        |store, key| {
            let item_updated = load_playback_episode_mapping_snapshot(store, key)
                .map(|snapshot| snapshot.updated_at)
                .unwrap_or(0);
            // Item timestamps only move when coordinates change, so recency also rides
            // the scope digest's `seen_at` — an active title must not evict on write age.
            let scope_seen = episode_mapping_scope_key(key)
                .and_then(|scope| scope_seen_at.get(scope))
                .copied()
                .unwrap_or(0);
            item_updated.max(scope_seen)
        },
        playback_episode_mapping_item_key,
    );
    // A scope that lost any indexed item loses its digest.
    let mut invalidated_scopes = HashSet::new();
    for key in &pre_prune {
        if episode_mapping_index.binary_search(key).is_err() {
            if let Some(scope) = episode_mapping_scope_key(key) {
                invalidated_scopes.insert(scope.to_string());
            }
        }
    }
    let digest_invalidated = invalidated_scopes.contains(own_scope_key);
    for scope in invalidated_scopes {
        store.delete(playback_episode_mapping_digest_item_key(&scope));
    }
    (true, digest_invalidated)
}

pub(super) fn playback_episode_mapping_snapshot_key(
    media_type: &str,
    media_id: &str,
    canonical_season: u32,
    canonical_episode: u32,
) -> String {
    format!(
        "{}:{}:{}:{}",
        media_type, media_id, canonical_season, canonical_episode
    )
}

pub(super) fn load_playback_episode_mapping_snapshot(
    store: &DurableStore,
    key: &str,
) -> Option<PlaybackEpisodeMappingSnapshot> {
    store.get_typed(playback_episode_mapping_item_key(key))
}

fn episode_mapping_snapshot_matches(
    left: &PlaybackEpisodeMappingSnapshot,
    right: &PlaybackEpisodeMappingSnapshot,
) -> bool {
    left.media_id == right.media_id
        && left.media_type == right.media_type
        && left.canonical_season == right.canonical_season
        && left.canonical_episode == right.canonical_episode
        && left.source_lookup_id == right.source_lookup_id
        && left.source_season == right.source_season
        && left.source_episode == right.source_episode
}

fn mapped_canonical_season_is_final(
    store: &DurableStore,
    media_type: &str,
    media_id: &str,
    season: u32,
) -> bool {
    let Some(scope_key) = super::playback_title_scope_key(Some(media_type), Some(media_id)) else {
        return false;
    };
    // Any partial eviction removes the digest, so surviving keys cannot prove the final season.
    if store
        .get(playback_episode_mapping_digest_item_key(&scope_key))
        .and_then(read_episode_mapping_digest)
        .is_none()
    {
        return false;
    }
    let index = load_advisory_index(store, PLAYBACK_EPISODE_MAPPING_INDEX_KEY);
    max_mapped_canonical_season(&index, media_type, media_id)
        .is_some_and(|max_season| season >= max_season)
}

impl PlaybackStateService {
    /// Caches the canonical→source coordinate mapping for every episode and returns
    /// the resolved snapshots so callers skip a second store pass. `None` = the
    /// scope inputs failed normalization.
    /// A per-title digest short-circuits repeat opens (unchanged lists pay one small
    /// read); it lives in the store under the same generation-guarded section and
    /// is deleted for any scope whose entries the cap prune evicts.
    pub(crate) fn cache_episode_mappings(
        &self,
        app: &AppHandle,
        media_type: &str,
        media_id: &str,
        fallback_lookup_id: Option<&str>,
        episodes: &[Episode],
    ) -> Result<Option<Vec<PlaybackEpisodeMappingSnapshot>>, String> {
        let Some(media_type) = normalize_watch_progress_type(media_type) else {
            return Ok(None);
        };
        let Some(media_id) = normalize_media_id(media_id) else {
            return Ok(None);
        };

        if episodes.is_empty() {
            // Empty addon metadata does not prove that previously mapped episodes were removed.
            return Ok(Some(Vec::new()));
        }

        // Snapshots are a pure function of the episode list — compute up front so
        // they're returned even when the write is skipped or a racing clear drops it.
        let normalized_fallback_lookup_id = fallback_lookup_id.and_then(normalize_media_id);
        let updated_at = now_unix_millis();
        let snapshots: Vec<PlaybackEpisodeMappingSnapshot> = episodes
            .iter()
            .map(|episode| {
                build_episode_mapping_snapshot(
                    media_type,
                    &media_id,
                    normalized_fallback_lookup_id.as_deref(),
                    episode,
                    updated_at,
                )
            })
            .collect();
        let digest = episode_mappings_digest(
            media_type,
            &media_id,
            normalized_fallback_lookup_id.as_deref(),
            episodes,
        );
        let scope_key = format!("{media_type}:{media_id}");
        let digest_key = playback_episode_mapping_digest_item_key(&scope_key);

        let start_generation = self.history_generation();
        let store = self.open_state_store(app)?;
        // `clear` wipes episode-mapping keys with history; a racing fetch must not
        // repopulate them (same `set` hazard as `record_stream_outcome`). The lock
        // makes check-vs-write atomic against `clear`/`remove_keys`.
        let _state_file_guard = self.lock_state_file_write();
        if self.history_generation() != start_generation {
            return Ok(Some(snapshots));
        }

        // Digest match proves every item was already written. The seen_at refresh
        // lands in the in-memory map and rides the next writer's flush — no save of its own.
        if stored_episode_mapping_digest_matches(&store, &digest_key, digest, updated_at) {
            return Ok(Some(snapshots));
        }

        let mut episode_mapping_index =
            load_advisory_index(&store, PLAYBACK_EPISODE_MAPPING_INDEX_KEY);
        let (pending_writes, pending_deletes, mut changed) = collect_episode_mapping_writes(
            &store,
            media_type,
            &media_id,
            episodes,
            &snapshots,
            &mut episode_mapping_index,
        );

        // Item writes apply only after a second generation check — a clear that bumped mid-scan can't land orphaned items.
        if self.history_generation() != start_generation {
            return Ok(Some(snapshots));
        }
        for snapshot_key in pending_deletes {
            store.delete(playback_episode_mapping_item_key(&snapshot_key));
        }
        if !pending_writes.is_empty() {
            changed = true;
            for (snapshot_key, snapshot) in pending_writes {
                store.set(
                    playback_episode_mapping_item_key(&snapshot_key),
                    json!(snapshot),
                );
            }
        }

        let (pruned, digest_invalidated) =
            prune_episode_mapping_index(&store, &mut episode_mapping_index, &scope_key);
        changed |= pruned;

        if !digest_invalidated {
            store.set(
                digest_key,
                json!(EpisodeMappingDigestRecord {
                    digest,
                    seen_at: updated_at,
                }),
            );
        }
        if changed {
            store.set(
                PLAYBACK_EPISODE_MAPPING_INDEX_KEY,
                json!(episode_mapping_index),
            );
        }
        store.save()?;

        Ok(Some(snapshots))
    }

    pub(crate) fn get_episode_video_id(
        &self,
        app: &AppHandle,
        media_type: &str,
        media_id: &str,
        season: u32,
        episode: u32,
    ) -> Result<Option<String>, String> {
        let Some(media_type) = normalize_watch_progress_type(media_type) else {
            return Ok(None);
        };
        let Some(media_id) = normalize_media_id(media_id) else {
            return Ok(None);
        };
        let store = self.open_state_store(app)?;
        let key = playback_episode_mapping_snapshot_key(media_type, &media_id, season, episode);
        let cached: Option<CachedEpisodeMapping> =
            store.get_typed(playback_episode_mapping_item_key(&key));
        Ok(cached.and_then(|cached| {
            cached
                .video_id
                .as_deref()
                .and_then(|id| normalize_media_id(crate::commands::js_trim(id)))
        }))
    }

    pub(crate) fn get_episode_mapping(
        &self,
        app: &AppHandle,
        media_type: &str,
        media_id: &str,
        canonical_season: u32,
        canonical_episode: u32,
    ) -> Result<Option<PlaybackEpisodeMappingSnapshot>, String> {
        let Some(media_type) = normalize_watch_progress_type(media_type) else {
            return Ok(None);
        };
        let Some(media_id) = normalize_media_id(media_id) else {
            return Ok(None);
        };

        let store = self.open_state_store(app)?;
        Ok(load_playback_episode_mapping_snapshot(
            &store,
            &playback_episode_mapping_snapshot_key(
                media_type,
                &media_id,
                canonical_season,
                canonical_episode,
            ),
        ))
    }

    /// Whether the requested canonical season is the show's final season, per the
    /// cached mapping index. Blocking store read — callers run it on `run_blocking_store_op`.
    pub(crate) fn episode_is_final_season(
        &self,
        app: &AppHandle,
        media_type: &str,
        media_id: &str,
        season: Option<u32>,
    ) -> bool {
        let Some(season) = season else {
            return false;
        };
        let Ok(store) = self.open_state_store(app) else {
            crate::operational_log::log_warn(
                "playback-state",
                "episode_is_final_season",
                "degraded",
                &[crate::operational_log::field("media_id", media_id)],
            );
            return false;
        };
        mapped_canonical_season_is_final(&store, media_type, media_id, season)
    }
}

#[cfg(test)]
mod tests;
