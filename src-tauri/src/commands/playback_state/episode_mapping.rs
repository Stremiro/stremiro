use super::{
    insert_sorted_unique, load_index, prune_index_to_cap, PlaybackStateService,
    PLAYBACK_STATE_STORE_FILE,
};
use crate::commands::episode_navigation::build_source_episode_coordinates;
use crate::commands::{
    normalize_media_id, normalize_watch_progress_type, now_unix_millis, DurableStore,
};
use crate::providers::Episode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use tauri::AppHandle;

pub(super) const PLAYBACK_EPISODE_MAPPING_INDEX_KEY: &str = "playback_episode_mapping_index";
pub(super) const PLAYBACK_EPISODE_MAPPING_ITEM_PREFIX: &str = "playback_episode_mapping_item:";
pub(super) const PLAYBACK_EPISODE_MAPPING_DIGEST_ITEM_PREFIX: &str =
    "playback_episode_mapping_digest_item:";
/// Hard bound for cached episode-coordinate mappings. Health indexes prune by
/// recency; mappings are keyed per episode and would otherwise grow without
/// bound as the user browses more series.
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

/// Scope (`{type}:{id}`) of a `{type}:{id}:{season}:{episode}` snapshot key:
/// strip the two trailing coordinate segments since media ids may contain
/// `:` themselves.
fn episode_mapping_scope_key(snapshot_key: &str) -> Option<&str> {
    snapshot_key
        .rfind(':')
        .and_then(|end| snapshot_key[..end].rfind(':'))
        .map(|split| &snapshot_key[..split])
}

/// Canonical season of a mapping-index key, read from the right because
/// media ids may themselves contain `:`.
fn mapping_index_key_canonical_season(key: &str) -> Option<u32> {
    let episode_split = key.rfind(':')?;
    let season_split = key[..episode_split].rfind(':')?;
    key[season_split + 1..episode_split].parse::<u32>().ok()
}

/// Highest canonical season the title's cached episode mappings cover. The
/// episode battery resolves numberless "final season" naming claims through
/// it: a requested season at or beyond the max is the only season such a
/// claim can refer to. An unmapped title yields `None` — the caller degrades
/// to "not final", so final-season-named releases lose their loose-match
/// credit and same-episode pools still rank by quality.
pub(super) fn max_mapped_canonical_season(
    index_keys: &[String],
    media_type: &str,
    media_id: &str,
) -> Option<u32> {
    let canonical_type = normalize_watch_progress_type(media_type)?;
    let normalized_id = normalize_media_id(media_id)?;
    // The trailing `:` guards the prefix: `series:tt1:` must not match
    // `series:tt12345:…`.
    let scope_prefix = format!("{canonical_type}:{normalized_id}:");
    index_keys
        .iter()
        .filter(|key| key.starts_with(&scope_prefix))
        .filter_map(|key| mapping_index_key_canonical_season(key))
        .max()
}

/// Digest plus the last details-open that verified it. `seen_at` feeds the
/// cap prune's recency so actively opened titles outlive browsed-once ones;
/// without it an active title would evict on its first-write age.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub(super) struct EpisodeMappingDigestRecord {
    pub(super) digest: u64,
    pub(super) seen_at: u64,
}

/// Reads both the current record shape and legacy bare-u64 digests (seen_at
/// 0 keeps those prune-able until the next open rewrites the record).
fn read_episode_mapping_digest(value: &serde_json::Value) -> Option<(u64, u64)> {
    if let Some(digest) = value.as_u64() {
        return Some((digest, 0));
    }
    serde_json::from_value::<EpisodeMappingDigestRecord>(value.clone())
        .ok()
        .map(|record| (record.digest, record.seen_at))
}

/// Fingerprint of every input `build_episode_mapping_snapshot` reads, so a
/// details re-open with an unchanged episode list skips the per-episode
/// store read/compare loop. Persisted per title; a mismatch (or eviction)
/// simply costs one rescan, never a wrong result.
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
        episode.season.hash(&mut hasher);
        episode.episode.hash(&mut hasher);
        episode.stream_lookup_id.hash(&mut hasher);
        episode.stream_season.hash(&mut hasher);
        episode.stream_episode.hash(&mut hasher);
    }
    hasher.finish()
}

