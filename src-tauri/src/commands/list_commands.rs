use super::list_helpers::{
    list_item_store_key, list_meta_key, load_list, load_lists_order, normalize_list_icon,
    normalize_list_id, normalize_list_name, normalize_smart_list_library, reorder_known_ids,
    smart_list_items, validate_smart_list_rules, ListError, ListErrorKind, ListItemIdentity,
    SmartListRules, UserList, UserListSummary, UserListWithItems, LISTS_ORDER_KEY,
    LIST_ITEM_KEY_PREFIX, MAX_LISTS, MAX_LIST_ITEMS,
};
use super::store_helpers::{merge_library_item, normalize_library_item};
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
    rules: Option<SmartListRules>,
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
            rules: rules.map(validate_smart_list_rules).transpose()?,
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
    rules: Option<SmartListRules>,
) -> Result<(), ListError> {
    let list_id = normalize_list_id(&list_id).ok_or_else(|| "Invalid list id.".to_string())?;
    run_typed_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;

        let mut list = load_list(&store, &list_id)?;

        if let Some(rules) = rules {
            if list.rules.is_none() {
                return Err(ListError::new(
                    ListErrorKind::InvalidRules,
                    "Only smart lists have rules.",
                ));
            }
            list.rules = Some(validate_smart_list_rules(rules)?);
        }
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
        list.require_manual()?;
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
            is_smart: false,
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
    list.require_manual()?;
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
    item_ids: Vec<String>,
) -> Result<usize, ListError> {
    run_typed_store_op(move || {
        let list_id = normalize_list_id(&list_id).ok_or_else(|| "Invalid list id.".to_string())?;
        let store = super::open_store(&app, LISTS_STORE_FILE)?;
        load_list(&store, &list_id)?.require_manual()?;
        let library = super::open_store(&app, super::LIBRARY_STORE_FILE)?;
        let items = super::library_commands::resolve_library_items(&library, item_ids)
            .map_err(String::from)?;
        add_list_items(&store, &list_id, items)
    })
    .await
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct RemovedListItem {
    item: MediaItem,
    index: usize,
    /// Original predecessor id: Undo re-anchors beside it, so reorders made
    /// after the removal keep restored titles next to their old neighbour.
    #[serde(default)]
    after: Option<String>,
}

fn remove_list_items(
    store: &DurableStore,
    list_id: &str,
    item_ids: Vec<String>,
) -> Result<Vec<RemovedListItem>, ListError> {
    let mut list = load_list(store, list_id)?;
    list.require_manual()?;
    let ids: HashSet<String> = super::store_helpers::normalize_bulk_ids(item_ids)?
        .into_iter()
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    // A missing or corrupt item record must not block removal; it just can't be restored.
    let removed = list
        .item_ids
        .iter()
        .enumerate()
        .filter(|(_, id)| ids.contains(*id))
        .filter_map(|(index, id)| {
            store
                .get_typed(list_item_store_key(list_id, id))
                .and_then(normalize_library_item)
                .filter(|item| item.id == *id)
                .map(|item| RemovedListItem {
                    item,
                    index,
                    after: index
                        .checked_sub(1)
                        .map(|before| list.item_ids[before].clone()),
                })
        })
        .collect::<Vec<_>>();
    list.item_ids.retain(|id| !ids.contains(id));
    for id in ids {
        store.delete(list_item_store_key(list_id, &id));
    }
    store.set(list_meta_key(list_id), json!(list));
    store.save()?;
    Ok(removed)
}

#[command]
pub async fn bulk_remove_from_list(
    app: AppHandle,
    list_id: String,
    item_ids: Vec<String>,
) -> Result<Vec<RemovedListItem>, ListError> {
    let list_id = normalize_list_id(&list_id).ok_or_else(|| "Invalid list id.".to_string())?;
    run_typed_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;
        remove_list_items(&store, &list_id, item_ids)
    })
    .await
}

fn restore_list_entries(
    store: &DurableStore,
    list_id: &str,
    entries: Vec<RemovedListItem>,
) -> Result<(), ListError> {
    let mut list = load_list(store, list_id)?;
    list.require_manual()?;
    if entries.len() > super::store_helpers::MAX_BULK_ITEMS {
        return Err("Too many titles.".to_string().into());
    }
    let mut prepared = Vec::with_capacity(entries.len());
    let mut seen = HashSet::with_capacity(entries.len());
    for entry in entries {
        if entry.index >= MAX_LIST_ITEMS {
            return Err("Invalid list position.".to_string().into());
        }
        let item =
            normalize_library_item(entry.item).ok_or_else(|| "Invalid media item.".to_string())?;
        if seen.insert(item.id.clone()) {
            prepared.push(RemovedListItem {
                item,
                index: entry.index,
                after: entry.after,
            });
        }
    }
    if prepared.is_empty() {
        return Ok(());
    }
    let known: HashSet<&str> = list.item_ids.iter().map(String::as_str).collect();
    prepared.retain(|entry| !known.contains(entry.item.id.as_str()));
    if list.item_ids.len() + prepared.len() > MAX_LIST_ITEMS {
        return Err(ListError::new(ListErrorKind::ListFull, "List is full."));
    }
    drop(known);
    list.item_ids = restored_list_order(list.item_ids, &prepared);
    for entry in prepared {
        store.set(
            list_item_store_key(list_id, &entry.item.id),
            json!(entry.item),
        );
    }
    store.set(list_meta_key(list_id), json!(list));
    store.save()?;
    Ok(())
}

