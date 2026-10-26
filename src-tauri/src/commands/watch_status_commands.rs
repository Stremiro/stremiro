use super::library_commands::LibraryWriteError;
use super::store_helpers::{
    library_item_key, load_library_index, load_status_added_ids, load_watch_status_index,
    load_watch_statuses_map, mark_status_added, normalize_library_item, normalize_watch_status,
    persist_index_map, read_watch_status_snapshot, remove_index_ids, retain_status_added_ids,
    watch_status_item_key, LIBRARY_LAYOUT, WATCH_STATUS_LAYOUT,
};
use super::{
    normalize_media_id, run_typed_store_op, DurableStore, LIBRARY_INDEX_KEY, LIBRARY_STORE_FILE,
    WATCH_STATUS_INDEX_KEY, WATCH_STATUS_STORE_FILE,
};
use crate::providers::MediaItem;
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use tauri::{command, AppHandle};

/// Bound on the status index: every set rewrites the index key, so an
/// unbounded index makes every read/write linear in junk entries.
pub(super) const MAX_WATCH_STATUS_ITEMS: usize = 10_000;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchStatusErrorKind {
    InvalidItem,
    InvalidStatus,
    StatusCapacity,
    LibraryCapacity,
    #[default]
    Failed,
}

pub type WatchStatusError = super::CommandError<WatchStatusErrorKind>;

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

/// Returns the title's Library entry after the write; `None` means it is not in
/// the Library (clearing a status removes titles that the status added).
#[command]
pub async fn set_watch_status(
    app: AppHandle,
    item: MediaItem,
    status: Option<String>,
) -> Result<Option<MediaItem>, WatchStatusError> {
    run_typed_store_op(move || {
        let store = super::open_store(&app, WATCH_STATUS_STORE_FILE)?;
        let library_store = super::open_store(&app, LIBRARY_STORE_FILE)?;
        write_watch_status(&store, &library_store, item, status)
    })
    .await
}

