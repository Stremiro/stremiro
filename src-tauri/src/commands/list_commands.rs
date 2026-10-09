use super::list_helpers::{
    list_item_store_key, list_meta_key, load_list, load_lists_order, normalize_list_icon,
    normalize_list_id, normalize_list_name, reorder_known_ids, UserList, UserListWithItems,
    LISTS_ORDER_KEY, LIST_ITEM_KEY_PREFIX, MAX_LISTS, MAX_LIST_ITEMS,
};
use super::store_helpers::normalize_library_item;
use super::{normalize_media_id, DurableStore, LISTS_STORE_FILE};
use crate::providers::MediaItem;
use serde_json::json;
use std::collections::HashSet;
use tauri::{command, AppHandle};

#[command]
pub async fn create_list(
    app: AppHandle,
    name: String,
    icon: Option<String>,
) -> Result<UserList, String> {
    // Store file IO is blocking: run the read-modify-write off the async
    // worker, matching the library/history command pattern.
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;

        let name =
            normalize_list_name(&name).ok_or_else(|| "List name is required.".to_string())?;
        let id = format!("list_{}", uuid::Uuid::new_v4().simple());

        let list = UserList {
            id: id.clone(),
            name,
            icon: normalize_list_icon(icon.as_deref()),
            item_ids: Vec::new(),
        };

        let mut order = load_lists_order(&store)?;
        if order.len() >= MAX_LISTS {
            return Err(format!("Too many lists. Maximum is {}.", MAX_LISTS));
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
pub async fn delete_list(app: AppHandle, list_id: String) -> Result<(), String> {
    let list_id = normalize_list_id(&list_id).ok_or_else(|| "Invalid list id.".to_string())?;
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;

        // Validate the order index before the first mutation: a corrupt
        // header must fail without leaving dirty deletes the exit flush
        // would commit.
        let mut order = load_lists_order(&store)?;

        store.delete(list_meta_key(&list_id));

        // Prefix sweep, not meta enumeration: a corrupt meta has no readable
        // item_ids, and ids dropped by an earlier partial write leave item
        // keys the meta no longer lists. The trailing `:` keeps `list_a`
        // from matching `list_ab`'s items.
        let item_prefix = format!("{LIST_ITEM_KEY_PREFIX}{list_id}:");
        let item_keys: Vec<String> = store
            .keys()
            .into_iter()
            .filter(|key| key.starts_with(&item_prefix))
            .collect();
        for key in item_keys {
            store.delete(key);
        }

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
) -> Result<(), String> {
    let list_id = normalize_list_id(&list_id).ok_or_else(|| "Invalid list id.".to_string())?;
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;

        let mut list = load_list(&store, &list_id)?;

        list.name =
            normalize_list_name(&name).ok_or_else(|| "List name is required.".to_string())?;
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
pub async fn add_to_list(app: AppHandle, list_id: String, item: MediaItem) -> Result<(), String> {
    let list_id = normalize_list_id(&list_id).ok_or_else(|| "Invalid list id.".to_string())?;
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;

        let mut list = load_list(&store, &list_id)?;
        let item = normalize_library_item(item).ok_or_else(|| {
            "Invalid media item. Missing required id, title, or type.".to_string()
        })?;

        if !list.item_ids.contains(&item.id) {
            if list.item_ids.len() >= MAX_LIST_ITEMS {
                return Err(format!(
                    "List is full. Maximum is {} items.",
                    MAX_LIST_ITEMS
                ));
            }
            list.item_ids.push(item.id.clone());
            store.set(list_item_store_key(&list_id, &item.id), json!(item));
            store.set(list_meta_key(&list_id), json!(list));
            store.save()?;
        }

        Ok(())
    })
    .await
}

#[command]
pub async fn remove_from_list(
    app: AppHandle,
    list_id: String,
    item_id: String,
) -> Result<(), String> {
    let list_id = normalize_list_id(&list_id).ok_or_else(|| "Invalid list id.".to_string())?;
    let item_id =
        normalize_media_id(&item_id).ok_or_else(|| "Invalid list item id.".to_string())?;
    super::run_blocking_store_op(move || {
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
pub async fn get_lists(app: AppHandle) -> Result<Vec<UserListWithItems>, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;
        read_lists(&store)
    })
    .await
}

pub(super) fn read_lists(store: &DurableStore) -> Result<Vec<UserListWithItems>, String> {
    let order = load_lists_order(store)?;
    let mut result: Vec<UserListWithItems> = Vec::with_capacity(order.len());
    let mut surviving_ids: Vec<String> = Vec::with_capacity(order.len());
    let mut modified = false;

    for list_id in &order {
        let Some(mut list) = store.get_typed::<UserList>(list_meta_key(list_id)) else {
            continue;
        };
        surviving_ids.push(list_id.clone());
        let mut seen = HashSet::with_capacity(list.item_ids.len());
        // Read every original row before repairing keys. Swapped ids must
        // not overwrite an unread row; colliding ids keep the first valid
        // item, matching backup import's dedupe policy.
        let items: Vec<MediaItem> = list
            .item_ids
            .iter()
            .filter_map(|id| store.get_typed::<MediaItem>(list_item_store_key(list_id, id)))
            .filter_map(normalize_library_item)
            .filter(|item| seen.insert(item.id.clone()))
            .collect();
        let cleaned_item_ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
        if cleaned_item_ids != list.item_ids {
            // Delete all old keys before any insert: a later old-key delete
            // could otherwise erase an earlier repaired row.
            for id in &list.item_ids {
                store.delete(list_item_store_key(list_id, id));
            }
            for item in &items {
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

        result.push(UserListWithItems {
            id: list.id,
            name: list.name,
            icon: list.icon,
            item_ids: list.item_ids,
            items,
        });
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
) -> Result<(), String> {
    let list_id = normalize_list_id(&list_id).ok_or_else(|| "Invalid list id.".to_string())?;
    // Payload bound before spawning: the merge is O(n+m) but still allocates
    // per payload element, so reject oversized payloads up front.
    if item_ids.len() > MAX_LIST_ITEMS {
        return Err(format!(
            "Too many list items. Maximum is {}.",
            MAX_LIST_ITEMS
        ));
    }
    super::run_blocking_store_op(move || {
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
pub async fn reorder_lists(app: AppHandle, list_ids: Vec<String>) -> Result<(), String> {
    if list_ids.len() > MAX_LISTS {
        return Err(format!("Too many lists. Maximum is {}.", MAX_LISTS));
    }
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, LISTS_STORE_FILE)?;

        let current_order = load_lists_order(&store)?;
        // The stale-snapshot merge rule lives in `reorder_known_ids`: ids the
        // payload omits are appended in current order instead of being dropped
        // from the only index `get_lists` reads.
        let new_order = reorder_known_ids(&current_order, list_ids);

        store.set(LISTS_ORDER_KEY, json!(new_order));
        store.save()?;

        Ok(())
    })
    .await
}
