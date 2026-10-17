use super::list_helpers::{
    list_item_store_key, list_meta_key, load_list, load_lists_order, normalize_list_icon,
    normalize_list_id, normalize_list_name, reorder_known_ids, ListError, ListErrorKind,
    ListItemIdentity, UserList, UserListSummary, UserListWithItems, LISTS_ORDER_KEY,
    LIST_ITEM_KEY_PREFIX, MAX_LISTS, MAX_LIST_ITEMS,
};
use super::store_helpers::{merge_library_item, normalize_library_item, normalize_library_items};
use super::{normalize_media_id, run_typed_store_op, DurableStore, LISTS_STORE_FILE};
use crate::providers::MediaItem;
use serde_json::json;
use std::collections::{hash_map::Entry, HashMap, HashSet};
use tauri::{command, AppHandle};

#[command]
pub async fn create_list(
    app: AppHandle,
    name: String,
    icon: Option<String>,
) -> Result<UserList, ListError> {
    // Store file IO is blocking: run the read-modify-write off the async
    // worker, matching the library/history command pattern.
    run_typed_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;

        let name = normalize_list_name(&name).ok_or_else(|| {
            ListError::new(ListErrorKind::ListNameRequired, "List name is required.")
        })?;
        let id = format!("list_{}", uuid::Uuid::new_v4().simple());

        let list = UserList {
            id: id.clone(),
            name,
            icon: normalize_list_icon(icon.as_deref()),
            item_ids: Vec::new(),
        };

        let mut order = load_lists_order(&store)?;
        if order.len() >= MAX_LISTS {
            return Err(ListError::new(
                ListErrorKind::TooManyLists,
                format!("Too many lists. Maximum is {}.", MAX_LISTS),
            ));
        }
        order.push(id.clone());

        store.set(list_meta_key(&id), json!(list));
        store.set(LISTS_ORDER_KEY, json!(order));
        store.save()?;

        Ok(list)
    })
    .await
}

#[command]
pub async fn delete_list(app: AppHandle, list_id: String) -> Result<(), ListError> {
    let list_id = normalize_list_id(&list_id).ok_or_else(|| "Invalid list id.".to_string())?;
    run_typed_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;

        // Validate the order index before the first mutation — a corrupt header must
        // fail without leaving dirty deletes the exit flush would commit.
        let mut order = load_lists_order(&store)?;

        store.delete(list_meta_key(&list_id));

        // Prefix sweep, not meta enumeration — a corrupt meta has no readable
        // item_ids and partial writes leave unlisted item keys. The trailing `:`
        // keeps `list_a` from matching `list_ab`'s items.
        let item_prefix = format!("{LIST_ITEM_KEY_PREFIX}{list_id}:");
        store.delete_matching(|key| key.starts_with(&item_prefix));

        order.retain(|id| id != &list_id);
        store.set(LISTS_ORDER_KEY, json!(order));
        store.save()?;

        Ok(())
    })
    .await
}

#[command]
pub async fn rename_list(
    app: AppHandle,
    list_id: String,
    name: String,
    icon: Option<String>,
) -> Result<(), ListError> {
    let list_id = normalize_list_id(&list_id).ok_or_else(|| "Invalid list id.".to_string())?;
    run_typed_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;

        let mut list = load_list(&store, &list_id)?;

        list.name = normalize_list_name(&name).ok_or_else(|| {
            ListError::new(ListErrorKind::ListNameRequired, "List name is required.")
        })?;
        if let Some(next_icon) = icon {
            list.icon = normalize_list_icon(Some(next_icon.as_str()));
        }

        store.set(list_meta_key(&list_id), json!(list));
        store.save()?;

        Ok(())
    })
    .await
}

#[command]
pub async fn add_to_list(
    app: AppHandle,
    list_id: String,
    item: MediaItem,
) -> Result<UserListSummary, ListError> {
    let list_id = normalize_list_id(&list_id).ok_or_else(|| "Invalid list id.".to_string())?;
    run_typed_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;

        let mut list = load_list(&store, &list_id)?;
        let item = normalize_library_item(item).ok_or_else(|| {
            "Invalid media item. Missing required id, title, or type.".to_string()
        })?;

        if !list.item_ids.contains(&item.id) {
            if list.item_ids.len() >= MAX_LIST_ITEMS {
                return Err(ListError::new(
                    ListErrorKind::ListFull,
                    format!("List is full. Maximum is {} items.", MAX_LIST_ITEMS),
                ));
            }
            list.item_ids.push(item.id.clone());
            store.set(list_item_store_key(&list_id, &item.id), json!(item));
            store.set(list_meta_key(&list_id), json!(list));
        }
        store.save()?;

        Ok(UserListSummary {
            id: list_id,
            name: list.name,
            icon: list.icon,
            item_count: list.item_ids.len(),
            contains_item: true,
        })
    })
    .await
}

