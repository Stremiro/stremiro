use super::store_helpers::{
    library_item_key, load_library_index, load_library_map, load_watch_status_index,
    merge_library_item, normalize_library_item, watch_status_item_key,
};
use super::{
    normalize_media_id, run_blocking_store_op, DurableStore, LIBRARY_INDEX_KEY, LIBRARY_STORE_FILE,
    WATCH_STATUS_INDEX_KEY, WATCH_STATUS_STORE_FILE,
};
use crate::providers::MediaItem;
use serde_json::json;
use tauri::{command, AppHandle};

/// Bound on the library index: every add rewrites the index key, so an
/// unbounded index makes every read/write linear in junk entries.
pub(super) const MAX_LIBRARY_ITEMS: usize = 5_000;

/// Prepare without mutating either domain: status-set uses this preflight
/// before writing its status, so a full library rejects the entire action.
pub(super) fn prepare_library_write(
    store: &DurableStore,
    item: MediaItem,
) -> Result<(MediaItem, Vec<String>), String> {
    let mut index = load_library_index(store)?;
    let item = normalize_library_item(item).ok_or_else(|| {
        "Invalid library item. ID, title, and media type are required.".to_string()
    })?;
    let existing = store
        .get(library_item_key(&item.id))
        .and_then(|value| serde_json::from_value::<MediaItem>(value).ok())
        .and_then(normalize_library_item);
    let item = if let Some(existing) = existing {
        merge_library_item(existing, item)
    } else {
        item
    };
    if !index.contains(&item.id) {
        if index.len() >= MAX_LIBRARY_ITEMS {
            return Err("Library is full.".to_string());
        }
        index.push(item.id.clone());
        index.sort();
    }
    Ok((item, index))
}

#[command]
pub async fn add_to_library(app: AppHandle, item: MediaItem) -> Result<(), String> {
    run_blocking_store_op(move || {
        let store = super::open_store(&app, LIBRARY_STORE_FILE)?;
        let (final_item, index) = prepare_library_write(&store, item)?;

        store.set(library_item_key(&final_item.id), json!(final_item));
        store.set(LIBRARY_INDEX_KEY, json!(index));
        store.save()?;
        Ok(())
    })
    .await
}

#[command]
pub async fn remove_from_library(app: AppHandle, id: String) -> Result<(), String> {
    run_blocking_store_op(move || {
        let store = super::open_store(&app, LIBRARY_STORE_FILE)?;
        let id =
            normalize_media_id(&id).ok_or_else(|| "Invalid media id for library.".to_string())?;

        let mut index = load_library_index(&store)?;

        // Watch status is a library attribute: clear it in the same blocking
        // op so a removed title can't leave an invisible status row. Both stores and both
        // indexes are opened and validated before any delete/set/save, so a
        // corrupt status index fails before the library entry is touched.
        let status_store = super::open_store(&app, WATCH_STATUS_STORE_FILE)?;
        let mut status_index = load_watch_status_index(&status_store)?;

        let deleted_item = store.delete(library_item_key(&id));
        let original_len = index.len();
        index.retain(|entry| entry != &id);

        if deleted_item || index.len() != original_len {
            store.set(LIBRARY_INDEX_KEY, json!(index));
            store.save()?;
        }

        let removed_status = status_store.delete(watch_status_item_key(&id));
        let original_status_len = status_index.len();
        status_index.retain(|entry| entry != &id);
        if removed_status || status_index.len() != original_status_len {
            status_store.set(WATCH_STATUS_INDEX_KEY, json!(status_index));
            status_store.save()?;
        }

        Ok(())
    })
    .await
}

#[command]
pub async fn get_library(app: AppHandle) -> Result<Vec<MediaItem>, String> {
    run_blocking_store_op(move || {
        let store = super::open_store(&app, LIBRARY_STORE_FILE)?;
        let cleaned = load_library_map(&store)?;

        let mut items: Vec<MediaItem> = cleaned.into_values().collect();
        // Cached key: one lowercase allocation per item instead of O(n log n) inside the comparator.
        items.sort_by_cached_key(|item| (item.title.to_lowercase(), item.id.clone()));

        Ok(items)
    })
    .await
}