fn restored_list_order(mut order: Vec<String>, entries: &[RemovedListItem]) -> Vec<String> {
    let mut sorted: Vec<&RemovedListItem> = entries.iter().collect();
    sorted.sort_by_key(|entry| entry.index);
    for entry in sorted {
        let position = entry
            .after
            .as_ref()
            .and_then(|after| order.iter().position(|id| id == after))
            .map_or(entry.index.min(order.len()), |anchor| anchor + 1);
        order.insert(position, entry.item.id.clone());
    }
    order
}

#[command]
pub async fn restore_list_items(
    app: AppHandle,
    list_id: String,
    entries: Vec<RemovedListItem>,
) -> Result<(), ListError> {
    let list_id = normalize_list_id(&list_id).ok_or_else(|| "Invalid list id.".to_string())?;
    run_typed_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;
        restore_list_entries(&store, &list_id, entries)
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

        remove_list_items(&store, &list_id, vec![item_id])?;
        Ok(())
    })
    .await
}

#[command]
pub async fn get_lists(app: AppHandle) -> Result<Vec<UserListWithItems>, ListError> {
    run_typed_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;
        let mut lists = read_lists(&store)?;
        if lists.iter().any(|list| list.rules.is_some()) {
            let statuses_required = lists
                .iter()
                .filter_map(|list| list.rules.as_ref())
                .any(|rules| !rules.statuses.is_empty());
            let (library, statuses) =
                read_smart_list_sources(|file| super::open_store(&app, file), statuses_required)?;
            let library = normalize_smart_list_library(&library);
            for list in &mut lists {
                if let Some(rules) = &list.rules {
                    list.items = smart_list_items(rules, &library, &statuses)
                        .cloned()
                        .collect();
                    list.item_ids = list.items.iter().map(|item| item.id.clone()).collect();
                }
            }
        }
        Ok(lists)
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
        let lists = read_lists_with(
            &store,
            |store, key| {
                let item = store
                    .get_typed::<ListItemIdentity>(key)?
                    .normalized_item()?;
                Some((item.id, ()))
            },
            |list, _| list,
        )?;
        let (library, statuses) = if lists.iter().any(|list| list.rules.is_some()) {
            let statuses_required = lists
                .iter()
                .filter_map(|list| list.rules.as_ref())
                .any(|rules| !rules.statuses.is_empty());
            read_smart_list_sources(|file| super::open_store(&app, file), statuses_required)?
        } else {
            (Vec::new(), HashMap::new())
        };
        let library = normalize_smart_list_library(&library);
        Ok(lists
            .into_iter()
            .map(|list| {
                let (item_count, contains_item) = if let Some(rules) = &list.rules {
                    smart_list_items(rules, &library, &statuses).fold(
                        (0, false),
                        |(count, contains), item| {
                            (count + 1, contains || item_id.as_ref() == Some(&item.id))
                        },
                    )
                } else {
                    (
                        list.item_ids.len(),
                        item_id
                            .as_ref()
                            .is_some_and(|id| list.item_ids.contains(id)),
                    )
                };
                UserListSummary {
                    is_smart: list.rules.is_some(),
                    item_count,
                    contains_item,
                    id: list.id,
                    name: list.name,
                    icon: list.icon,
                }
            })
            .collect())
    })
    .await
}

