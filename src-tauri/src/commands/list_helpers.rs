use super::media_type::normalize_watch_progress_type;
use super::store_helpers::load_index;
use super::DurableStore;
use crate::providers::{bound_optional, trim_to_max, MediaItem};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ListErrorKind {
    ListNameRequired,
    ListNotFound,
    TooManyLists,
    ListFull,
    InvalidRules,
    SmartListReadOnly,
    Failed,
}

#[derive(Debug, Serialize)]
pub struct ListError {
    pub kind: ListErrorKind,
    pub message: String,
}

impl ListError {
    pub(super) fn new(kind: ListErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl From<String> for ListError {
    fn from(message: String) -> Self {
        Self::new(ListErrorKind::Failed, message)
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WatchStatus {
    Watching,
    Watched,
    PlanToWatch,
    Dropped,
}

impl WatchStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Watching => "watching",
            Self::Watched => "watched",
            Self::PlanToWatch => "plan_to_watch",
            Self::Dropped => "dropped",
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
#[serde(default)]
pub struct SmartListRules {
    pub media_type: Option<String>,
    pub genres: Vec<String>,
    pub statuses: Vec<WatchStatus>,
    pub year_from: Option<u32>,
    pub year_to: Option<u32>,
}

pub(super) fn validate_smart_list_rules(
    mut rules: SmartListRules,
) -> Result<SmartListRules, ListError> {
    let invalid = |message| ListError::new(ListErrorKind::InvalidRules, message);
    if let Some(media_type) = rules.media_type {
        rules.media_type = Some(
            normalize_watch_progress_type(&media_type)
                .ok_or_else(|| invalid("Choose Movies or Series."))?
                .to_string(),
        );
    }
    if rules.genres.len() > 12 {
        return Err(invalid("Choose at most 12 genres."));
    }
    let mut seen = HashSet::new();
    let mut genres = Vec::with_capacity(rules.genres.len());
    for genre in rules.genres {
        let genre = genre.trim();
        if genre.is_empty()
            || genre
                .chars()
                .nth(super::media_normalization::MEDIA_GENRE_MAX_CHARS)
                .is_some()
        {
            return Err(invalid("Genres must contain between 1 and 64 characters."));
        }
        if seen.insert(normalize_smart_list_genre(genre)) {
            genres.push(genre.to_string());
        }
    }
    rules.genres = genres;
    let mut statuses = Vec::with_capacity(4);
    for status in rules.statuses {
        if !statuses.contains(&status) {
            statuses.push(status);
        }
    }
    rules.statuses = statuses;
    if rules
        .year_from
        .into_iter()
        .chain(rules.year_to)
        .any(|year| !(1889..=2100).contains(&year))
        || matches!((rules.year_from, rules.year_to), (Some(from), Some(to)) if from > to)
    {
        return Err(invalid(
            "Use years from 1889 to 2100, with From no later than To.",
        ));
    }
    if rules.media_type.is_none()
        && rules.genres.is_empty()
        && rules.statuses.is_empty()
        && rules.year_from.is_none()
        && rules.year_to.is_none()
    {
        return Err(invalid("Choose at least one smart list rule."));
    }
    Ok(rules)
}

pub(super) fn normalize_smart_list_genre(genre: &str) -> String {
    genre.trim().to_lowercase()
}

pub(super) fn normalize_smart_list_library(
    library: &[MediaItem],
) -> Vec<(&MediaItem, Vec<String>)> {
    library
        .iter()
        .map(|item| {
            let genres = item
                .genres
                .iter()
                .flatten()
                .map(|genre| normalize_smart_list_genre(genre))
                .collect();
            (item, genres)
        })
        .collect()
}

pub(super) fn smart_list_items<'a, 'b>(
    rules: &'b SmartListRules,
    library: &'b [(&'a MediaItem, Vec<String>)],
    statuses: &'b HashMap<String, String>,
) -> impl Iterator<Item = &'a MediaItem> + 'b {
    let genres: HashSet<String> = rules
        .genres
        .iter()
        .map(|genre| genre.to_lowercase())
        .collect();
    library
        .iter()
        .filter(move |(item, item_genres)| {
            rules.media_type.as_deref().is_none_or(|media_type| {
                normalize_watch_progress_type(&item.type_) == Some(media_type)
            }) && (genres.is_empty() || item_genres.iter().any(|genre| genres.contains(genre)))
                && (rules.statuses.is_empty()
                    || statuses.get(&item.id).is_some_and(|status| {
                        rules.statuses.iter().any(|rule| rule.as_str() == status)
                    }))
                && ((rules.year_from.is_none() && rules.year_to.is_none())
                    || item.primary_year.is_some_and(|year| {
                        rules.year_from.is_none_or(|from| year >= from)
                            && rules.year_to.is_none_or(|to| year <= to)
                    }))
        })
        .map(|(item, _)| *item)
        .take(MAX_LIST_ITEMS)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserList {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub item_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<SmartListRules>,
}

impl UserList {
    pub(super) fn require_manual(&self) -> Result<(), ListError> {
        if self.rules.is_some() {
            return Err(ListError::new(
                ListErrorKind::SmartListReadOnly,
                "Smart lists update automatically.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserListWithItems {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub item_ids: Vec<String>,
    pub items: Vec<MediaItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<SmartListRules>,
}

#[derive(Debug, Serialize)]
pub struct UserListSummary {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub item_count: usize,
    pub contains_item: bool,
    pub is_smart: bool,
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
    pub(super) fn normalized_item(self) -> Option<MediaItem> {
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
    let id = input.trim();
    if id.chars().nth(MAX_LIST_ID_CHARS).is_some()
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return None;
    }
    super::normalize_opaque_field(id)
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
pub(super) fn load_list(store: &DurableStore, list_id: &str) -> Result<UserList, ListError> {
    store
        .get_typed(list_meta_key(list_id))
        .ok_or_else(|| ListError::new(ListErrorKind::ListNotFound, "List not found"))
}

/// Strict order read through the shared index policy — a non-array or
/// all-undecodable header is corrupt; erroring keeps mutations from rebuilding
/// an empty index over orphaned `list:*` keys.
pub(super) fn load_lists_order(store: &DurableStore) -> Result<Vec<String>, String> {
    let raw_order = load_index(store, LISTS_ORDER_KEY)?;
    let has_raw_order = !raw_order.is_empty();

    let mut seen: HashSet<String> = HashSet::with_capacity(raw_order.len());
    let order: Vec<String> = raw_order
        .into_iter()
        .filter_map(|list_id| bound_optional(Some(list_id), usize::MAX))
        .filter(|list_id| seen.insert(list_id.clone()))
        .collect();

    if has_raw_order && order.is_empty() {
        return Err(format!("Invalid {LISTS_ORDER_KEY} index."));
    }
    Ok(order)
}

/// Shared reorder merge for `reorder_list_items`/`reorder_lists`: the payload is a
/// reorder, not a delete — omitted ids append in current order so a stale snapshot
/// can't orphan stored keys. O(n+m) via hash sets.
pub(super) fn reorder_known_ids(current: &[String], requested: Vec<String>) -> Vec<String> {
    let mut remaining: HashSet<&str> = current.iter().map(String::as_str).collect();
    let mut merged: Vec<String> = Vec::with_capacity(current.len());

    for id in requested {
        if remaining.remove(id.as_str()) {
            merged.push(id);
        }
    }
    for id in current {
        if remaining.remove(id.as_str()) {
            merged.push(id.clone());
        }
    }

    merged
}

#[cfg(test)]
mod tests;
