use super::store_helpers::{
    library_item_key, load_watch_status_index, load_watch_statuses_map, normalize_watch_status,
    watch_status_item_key,
};
use super::{
    normalize_media_id, LIBRARY_INDEX_KEY, LIBRARY_STORE_FILE, WATCH_STATUS_INDEX_KEY,
    WATCH_STATUS_STORE_FILE,
};
use crate::providers::MediaItem;
use serde_json::json;
use std::collections::HashMap;
use tauri::{command, AppHandle};

/// Bound on the status index: every set rewrites the index key, so an
/// unbounded index makes every read/write linear in junk entries.
pub(super) const MAX_WATCH_STATUS_ITEMS: usize = 10_000;

#[command]
pub async fn set_watch_status(
    app: AppHandle,
    item: MediaItem,
    status: Option<String>,
) -> Result<Option<MediaItem>, String> {
    // Store file IO is blocking: run the read-modify-write off the async
    // worker, matching the library/history command pattern.
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, WATCH_STATUS_STORE_FILE)?;
        // The id is a store key: reject malformed input rather than truncate
        // so two hostile ids can't collide onto one key, and never silently
        // accept a payload that can't round-trip.
        let item_id = normalize_media_id(&item.id)
            .ok_or_else(|| "Invalid media id for watch status.".to_string())?;

        let mut index = load_watch_status_index(&store)?;

        match status {
            Some(value) => {
                let Some(canonical) = normalize_watch_status(&value) else {
                    return Err("Invalid watch status.".to_string());
                };
                if !index.contains(&item_id) {
                    if index.len() >= MAX_WATCH_STATUS_ITEMS {
                        return Err("Watch status list is full.".to_string());
                    }
                    index.push(item_id.clone());
                    index.sort();
                }
                let library_store = super::open_store(&app, LIBRARY_STORE_FILE)?;
                let (item, library_index) =
                    super::library_commands::prepare_library_write(&library_store, item)?;
                // Both indexes, capacities and payloads are validated before
                // either domain is mutated, under the shared store-op lock.
                library_store.set(library_item_key(&item_id), json!(item));
                library_store.set(LIBRARY_INDEX_KEY, json!(library_index));
                library_store.save()?;
                store.set(watch_status_item_key(&item_id), json!(canonical));
                store.set(WATCH_STATUS_INDEX_KEY, json!(index));
                store.save()?;
                return Ok(Some(item));
            }
            None => {
                let removed_item = store.delete(watch_status_item_key(&item_id));
                let original_len = index.len();
                index.retain(|id| id != &item_id);
                // Clearing an id that was never tracked is a no-op: skip the
                // index rewrite + save so callers that pre-clear on library
                // removal don't pay a store write per remove.
                if !removed_item && index.len() == original_len {
                    return Ok(None);
                }
            }
        }

        store.set(WATCH_STATUS_INDEX_KEY, json!(index));
        store.save()?;
        Ok(None)
    })
    .await
}

#[command]
pub async fn get_all_watch_statuses(app: AppHandle) -> Result<HashMap<String, String>, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, WATCH_STATUS_STORE_FILE)?;
        load_watch_statuses_map(&store)
    })
    .await
}
