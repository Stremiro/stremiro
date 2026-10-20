use super::list_helpers::normalize_smart_list_genre;
use super::store_helpers::{
    library_item_key, load_library_index, load_library_map, load_watch_status_index,
    merge_library_item, normalize_bulk_ids, normalize_library_item, normalize_watch_status,
    persist_index_map, read_library_snapshot, read_watch_status_snapshot, retain_status_added_ids,
    watch_status_item_key, LIBRARY_LAYOUT, WATCH_STATUS_LAYOUT,
};
use super::{
    js_trim, normalize_media_id, run_blocking_store_op, DurableStore, LIBRARY_INDEX_KEY,
    LIBRARY_STORE_FILE, WATCH_STATUS_INDEX_KEY, WATCH_STATUS_STORE_FILE,
};
use crate::providers::MediaItem;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashMap, HashSet};
use tauri::{command, AppHandle};

/// Bound on the library index: every add rewrites the index key, so an
/// unbounded index makes every read/write linear in junk entries.
pub(super) const MAX_LIBRARY_ITEMS: usize = 5_000;
const TITLE_SEARCH_MAX_TITLES: usize = 10_000;
const TITLE_SEARCH_MAX_QUERY_CHARS: usize = 4_096;

#[derive(Debug)]
pub(super) enum LibraryWriteError {
    InvalidItem(String),
    CapacityExceeded(String),
    Failed(String),
}

impl From<String> for LibraryWriteError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<LibraryWriteError> for String {
    fn from(error: LibraryWriteError) -> Self {
        match error {
            LibraryWriteError::InvalidItem(message)
            | LibraryWriteError::CapacityExceeded(message)
            | LibraryWriteError::Failed(message) => message,
        }
    }
}

pub(super) fn resolve_library_items(
    store: &DurableStore,
    ids: Vec<String>,
) -> Result<Vec<MediaItem>, LibraryWriteError> {
    let ids =
        super::store_helpers::normalize_bulk_ids(ids).map_err(LibraryWriteError::InvalidItem)?;
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut library = read_library_snapshot(store)?.items;
    // Titles removed elsewhere since selection are skipped; only an all-stale
    // selection fails, so callers never report success for zero matches.
    let items: Vec<MediaItem> = ids.iter().filter_map(|id| library.remove(id)).collect();
    if items.is_empty() {
        return Err(LibraryWriteError::InvalidItem(
            "Selected titles are no longer in your library.".to_string(),
        ));
    }
    Ok(items)
}

/// Prepare without mutating either domain: status-set uses this preflight
/// before writing its status, so a full library rejects the entire action.
/// The index is `Some` only when the title is new to the Library.
pub(super) fn prepare_library_write(
    store: &DurableStore,
    item: MediaItem,
) -> Result<(MediaItem, Option<Vec<String>>), LibraryWriteError> {
    let mut index = load_library_index(store)?;
    let item = normalize_library_item(item).ok_or_else(|| {
        LibraryWriteError::InvalidItem(
            "Invalid library item. ID, title, and media type are required.".to_string(),
        )
    })?;
    let existing = store
        .get_typed(library_item_key(&item.id))
        .and_then(normalize_library_item)
        .filter(|existing| existing.id == item.id);
    let item = merge_library_item(existing.as_ref(), item);
    if index.contains(&item.id) {
        return Ok((item, None));
    }
    if index.len() >= MAX_LIBRARY_ITEMS {
        return Err(LibraryWriteError::CapacityExceeded(
            "Library is full.".to_string(),
        ));
    }
    index.push(item.id.clone());
    index.sort();
    Ok((item, Some(index)))
}