fn write_watch_status(
    store: &DurableStore,
    library_store: &DurableStore,
    item: MediaItem,
    status: Option<String>,
) -> Result<Option<MediaItem>, WatchStatusError> {
    // The id is a store key — reject malformed input rather than truncate, so
    // hostile ids can't collide onto one key or fail to round-trip.
    let item_id = normalize_media_id(&item.id).ok_or_else(|| {
        WatchStatusError::new(
            WatchStatusErrorKind::InvalidItem,
            "Invalid media id for watch status.",
        )
    })?;
    let mut index = load_watch_status_index(store)?;

    let Some(canonical) = normalize_bulk_status(status)? else {
        // Validate the library before the status commits; statuses commit first
        // so a failed library save can't leave a status on a removed title.
        let library_index = load_library_index(library_store)?;
        let status_added = load_status_added_ids(library_store).contains(&item_id);
        let ids = HashSet::from([item_id.as_str()]);
        remove_index_ids(store, WATCH_STATUS_LAYOUT, index, &ids);
        store.save()?;
        if status_added {
            remove_index_ids(library_store, LIBRARY_LAYOUT, library_index, &ids);
            library_store.save()?;
            return Ok(None);
        }
        library_store.save()?;
        return Ok(library_index
            .contains(&item_id)
            .then(|| {
                library_store
                    .get_typed(library_item_key(&item_id))
                    .and_then(normalize_library_item)
                    .filter(|item| item.id == item_id)
            })
            .flatten());
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
    let (item, library_index) =
        super::library_commands::prepare_library_write(library_store, item)?;
    // Both indexes, capacities and payloads are validated before
    // either domain is mutated, under the shared store-op lock.
    library_store.set(library_item_key(&item_id), json!(item));
    if let Some(library_index) = library_index {
        library_store.set(LIBRARY_INDEX_KEY, json!(library_index));
        mark_status_added(library_store, &item_id);
    }
    library_store.save()?;
    store.set(watch_status_item_key(&item_id), json!(canonical));
    store.set(WATCH_STATUS_INDEX_KEY, json!(index));
    store.save()?;
    Ok(Some(item))
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

fn resolve_bulk_status_ids(
    store: &DurableStore,
    ids: Vec<String>,
) -> Result<Vec<String>, WatchStatusError> {
    Ok(super::library_commands::resolve_library_items(store, ids)?
        .into_iter()
        .map(|item| item.id)
        .collect())
}

/// Bulk clears run inside the Library page, so the titles stay and become the user's own.
fn clear_watch_status_items(
    store: &DurableStore,
    library_store: &DurableStore,
    ids: &[String],
) -> Result<usize, WatchStatusError> {
    let index = load_watch_status_index(store)?;
    let cleared: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let changed = remove_index_ids(store, WATCH_STATUS_LAYOUT, index, &cleared);
    store.save()?;
    retain_status_added_ids(library_store, |id| !cleared.contains(id));
    library_store.save()?;
    Ok(changed)
}

fn set_watch_status_items(
    store: &DurableStore,
    library_store: &DurableStore,
    ids: Vec<String>,
    status: String,
) -> Result<usize, WatchStatusError> {
    let mut statuses = read_watch_status_snapshot(store)?;
    let new_status_count = ids
        .iter()
        .filter(|id| !statuses.items.contains_key(*id))
        .count();
    if new_status_count > 0 && statuses.items.len() + new_status_count > MAX_WATCH_STATUS_ITEMS {
        return Err(WatchStatusError::new(
            WatchStatusErrorKind::StatusCapacity,
            "Watch status list is full.",
        ));
    }
    let processed = ids.len();
    let mut status_changed = false;
    for id in ids {
        if statuses.items.get(&id) != Some(&status) {
            statuses.items.insert(id, status.clone());
            status_changed = true;
        }
    }
    library_store.save()?;
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
    ids: Vec<String>,
    status: Option<String>,
) -> Result<usize, WatchStatusError> {
    run_typed_store_op(move || {
        let status = normalize_bulk_status(status)?;
        if ids.is_empty() {
            return Ok(0);
        }
        let library_store = super::open_store(&app, LIBRARY_STORE_FILE)?;
        let ids = resolve_bulk_status_ids(&library_store, ids)?;
        let store = super::open_store(&app, WATCH_STATUS_STORE_FILE)?;
        match status {
            None => clear_watch_status_items(&store, &library_store, &ids),
            Some(status) => set_watch_status_items(&store, &library_store, ids, status),
        }
    })
    .await
}

#[command]
pub async fn get_all_watch_statuses(
    app: AppHandle,
) -> Result<HashMap<String, String>, WatchStatusError> {
    super::with_store(app, WATCH_STATUS_STORE_FILE, |store| {
        Ok(load_watch_statuses_map(&store)?)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::{test_media_item, test_store};

    #[test]
    fn clearing_a_status_removes_only_titles_the_status_added() {
        let statuses = test_store();
        let library = test_store();
        let added = test_media_item("added", "movie");
        let mut saved = test_media_item("saved", "movie");
        saved.poster = Some("https://example.com/poster.jpg".into());
        library.store.set(LIBRARY_INDEX_KEY, json!(["saved"]));
        library.store.set(library_item_key("saved"), json!(saved));
        for item in [&added, &saved] {
            let write = write_watch_status(
                &statuses.store,
                &library.store,
                item.clone(),
                Some("watched".into()),
            );
            assert!(write.unwrap().is_some());
        }
        assert_eq!(
            library.store.get(LIBRARY_INDEX_KEY),
            Some(json!(["added", "saved"]))
        );
        assert_eq!(load_status_added_ids(&library.store), ["added"]);
        assert!(
            write_watch_status(&statuses.store, &library.store, added, None)
                .unwrap()
                .is_none()
        );
        let mut sparse = saved.clone();
        sparse.poster = None;
        assert_eq!(
            json!(write_watch_status(&statuses.store, &library.store, sparse, None).unwrap()),
            json!(saved)
        );
        assert_eq!(library.store.get(LIBRARY_INDEX_KEY), Some(json!(["saved"])));
        assert!(library.store.get(library_item_key("added")).is_none());
        assert!(load_status_added_ids(&library.store).is_empty());
        assert_eq!(statuses.store.get(WATCH_STATUS_INDEX_KEY), Some(json!([])));
    }

    #[test]
    fn bulk_library_id_resolution_preserves_validation_and_store_error_kinds() {
        let library = test_store();
        let resolve = |ids| resolve_bulk_status_ids(&library.store, ids).map(|_| ());
        for ids in [
            vec!["".into()],
            vec!["missing".into()],
            vec!["a".into(); super::super::store_helpers::MAX_BULK_ITEMS + 1],
        ] {
            assert_eq!(
                resolve(ids).unwrap_err().kind,
                WatchStatusErrorKind::InvalidItem
            );
        }
        library
            .store
            .set(LIBRARY_INDEX_KEY, json!({"corrupt": true}));
        assert_eq!(
            resolve(vec!["".into()]).unwrap_err().kind,
            WatchStatusErrorKind::InvalidItem
        );
        assert_eq!(
            resolve(vec!["a".into()]).unwrap_err().kind,
            WatchStatusErrorKind::Failed
        );
        assert_eq!(library.store.save_count(), 0);
    }

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
    fn bulk_status_set_deduplicates_and_saves_pending_library_changes_once() {
        let statuses = test_store();
        let library = test_store();
        let existing = test_media_item("a", "movie");
        library.store.set(LIBRARY_INDEX_KEY, json!(["a"]));
        library.store.set(library_item_key("a"), json!(existing));
        library.store.save().unwrap();
        let item = test_media_item("b", "series");
        library.store.set(library_item_key("b"), json!(item));
        library.store.set(LIBRARY_INDEX_KEY, json!(["a", "b"]));
        let ids =
            resolve_bulk_status_ids(&library.store, vec!["a".into(), "b".into(), " b ".into()])
                .unwrap();
        let status = normalize_bulk_status(Some(" WATCHED ".into()))
            .unwrap()
            .unwrap();
        assert_eq!(
            set_watch_status_items(&statuses.store, &library.store, ids.clone(), status.clone())
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
        assert_eq!(library.store.get(library_item_key("b")), Some(json!(item)));
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&library.path).unwrap()).unwrap();
        assert_eq!(saved[library_item_key("b")], json!(item));
        assert_eq!(statuses.store.save_count(), 1);
        assert_eq!(library.store.save_count(), 2);
        assert_eq!(
            set_watch_status_items(
                &statuses.store,
                &library.store,
                resolve_bulk_status_ids(&library.store, ids).unwrap(),
                status
            )
            .unwrap(),
            2
        );
        assert_eq!(statuses.store.save_count(), 1);
        assert_eq!(library.store.save_count(), 2);
    }

    #[test]
    fn bulk_status_clear_keeps_library_intact_and_counts_removed_entries() {
        let statuses = test_store();
        let library = test_store();
        library.store.set(LIBRARY_INDEX_KEY, json!(["a", "b"]));
        for id in ["a", "b"] {
            library
                .store
                .set(library_item_key(id), json!(test_media_item(id, "movie")));
        }
        let ids = resolve_bulk_status_ids(&library.store, vec!["a".into(), "b".into()]).unwrap();
        set_watch_status_items(
            &statuses.store,
            &library.store,
            ids.clone(),
            "watching".into(),
        )
        .unwrap();
        let before = std::fs::read(&library.path).unwrap();
        assert_eq!(normalize_bulk_status(None).unwrap(), None);
        assert_eq!(
            clear_watch_status_items(&statuses.store, &library.store, &ids).unwrap(),
            2
        );
        assert_eq!(statuses.store.get(WATCH_STATUS_INDEX_KEY), Some(json!([])));
        assert_eq!(std::fs::read(&library.path).unwrap(), before);
        assert_eq!(library.store.save_count(), 1);
        assert_eq!(statuses.store.save_count(), 2);
        assert_eq!(
            clear_watch_status_items(&statuses.store, &library.store, &ids).unwrap(),
            0
        );
        assert_eq!(statuses.store.save_count(), 2);
        #[cfg(windows)]
        for (bulk, id) in [(false, "auto-single"), (true, "auto-bulk")] {
            use std::os::windows::fs::OpenOptionsExt;

            let item = test_media_item(id, "movie");
            write_watch_status(
                &statuses.store,
                &library.store,
                item.clone(),
                Some("watched".into()),
            )
            .unwrap();
            let saves = library.store.save_count();
            let clear = || {
                if bulk {
                    clear_watch_status_items(&statuses.store, &library.store, &[id.into()])
                        .map(|_| ())
                } else {
                    write_watch_status(&statuses.store, &library.store, item.clone(), None)
                        .map(|_| ())
                }
            };
            let held = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&library.path)
                .unwrap();
            assert!(clear().is_err());
            assert_eq!(library.store.save_count(), saves);
            drop(held);
            clear().unwrap();
            assert_eq!(library.store.save_count(), saves + 1);
            let reopened = super::super::DurableStoreRegistry::default()
                .open_path(library.path.clone())
                .unwrap();
            assert!(!load_status_added_ids(&reopened).contains(&id.to_string()));
            assert_eq!(
                load_library_index(&reopened).unwrap().contains(&id.into()),
                bulk
            );
        }
    }

    #[test]
    fn bulk_status_invalid_input_fails_without_partial_writes() {
        let statuses = test_store();
        let library = test_store();
        for (status, ids) in [
            ("invalid", vec!["a".into()]),
            ("watched", vec!["a".into(), "".into()]),
            ("invalid", vec!["".into()]),
            ("invalid", Vec::new()),
        ] {
            let result = normalize_bulk_status(Some(status.into())).and_then(|status| {
                let ids = resolve_bulk_status_ids(&library.store, ids)?;
                set_watch_status_items(&statuses.store, &library.store, ids, status.unwrap())
            });
            let error = result.unwrap_err();
            let (kind, message) = if status == "invalid" {
                (WatchStatusErrorKind::InvalidStatus, "Invalid watch status.")
            } else {
                (WatchStatusErrorKind::InvalidItem, "Invalid media id.")
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
    fn bulk_status_duplicate_ids_count_once_at_library_capacity() {
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
        let ids =
            resolve_bulk_status_ids(&library.store, vec!["id0".into(), "id0".into()]).unwrap();
        assert_eq!(
            set_watch_status_items(&statuses.store, &library.store, ids, "watched".into()).unwrap(),
            1
        );
        assert_eq!(library.store.save_count(), 1);
        assert_eq!(statuses.store.save_count(), 1);
    }

    #[test]
    fn bulk_status_capacity_failure_does_not_read_repair_or_write_either_store() {
        let statuses = test_store();
        let library = test_store();
        let mut ids: Vec<String> = (0..MAX_WATCH_STATUS_ITEMS)
            .map(|index| format!("id{index}"))
            .collect();
        for id in &ids {
            statuses
                .store
                .set(watch_status_item_key(id), json!("watched"));
        }
        ids.push("missing".into());
        statuses.store.set(WATCH_STATUS_INDEX_KEY, json!(ids));
        library
            .store
            .set(LIBRARY_INDEX_KEY, json!(["new", "missing"]));
        library.store.set(
            library_item_key("new"),
            json!(test_media_item("new", "movie")),
        );
        statuses.store.save().unwrap();
        library.store.save().unwrap();
        let status_before = std::fs::read(&statuses.path).unwrap();
        let library_before = std::fs::read(&library.path).unwrap();
        let ids = resolve_bulk_status_ids(&library.store, vec!["new".into()]).unwrap();
        let error = set_watch_status_items(&statuses.store, &library.store, ids, "watched".into())
            .unwrap_err();
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({"kind": "status_capacity", "message": "Watch status list is full."})
        );
        statuses.store.save().unwrap();
        library.store.save().unwrap();
        assert_eq!(std::fs::read(&statuses.path).unwrap(), status_before);
        assert_eq!(std::fs::read(&library.path).unwrap(), library_before);
        assert_eq!(statuses.store.save_count(), 1);
        assert_eq!(library.store.save_count(), 1);
    }

    #[test]
    fn bulk_status_resolves_normalized_ids_and_skips_stale_selection_without_repairs() {
        let statuses = test_store();
        let library = test_store();
        let mut item = test_media_item(" a ", "Series");
        item.title = " Normalized title ".into();
        library
            .store
            .set(LIBRARY_INDEX_KEY, json!([" a ", "missing"]));
        library.store.set(library_item_key(" a "), json!(item));
        library.store.save().unwrap();
        let before = std::fs::read(&library.path).unwrap();
        let ids =
            resolve_bulk_status_ids(&library.store, vec!["a".into(), "a".into(), "stale".into()])
                .unwrap();
        assert_eq!(ids, vec!["a"]);
        assert_eq!(
            set_watch_status_items(&statuses.store, &library.store, ids, "watching".into())
                .unwrap(),
            1
        );
        assert_eq!(
            statuses.store.get(watch_status_item_key("a")),
            Some(json!("watching"))
        );
        let error = resolve_bulk_status_ids(&library.store, vec!["stale".into()])
            .err()
            .unwrap();
        assert_eq!(error.kind, WatchStatusErrorKind::InvalidItem);
        assert_eq!(
            error.message,
            "Selected titles are no longer in your library."
        );
        library.store.save().unwrap();
        assert_eq!(std::fs::read(&library.path).unwrap(), before);
        assert_eq!(library.store.save_count(), 1);
    }
}
