use super::media_normalization::{build_display_year, normalize_media_item};
use super::{
    normalize_media_id, normalize_watch_progress_type, DurableStore, LIBRARY_INDEX_KEY,
    LIBRARY_ITEM_PREFIX, WATCH_STATUS_INDEX_KEY, WATCH_STATUS_ITEM_PREFIX,
};
use crate::providers::{extract_primary_year, MediaItem};
use serde_json::json;
use std::collections::HashMap;

pub(super) fn normalize_library_item(mut item: MediaItem) -> Option<MediaItem> {
    // The id is a store key: reject rather than truncate so two hostile ids
    // can't collide onto one key.
    let id = normalize_media_id(&item.id)?;

    item.type_ = normalize_watch_progress_type(&item.type_)?.to_string();

    item.id = id;
    // Field bounds + year normalization live in the single media
    // normalizer; the library adds one rule — a titleless item cannot
    // render a row, so it is rejected rather than persisted.
    let item = normalize_media_item(item);
    (!item.title.is_empty()).then_some(item)
}

pub(super) fn merge_library_item(existing: MediaItem, incoming: MediaItem) -> MediaItem {
    let year = incoming.year.or(existing.year);

    MediaItem {
        id: existing.id,
        title: incoming.title,
        poster: incoming.poster.or(existing.poster),
        backdrop: incoming.backdrop.or(existing.backdrop),
        logo: incoming.logo.or(existing.logo),
        description: incoming.description.or(existing.description),
        year: year.clone(),
        primary_year: incoming
            .primary_year
            .or(existing.primary_year)
            .or_else(|| extract_primary_year(year.as_deref())),
        display_year: incoming
            .display_year
            .or(existing.display_year)
            .or_else(|| build_display_year(year.as_deref())),
        genres: incoming.genres.or(existing.genres),
        type_: incoming.type_,
    }
}

pub(super) fn library_item_key(item_id: &str) -> String {
    format!("{}{}", LIBRARY_ITEM_PREFIX, item_id)
}

/// The two coordinates of an index+item store domain: the sorted index
/// header and the per-item key builder. Bundled so the generic index ops
/// below cannot mix domains' keys.
#[derive(Clone, Copy)]
pub(super) struct IndexStoreLayout {
    pub index_key: &'static str,
    pub item_key: fn(&str) -> String,
}

pub(super) const LIBRARY_LAYOUT: IndexStoreLayout = IndexStoreLayout {
    index_key: LIBRARY_INDEX_KEY,
    item_key: library_item_key,
};

/// Single write path for index+item stores: drop item keys present in
/// `previous_index` but absent from `map`, write every map entry, persist the
/// sorted index, and save once.
pub(super) fn persist_index_map<T: serde::Serialize>(
    store: &DurableStore,
    layout: IndexStoreLayout,
    previous_index: &[String],
    map: &HashMap<String, T>,
) -> Result<Vec<String>, String> {
    for stale_id in previous_index {
        if !map.contains_key(stale_id) {
            store.delete((layout.item_key)(stale_id));
        }
    }

    let mut index: Vec<String> = map.keys().cloned().collect();
    index.sort();
    for (item_id, item) in map {
        store.set((layout.item_key)(item_id), json!(item));
    }
    store.set(layout.index_key, json!(index));
    store.save()?;
    Ok(index)
}

/// Shared prefix-sweep clear for index/item store domains: deletes every key
/// under `prefixes`, resets the index/order key, and saves once. Prefix
/// sweep, not index-driven enumeration: a corrupt index parses as empty and
/// would orphan item rows nothing else scans — key space is the only
/// complete enumeration.
pub(super) fn clear_index_domain(
    store: &DurableStore,
    prefixes: &[&str],
    index_key: &str,
) -> Result<(), String> {
    let item_keys: Vec<String> = store
        .keys()
        .into_iter()
        .filter(|key| prefixes.iter().any(|prefix| key.starts_with(prefix)))
        .collect();
    for key in item_keys {
        store.delete(key);
    }
    store.set(index_key, json!(Vec::<String>::new()));
    store.save()?;
    Ok(())
}

