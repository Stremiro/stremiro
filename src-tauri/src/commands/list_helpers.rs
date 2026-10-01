use super::store_helpers::load_index;
use super::{normalize_non_empty, DurableStore};
use crate::providers::MediaItem;
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

pub(super) const LISTS_ORDER_KEY: &str = "lists_order";
/// Store key prefixes — single owner so prefix sweeps (clear/delete) can
/// never drift from the key builders below.
pub(crate) const LIST_META_KEY_PREFIX: &str = "list:";
pub(crate) const LIST_ITEM_KEY_PREFIX: &str = "list_item:";
pub(super) const MAX_LIST_NAME_CHARS: usize = 64;
pub(super) const MAX_LIST_ICON_CHARS: usize = 16;
/// Generated ids are `list_<32 lowercase hex>`; the bound leaves headroom
/// without admitting arbitrary strings. Shared with backup import so the
/// live and restore paths agree on what fits.
pub(super) const MAX_LIST_ID_CHARS: usize = 64;
/// Live bounds on the lists domain — single owner for the command handlers
/// and backup import so a restore can never exceed what `create_list` or
/// `add_to_list` would accept.
pub(super) const MAX_LISTS: usize = 128;
pub(super) const MAX_LIST_ITEMS: usize = 2_000;

/// List ids are app-generated and become store keys (`list:{id}`): opaque
/// hygiene plus charset + length so a hostile id can't probe or collide onto
/// another key namespace. Read paths stay lenient for legacy data.
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

/// Single ingress rule for list names/icons across the live commands and
/// backup import: trim, drop blank names, cap lengths. The trimmed prefix
/// always starts with a non-space char, so the bound cannot reintroduce
/// emptiness.
pub(super) fn normalize_list_name(input: &str) -> Option<String> {
    normalize_non_empty(input)
        .map(|name| name.chars().take(MAX_LIST_NAME_CHARS).collect::<String>())
}

pub(super) fn normalize_list_icon(input: Option<&str>) -> String {
    input
        .and_then(normalize_non_empty)
        .map(|icon| icon.chars().take(MAX_LIST_ICON_CHARS).collect::<String>())
        .unwrap_or_else(|| "📋".to_string())
}

pub(super) fn list_meta_key(list_id: &str) -> String {
    format!("{}{}", LIST_META_KEY_PREFIX, list_id)
}

pub(super) fn list_item_store_key(list_id: &str, item_id: &str) -> String {
    format!("{}{}:{}", LIST_ITEM_KEY_PREFIX, list_id, item_id)
}

/// Strict order read through the shared index policy: a missing header is
/// an empty domain, but a non-array or all-undecodable header is corrupt —
/// erroring keeps create/delete/import/reorder from rebuilding an empty
/// index over orphaned `list:*` keys.
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

/// Shared reorder merge for `reorder_list_items`/`reorder_lists`: the payload
/// is a reorder, not a delete — omitted ids are appended in current order so
/// a stale snapshot can't orphan stored keys. O(n+m) via hash sets.
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