fn read_smart_list_sources(
    open_store: impl Fn(&str) -> Result<DurableStore, String>,
    statuses_required: bool,
) -> Result<(Vec<MediaItem>, HashMap<String, String>), String> {
    let library = open_store(super::LIBRARY_STORE_FILE)?;
    let mut snapshot = super::store_helpers::read_library_snapshot(&library)?;
    let items = snapshot
        .index
        .iter()
        .filter_map(|id| normalize_media_id(id).and_then(|id| snapshot.items.remove(&id)))
        .collect();
    let statuses = if statuses_required {
        super::store_helpers::read_watch_status_snapshot(&open_store(
            super::WATCH_STATUS_STORE_FILE,
        )?)?
        .items
    } else {
        HashMap::new()
    };
    Ok((items, statuses))
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
            rules: list.rules,
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
        if list.rules.is_some() {
            if list.id != *list_id {
                list.id = list_id.clone();
                store.set(list_meta_key(list_id), json!(list));
                modified = true;
            }
            list.item_ids.clear();
            result.push(build(list, Vec::new()));
            continue;
        }
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
        list.require_manual()?;

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
    use super::super::store_helpers::normalize_library_items;
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
                rules: None,
            }),
        );
        store.save().unwrap();
    }

    #[test]
    fn smart_lists_require_status_reads_only_for_status_rules() {
        let library = test_store();
        let statuses = test_store();
        library
            .store
            .set(super::super::LIBRARY_INDEX_KEY, json!(["a"]));
        library.store.set(
            super::super::store_helpers::library_item_key("a"),
            json!(test_media_item("a", "movie")),
        );
        statuses.store.set(
            super::super::WATCH_STATUS_INDEX_KEY,
            json!({"corrupt": true}),
        );
        let open = |file: &str| match file {
            super::super::LIBRARY_STORE_FILE => Ok(library.store.clone()),
            super::super::WATCH_STATUS_STORE_FILE => Ok(statuses.store.clone()),
            _ => unreachable!(),
        };
        assert_eq!(
            read_smart_list_sources(open, true).unwrap_err(),
            "Invalid watch_status_index index."
        );
        let (items, statuses) = read_smart_list_sources(
            |file| {
                assert_eq!(file, super::super::LIBRARY_STORE_FILE);
                Ok(library.store.clone())
            },
            false,
        )
        .unwrap();
        assert_eq!(items.len(), 1);
        assert!(statuses.is_empty());
        let error = read_smart_list_sources(
            |file| {
                if file == super::super::LIBRARY_STORE_FILE {
                    Ok(library.store.clone())
                } else {
                    Err("Status store unavailable.".into())
                }
            },
            true,
        )
        .unwrap_err();
        assert_eq!(error, "Status store unavailable.");
    }

    #[test]
    fn bulk_list_remove_returns_original_positions_and_undo_restores_order_once() {
        let fixture = test_store();
        let ids = ["a", "b", "c", "d"];
        for id in ids {
            fixture.store.set(
                list_item_store_key("list_a", id),
                json!(test_media_item(id, "movie")),
            );
        }
        seed_list(&fixture.store, ids.map(String::from).to_vec());
        let entries = remove_list_items(
            &fixture.store,
            "list_a",
            vec![" d ".into(), "b".into(), "b".into(), "missing".into()],
        )
        .unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| (entry.item.id.as_str(), entry.index))
                .collect::<Vec<_>>(),
            [("b", 1), ("d", 3)]
        );
        assert_eq!(
            load_list(&fixture.store, "list_a").unwrap().item_ids,
            ["a", "c"]
        );
        assert_eq!(fixture.store.save_count(), 2);
        let wire = serde_json::to_value(&entries).unwrap();
        restore_list_entries(&fixture.store, "list_a", entries).unwrap();
        assert_eq!(load_list(&fixture.store, "list_a").unwrap().item_ids, ids);
        assert_eq!(fixture.store.save_count(), 3);
        restore_list_entries(
            &fixture.store,
            "list_a",
            serde_json::from_value(wire).unwrap(),
        )
        .unwrap();
        assert_eq!(load_list(&fixture.store, "list_a").unwrap().item_ids, ids);
        assert_eq!(fixture.store.save_count(), 3);
    }

    #[test]
    fn list_undo_reanchors_after_reorder_and_falls_back_to_index() {
        let fixture = test_store();
        let ids = ["a", "b", "c", "d"];
        for id in ids {
            fixture.store.set(
                list_item_store_key("list_a", id),
                json!(test_media_item(id, "movie")),
            );
        }
        seed_list(&fixture.store, ids.map(String::from).to_vec());
        let entries =
            remove_list_items(&fixture.store, "list_a", vec!["c".into(), "b".into()]).unwrap();
        let wire = serde_json::to_value(&entries).unwrap();
        assert_eq!(wire[0]["after"], "a");
        assert_eq!(wire[1]["after"], "b");
        seed_list(&fixture.store, vec!["d".into(), "a".into()]);
        restore_list_entries(&fixture.store, "list_a", entries).unwrap();
        assert_eq!(
            load_list(&fixture.store, "list_a").unwrap().item_ids,
            ["d", "a", "b", "c"]
        );
        seed_list(&fixture.store, vec!["x".into(), "y".into()]);
        let legacy: Vec<RemovedListItem> = serde_json::from_value(serde_json::json!([
            { "item": test_media_item("z", "movie"), "index": 1 }
        ]))
        .unwrap();
        restore_list_entries(&fixture.store, "list_a", legacy).unwrap();
        assert_eq!(
            load_list(&fixture.store, "list_a").unwrap().item_ids,
            ["x", "z", "y"]
        );
    }

    #[test]
    fn list_remove_drops_ids_without_item_records_but_returns_only_restorable_entries() {
        let fixture = test_store();
        fixture.store.set(
            list_item_store_key("list_a", "a"),
            json!(test_media_item("a", "movie")),
        );
        seed_list(&fixture.store, vec!["ghost".into(), "a".into()]);
        let entries =
            remove_list_items(&fixture.store, "list_a", vec!["ghost".into(), "a".into()]).unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| (entry.item.id.as_str(), entry.index))
                .collect::<Vec<_>>(),
            [("a", 1)]
        );
        assert!(load_list(&fixture.store, "list_a")
            .unwrap()
            .item_ids
            .is_empty());
    }

    #[test]
    fn bulk_list_remove_rejects_invalid_or_oversized_input_before_mutation() {
        let fixture = test_store();
        fixture.store.set(
            list_item_store_key("list_a", "a"),
            json!(test_media_item("a", "movie")),
        );
        seed_list(&fixture.store, vec!["a".into()]);
        let before = std::fs::read(&fixture.path).unwrap();
        assert!(remove_list_items(&fixture.store, "list_a", Vec::new())
            .unwrap()
            .is_empty());
        assert!(remove_list_items(&fixture.store, "list_a", vec!["a".into(), "".into()]).is_err());
        assert!(remove_list_items(
            &fixture.store,
            "list_a",
            vec!["a".into(); super::super::store_helpers::MAX_BULK_ITEMS + 1]
        )
        .is_err());
        assert_eq!(
            remove_list_items(&fixture.store, "list_missing", vec!["a".into()])
                .unwrap_err()
                .kind,
            ListErrorKind::ListNotFound
        );
        fixture.store.save().unwrap();
        assert_eq!(std::fs::read(&fixture.path).unwrap(), before);
        assert_eq!(fixture.store.save_count(), 1);
    }

    #[test]
    fn list_undo_preserves_new_membership_and_rejects_invalid_positions_atomically() {
        let fixture = test_store();
        fixture.store.set(
            list_item_store_key("list_a", "a"),
            json!(test_media_item("a", "movie")),
        );
        seed_list(&fixture.store, vec!["a".into()]);
        let entry = |id, index| RemovedListItem {
            item: test_media_item(id, "movie"),
            index,
            after: None,
        };
        assert!(restore_list_entries(
            &fixture.store,
            "list_a",
            vec![entry("b", 0), entry("c", MAX_LIST_ITEMS)]
        )
        .is_err());
        assert!(fixture
            .store
            .get(list_item_store_key("list_a", "b"))
            .is_none());
        restore_list_entries(
            &fixture.store,
            "list_a",
            vec![entry("a", 1), entry("b", 0), entry("b", 0)],
        )
        .unwrap();
        assert_eq!(
            load_list(&fixture.store, "list_a").unwrap().item_ids,
            ["b", "a"]
        );
        assert_eq!(fixture.store.save_count(), 2);
        seed_list(
            &fixture.store,
            (0..MAX_LIST_ITEMS)
                .map(|index| format!("id{index}"))
                .collect(),
        );
        let before = std::fs::read(&fixture.path).unwrap();
        assert_eq!(
            restore_list_entries(&fixture.store, "list_a", vec![entry("new", 0)])
                .unwrap_err()
                .kind,
            ListErrorKind::ListFull
        );
        fixture.store.save().unwrap();
        assert_eq!(std::fs::read(&fixture.path).unwrap(), before);
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
        let mut list = load_list(&fixture.store, "list_a").unwrap();
        list.rules = Some(SmartListRules {
            year_from: Some(2020),
            ..Default::default()
        });
        fixture.store.set(list_meta_key("list_a"), json!(list));
        assert_eq!(
            add_list_items(
                &fixture.store,
                "list_a",
                vec![test_media_item("a", "movie")]
            )
            .unwrap_err()
            .kind,
            ListErrorKind::SmartListReadOnly,
        );
        assert_eq!(
            remove_list_items(&fixture.store, "list_a", Vec::new())
                .unwrap_err()
                .kind,
            ListErrorKind::SmartListReadOnly,
        );
        assert_eq!(
            restore_list_entries(&fixture.store, "list_a", Vec::new())
                .unwrap_err()
                .kind,
            ListErrorKind::SmartListReadOnly,
        );
        assert_eq!(fixture.store.save_count(), 1);
    }
}