/// Index/order arrays decode member-by-member: one corrupt (non-string)
/// entry must not orphan every item row behind an empty index — the item
/// keys still resolve directly, and a rewritten empty index would strand
/// them permanently.
pub(crate) fn decode_string_list(value: serde_json::Value) -> Option<Vec<String>> {
    serde_json::from_value::<Vec<serde_json::Value>>(value)
        .ok()
        .map(|members| {
            members
                .into_iter()
                .filter_map(|member| member.as_str().map(str::to_string))
                .collect()
        })
}

/// Index read for the current index+item store shape: an absent index is an
/// empty domain, a stored non-array is corrupt, and a non-empty array that
/// decodes to zero strings is corrupt — erroring there keeps a later library
/// or status save from silently overwriting the corrupt index.
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

/// Index-driven map load with read-repair: missing/malformed items and key
/// drift mark the store `modified`, then one persist call drops stale item
/// keys and rewrites index + items in a single save.
fn load_index_map<T, N, M>(
    store: &DurableStore,
    layout: IndexStoreLayout,
    normalize: N,
    merge: M,
) -> Result<HashMap<String, T>, String>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
    N: Fn(&str, T) -> Option<(String, T)>,
    M: Fn(T, T) -> T,
{
    let index = load_index(store, layout.index_key)?;
    let mut map: HashMap<String, T> = HashMap::with_capacity(index.len());
    let mut modified = false;

    for item_id in &index {
        let Some(value) = store.get((layout.item_key)(item_id)) else {
            modified = true;
            continue;
        };

        let Some((key, normalized)) = serde_json::from_value::<T>(value)
            .ok()
            .and_then(|parsed| normalize(item_id, parsed))
        else {
            modified = true;
            continue;
        };

        if key != *item_id {
            modified = true;
        }

        if let Some(existing) = map.remove(&key) {
            modified = true;
            map.insert(key, merge(existing, normalized));
        } else {
            map.insert(key, normalized);
        }
    }

    if modified {
        persist_index_map(store, layout, &index, &map)?;
    }

    Ok(map)
}

pub(super) fn load_library_index(store: &DurableStore) -> Result<Vec<String>, String> {
    load_index(store, LIBRARY_LAYOUT.index_key)
}

pub(super) fn load_library_map(store: &DurableStore) -> Result<HashMap<String, MediaItem>, String> {
    load_index_map(
        store,
        LIBRARY_LAYOUT,
        |_item_id, item| normalize_library_item(item).map(|item| (item.id.clone(), item)),
        merge_library_item,
    )
}

pub(super) fn watch_status_item_key(item_id: &str) -> String {
    format!("{}{}", WATCH_STATUS_ITEM_PREFIX, item_id)
}

pub(super) const WATCH_STATUS_LAYOUT: IndexStoreLayout = IndexStoreLayout {
    index_key: WATCH_STATUS_INDEX_KEY,
    item_key: watch_status_item_key,
};

/// Rust is the single authority for watch-status values. The frontend already
/// sends the `WatchStatus` union (`watching`/`watched`/`plan_to_watch`/
/// `dropped`); direct IPC, legacy stores, and backup imports are untrusted and
/// must funnel through here so arbitrary strings can never persist.
pub(crate) fn normalize_watch_status(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "watching" => Some("watching".to_string()),
        "watched" => Some("watched".to_string()),
        "plan_to_watch" | "plan to watch" => Some("plan_to_watch".to_string()),
        "dropped" => Some("dropped".to_string()),
        _ => None,
    }
}

pub(super) fn load_watch_status_index(store: &DurableStore) -> Result<Vec<String>, String> {
    load_index(store, WATCH_STATUS_LAYOUT.index_key)
}

pub(super) fn load_watch_statuses_map(
    store: &DurableStore,
) -> Result<HashMap<String, String>, String> {
    load_index_map(
        store,
        WATCH_STATUS_LAYOUT,
        |item_id, status: String| {
            normalize_watch_status(&status).map(|status| (item_id.to_string(), status))
        },
        |_existing, incoming| incoming,
    )
}