fn add_list_items(
    store: &DurableStore,
    list_id: &str,
    items: Vec<MediaItem>,
) -> Result<usize, ListError> {
    let mut list = load_list(store, list_id)?;
    if items.is_empty() {
        return Ok(0);
    }
    let mut known: HashSet<&str> = list.item_ids.iter().map(String::as_str).collect();
    let new_ids: Vec<String> = items
        .iter()
        .filter(|item| known.insert(&item.id))
        .map(|item| item.id.clone())
        .collect();
    if !new_ids.is_empty() && list.item_ids.len() + new_ids.len() > MAX_LIST_ITEMS {
        return Err(ListError::new(
            ListErrorKind::ListFull,
            format!("A custom list cannot exceed {} items", MAX_LIST_ITEMS),
        ));
    }
    drop(known);
    let added = new_ids.len();
    list.item_ids.extend(new_ids);
    // Stage merges before any store mutation. Duplicate ids merge in payload
    // order and cost only one store read and one final write.
    let mut prepared = HashMap::<String, MediaItem>::with_capacity(items.len());
    for item in items {
        match prepared.entry(item.id.clone()) {
            Entry::Occupied(mut entry) => {
                let existing = entry.get_mut();
                *existing = merge_library_item(Some(existing), item);
            }
            Entry::Vacant(entry) => {
                let existing = store
                    .get_typed(list_item_store_key(list_id, entry.key()))
                    .and_then(normalize_library_item)
                    .filter(|existing| existing.id == *entry.key());
                entry.insert(merge_library_item(existing.as_ref(), item));
            }
        }
    }
    for (id, item) in prepared {
        store.set(list_item_store_key(list_id, &id), json!(item));
    }
    store.set(list_meta_key(list_id), json!(list));
    store.save()?;
    Ok(added)
}

#[command]
pub async fn bulk_add_to_list(
    app: AppHandle,
    list_id: String,
    items: Vec<MediaItem>,
) -> Result<usize, ListError> {
    run_typed_store_op(move || {
        let list_id = normalize_list_id(&list_id).ok_or_else(|| "Invalid list id.".to_string())?;
        let items = normalize_library_items(items)?;
        let store = super::open_store(&app, LISTS_STORE_FILE)?;
        add_list_items(&store, &list_id, items)
    })
    .await
}

#[command]
pub async fn remove_from_list(
    app: AppHandle,
    list_id: String,
    item_id: String,
) -> Result<(), ListError> {
    let list_id = normalize_list_id(&list_id).ok_or_else(|| "Invalid list id.".to_string())?;
    let item_id =
        normalize_media_id(&item_id).ok_or_else(|| "Invalid list item id.".to_string())?;
    run_typed_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;

        let mut list = load_list(&store, &list_id)?;

        list.item_ids.retain(|id| id != &item_id);
        store.delete(list_item_store_key(&list_id, &item_id));
        store.set(list_meta_key(&list_id), json!(list));
        store.save()?;

        Ok(())
    })
    .await
}

#[command]
pub async fn get_lists(app: AppHandle) -> Result<Vec<UserListWithItems>, ListError> {
    run_typed_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;
        read_lists(&store).map_err(Into::into)
    })
    .await
}

#[command]
pub async fn get_list_summaries(
    app: AppHandle,
    item_id: Option<String>,
) -> Result<Vec<UserListSummary>, ListError> {
    let item_id = item_id.as_deref().and_then(normalize_media_id);
    run_typed_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;
        read_lists_with(
            &store,
            |store, key| {
                let item = store
                    .get_typed::<ListItemIdentity>(key)?
                    .normalized_item()?;
                Some((item.id, ()))
            },
            |list, _| UserListSummary {
                item_count: list.item_ids.len(),
                contains_item: item_id
                    .as_ref()
                    .is_some_and(|id| list.item_ids.contains(id)),
                id: list.id,
                name: list.name,
                icon: list.icon,
            },
        )
        .map_err(Into::into)
    })
    .await
}

pub(super) fn read_lists(store: &DurableStore) -> Result<Vec<UserListWithItems>, String> {
    read_lists_with(
        store,
        |store, key| {
            let item = store
                .get_typed::<MediaItem>(key)
                .and_then(normalize_library_item)?;
            Some((item.id.clone(), item))
        },
        |list, items| UserListWithItems {
            id: list.id,
            name: list.name,
            icon: list.icon,
            item_ids: list.item_ids,
            items,
        },
    )
}

