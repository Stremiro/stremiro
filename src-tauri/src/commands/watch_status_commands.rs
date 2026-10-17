use super::library_commands::LibraryWriteError;
use super::store_helpers::{
    library_item_key, load_watch_status_index, load_watch_statuses_map, normalize_library_items,
    normalize_watch_status, persist_index_map, read_library_snapshot, read_watch_status_snapshot,
    watch_status_item_key, LIBRARY_LAYOUT, WATCH_STATUS_LAYOUT,
};
use super::{
    normalize_media_id, run_typed_store_op, DurableStore, LIBRARY_INDEX_KEY, LIBRARY_STORE_FILE,
    WATCH_STATUS_INDEX_KEY, WATCH_STATUS_STORE_FILE,
};
use crate::providers::MediaItem;
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use tauri::{command, AppHandle};

/// Bound on the status index: every set rewrites the index key, so an
/// unbounded index makes every read/write linear in junk entries.
pub(super) const MAX_WATCH_STATUS_ITEMS: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchStatusErrorKind {
    InvalidItem,
    InvalidStatus,
    StatusCapacity,
    LibraryCapacity,
    Failed,
}

#[derive(Debug, Serialize)]
pub struct WatchStatusError {
    pub kind: WatchStatusErrorKind,
    pub message: String,
}

