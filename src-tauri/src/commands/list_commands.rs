use super::list_helpers::{
    list_item_store_key, list_meta_key, load_lists_order, normalize_list_icon, normalize_list_id,
    normalize_list_name, reorder_known_ids, UserList, UserListWithItems, LISTS_ORDER_KEY,
    LIST_ITEM_KEY_PREFIX, MAX_LISTS, MAX_LIST_ITEMS,
};
use super::store_helpers::normalize_library_item;
use super::{normalize_media_id, LISTS_STORE_FILE};
use crate::providers::MediaItem;
use serde_json::json;
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

        store.set(list_meta_key(&id), json!(list.clone()));
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

        let mut list = store
            .get(list_meta_key(&list_id))
            .and_then(|value| serde_json::from_value::<UserList>(value).ok())
            .ok_or_else(|| "List not found".to_string())?;

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

        let mut list = store
            .get(list_meta_key(&list_id))
            .and_then(|value| serde_json::from_value::<UserList>(value).ok())
            .ok_or_else(|| "List not found".to_string())?;
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

        let mut list = store
            .get(list_meta_key(&list_id))
            .and_then(|value| serde_json::from_value::<UserList>(value).ok())
            .ok_or_else(|| "List not found".to_string())?;

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

        let order = load_lists_order(&store)?;
        let mut result: Vec<UserListWithItems> = Vec::with_capacity(order.len());
        let mut surviving_ids: Vec<String> = Vec::with_capacity(order.len());
        let mut modified = false;

        for list_id in &order {
            if let Some(meta_val) = store.get(list_meta_key(list_id)) {
                if let Ok(list) = serde_json::from_value::<UserList>(meta_val) {
                    surviving_ids.push(list_id.clone());
                    let mut items: Vec<MediaItem> = Vec::with_capacity(list.item_ids.len());
                    let mut cleaned_item_ids: Vec<String> = Vec::with_capacity(list.item_ids.len());

                    for item_id in &list.item_ids {
                        let Some(item_val) = store.get(list_item_store_key(list_id, item_id))
                        else {
                            modified = true;
                            continue;
                        };
                        let Ok(item) = serde_json::from_value::<MediaItem>(item_val) else {
                            modified = true;
                            store.delete(list_item_store_key(list_id, item_id));
                            continue;
                        };
                        let Some(item) = normalize_library_item(item) else {
                            modified = true;
                            store.delete(list_item_store_key(list_id, item_id));
                            continue;
                        };

                        // Re-key drifted rows: the normalized id is the
                        // identity every list op (`add`/`remove`/`reorder`)
                        // addresses, so a raw key that differs would leave
                        // the item un-removable.
                        if item.id != *item_id {
                            modified = true;
                            store.set(list_item_store_key(list_id, &item.id), json!(&item));
                            store.delete(list_item_store_key(list_id, item_id));
                        }

                        cleaned_item_ids.push(item.id.clone());
                        items.push(item);
                    }

                    // The order entry owns the list identity — a meta `id`
                    // that drifted would un-key every list op, so rewrite it
                    // alongside any item-id cleanup.
                    if cleaned_item_ids != list.item_ids || list.id != *list_id {
                        modified = true;
                        let repaired = UserList {
                            id: list_id.clone(),
                            name: list.name.clone(),
                            icon: list.icon.clone(),
                            item_ids: cleaned_item_ids.clone(),
                        };
                        store.set(list_meta_key(list_id), json!(repaired));
                    }

                    result.push(UserListWithItems {
                        id: list_id.clone(),
                        name: list.name,
                        icon: list.icon,
                        item_ids: cleaned_item_ids,
                        items,
                    });
                }
            }
        }

        // Ghost order entries (missing or unparseable meta) never surface in
        // the result — prune them from the index so they stop costing a
        // store probe on every read.
        if surviving_ids.len() != order.len() {
            modified = true;
            store.set(LISTS_ORDER_KEY, json!(surviving_ids));
        }

        if modified {
            store.save()?;
        }

        Ok(result)
    })
    .await
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

        let mut list = store
            .get(list_meta_key(&list_id))
            .and_then(|value| serde_json::from_value::<UserList>(value).ok())
            .ok_or_else(|| "List not found".to_string())?;

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
