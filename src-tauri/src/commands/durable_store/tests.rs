use super::*;
use serde_json::json;

fn temp_store_path(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "stremiro-store-test-{tag}-{}.json",
        uuid::Uuid::new_v4().simple()
    ))
}

fn partial_leftover_count(path: &Path) -> usize {
    let file_name = path.file_name().unwrap().to_str().unwrap().to_string();
    std::fs::read_dir(path.parent().expect("parent"))
        .expect("read dir")
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&format!("{file_name}.partial-")))
        })
        .count()
}

#[test]
fn registry_shares_one_map_and_save_persists() {
    let path = temp_store_path("shared");
    let registry = DurableStoreRegistry::default();

    let first = registry.open_path(path.clone()).expect("open missing file");
    // A nonexistent file stays absent until an explicit save — opening is
    // not a write.
    assert!(!path.exists());
    let second = registry.open_path(path.clone()).expect("reopen same path");
    assert!(Arc::ptr_eq(&first.data, &second.data));

    first.set("title", json!("Inception"));
    // Both handles see the mutation — the registry holds one live map.
    assert_eq!(second.get("title"), Some(json!("Inception")));

    // `get` clones: mutating the returned value cannot touch stored data.
    first.set("config", json!({ "nested": { "a": 1 } }));
    let mut payload = first.get("config").expect("stored config");
    payload["nested"]["a"] = json!(99);
    assert_eq!(second.get("config"), Some(json!({ "nested": { "a": 1 } })));

    first.save().expect("save");
    // On-disk payload is the flat {key: value} object the plugin wrote.
    let written: serde_json::Map<String, Value> =
        serde_json::from_slice(&std::fs::read(&path).expect("read saved file"))
            .expect("parse saved file");
    assert_eq!(written.get("title"), Some(&json!("Inception")));
    assert_eq!(
        written.get("config"),
        Some(&json!({ "nested": { "a": 1 } }))
    );

    // A fresh registry reloads the saved bytes — persistence, not caching.
    let fresh = DurableStoreRegistry::default();
    let reopened = fresh.open_path(path.clone()).expect("open saved file");
    assert_eq!(reopened.get("title"), Some(json!("Inception")));

    let _ = std::fs::remove_file(&path);
}