#[command]
pub async fn add_to_library(app: AppHandle, item: MediaItem) -> Result<MediaItem, String> {
    run_blocking_store_op(move || {
        let store = super::open_store(&app, LIBRARY_STORE_FILE)?;
        let (final_item, index) = prepare_library_write(&store, item).map_err(String::from)?;

        store.set(library_item_key(&final_item.id), json!(final_item));
        if let Some(index) = index {
            store.set(LIBRARY_INDEX_KEY, json!(index));
        }
        // An explicit save makes the title the user's own, independent of its status.
        retain_status_added_ids(&store, |id| id != final_item.id);
        store.save()?;
        Ok(final_item)
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

        // Watch status is a library attribute — clear it in the same blocking op so
        // a removed title can't leave an invisible status row. Both stores/indexes
        // are validated before any mutation, so a corrupt status index fails first.
        // Statuses commit first: a leftover status (resurrectable by the details
        // self-heal) is the harmful half; a library row without a status is benign.
        let status_store = super::open_store(&app, WATCH_STATUS_STORE_FILE)?;
        let mut status_index = load_watch_status_index(&status_store)?;

        let removed_status = status_store.delete(watch_status_item_key(&id));
        let original_status_len = status_index.len();
        status_index.retain(|entry| entry != &id);
        if removed_status || status_index.len() != original_status_len {
            status_store.set(WATCH_STATUS_INDEX_KEY, json!(status_index));
        }
        status_store.save()?;

        let deleted_item = store.delete(library_item_key(&id));
        let original_len = index.len();
        index.retain(|entry| entry != &id);

        if deleted_item || index.len() != original_len {
            store.set(LIBRARY_INDEX_KEY, json!(index));
        }
        retain_status_added_ids(&store, |entry| entry != id);
        store.save()?;

        Ok(())
    })
    .await
}

fn remove_library_items(
    store: &DurableStore,
    status_store: &DurableStore,
    ids: &[String],
) -> Result<usize, String> {
    let mut library = read_library_snapshot(store)?;
    let mut statuses = read_watch_status_snapshot(status_store)?;
    let mut removed = 0usize;
    let mut status_changed = false;
    for id in ids {
        removed += usize::from(library.items.remove(id).is_some());
        status_changed |= statuses.items.remove(id).is_some();
    }
    // Same status-before-library durability ordering as single removal.
    if status_changed {
        persist_index_map(
            status_store,
            WATCH_STATUS_LAYOUT,
            &statuses.index,
            &statuses.items,
        )?;
    } else {
        status_store.save()?;
    }
    let removed_ids: HashSet<&str> = ids.iter().map(String::as_str).collect();
    retain_status_added_ids(store, |id| !removed_ids.contains(id));
    if removed > 0 {
        persist_index_map(store, LIBRARY_LAYOUT, &library.index, &library.items)?;
    } else {
        store.save()?;
    }
    Ok(removed)
}

#[command]
pub async fn bulk_remove_from_library(app: AppHandle, ids: Vec<String>) -> Result<usize, String> {
    run_blocking_store_op(move || {
        if ids.is_empty() {
            return Ok(0);
        }
        let ids = normalize_bulk_ids(ids)?;
        let store = super::open_store(&app, LIBRARY_STORE_FILE)?;
        let status_store = super::open_store(&app, WATCH_STATUS_STORE_FILE)?;
        remove_library_items(&store, &status_store, &ids)
    })
    .await
}

#[command]
pub async fn get_library(app: AppHandle) -> Result<Vec<MediaItem>, String> {
    run_blocking_store_op(move || {
        let store = super::open_store(&app, LIBRARY_STORE_FILE)?;
        read_library_items(&store)
    })
    .await
}

fn read_library_items(store: &DurableStore) -> Result<Vec<MediaItem>, String> {
    let mut items: Vec<MediaItem> = load_library_map(store)?.into_values().collect();
    items.sort_by_cached_key(|item| (item.title.to_lowercase(), item.id.clone()));
    Ok(items)
}

fn read_library_genres(store: &DurableStore) -> Result<Vec<String>, String> {
    let mut items: Vec<_> = read_library_snapshot(store)?.items.into_values().collect();
    items.sort_by_cached_key(|item| (item.title.to_lowercase(), item.id.clone()));
    let mut genres = BTreeMap::new();
    for item in items {
        for genre in item.genres.into_iter().flatten() {
            genres
                .entry(normalize_smart_list_genre(&genre))
                .or_insert(genre);
        }
    }
    Ok(genres.into_values().collect())
}

