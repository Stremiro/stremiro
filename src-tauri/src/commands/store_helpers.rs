use super::media_normalization::{build_display_year, normalize_media_item};
use super::{
    normalize_media_id, normalize_watch_progress_type, DurableStore, LIBRARY_INDEX_KEY,
    LIBRARY_ITEM_PREFIX, WATCH_STATUS_INDEX_KEY, WATCH_STATUS_ITEM_PREFIX,
};
use crate::providers::{extract_primary_year, MediaItem};
use serde_json::json;
use std::collections::{HashMap, HashSet};

pub(super) const MAX_BULK_ITEMS: usize = 5_000;

pub(super) fn normalize_bulk_ids(ids: Vec<String>) -> Result<Vec<String>, String> {
    if ids.len() > MAX_BULK_ITEMS {
        return Err(format!("Too many titles. Maximum is {MAX_BULK_ITEMS}."));
    }
    let mut seen = HashSet::with_capacity(ids.len());
    ids.into_iter()
        .map(|id| normalize_media_id(&id).ok_or_else(|| "Invalid media id.".to_string()))
        .filter_map(|result| match result {
            Ok(id) if seen.insert(id.clone()) => Some(Ok(id)),
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

pub(super) fn normalize_library_item(mut item: MediaItem) -> Option<MediaItem> {
    // The id is a store key: reject rather than truncate so two hostile ids
    // can't collide onto one key.
    let id = normalize_media_id(&item.id)?;

    item.type_ = normalize_watch_progress_type(&item.type_)?.to_string();

    item.id = id;
    // Field bounds + year normalization live in the shared media normalizer;
    // the library adds one rule — a titleless item can't render a row.
    let item = normalize_media_item(item);
    (!item.title.is_empty()).then_some(item)
}

#[cfg(test)]
pub(super) fn normalize_library_items(items: Vec<MediaItem>) -> Result<Vec<MediaItem>, String> {
    if items.len() > MAX_BULK_ITEMS {
        return Err(format!("Too many titles. Maximum is {MAX_BULK_ITEMS}."));
    }
    items
        .into_iter()
        .map(|item| {
            normalize_library_item(item).ok_or_else(|| {
                "Invalid media item. Missing required id, title, or type.".to_string()
            })
        })
        .collect()
}

pub(super) fn merge_library_item(existing: Option<&MediaItem>, mut item: MediaItem) -> MediaItem {
    if let Some(existing) = existing {
        item.poster = item.poster.or_else(|| existing.poster.clone());
        item.backdrop = item.backdrop.or_else(|| existing.backdrop.clone());
        item.logo = item.logo.or_else(|| existing.logo.clone());
        item.description = item.description.or_else(|| existing.description.clone());
        item.year = item.year.or_else(|| existing.year.clone());
        item.primary_year = item.primary_year.or(existing.primary_year);
        item.display_year = item.display_year.or_else(|| existing.display_year.clone());
        item.genres = item.genres.or_else(|| existing.genres.clone());
    }
    item.primary_year = item
        .primary_year
        .or_else(|| extract_primary_year(item.year.as_deref()));
    item.display_year = item
        .display_year
        .or_else(|| build_display_year(item.year.as_deref()));
    item
}

pub(super) fn library_item_key(item_id: &str) -> String {
    format!("{}{}", LIBRARY_ITEM_PREFIX, item_id)
}

/// The two coordinates of an index+item store domain — bundled so the generic
/// index ops below can't mix domains' keys.
#[derive(Clone, Copy)]
pub(super) struct IndexStoreLayout {
    pub index_key: &'static str,
    pub item_key: fn(&str) -> String,
}

pub(super) const LIBRARY_LAYOUT: IndexStoreLayout = IndexStoreLayout {
    index_key: LIBRARY_INDEX_KEY,
    item_key: library_item_key,
};

/// Single write path for index+item stores: drop items absent from `map`,
/// write every entry, persist the sorted index, save once.
pub(super) fn persist_index_map<T: serde::Serialize>(
    store: &DurableStore,
    layout: IndexStoreLayout,
    previous_index: &[String],
    map: &HashMap<String, T>,
) -> Result<(), String> {
    for stale_id in previous_index {
        if !map.contains_key(stale_id) {
            store.delete((layout.item_key)(stale_id));
        }
    }

    let mut index: Vec<&str> = map.keys().map(String::as_str).collect();
    index.sort();
    for (item_id, item) in map {
        store.set((layout.item_key)(item_id), json!(item));
    }
    store.set(layout.index_key, json!(index));
    store.save()
}

/// Shared prefix-sweep clear for index/item domains: deletes every key under
/// `prefixes`, resets index/order keys, saves once. Prefix sweep, not index-driven
/// enumeration — a corrupt index parses as empty and would orphan item rows.
pub(super) fn clear_index_domain(
    store: &DurableStore,
    prefixes: &[&str],
    index_keys: &[&str],
) -> Result<(), String> {
    store.delete_matching(|key| prefixes.iter().any(|prefix| key.starts_with(prefix)));
    for index_key in index_keys {
        store.set(*index_key, json!(Vec::<String>::new()));
    }
    store.save()?;
    Ok(())
}

/// Index/order arrays decode member-by-member — one corrupt entry must not
/// orphan every item row behind an empty index.
pub(crate) fn decode_string_list(value: serde_json::Value) -> Option<Vec<String>> {
    let serde_json::Value::Array(members) = value else {
        return None;
    };
    Some(
        members
            .into_iter()
            .filter_map(|member| match member {
                serde_json::Value::String(text) => Some(text),
                _ => None,
            })
            .collect(),
    )
}

/// Index read: absent is an empty domain; a stored non-array or a non-empty array
/// decoding to zero strings is corrupt — erroring keeps a later save from silently
/// overwriting the corrupt index.
pub(super) fn load_index(store: &DurableStore, index_key: &str) -> Result<Vec<String>, String> {
    let Some(value) = store.get(index_key) else {
        return Ok(Vec::new());
    };
    let member_count = value.as_array().map_or(0, Vec::len);
    let Some(index) = decode_string_list(value) else {
        return Err(format!("Invalid {index_key} index."));
    };
    if member_count > 0 && index.is_empty() {
        return Err(format!("Invalid {index_key} index."));
    }
    Ok(index)
}

pub(super) struct IndexStoreSnapshot<T> {
    pub items: HashMap<String, T>,
    pub index: Vec<String>,
    modified: bool,
}

/// Read-only snapshot: bulk commands must finish capacity checks before even
/// read-repair mutates a live store (dirty data could later flush on exit).
fn read_index_map<T, N, M>(
    store: &DurableStore,
    layout: IndexStoreLayout,
    normalize: N,
    merge: M,
) -> Result<IndexStoreSnapshot<T>, String>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
    N: Fn(&str, T) -> Option<(String, T)>,
    M: Fn(&T, T) -> T,
{
    let index = load_index(store, layout.index_key)?;
    let mut map: HashMap<String, T> = HashMap::with_capacity(index.len());
    let mut modified = false;

    for item_id in &index {
        let Some((key, normalized)) = store
            .get_typed::<T>((layout.item_key)(item_id))
            .and_then(|parsed| normalize(item_id, parsed))
        else {
            modified = true;
            continue;
        };

        if key != *item_id {
            modified = true;
        }

        match map.entry(key) {
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                modified = true;
                let merged = merge(entry.get(), normalized);
                entry.insert(merged);
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(normalized);
            }
        }
    }

    Ok(IndexStoreSnapshot {
        items: map,
        index,
        modified,
    })
}

fn load_snapshot<T: serde::Serialize>(
    store: &DurableStore,
    layout: IndexStoreLayout,
    snapshot: IndexStoreSnapshot<T>,
) -> Result<HashMap<String, T>, String> {
    if snapshot.modified {
        persist_index_map(store, layout, &snapshot.index, &snapshot.items)?;
    }
    Ok(snapshot.items)
}

pub(super) fn load_library_index(store: &DurableStore) -> Result<Vec<String>, String> {
    load_index(store, LIBRARY_LAYOUT.index_key)
}

pub(super) fn load_library_map(store: &DurableStore) -> Result<HashMap<String, MediaItem>, String> {
    load_snapshot(store, LIBRARY_LAYOUT, read_library_snapshot(store)?)
}

pub(super) fn load_library_item_identities(store: &DurableStore) -> Result<Vec<MediaItem>, String> {
    let index = load_library_index(store)?;
    let mut seen = HashSet::with_capacity(index.len());
    let mut items = Vec::with_capacity(index.len());
    for id in index {
        match store
            .get_typed::<super::list_helpers::ListItemIdentity>(library_item_key(&id))
            .and_then(|identity| identity.normalized_item())
        {
            Some(item) if item.id == id && seen.insert(item.id.clone()) => items.push(item),
            // Keep full snapshots and donor metadata intact when the index needs repair.
            _ => return load_library_map(store).map(|items| items.into_values().collect()),
        }
    }
    Ok(items)
}

pub(super) fn read_library_snapshot(
    store: &DurableStore,
) -> Result<IndexStoreSnapshot<MediaItem>, String> {
    read_index_map(
        store,
        LIBRARY_LAYOUT,
        |_item_id, item| normalize_library_item(item).map(|item| (item.id.clone(), item)),
        |existing, incoming| merge_library_item(Some(existing), incoming),
    )
}

pub(super) fn watch_status_item_key(item_id: &str) -> String {
    format!("{}{}", WATCH_STATUS_ITEM_PREFIX, item_id)
}

pub(super) const WATCH_STATUS_LAYOUT: IndexStoreLayout = IndexStoreLayout {
    index_key: WATCH_STATUS_INDEX_KEY,
    item_key: watch_status_item_key,
};

/// Rust is the single authority for watch-status values (`watching`/`watched`/
/// `plan_to_watch`/`dropped`) — IPC, legacy stores, and backups funnel through
/// here so arbitrary strings never persist.
pub(crate) fn normalize_watch_status(value: &str) -> Option<String> {
    match value.trim() {
        status if status.eq_ignore_ascii_case("watching") => Some("watching".to_string()),
        status if status.eq_ignore_ascii_case("watched") => Some("watched".to_string()),
        status
            if status.eq_ignore_ascii_case("plan_to_watch")
                || status.eq_ignore_ascii_case("plan to watch") =>
        {
            Some("plan_to_watch".to_string())
        }
        status if status.eq_ignore_ascii_case("dropped") => Some("dropped".to_string()),
        _ => None,
    }
}

pub(super) fn load_watch_status_index(store: &DurableStore) -> Result<Vec<String>, String> {
    load_index(store, WATCH_STATUS_LAYOUT.index_key)
}

pub(super) fn load_watch_statuses_map(
    store: &DurableStore,
) -> Result<HashMap<String, String>, String> {
    load_snapshot(
        store,
        WATCH_STATUS_LAYOUT,
        read_watch_status_snapshot(store)?,
    )
}

pub(super) fn read_watch_status_snapshot(
    store: &DurableStore,
) -> Result<IndexStoreSnapshot<String>, String> {
    read_index_map(
        store,
        WATCH_STATUS_LAYOUT,
        |item_id, status: String| {
            let item_id = normalize_media_id(item_id)?;
            normalize_watch_status(&status).map(|status| (item_id, status))
        },
        |_existing, incoming| incoming,
    )
}

#[cfg(test)]
mod tests {
    use super::super::library_commands::resolve_library_items;
    use super::*;
    use crate::test_helpers::{test_media_item, test_store};

    #[test]
    fn bulk_library_resolution_is_bounded_deduplicated_and_read_only() {
        let fixture = test_store();
        let item = test_media_item("a", "movie");
        fixture.store.set(LIBRARY_INDEX_KEY, json!(["a"]));
        fixture.store.set(library_item_key("a"), json!(item));
        fixture.store.save().unwrap();
        let before = std::fs::read(&fixture.path).unwrap();
        let items = resolve_library_items(&fixture.store, vec![" a ".into(), "a".into()]).unwrap();
        assert_eq!(serde_json::to_value(items).unwrap(), json!([item]));
        assert!(resolve_library_items(&fixture.store, Vec::new())
            .unwrap()
            .is_empty());
        assert_eq!(
            serde_json::to_value(
                resolve_library_items(&fixture.store, vec!["missing".into(), "a".into()]).unwrap()
            )
            .unwrap(),
            json!([item])
        );
        assert!(resolve_library_items(&fixture.store, vec!["missing".into()]).is_err());
        assert!(normalize_bulk_ids(vec!["a".into(), "".into()]).is_err());
        assert!(normalize_bulk_ids(vec!["a".into(); MAX_BULK_ITEMS]).is_ok());
        assert!(normalize_bulk_ids(vec!["a".into(); MAX_BULK_ITEMS + 1]).is_err());
        assert!(
            normalize_library_items(vec![test_media_item("a", "movie"); MAX_BULK_ITEMS + 1])
                .is_err()
        );
        fixture.store.save().unwrap();
        assert_eq!(std::fs::read(&fixture.path).unwrap(), before);
        assert_eq!(fixture.store.save_count(), 1);
    }

    #[test]
    fn borrowed_library_merge_preserves_missing_metadata_without_mutating_existing() {
        let mut existing = test_media_item("a", "movie");
        existing.poster = Some("https://img.example/old.jpg".into());
        existing.backdrop = Some("https://img.example/backdrop.jpg".into());
        existing.logo = Some("https://img.example/logo.png".into());
        existing.description = Some("Existing description".into());
        existing.year = Some("2024".into());
        existing.primary_year = Some(2024);
        existing.display_year = Some("2024".into());
        existing.genres = Some(vec!["Drama".into()]);
        let before = json!(existing);
        let mut incoming = test_media_item("a", "movie");
        incoming.title = "New title".into();
        incoming.poster = Some("https://img.example/new.jpg".into());
        let merged = merge_library_item(Some(&existing), incoming);
        assert_eq!(merged.title, "New title");
        assert_eq!(
            merged.poster.as_deref(),
            Some("https://img.example/new.jpg")
        );
        assert_eq!(merged.backdrop, existing.backdrop);
        assert_eq!(merged.logo, existing.logo);
        assert_eq!(merged.description, existing.description);
        assert_eq!(merged.year, existing.year);
        assert_eq!(merged.primary_year, Some(2024));
        assert_eq!(merged.display_year, existing.display_year);
        assert_eq!(merged.genres, existing.genres);
        assert_eq!(json!(existing), before);
    }

    #[test]
    fn new_library_merge_derives_year_fields_without_an_existing_item() {
        let mut item = test_media_item("a", "movie");
        item.year = Some("2023-2024".into());
        let merged = merge_library_item(None, item);
        assert_eq!(merged.primary_year, Some(2023));
        assert_eq!(merged.display_year.as_deref(), Some("2023"));
    }

    #[test]
    fn watch_status_read_normalizes_ids_and_repairs_collisions() {
        let test = crate::test_helpers::test_store();
        let overlong = "a".repeat(super::super::MEDIA_ID_MAX_CHARS + 1);
        let rows = [
            (" tt123 ", " WATCHED "),
            ("tt123", "watching"),
            (" tt456 ", "invalid"),
            ("tt456", "plan to watch"),
            (" ", "watched"),
            ("null", "watched"),
            ("undefined", "watched"),
            (overlong.as_str(), "watched"),
        ];
        for (id, status) in rows {
            test.store.set(watch_status_item_key(id), json!(status));
        }
        test.store
            .set(WATCH_STATUS_INDEX_KEY, json!(rows.map(|(id, _status)| id)));

        let snapshot = read_watch_status_snapshot(&test.store).unwrap();
        let expected = HashMap::from([
            ("tt123".to_string(), "watching".to_string()),
            ("tt456".to_string(), "plan_to_watch".to_string()),
        ]);
        assert_eq!(snapshot.items, expected);
        assert!(snapshot.modified);
        assert_eq!(test.store.save_count(), 0);
        assert!(test.store.get(watch_status_item_key(" tt123 ")).is_some());
        assert_eq!(load_watch_statuses_map(&test.store).unwrap(), expected);
        assert_eq!(test.store.save_count(), 1);
        assert_eq!(
            load_watch_status_index(&test.store).unwrap(),
            ["tt123", "tt456"]
        );
        for (id, _status) in rows {
            if !expected.contains_key(id) {
                assert!(test.store.get(watch_status_item_key(id)).is_none());
            }
        }
        assert_eq!(load_watch_statuses_map(&test.store).unwrap(), expected);
        assert_eq!(test.store.save_count(), 1);
    }
}