impl WatchStatusError {
    fn new(kind: WatchStatusErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl From<String> for WatchStatusError {
    fn from(message: String) -> Self {
        Self::new(WatchStatusErrorKind::Failed, message)
    }
}

impl From<LibraryWriteError> for WatchStatusError {
    fn from(error: LibraryWriteError) -> Self {
        match error {
            LibraryWriteError::InvalidItem(message) => {
                Self::new(WatchStatusErrorKind::InvalidItem, message)
            }
            LibraryWriteError::CapacityExceeded(message) => {
                Self::new(WatchStatusErrorKind::LibraryCapacity, message)
            }
            LibraryWriteError::Failed(message) => message.into(),
        }
    }
}

#[command]
pub async fn set_watch_status(
    app: AppHandle,
    item: MediaItem,
    status: Option<String>,
) -> Result<Option<MediaItem>, WatchStatusError> {
    // Store file IO is blocking: run the read-modify-write off the async
    // worker, matching the library/history command pattern.
    run_typed_store_op(move || {
        let store = super::open_store(&app, WATCH_STATUS_STORE_FILE)?;
        // The id is a store key — reject malformed input rather than truncate, so
        // hostile ids can't collide onto one key or fail to round-trip.
        let item_id = normalize_media_id(&item.id).ok_or_else(|| {
            WatchStatusError::new(
                WatchStatusErrorKind::InvalidItem,
                "Invalid media id for watch status.",
            )
        })?;

        let mut index = load_watch_status_index(&store)?;

        match status {
            Some(value) => {
                let Some(canonical) = normalize_watch_status(&value) else {
                    return Err(WatchStatusError::new(
                        WatchStatusErrorKind::InvalidStatus,
                        "Invalid watch status.",
                    ));
                };
                if !index.contains(&item_id) {
                    if index.len() >= MAX_WATCH_STATUS_ITEMS {
                        return Err(WatchStatusError::new(
                            WatchStatusErrorKind::StatusCapacity,
                            "Watch status list is full.",
                        ));
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
                if !removed_item && index.len() == original_len {
                    store.save()?;
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

fn normalize_bulk_status(status: Option<String>) -> Result<Option<String>, WatchStatusError> {
    status
        .map(|status| {
            normalize_watch_status(&status).ok_or_else(|| {
                WatchStatusError::new(WatchStatusErrorKind::InvalidStatus, "Invalid watch status.")
            })
        })
        .transpose()
}

fn normalize_bulk_status_items(
    items: Vec<MediaItem>,
) -> Result<HashMap<String, MediaItem>, WatchStatusError> {
    // Validate every payload, including overwritten duplicates, before opening stores.
    Ok(normalize_library_items(items)
        .map_err(|message| WatchStatusError::new(WatchStatusErrorKind::InvalidItem, message))?
        .into_iter()
        .map(|item| (item.id.clone(), item))
        .collect())
}

fn clear_watch_status_items(
    store: &DurableStore,
    items: &HashMap<String, MediaItem>,
) -> Result<usize, WatchStatusError> {
    let mut statuses = read_watch_status_snapshot(store)?;
    let changed = items
        .keys()
        .filter(|id| statuses.items.remove(*id).is_some())
        .count();
    if changed > 0 {
        persist_index_map(store, WATCH_STATUS_LAYOUT, &statuses.index, &statuses.items)?;
    } else {
        store.save()?;
    }
    Ok(changed)
}

fn set_watch_status_items(
    store: &DurableStore,
    library_store: &DurableStore,
    items: HashMap<String, MediaItem>,
    status: String,
) -> Result<usize, WatchStatusError> {
    let mut statuses = read_watch_status_snapshot(store)?;
    let mut library = read_library_snapshot(library_store)?;
    let new_library_count = items
        .keys()
        .filter(|id| !library.items.contains_key(*id))
        .count();
    if new_library_count > 0
        && library.items.len() + new_library_count > super::library_commands::MAX_LIBRARY_ITEMS
    {
        return Err(WatchStatusError::new(
            WatchStatusErrorKind::LibraryCapacity,
            format!(
                "Library cannot exceed {} items",
                super::library_commands::MAX_LIBRARY_ITEMS
            ),
        ));
    }
    let new_status_count = items
        .keys()
        .filter(|id| !statuses.items.contains_key(*id))
        .count();
    if new_status_count > 0 && statuses.items.len() + new_status_count > MAX_WATCH_STATUS_ITEMS {
        return Err(WatchStatusError::new(
            WatchStatusErrorKind::StatusCapacity,
            "Watch status list is full.",
        ));
    }
    let processed = items.len();
    let mut status_changed = false;
    let mut library_changed = false;
    for (id, item) in items {
        if statuses.items.get(&id) != Some(&status) {
            statuses.items.insert(id.clone(), status.clone());
            status_changed = true;
        }
        if let std::collections::hash_map::Entry::Vacant(entry) = library.items.entry(id) {
            entry.insert(item);
            library_changed = true;
        }
    }
    // Library first, as in single status-set: a durable status must not outlive
    // a failed library insertion. Both snapshots/capacities were validated above.
    if library_changed {
        persist_index_map(
            library_store,
            LIBRARY_LAYOUT,
            &library.index,
            &library.items,
        )?;
    } else {
        library_store.save()?;
    }
    if status_changed {
        persist_index_map(store, WATCH_STATUS_LAYOUT, &statuses.index, &statuses.items)?;
    } else {
        store.save()?;
    }
    Ok(processed)
}

#[command]
pub async fn bulk_set_watch_status(
    app: AppHandle,
    items: Vec<MediaItem>,
    status: Option<String>,
) -> Result<usize, WatchStatusError> {
    run_typed_store_op(move || {
        let status = normalize_bulk_status(status)?;
        if items.is_empty() {
            return Ok(0);
        }
        let items = normalize_bulk_status_items(items)?;
        let store = super::open_store(&app, WATCH_STATUS_STORE_FILE)?;
        match status {
            None => clear_watch_status_items(&store, &items),
            Some(status) => {
                let library_store = super::open_store(&app, LIBRARY_STORE_FILE)?;
                set_watch_status_items(&store, &library_store, items, status)
            }
        }
    })
    .await
}

#[command]
pub async fn get_all_watch_statuses(
    app: AppHandle,
) -> Result<HashMap<String, String>, WatchStatusError> {
    run_typed_store_op(move || {
        let store = super::open_store(&app, WATCH_STATUS_STORE_FILE)?;
        Ok(load_watch_statuses_map(&store)?)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::{test_media_item, test_store};

    #[test]
    fn library_preflight_errors_preserve_watch_status_kinds_and_library_messages() {
        use super::super::library_commands::{prepare_library_write, MAX_LIBRARY_ITEMS};

        let library = test_store();
        let error =
            prepare_library_write(&library.store, test_media_item("", "movie")).unwrap_err();
        assert!(matches!(error, LibraryWriteError::InvalidItem(_)));
        let message = "Invalid library item. ID, title, and media type are required.";
        assert_eq!(String::from(error), message);
        let error: WatchStatusError =
            prepare_library_write(&library.store, test_media_item("", "movie"))
                .unwrap_err()
                .into();
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({"kind": "invalid_item", "message": message})
        );

        let ids: Vec<String> = (0..MAX_LIBRARY_ITEMS)
            .map(|index| format!("id{index}"))
            .collect();
        library.store.set(LIBRARY_INDEX_KEY, json!(ids));
        let error =
            prepare_library_write(&library.store, test_media_item("new", "movie")).unwrap_err();
        assert!(matches!(error, LibraryWriteError::CapacityExceeded(_)));
        assert_eq!(String::from(error), "Library is full.");
        let error: WatchStatusError =
            prepare_library_write(&library.store, test_media_item("new", "movie"))
                .unwrap_err()
                .into();
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({"kind": "library_capacity", "message": "Library is full."})
        );

        library
            .store
            .set(LIBRARY_INDEX_KEY, json!({"corrupt": true}));
        let message = super::super::store_helpers::load_library_index(&library.store).unwrap_err();
        let error =
            prepare_library_write(&library.store, test_media_item("new", "movie")).unwrap_err();
        assert!(matches!(error, LibraryWriteError::Failed(_)));
        assert_eq!(String::from(error), message);
        let error: WatchStatusError =
            prepare_library_write(&library.store, test_media_item("new", "movie"))
                .unwrap_err()
                .into();
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({"kind": "failed", "message": message})
        );
        assert_eq!(library.store.save_count(), 0);
    }

    #[test]
    fn bulk_status_set_deduplicates_and_auto_inserts_library_once() {
        let statuses = test_store();
        let library = test_store();
        let existing = test_media_item("a", "movie");
        library.store.set(LIBRARY_INDEX_KEY, json!(["a"]));
        library.store.set(library_item_key("a"), json!(existing));
        library.store.save().unwrap();
        let mut last = test_media_item(" b ", "series");
        last.title = "Last occurrence".into();
        let items = normalize_bulk_status_items(vec![
            test_media_item("a", "movie"),
            test_media_item("b", "series"),
            last,
        ])
        .unwrap();
        let status = normalize_bulk_status(Some(" WATCHED ".into()))
            .unwrap()
            .unwrap();
        assert_eq!(
            set_watch_status_items(
                &statuses.store,
                &library.store,
                items.clone(),
                status.clone()
            )
            .unwrap(),
            2
        );
        assert_eq!(
            statuses.store.get(watch_status_item_key("a")),
            Some(json!("watched"))
        );
        assert_eq!(
            statuses.store.get(watch_status_item_key("b")),
            Some(json!("watched"))
        );
        assert_eq!(
            library.store.get(LIBRARY_INDEX_KEY),
            Some(json!(["a", "b"]))
        );
        assert_eq!(
            library.store.get(library_item_key("a")),
            Some(json!(existing))
        );
        assert_eq!(
            library
                .store
                .get_typed::<MediaItem>(library_item_key("b"))
                .unwrap()
                .title,
            "Last occurrence"
        );
        assert_eq!(statuses.store.save_count(), 1);
        assert_eq!(library.store.save_count(), 2);
        assert_eq!(
            set_watch_status_items(&statuses.store, &library.store, items, status).unwrap(),
            2
        );
        assert_eq!(statuses.store.save_count(), 1);
        assert_eq!(library.store.save_count(), 2);
    }

    #[test]
    fn bulk_status_clear_keeps_library_intact_and_counts_removed_entries() {
        let statuses = test_store();
        let library = test_store();
        let items = normalize_bulk_status_items(vec![
            test_media_item("a", "movie"),
            test_media_item("b", "movie"),
        ])
        .unwrap();
        set_watch_status_items(
            &statuses.store,
            &library.store,
            items.clone(),
            "watching".into(),
        )
        .unwrap();
        let before = std::fs::read(&library.path).unwrap();
        assert_eq!(normalize_bulk_status(None).unwrap(), None);
        assert_eq!(
            clear_watch_status_items(&statuses.store, &items).unwrap(),
            2
        );
        assert_eq!(statuses.store.get(WATCH_STATUS_INDEX_KEY), Some(json!([])));
        assert_eq!(std::fs::read(&library.path).unwrap(), before);
        assert_eq!(library.store.save_count(), 1);
        assert_eq!(statuses.store.save_count(), 2);
        assert_eq!(
            clear_watch_status_items(&statuses.store, &items).unwrap(),
            0
        );
        assert_eq!(statuses.store.save_count(), 2);
    }

    #[test]
    fn bulk_status_invalid_input_fails_without_partial_writes() {
        let statuses = test_store();
        let library = test_store();
        for (status, items) in [
            ("invalid", vec![test_media_item("a", "movie")]),
            (
                "watched",
                vec![test_media_item("a", "movie"), test_media_item("", "movie")],
            ),
            (
                "watched",
                vec![test_media_item("a", "movie"), test_media_item("b", "bad")],
            ),
            (
                "watched",
                vec![test_media_item("a", "movie"), test_media_item("a", "bad")],
            ),
            ("invalid", Vec::new()),
        ] {
            let result = normalize_bulk_status(Some(status.into())).and_then(|status| {
                let items = normalize_bulk_status_items(items)?;
                set_watch_status_items(&statuses.store, &library.store, items, status.unwrap())
            });
            let error = result.unwrap_err();
            let (kind, message) = if status == "invalid" {
                (WatchStatusErrorKind::InvalidStatus, "Invalid watch status.")
            } else {
                (
                    WatchStatusErrorKind::InvalidItem,
                    "Invalid media item. Missing required id, title, or type.",
                )
            };
            assert_eq!(error.kind, kind);
            assert_eq!(error.message, message);
            statuses.store.save().unwrap();
            library.store.save().unwrap();
            assert!(!statuses.path.exists());
            assert!(!library.path.exists());
        }
    }

    #[test]
    fn bulk_status_capacity_failure_does_not_read_repair_or_write_either_store() {
        let statuses = test_store();
        let library = test_store();
        let ids: Vec<String> = (0..super::super::library_commands::MAX_LIBRARY_ITEMS)
            .map(|index| format!("id{index}"))
            .collect();
        for id in &ids {
            library
                .store
                .set(library_item_key(id), json!(test_media_item(id, "movie")));
        }
        library.store.set(LIBRARY_INDEX_KEY, json!(ids));
        // A read-repairing loader would delete this missing row even though the batch fails.
        statuses
            .store
            .set(WATCH_STATUS_INDEX_KEY, json!(["missing"]));
        statuses.store.save().unwrap();
        library.store.save().unwrap();
        let status_before = std::fs::read(&statuses.path).unwrap();
        let library_before = std::fs::read(&library.path).unwrap();
        let items = normalize_bulk_status_items(vec![test_media_item("new", "movie")]).unwrap();
        let error =
            set_watch_status_items(&statuses.store, &library.store, items, "watched".into())
                .unwrap_err();
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({"kind": "library_capacity", "message": "Library cannot exceed 5000 items"})
        );
        statuses.store.save().unwrap();
        library.store.save().unwrap();
        assert_eq!(std::fs::read(&statuses.path).unwrap(), status_before);
        assert_eq!(std::fs::read(&library.path).unwrap(), library_before);
        assert_eq!(statuses.store.save_count(), 1);
        assert_eq!(library.store.save_count(), 1);
    }

    #[test]
    fn bulk_status_duplicate_ids_count_once_at_library_capacity() {
        let statuses = test_store();
        let library = test_store();
        let ids: Vec<String> = (0..super::super::library_commands::MAX_LIBRARY_ITEMS - 1)
            .map(|index| format!("id{index}"))
            .collect();
        for id in &ids {
            library
                .store
                .set(library_item_key(id), json!(test_media_item(id, "movie")));
        }
        library.store.set(LIBRARY_INDEX_KEY, json!(ids));
        let items = normalize_bulk_status_items(vec![
            test_media_item("new", "movie"),
            test_media_item("new", "movie"),
        ])
        .unwrap();
        assert_eq!(
            set_watch_status_items(&statuses.store, &library.store, items, "watched".into())
                .unwrap(),
            1
        );
        assert_eq!(library.store.save_count(), 1);
        assert_eq!(statuses.store.save_count(), 1);
    }

    #[test]
    fn bulk_status_preserves_status_capacity_before_inserting_library_items() {
        let statuses = test_store();
        let library = test_store();
        let ids: Vec<String> = (0..MAX_WATCH_STATUS_ITEMS)
            .map(|index| format!("id{index}"))
            .collect();
        for id in &ids {
            statuses
                .store
                .set(watch_status_item_key(id), json!("watched"));
        }
        statuses.store.set(WATCH_STATUS_INDEX_KEY, json!(ids));
        statuses.store.save().unwrap();
        let before = std::fs::read(&statuses.path).unwrap();
        let items = normalize_bulk_status_items(vec![test_media_item("new", "movie")]).unwrap();
        let error =
            set_watch_status_items(&statuses.store, &library.store, items, "watched".into())
                .unwrap_err();
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({"kind": "status_capacity", "message": "Watch status list is full."})
        );
        statuses.store.save().unwrap();
        library.store.save().unwrap();
        assert_eq!(std::fs::read(&statuses.path).unwrap(), before);
        assert!(!library.path.exists());
        assert_eq!(statuses.store.save_count(), 1);
    }
}