pub(super) fn read_list_item_identities(store: &DurableStore) -> Result<Vec<MediaItem>, String> {
    read_lists_with(
        store,
        |store, key| {
            let item = store
                .get_typed::<ListItemIdentity>(key)?
                .normalized_item()?;
            Some((item.id.clone(), item))
        },
        |_list, items| items,
    )
    .map(|lists| lists.into_iter().flatten().collect())
}

fn read_lists_with<T, R>(
    store: &DurableStore,
    load_item: impl Fn(&DurableStore, &str) -> Option<(String, T)>,
    build: impl Fn(UserList, Vec<T>) -> R,
) -> Result<Vec<R>, String> {
    let order = load_lists_order(store)?;
    let mut result = Vec::with_capacity(order.len());
    let mut surviving_ids: Vec<String> = Vec::with_capacity(order.len());
    let mut modified = false;

    for list_id in &order {
        let Some(mut list) = store.get_typed::<UserList>(list_meta_key(list_id)) else {
            continue;
        };
        surviving_ids.push(list_id.clone());
        let mut seen = HashSet::with_capacity(list.item_ids.len());
        // Read every original row before repairing keys — swapped ids must not
        // overwrite an unread row; collisions keep the first valid item (backup import's dedupe policy).
        let rows: Vec<_> = list
            .item_ids
            .iter()
            .enumerate()
            .filter_map(|(index, id)| {
                let (cleaned_id, item) = load_item(store, &list_item_store_key(list_id, id))?;
                seen.insert(cleaned_id.clone())
                    .then_some((index, cleaned_id, item))
            })
            .collect();
        let cleaned_item_ids: Vec<String> = rows.iter().map(|(_, id, _)| id.clone()).collect();
        if cleaned_item_ids != list.item_ids {
            // Identity-only reads need full snapshots only to repair damaged membership.
            let repaired_items: Vec<MediaItem> = rows
                .iter()
                .filter_map(|(index, _, _)| {
                    store
                        .get_typed(list_item_store_key(list_id, &list.item_ids[*index]))
                        .and_then(normalize_library_item)
                })
                .collect();
            // Delete all old keys before any insert: a later old-key delete
            // could otherwise erase an earlier repaired row.
            for id in &list.item_ids {
                store.delete(list_item_store_key(list_id, id));
            }
            for item in &repaired_items {
                store.set(list_item_store_key(list_id, &item.id), json!(item));
            }
        }

        // The order entry owns the list identity all mutations address.
        if cleaned_item_ids != list.item_ids || list.id != *list_id {
            modified = true;
            list.id = list_id.clone();
            list.item_ids = cleaned_item_ids;
            store.set(list_meta_key(list_id), json!(list));
        }

        result.push(build(
            list,
            rows.into_iter().map(|(_, _, item)| item).collect(),
        ));
    }

    // Ghost order entries never surface in the result.
    if surviving_ids.len() != order.len() {
        modified = true;
        store.set(LISTS_ORDER_KEY, json!(surviving_ids));
    }
    if modified {
        store.save()?;
    }
    Ok(result)
}

#[command]
pub async fn reorder_list_items(
    app: AppHandle,
    list_id: String,
    item_ids: Vec<String>,
) -> Result<(), ListError> {
    let list_id = normalize_list_id(&list_id).ok_or_else(|| "Invalid list id.".to_string())?;
    // Payload bound before spawning: the merge is O(n+m) but still allocates
    // per payload element, so reject oversized payloads up front.
    if item_ids.len() > MAX_LIST_ITEMS {
        return Err(format!("Too many list items. Maximum is {}.", MAX_LIST_ITEMS).into());
    }
    run_typed_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;

        let mut list = load_list(&store, &list_id)?;

        list.item_ids = reorder_known_ids(&list.item_ids, item_ids);

        store.set(list_meta_key(&list_id), json!(list));
        store.save()?;

        Ok(())
    })
    .await
}

