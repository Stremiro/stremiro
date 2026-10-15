use super::store_helpers::load_index;
use super::{normalize_non_empty, DurableStore};
use crate::providers::{trim_to_max, MediaItem};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserList {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub item_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserListWithItems {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub item_ids: Vec<String>,
    pub items: Vec<MediaItem>,
}

#[derive(Debug, Serialize)]
pub struct UserListSummary {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub item_count: usize,
    pub contains_item: bool,
}

// Validate the snapshot's wire shape without allocating its artwork, description or genres.
#[derive(Deserialize)]
pub(super) struct ListItemIdentity {
    id: String,
    title: String,
    #[serde(rename = "type")]
    type_: String,
    #[serde(
        default,
        rename = "poster",
        deserialize_with = "validate_optional_string"
    )]
    _poster: (),
    #[serde(
        default,
        rename = "backdrop",
        deserialize_with = "validate_optional_string"
    )]
    _backdrop: (),
    #[serde(
        default,
        rename = "logo",
        deserialize_with = "validate_optional_string"
    )]
    _logo: (),
    #[serde(
        default,
        rename = "description",
        deserialize_with = "validate_optional_string"
    )]
    _description: (),
    #[serde(
        default,
        rename = "year",
        deserialize_with = "validate_optional_string"
    )]
    _year: (),
    #[serde(
        default,
        rename = "displayYear",
        deserialize_with = "validate_optional_string"
    )]
    _display_year: (),
    #[serde(
        default,
        rename = "genres",
        deserialize_with = "validate_optional_genres"
    )]
    _genres: (),
}

fn validate_optional_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<(), D::Error> {
    Option::<&str>::deserialize(deserializer).map(|_| ())
}

fn validate_optional_genres<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<(), D::Error> {
    Option::<Vec<&str>>::deserialize(deserializer).map(|_| ())
}

impl ListItemIdentity {
    pub(super) fn normalized_id(self) -> Option<String> {
        super::store_helpers::normalize_library_item(MediaItem {
            id: self.id,
            title: self.title,
            type_: self.type_,
            poster: None,
            backdrop: None,
            logo: None,
            description: None,
            year: None,
            primary_year: None,
            display_year: None,
            genres: None,
        })
        .map(|item| item.id)
    }
}

pub(super) const LISTS_ORDER_KEY: &str = "lists_order";
/// Store key prefixes — single owner so prefix sweeps (clear/delete) can
/// never drift from the key builders below.
pub(crate) const LIST_META_KEY_PREFIX: &str = "list:";
pub(crate) const LIST_ITEM_KEY_PREFIX: &str = "list_item:";
pub(super) const MAX_LIST_NAME_CHARS: usize = 64;
pub(super) const MAX_LIST_ICON_CHARS: usize = 16;
/// Generated ids are `list_<32 lowercase hex>` — shared with backup import so the
/// live and restore paths agree on what fits.
pub(super) const MAX_LIST_ID_CHARS: usize = 64;
/// Live bounds on the lists domain — single owner for commands and backup import so
/// a restore never exceeds what `create_list`/`add_to_list` accept.
pub(super) const MAX_LISTS: usize = 128;
pub(super) const MAX_LIST_ITEMS: usize = 2_000;

/// List ids are app-generated and become store keys (`list:{id}`) — charset + length
/// bound so a hostile id can't probe or collide another key namespace.
/// Read paths stay lenient for legacy data.
pub(super) fn normalize_list_id(input: &str) -> Option<String> {
    let id = super::normalize_opaque_field(input)?;
    if id.chars().count() > MAX_LIST_ID_CHARS
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return None;
    }
    Some(id)
}

/// Single ingress rule for list names/icons across live commands and backup
/// import: trim, drop blanks, cap lengths — the trimmed prefix can't reintroduce emptiness.
pub(super) fn normalize_list_name(input: &str) -> Option<String> {
    trim_to_max(input, MAX_LIST_NAME_CHARS)
}

pub(super) fn normalize_list_icon(input: Option<&str>) -> String {
    input
        .and_then(|icon| trim_to_max(icon, MAX_LIST_ICON_CHARS))
        .unwrap_or_else(|| "📋".to_string())
}

pub(super) fn list_meta_key(list_id: &str) -> String {
    format!("{}{}", LIST_META_KEY_PREFIX, list_id)
}

pub(super) fn list_item_store_key(list_id: &str, item_id: &str) -> String {
    format!("{}{}:{}", LIST_ITEM_KEY_PREFIX, list_id, item_id)
}

/// Meta read for the mutation commands — absent or corrupt both fail as "not found"
/// (a corrupt meta has no usable `item_ids` anyway).
pub(super) fn load_list(store: &DurableStore, list_id: &str) -> Result<UserList, String> {
    store
        .get_typed(list_meta_key(list_id))
        .ok_or_else(|| "List not found".to_string())
}

/// Strict order read through the shared index policy — a non-array or
/// all-undecodable header is corrupt; erroring keeps mutations from rebuilding
/// an empty index over orphaned `list:*` keys.
pub(super) fn load_lists_order(store: &DurableStore) -> Result<Vec<String>, String> {
    let raw_order = load_index(store, LISTS_ORDER_KEY)?;

    let mut seen: HashSet<String> = HashSet::with_capacity(raw_order.len());
    let order: Vec<String> = raw_order
        .iter()
        .filter_map(|list_id| normalize_non_empty(list_id))
        .filter(|list_id| seen.insert(list_id.clone()))
        .collect();

    if !raw_order.is_empty() && order.is_empty() {
        return Err(format!("Invalid {LISTS_ORDER_KEY} index."));
    }
    Ok(order)
}

/// Shared reorder merge for `reorder_list_items`/`reorder_lists`: the payload is a
/// reorder, not a delete — omitted ids append in current order so a stale snapshot
/// can't orphan stored keys. O(n+m) via hash sets.
pub(super) fn reorder_known_ids(current: &[String], requested: Vec<String>) -> Vec<String> {
    let known: HashSet<&str> = current.iter().map(String::as_str).collect();
    let mut seen: HashSet<String> = HashSet::with_capacity(current.len());
    let mut merged: Vec<String> = Vec::with_capacity(current.len());

    for id in requested {
        if known.contains(id.as_str()) && seen.insert(id.clone()) {
            merged.push(id);
        }
    }
    for id in current {
        if seen.insert(id.clone()) {
            merged.push(id.clone());
        }
    }

    merged
}

#[cfg(test)]
mod tests;