#[command]
pub async fn get_library_genres(app: AppHandle) -> Result<Vec<String>, String> {
    run_blocking_store_op(move || {
        let store = super::open_store(&app, LIBRARY_STORE_FILE)?;
        read_library_genres(&store)
    })
    .await
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum LibrarySort {
    #[default]
    Default,
    TitleAsc,
    TitleDesc,
    YearAsc,
    YearDesc,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LibraryType {
    #[default]
    All,
    Movie,
    Series,
}

#[derive(Default, Deserialize)]
pub(crate) struct LibraryFilters {
    query: Option<String>,
    #[serde(default, rename = "type")]
    type_: LibraryType,
    status: Option<String>,
    #[serde(default)]
    sort: LibrarySort,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileLibrary {
    items: Vec<MediaItem>,
    all_ids: Vec<String>,
    status_counts: HashMap<String, usize>,
}

pub(super) fn library_status_counts<'a>(
    ids: impl IntoIterator<Item = &'a str>,
    statuses: &HashMap<String, String>,
) -> HashMap<String, usize> {
    let mut counts = ["watching", "watched", "plan_to_watch", "dropped", "none"]
        .into_iter()
        .map(|status| (status.to_string(), 0))
        .collect::<HashMap<_, _>>();
    for id in ids {
        let status = statuses.get(id).map_or("none", String::as_str);
        if let Some(count) = counts.get_mut(status) {
            *count += 1;
        }
    }
    counts
}

fn matching_title_key(title: &str, query: &str) -> Option<String> {
    let title = title.to_lowercase();
    title.contains(query).then_some(title)
}

#[command]
pub fn search_titles(titles: Vec<String>, query: String) -> Result<Vec<u32>, String> {
    if titles.len() > TITLE_SEARCH_MAX_TITLES {
        return Err("Too many titles.".to_string());
    }
    if query.chars().nth(TITLE_SEARCH_MAX_QUERY_CHARS).is_some() {
        return Err("Title search query is too long.".to_string());
    }
    let query = js_trim(&query).to_lowercase();
    if query.is_empty() {
        return Ok((0..titles.len() as u32).collect());
    }
    Ok(titles
        .iter()
        .enumerate()
        .filter_map(|(index, title)| matching_title_key(title, &query).map(|_| index as u32))
        .collect())
}

fn filter_profile_library(
    mut items: Vec<MediaItem>,
    statuses: &HashMap<String, String>,
    filters: LibraryFilters,
) -> Result<ProfileLibrary, String> {
    let status = match filters.status.as_deref().map(str::trim) {
        None | Some("all") => None,
        Some("none") => Some("none".to_string()),
        Some(value) => {
            Some(normalize_watch_status(value).ok_or_else(|| "Invalid watch status.".to_string())?)
        }
    };
    // Keep literal Unicode/punctuation matching; remote search normalization is ASCII-only.
    let query: String = js_trim(filters.query.as_deref().unwrap_or(""))
        .chars()
        .take(super::MAX_SEARCH_QUERY_CHARS)
        .collect();
    let query = query.to_lowercase();
    let mut all_ids: Vec<_> = items.iter().map(|item| item.id.clone()).collect();
    all_ids.sort_unstable();
    let status_counts = library_status_counts(items.iter().map(|item| item.id.as_str()), statuses);
    items.retain(|item| {
        let type_matches = match filters.type_ {
            LibraryType::All => true,
            LibraryType::Movie => item.type_ == "movie",
            LibraryType::Series => item.type_ == "series",
        };
        type_matches
            && status.as_deref().is_none_or(|status| {
                statuses.get(&item.id).map_or("none", String::as_str) == status
            })
    });
    let mut items: Vec<_> = items
        .into_iter()
        .filter_map(|item| {
            let title = matching_title_key(&item.title, &query)?;
            let year = item.primary_year;
            let year_key = match filters.sort {
                LibrarySort::YearDesc => year.map(|year| u32::MAX - year).unwrap_or(u32::MAX),
                LibrarySort::YearAsc => year.unwrap_or(u32::MAX),
                _ => 0,
            };
            Some(((year_key, title), item))
        })
        .collect();
    items.sort_by(|(left_key, left), (right_key, right)| {
        left_key.cmp(right_key).then_with(|| left.id.cmp(&right.id))
    });
    if matches!(filters.sort, LibrarySort::TitleDesc) {
        items.reverse();
    }
    Ok(ProfileLibrary {
        items: items.into_iter().map(|(_, item)| item).collect(),
        all_ids,
        status_counts,
    })
}

#[command]
pub async fn get_profile_library(
    app: AppHandle,
    filters: Option<LibraryFilters>,
) -> Result<ProfileLibrary, String> {
    run_blocking_store_op(move || {
        let store = super::open_store(&app, LIBRARY_STORE_FILE)?;
        let status_store = super::open_store(&app, WATCH_STATUS_STORE_FILE)?;
        read_profile_library(&store, &status_store, filters.unwrap_or_default())
    })
    .await
}

fn read_profile_library(
    store: &DurableStore,
    status_store: &DurableStore,
    filters: LibraryFilters,
) -> Result<ProfileLibrary, String> {
    // Both snapshots must succeed before any filtered result can be shown.
    let items = read_library_snapshot(store)?.items.into_values().collect();
    let statuses = read_watch_status_snapshot(status_store)?.items;
    filter_profile_library(items, &statuses, filters)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::{test_media_item, test_store};

    #[test]
    fn library_genres_are_sorted_deduplicated_and_keep_first_library_casing() {
        let fixture = test_store();
        assert!(read_library_genres(&fixture.store).unwrap().is_empty());
        let index = json!(["z", "missing", "a"]);
        fixture.store.set(LIBRARY_INDEX_KEY, index.clone());
        for (id, title, genres) in [
            ("z", "Zulu", vec!["DRAMA", "Comedy", "äpfel"]),
            ("a", "Alpha", vec![" Drama ", "ÄPFEL", "Action"]),
        ] {
            let mut item = test_media_item(id, "movie");
            item.title = title.into();
            item.genres = Some(genres.into_iter().map(str::to_string).collect());
            fixture.store.set(library_item_key(id), json!(item));
        }
        assert_eq!(
            read_library_genres(&fixture.store).unwrap(),
            ["Action", "Comedy", "Drama", "ÄPFEL"]
        );
        assert_eq!(fixture.store.get(LIBRARY_INDEX_KEY), Some(index));
        assert_eq!(fixture.store.save_count(), 0);
        fixture
            .store
            .set(LIBRARY_INDEX_KEY, json!({"corrupt": true}));
        assert!(read_library_genres(&fixture.store).is_err());
        assert_eq!(fixture.store.save_count(), 0);
    }

    #[test]
    fn title_search_preserves_order_unicode_and_javascript_trim() {
        let titles: Vec<_> = ["ÄPFEL", "東京: Dawn", "äpfel again", "İSTANBUL", "ΟΣ", ""]
            .into_iter()
            .map(str::to_string)
            .collect();
        for (query, expected) in [
            ("\u{feff} ÄP \u{3000}", vec![0, 2]),
            ("東京:", vec![1]),
            ("i\u{307}", vec![3]),
            ("ος", vec![4]),
            ("\u{feff}\t\u{2028}", vec![0, 1, 2, 3, 4, 5]),
            ("\u{85}äp\u{85}", vec![]),
            ("missing", vec![]),
        ] {
            assert_eq!(
                search_titles(titles.clone(), query.into()).unwrap(),
                expected
            );
        }
        assert!(search_titles(vec![], String::new()).unwrap().is_empty());
    }

    #[test]
    fn title_search_accepts_caps_and_rejects_excess_without_truncating() {
        assert_eq!(
            search_titles(vec![String::new(); 10_000], String::new())
                .unwrap()
                .len(),
            10_000
        );
        assert_eq!(
            search_titles(vec!["界".repeat(4_097)], "界".repeat(4_096)).unwrap(),
            [0]
        );
        assert!(search_titles(vec![String::new(); 10_001], String::new()).is_err());
        assert!(search_titles(vec![], "x".repeat(4_097)).is_err());
    }

    fn profile_items() -> Vec<MediaItem> {
        [
            ("z", "Zulu", "movie", Some(2024)),
            ("b", "beta", "series", Some(2000)),
            ("a", "Alpha", "movie", Some(2024)),
            ("u", "Undated", "series", None),
            ("j", "東京: Dawn", "movie", None),
        ]
        .into_iter()
        .map(|(id, title, type_, year)| {
            let mut item = test_media_item(id, type_);
            item.title = title.to_string();
            item.primary_year = year;
            item
        })
        .collect()
    }

    fn profile_statuses() -> HashMap<String, String> {
        [
            ("a", "watched"),
            ("b", "watching"),
            ("z", "dropped"),
            ("outside", "watched"),
        ]
        .into_iter()
        .map(|(id, status)| (id.to_string(), status.to_string()))
        .collect()
    }

    fn profile_ids(filters: serde_json::Value) -> Vec<String> {
        filter_profile_library(
            profile_items(),
            &profile_statuses(),
            serde_json::from_value(filters).unwrap(),
        )
        .unwrap()
        .items
        .into_iter()
        .map(|item| item.id)
        .collect()
    }

    #[test]
    fn profile_search_matches_literal_titles_case_insensitively() {
        assert_eq!(profile_ids(json!({"query": "  ALP  "})), ["a"]);
        assert_eq!(profile_ids(json!({"query": " 東京: "})), ["j"]);
        assert_eq!(
            profile_ids(json!({"query": "\u{feff} ALP \u{3000}"})),
            ["a"]
        );
        assert!(profile_ids(json!({"query": "\u{85}alp\u{85}"})).is_empty());
        assert!(profile_ids(json!({"query": "missing"})).is_empty());
    }

    #[test]
    fn profile_type_and_status_filters_combine_including_no_status() {
        assert_eq!(profile_ids(json!({"type": "series"})), ["b", "u"]);
        assert_eq!(profile_ids(json!({"status": "watched"})), ["a"]);
        assert_eq!(profile_ids(json!({"status": "none"})), ["u", "j"]);
        assert_eq!(profile_ids(json!({"status": " Watching "})), ["b"]);
        assert_eq!(
            profile_ids(json!({"type": "movie", "status": "none"})),
            ["j"]
        );
        assert!(profile_ids(json!({"type": "movie", "status": "watching"})).is_empty());
        assert!(profile_ids(json!({"status": "plan_to_watch"})).is_empty());
    }

    #[test]
    fn profile_each_sort_is_deterministic_and_undated_titles_sink() {
        for (sort, expected) in [
            ("default", vec!["a", "b", "u", "z", "j"]),
            ("title-asc", vec!["a", "b", "u", "z", "j"]),
            ("title-desc", vec!["j", "z", "u", "b", "a"]),
            ("year-asc", vec!["b", "a", "z", "u", "j"]),
            ("year-desc", vec!["a", "z", "b", "u", "j"]),
        ] {
            assert_eq!(profile_ids(json!({"sort": sort})), expected, "{sort}");
        }
    }

    #[test]
    fn profile_search_keeps_unicode_matching_stable_ties_and_descending_reversal() {
        let items: Vec<_> = [("z", "ÄPFEL"), ("a", "Äpfel"), ("a", "äPFEL")]
            .into_iter()
            .map(|(id, title)| {
                let mut item = test_media_item(id, "movie");
                item.title = title.to_string();
                item
            })
            .collect();
        for sort in [
            "default",
            "title-asc",
            "title-desc",
            "year-asc",
            "year-desc",
        ] {
            let result = filter_profile_library(
                items.clone(),
                &HashMap::new(),
                serde_json::from_value(json!({"query": "  ÄP  ", "sort": sort})).unwrap(),
            )
            .unwrap();
            let titles: Vec<_> = result
                .items
                .iter()
                .map(|item| item.title.as_str())
                .collect();
            let expected = if sort == "title-desc" {
                ["ÄPFEL", "äPFEL", "Äpfel"]
            } else {
                ["Äpfel", "äPFEL", "ÄPFEL"]
            };
            assert_eq!(titles, expected, "{sort}");
        }
    }

    #[test]
    fn profile_status_counts_are_unfiltered_and_exclude_non_library_titles() {
        let result = filter_profile_library(
            profile_items(),
            &profile_statuses(),
            serde_json::from_value(json!({"query": "Alpha", "status": "watched"})).unwrap(),
        )
        .unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.all_ids, ["a", "b", "j", "u", "z"]);
        assert_eq!(result.status_counts["watched"], 1);
        assert_eq!(result.status_counts["watching"], 1);
        assert_eq!(result.status_counts["dropped"], 1);
        assert_eq!(result.status_counts["plan_to_watch"], 0);
        assert_eq!(result.status_counts["none"], 2);
        assert!(library_status_counts([], &profile_statuses())
            .values()
            .all(|count| *count == 0));
    }

    #[test]
    fn profile_rejects_unknown_filters_and_corrupt_status_data() {
        for filters in [json!({"type": "invalid"}), json!({"sort": "invalid"})] {
            assert!(serde_json::from_value::<LibraryFilters>(filters).is_err());
        }
        assert!(filter_profile_library(
            profile_items(),
            &profile_statuses(),
            serde_json::from_value(json!({"status": "invalid"})).unwrap(),
        )
        .is_err());
        let library = test_store();
        let statuses = test_store();
        library.store.set(LIBRARY_INDEX_KEY, json!(["a"]));
        library
            .store
            .set(library_item_key("a"), json!(test_media_item("a", "movie")));
        statuses
            .store
            .set(WATCH_STATUS_INDEX_KEY, json!({"corrupt": true}));
        for status in ["watched", "none", "all"] {
            assert!(read_profile_library(
                &library.store,
                &statuses.store,
                serde_json::from_value(json!({"status": status})).unwrap(),
            )
            .is_err());
        }
        assert_eq!(library.store.save_count(), 0);
        assert_eq!(statuses.store.save_count(), 0);
    }

    #[test]
    fn bulk_removal_counts_unique_existing_items_and_saves_each_domain_once() {
        let library = test_store();
        let statuses = test_store();
        for id in ["a", "b", "c"] {
            library
                .store
                .set(library_item_key(id), json!(test_media_item(id, "movie")));
            statuses
                .store
                .set(watch_status_item_key(id), json!("watching"));
        }
        library.store.set(LIBRARY_INDEX_KEY, json!(["a", "b", "c"]));
        library.store.set(
            super::super::LIBRARY_STATUS_ADDED_KEY,
            json!(["a", "c", "orphan"]),
        );
        statuses
            .store
            .set(WATCH_STATUS_INDEX_KEY, json!(["a", "b", "c"]));
        library.store.save().unwrap();
        statuses.store.save().unwrap();

        let ids = normalize_bulk_ids(vec![" a ".into(), "b".into(), "a".into(), "missing".into()])
            .unwrap();
        assert_eq!(
            remove_library_items(&library.store, &statuses.store, &ids).unwrap(),
            2
        );
        assert_eq!(library.store.get(LIBRARY_INDEX_KEY), Some(json!(["c"])));
        assert_eq!(
            super::super::store_helpers::load_status_added_ids(&library.store),
            ["c"]
        );
        assert_eq!(
            statuses.store.get(WATCH_STATUS_INDEX_KEY),
            Some(json!(["c"]))
        );
        assert!(library.store.get(library_item_key("a")).is_none());
        assert!(statuses.store.get(watch_status_item_key("b")).is_none());
        assert_eq!(library.store.save_count(), 2);
        assert_eq!(statuses.store.save_count(), 2);
        let reopened = super::super::DurableStoreRegistry::default()
            .open_path(library.path.clone())
            .unwrap();
        assert_eq!(reopened.get(LIBRARY_INDEX_KEY), Some(json!(["c"])));
        assert_eq!(
            remove_library_items(&library.store, &statuses.store, &ids).unwrap(),
            0
        );
        assert_eq!(library.store.save_count(), 2);
        assert_eq!(statuses.store.save_count(), 2);
    }

    #[test]
    fn bulk_removal_rejects_invalid_ids_without_partial_mutations() {
        let library = test_store();
        let statuses = test_store();
        library.store.set(LIBRARY_INDEX_KEY, json!(["a"]));
        library
            .store
            .set(library_item_key("a"), json!(test_media_item("a", "movie")));
        library.store.save().unwrap();
        let before = std::fs::read(&library.path).unwrap();
        for invalid in ["".to_string(), "undefined".to_string(), "x".repeat(257)] {
            let result = normalize_bulk_ids(vec!["a".into(), invalid])
                .and_then(|ids| remove_library_items(&library.store, &statuses.store, &ids));
            assert!(result.is_err());
            library.store.save().unwrap();
            assert_eq!(std::fs::read(&library.path).unwrap(), before);
            assert_eq!(library.store.save_count(), 1);
            assert_eq!(statuses.store.save_count(), 0);
        }
    }

    #[test]
    fn bulk_removal_validates_both_indexes_before_read_repair_or_deletes() {
        let library = test_store();
        let statuses = test_store();
        library
            .store
            .set(LIBRARY_INDEX_KEY, json!(["a", "missing"]));
        library
            .store
            .set(library_item_key("a"), json!(test_media_item("a", "movie")));
        statuses
            .store
            .set(WATCH_STATUS_INDEX_KEY, json!({"corrupt": true}));
        library.store.save().unwrap();
        assert!(remove_library_items(&library.store, &statuses.store, &["a".into()]).is_err());
        library.store.save().unwrap();
        assert_eq!(
            library.store.get(LIBRARY_INDEX_KEY),
            Some(json!(["a", "missing"]))
        );
        assert!(library.store.get(library_item_key("a")).is_some());
        assert_eq!(library.store.save_count(), 1);
    }
}