/// Digest short-circuit for `cache_episode_mappings`: a stored digest equal
/// to the just-computed one proves every item was already written, so the
/// per-episode read/compare loop is skipped entirely.
pub(super) fn stored_episode_mapping_digest_matches(
    store: &DurableStore,
    digest_key: &str,
    digest: u64,
    updated_at: u64,
) -> bool {
    let matches = store
        .get(digest_key)
        .and_then(|value| read_episode_mapping_digest(&value))
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

/// Diff pass for `cache_episode_mappings`: walk episodes against stored
/// snapshots, queue changed item writes, and register every snapshot key in
/// the sorted index. The caller applies the queued writes only after a
/// second generation check so a racing clear cannot land orphaned items.
/// Returns the queued `(item key, snapshot)` writes plus whether the index
/// gained a key.
pub(super) fn collect_episode_mapping_writes(
    store: &DurableStore,
    media_type: &str,
    media_id: &str,
    episodes: &[Episode],
    snapshots: &[PlaybackEpisodeMappingSnapshot],
    episode_mapping_index: &mut Vec<String>,
) -> (Vec<(String, PlaybackEpisodeMappingSnapshot)>, bool) {
    let mut changed = false;
    let mut pending_writes = Vec::new();

    for (episode, next_snapshot) in episodes.iter().zip(snapshots.iter()) {
        let snapshot_key = playback_episode_mapping_snapshot_key(
            media_type,
            media_id,
            episode.season,
            episode.episode,
        );
        let needs_write = load_playback_episode_mapping_snapshot(store, &snapshot_key)
            .is_none_or(|existing| !episode_mapping_snapshot_matches(&existing, next_snapshot));

        if needs_write {
            pending_writes.push((snapshot_key.clone(), next_snapshot.clone()));
        }
        if insert_sorted_unique(episode_mapping_index, &snapshot_key) {
            changed = true;
        }
    }

    (pending_writes, changed)
}

/// Cap prune for `cache_episode_mappings`: evicts oldest index entries by
/// max(item `updated_at`, scope digest `seen_at`) and deletes the digest of
/// every scope that lost an item — a surviving digest would suppress the
/// rewrite those evicted items need on the next details open. Returns
/// whether the index changed and whether this title's own digest was
/// invalidated (its entries evicted), in which case the caller must not
/// re-arm it.
pub(super) fn prune_episode_mapping_index(
    store: &DurableStore,
    episode_mapping_index: &mut Vec<String>,
    own_scope_key: &str,
) -> (bool, bool) {
    if episode_mapping_index.len() <= PLAYBACK_EPISODE_MAPPING_MAX_ENTRIES {
        return (false, false);
    }

    let pre_prune = episode_mapping_index.clone();
    prune_index_to_cap(
        store,
        episode_mapping_index,
        PLAYBACK_EPISODE_MAPPING_MAX_ENTRIES,
        |store, key| {
            let item_updated = load_playback_episode_mapping_snapshot(store, key)
                .map(|snapshot| snapshot.updated_at)
                .unwrap_or(0);
            // Item timestamps only move when coordinates change, so recency
            // for the cap also rides the scope digest's `seen_at` — an
            // actively opened title must not evict on its first-write age.
            let scope_seen = episode_mapping_scope_key(key)
                .and_then(|scope| store.get(playback_episode_mapping_digest_item_key(scope)))
                .and_then(|value| read_episode_mapping_digest(&value))
                .map(|(_, seen_at)| seen_at)
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
    store
        .get(playback_episode_mapping_item_key(key))
        .and_then(|value| serde_json::from_value::<PlaybackEpisodeMappingSnapshot>(value).ok())
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

impl PlaybackStateService {
    /// Caches the canonical→source coordinate mapping for every episode and
    /// returns the snapshots it resolved so callers enrich or look up
    /// coordinates without a second store pass. `None` means the title's
    /// scope inputs failed normalization, in which case no mapping exists.
    ///
    /// A per-title digest of the mapping inputs short-circuits repeat opens:
    /// unchanged episode lists pay one small store read instead of a read +
    /// JSON parse per episode. The digest lives in the same store it
    /// describes, written under the same generation-guarded section, and is
    /// deleted for any scope whose entries the cap prune evicts.
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
            return Ok(Some(Vec::new()));
        }

        // Snapshots are a pure function of the episode list: compute them up
        // front so they are returned even when the write is skipped or a
        // racing clear drops it.
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
        let store = crate::commands::open_store(app, PLAYBACK_STATE_STORE_FILE)?;
        // `clear` wipes episode-mapping keys with history; a mapping fetch
        // racing it must not repopulate them (same in-memory `set` hazard
        // as `record_stream_outcome`). The lock makes the check-vs-write
        // sequence atomic against `clear`/`remove_keys`.
        let _state_file_guard = self.lock_state_file_write();
        if self.history_generation() != start_generation {
            return Ok(Some(snapshots));
        }

        // Unchanged inputs: the stored digest proves every item was already
        // written, so skip the per-episode read/compare loop entirely. The
        // seen_at refresh lands in the shared in-memory map and rides the
        // next writer's flush — no save of its own.
        if stored_episode_mapping_digest_matches(&store, &digest_key, digest, updated_at) {
            return Ok(Some(snapshots));
        }

        let mut episode_mapping_index = load_index(&store, PLAYBACK_EPISODE_MAPPING_INDEX_KEY);
        let (pending_writes, mut changed) = collect_episode_mapping_writes(
            &store,
            media_type,
            &media_id,
            episodes,
            &snapshots,
            &mut episode_mapping_index,
        );

        // Item writes apply only after a second generation check: a clear
        // that bumped while this pass scanned cannot land orphaned items.
        if self.history_generation() != start_generation {
            return Ok(Some(snapshots));
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

        let store = crate::commands::open_store(app, PLAYBACK_STATE_STORE_FILE)?;
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

    /// Whether the requested canonical season is the show's final season,
    /// per the cached episode-mapping index. Blocking store read: callers
    /// run it on the blocking pool (`run_blocking_store_op`).
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
        let Ok(store) = crate::commands::open_store(app, PLAYBACK_STATE_STORE_FILE) else {
            return false;
        };
        let index = load_index(&store, PLAYBACK_EPISODE_MAPPING_INDEX_KEY);
        max_mapped_canonical_season(&index, media_type, media_id)
            .is_some_and(|max_season| season >= max_season)
    }
}

#[cfg(test)]
mod tests;