#[command]
pub async fn reorder_lists(app: AppHandle, list_ids: Vec<String>) -> Result<(), ListError> {
    if list_ids.len() > MAX_LISTS {
        return Err(ListError::new(
            ListErrorKind::TooManyLists,
            format!("Too many lists. Maximum is {}.", MAX_LISTS),
        ));
    }
    run_typed_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;

        let current_order = load_lists_order(&store)?;
        // Merge rule lives in `reorder_known_ids` — omitted ids append in current order.
        let new_order = reorder_known_ids(&current_order, list_ids);

        store.set(LISTS_ORDER_KEY, json!(new_order));
        store.save()?;

        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::{test_media_item, test_store};

    fn seed_list(store: &DurableStore, ids: Vec<String>) {
        store.set(
            list_meta_key("list_a"),
            json!(UserList {
                id: "list_a".into(),
                name: "List".into(),
                icon: "list".into(),
                item_ids: ids,
            }),
        );
        store.save().unwrap();
    }

    #[test]
    fn bulk_list_add_merges_existing_appends_new_and_saves_once() {
        let fixture = test_store();
        let mut existing = test_media_item("a", "movie");
        existing.poster = Some("https://img.example/a.jpg".into());
        fixture
            .store
            .set(list_item_store_key("list_a", "a"), json!(existing));
        seed_list(&fixture.store, vec!["a".into()]);
        let mut first_b = test_media_item("b", "movie");
        first_b.description = Some("Keep this description".into());
        let mut last_b = test_media_item(" b ", "movie");
        last_b.title = "Last title".into();
        let items = normalize_library_items(vec![
            test_media_item("a", "movie"),
            first_b,
            test_media_item("c", "series"),
            last_b,
        ])
        .unwrap();
        assert_eq!(add_list_items(&fixture.store, "list_a", items).unwrap(), 2);
        assert_eq!(
            load_list(&fixture.store, "list_a").unwrap().item_ids,
            ["a", "b", "c"]
        );
        let a = fixture
            .store
            .get_typed::<MediaItem>(list_item_store_key("list_a", "a"))
            .unwrap();
        assert_eq!(a.poster.as_deref(), Some("https://img.example/a.jpg"));
        let b = fixture
            .store
            .get_typed::<MediaItem>(list_item_store_key("list_a", "b"))
            .unwrap();
        assert_eq!(b.title, "Last title");
        assert_eq!(b.description.as_deref(), Some("Keep this description"));
        assert_eq!(fixture.store.save_count(), 2);
        let reopened = super::super::DurableStoreRegistry::default()
            .open_path(fixture.path.clone())
            .unwrap();
        assert_eq!(
            load_list(&reopened, "list_a").unwrap().item_ids,
            ["a", "b", "c"]
        );
    }

    #[test]
    fn bulk_list_capacity_failure_leaves_live_and_persisted_list_unchanged() {
        let fixture = test_store();
        seed_list(
            &fixture.store,
            (0..MAX_LIST_ITEMS)
                .map(|index| format!("id{index}"))
                .collect(),
        );
        let before = std::fs::read(&fixture.path).unwrap();
        let items = normalize_library_items(vec![
            test_media_item("id0", "movie"),
            test_media_item("new", "movie"),
        ])
        .unwrap();
        let error = add_list_items(&fixture.store, "list_a", items).unwrap_err();
        assert_eq!(error.kind, ListErrorKind::ListFull);
        assert_eq!(error.message, "A custom list cannot exceed 2000 items");
        fixture.store.save().unwrap();
        assert_eq!(std::fs::read(&fixture.path).unwrap(), before);
        assert!(fixture
            .store
            .get(list_item_store_key("list_a", "id0"))
            .is_none());
        assert_eq!(fixture.store.save_count(), 1);
    }

    #[test]
    fn bulk_list_duplicate_ids_do_not_double_count_capacity() {
        let fixture = test_store();
        seed_list(
            &fixture.store,
            (0..MAX_LIST_ITEMS - 1)
                .map(|index| format!("id{index}"))
                .collect(),
        );
        let items = normalize_library_items(vec![
            test_media_item("new", "movie"),
            test_media_item(" new ", "movie"),
        ])
        .unwrap();
        assert_eq!(add_list_items(&fixture.store, "list_a", items).unwrap(), 1);
        assert_eq!(
            load_list(&fixture.store, "list_a").unwrap().item_ids.len(),
            MAX_LIST_ITEMS
        );
    }

    #[test]
    fn bulk_list_invalid_item_and_missing_list_fail_without_mutations() {
        let fixture = test_store();
        seed_list(&fixture.store, Vec::new());
        let result = normalize_library_items(vec![
            test_media_item("a", "movie"),
            test_media_item("", "movie"),
        ])
        .map_err(ListError::from)
        .and_then(|items| add_list_items(&fixture.store, "list_a", items));
        assert!(result.is_err());
        assert!(normalize_list_id("invalid:list").is_none());
        assert_eq!(
            add_list_items(&fixture.store, "list_a", Vec::new()).unwrap(),
            0
        );
        assert_eq!(
            add_list_items(&fixture.store, "missing", Vec::new())
                .unwrap_err()
                .kind,
            ListErrorKind::ListNotFound
        );
        fixture.store.save().unwrap();
        assert_eq!(fixture.store.save_count(), 1);
        assert!(load_list(&fixture.store, "list_a")
            .unwrap()
            .item_ids
            .is_empty());
    }
}