#[test]
fn open_path_rejects_invalid_files_without_caching_or_touching() {
    for (tag, bytes) in [
        ("corrupt", b"{not json" as &[u8]),
        ("empty", b"" as &[u8]),
        ("nonobject", b"[1, 2, 3]" as &[u8]),
    ] {
        let path = temp_store_path(tag);
        std::fs::write(&path, bytes).expect("seed file");
        let registry = DurableStoreRegistry::default();

        assert!(registry.open_path(path.clone()).is_err());
        // A rejected open never truncates or rewrites the existing bytes.
        assert_eq!(std::fs::read(&path).expect("read back"), bytes);

        // The failure is not registered: replacing the file loads cleanly
        // from disk on the next open.
        std::fs::write(&path, br#"{"ok": true}"#).expect("replace file");
        let store = registry.open_path(path.clone()).expect("open valid file");
        assert_eq!(store.get("ok"), Some(json!(true)));

        let _ = std::fs::remove_file(&path);
    }
}

#[test]
fn flush_dirty_writes_only_changed_stores() {
    let path_a = temp_store_path("flush-a");
    let path_b = temp_store_path("flush-b");
    let path_c = temp_store_path("flush-c");
    let registry = DurableStoreRegistry::default();
    let store_a = registry.open_path(path_a.clone()).expect("open a");
    let store_b = registry.open_path(path_b.clone()).expect("open b");
    let store_c = registry.open_path(path_c.clone()).expect("open c");

    store_c.save().expect("clean save");
    assert!(!path_c.exists());

    store_a.set("k", json!(1));
    store_b.set("k", json!(2));
    registry.flush_dirty().expect("flush");

    // Both dirty stores persisted; the untouched store never created a file.
    let fresh = DurableStoreRegistry::default();
    assert_eq!(
        fresh.open_path(path_a.clone()).expect("reopen a").get("k"),
        Some(json!(1))
    );
    assert_eq!(
        fresh.open_path(path_b.clone()).expect("reopen b").get("k"),
        Some(json!(2))
    );
    assert!(!path_c.exists());

    assert!(!store_a.is_dirty());
    store_a.set("k", json!(1));
    assert!(!store_a.is_dirty());

    // A same-value set can't clear a pending dirty flag.
    store_a.set("k2", json!(true));
    store_a.set("k2", json!(true));
    assert!(store_a.is_dirty());

    let _ = std::fs::remove_file(&path_a);
    let _ = std::fs::remove_file(&path_b);
}

/// Windows regression: an exclusive-lock reader (AV/indexer semantics via a
/// zero-share handle) must fail the rename without tearing the committed
/// file, and a retry after the handle drops must land cleanly.
#[cfg(windows)]
#[test]
fn save_fails_cleanly_on_locked_destination() {
    use std::io::{Read, Seek, SeekFrom};
    use std::os::windows::fs::OpenOptionsExt;

    let path = temp_store_path("locked");
    let registry = DurableStoreRegistry::default();
    let store = registry.open_path(path.clone()).expect("open");
    store.set("k", json!("baseline"));
    store.save().expect("baseline save");
    let baseline = std::fs::read_to_string(&path).expect("read baseline");

    // A destination held with no sharing rights makes the rename fail the
    // same way a scanner's exclusive window does.
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .expect("hold destination");

    // A clean save never reaches for the locked destination.
    store.set("k", json!("baseline"));
    store.save().expect("clean save under lock");
    assert!(!store.is_dirty());

    store.set("k", json!("updated"));
    assert!(store.save().is_err());
    // The failed save stays dirty so the exit flush can retry it.
    assert!(store.is_dirty());
    // The committed bytes are untouched: the held handle reads the old
    // generation, not a torn fragment.
    let mut reader = &held;
    let mut held_bytes = Vec::new();
    reader
        .read_to_end(&mut held_bytes)
        .expect("read through held handle");
    assert_eq!(held_bytes, baseline.as_bytes());

    // The exit flush attempts every dirty store despite one failure: a
    // sibling in the same registry still persists while the locked store's
    // error propagates and its dirty flag stays set.
    let path_b = temp_store_path("locked-b");
    let store_b = registry.open_path(path_b.clone()).expect("open b");
    store_b.set("k", json!("b-payload"));
    assert!(registry.flush_dirty().is_err());
    let written_b: serde_json::Map<String, Value> =
        serde_json::from_slice(&std::fs::read(&path_b).expect("read flushed b"))
            .expect("parse flushed b");
    assert_eq!(written_b.get("k"), Some(&json!("b-payload")));
    assert!(!store_b.is_dirty());
    assert!(store.is_dirty());
    reader.seek(SeekFrom::Start(0)).expect("rewind held");
    let mut held_bytes = Vec::new();
    reader
        .read_to_end(&mut held_bytes)
        .expect("reread through held handle");
    assert_eq!(held_bytes, baseline.as_bytes());

    drop(held);
    store.save().expect("save after unlock");
    assert!(!store.is_dirty());
    assert_eq!(
        std::fs::read_to_string(&path).expect("read final"),
        baseline.replace("baseline", "updated")
    );

    // No `.partial-*` sibling survived either failure or the final commit.
    assert_eq!(partial_leftover_count(&path), 0);
    assert_eq!(partial_leftover_count(&path_b), 0);

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(&path_b);
}

/// `clear_readonly_on_denied` splits user-owned from app-owned destinations:
/// a user backup keeps its read-only flag (write fails, bytes untouched),
/// an app store clears the stale flag and commits.
#[cfg(windows)]
#[test]
fn write_atomic_file_honors_readonly_flag_only_when_allowed() {
    let path = temp_store_path("readonly");
    std::fs::write(&path, br#"{"k":"old"}"#).expect("baseline");
    let mut permissions = std::fs::metadata(&path).expect("meta").permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&path, permissions).expect("set readonly");

    assert!(write_atomic_file(&path, br#"{"k":"new"}"#, false).is_err());
    assert_eq!(std::fs::read(&path).expect("read"), br#"{"k":"old"}"#);
    assert!(std::fs::metadata(&path)
        .expect("meta")
        .permissions()
        .readonly());
    assert_eq!(partial_leftover_count(&path), 0);

    write_atomic_file(&path, br#"{"k":"new"}"#, true).expect("commit");
    assert_eq!(std::fs::read(&path).expect("read"), br#"{"k":"new"}"#);
    assert!(!std::fs::metadata(&path)
        .expect("meta")
        .permissions()
        .readonly());
    assert_eq!(partial_leftover_count(&path), 0);

    let _ = std::fs::remove_file(&path);
}

/// The lists order index follows the shared strict policy: a corrupt header
/// errors instead of silently loading an empty domain over live `list:*`
/// keys, and reading never dirties the store.
#[test]
fn load_lists_order_rejects_corrupt_header_without_touching_data() {
    use super::super::list_helpers::{list_meta_key, load_lists_order, LISTS_ORDER_KEY};
    let sentinel = json!({ "id": "list_a", "name": "A", "icon": "x", "item_ids": [] });

    // Missing and empty headers are a valid empty domain.
    for (tag, header) in [("absent", None), ("empty", Some(json!([])))] {
        let path = temp_store_path(&format!("lists-{tag}"));
        let store = DurableStoreRegistry::default()
            .open_path(path.clone())
            .expect("open");
        store.set(list_meta_key("list_a"), sentinel.clone());
        if let Some(header) = header {
            store.set(LISTS_ORDER_KEY, header);
        }
        store.save().expect("seed");
        assert_eq!(
            load_lists_order(&store).expect("valid header"),
            Vec::<String>::new()
        );
        let _ = std::fs::remove_file(&path);
    }

    // Whitespace padding and repeats normalize/dedupe in first-seen order.
    let path = temp_store_path("lists-padded");
    let store = DurableStoreRegistry::default()
        .open_path(path.clone())
        .expect("open");
    store.set(
        LISTS_ORDER_KEY,
        json!(["  list_a ", "list_b", "list_a", "   "]),
    );
    store.save().expect("seed");
    assert_eq!(
        load_lists_order(&store).expect("normalized order"),
        vec!["list_a".to_string(), "list_b".to_string()]
    );
    assert!(!store.is_dirty());
    let _ = std::fs::remove_file(&path);

    // Corrupt headers error; the stored bytes and sibling keys stay intact
    // and reads never mark the store dirty.
    for (tag, header) in [
        ("object", json!({ "list_a": true })),
        ("nonstrings", json!([1, 2])),
        ("blank", json!(["  ", ""])),
    ] {
        let path = temp_store_path(&format!("lists-{tag}"));
        let store = DurableStoreRegistry::default()
            .open_path(path.clone())
            .expect("open");
        store.set(list_meta_key("list_a"), sentinel.clone());
        store.set(LISTS_ORDER_KEY, header);
        store.save().expect("seed");
        let seeded = std::fs::read(&path).expect("read seeded");
        assert!(load_lists_order(&store).is_err());
        assert!(!store.is_dirty());
        assert_eq!(store.get(list_meta_key("list_a")), Some(sentinel.clone()));
        assert_eq!(std::fs::read(&path).expect("reread"), seeded);
        let _ = std::fs::remove_file(&path);
    }
}

#[test]
fn retry_transient_fs_retries_lock_errors_only() {
    // Transient Windows locks (AV/indexer): retried until success.
    let mut calls = 0;
    let outcome = retry_transient_fs(|| {
        calls += 1;
        if calls < 3 {
            Err(std::io::Error::from_raw_os_error(5))
        } else {
            Ok("done")
        }
    });
    assert_eq!(outcome.ok(), Some("done"));
    assert_eq!(calls, 3);

    // A non-lock error fails on the first attempt — no pointless retry.
    let mut calls = 0;
    let outcome: Result<(), std::io::Error> = retry_transient_fs(|| {
        calls += 1;
        Err(std::io::Error::from_raw_os_error(2)) // ERROR_FILE_NOT_FOUND
    });
    assert!(outcome.is_err());
    assert_eq!(calls, 1);

    // A lock that never clears exhausts the attempts and returns the error.
    let mut calls = 0;
    let outcome: Result<(), std::io::Error> = retry_transient_fs(|| {
        calls += 1;
        Err(std::io::Error::from_raw_os_error(32)) // ERROR_SHARING_VIOLATION
    });
    assert!(outcome.is_err());
    assert_eq!(calls, 8);
}

#[test]
fn clear_readonly_flag_only_touches_flagged_files() {
    let path = std::env::temp_dir().join(format!(
        "stremiro-readonly-test-{}.txt",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&path, b"x").expect("temp file");

    // Unflagged file: nothing to clear.
    assert!(!clear_readonly_flag(&path));

    let mut permissions = std::fs::metadata(&path).expect("metadata").permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&path, permissions).expect("set readonly");

    assert!(clear_readonly_flag(&path));
    assert!(!std::fs::metadata(&path)
        .expect("metadata")
        .permissions()
        .readonly());

    // Missing file: reports failure instead of panicking.
    let missing = std::env::temp_dir().join("stremiro-readonly-missing.txt");
    assert!(!clear_readonly_flag(&missing));

    let _ = std::fs::remove_file(&path);
}
