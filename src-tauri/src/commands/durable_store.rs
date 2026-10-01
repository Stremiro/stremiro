//! App-owned durable JSON stores: shared in-memory maps committed
//! atomically on `save`/exit; file locations and `{key: value}` schema
//! unchanged from the previous plugin backend.

use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

use crate::providers::lock_or_recover;

/// Windows AV/indexer scans and handles opened without delete sharing lock
/// a file for milliseconds and fail fs ops with ACCESS_DENIED or
/// SHARING_VIOLATION — retry briefly instead of failing the command on them.
fn is_transient_fs_lock(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5) | Some(32))
}

fn retry_transient_fs<T>(mut op: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    const MAX_ATTEMPTS: u32 = 8;
    const DELAY: std::time::Duration = std::time::Duration::from_millis(30);
    let mut attempt = 0;
    loop {
        match op() {
            Err(error) if is_transient_fs_lock(&error) && attempt + 1 < MAX_ATTEMPTS => {
                attempt += 1;
                std::thread::sleep(DELAY);
            }
            outcome => return outcome,
        }
    }
}

/// Clears the read-only flag on a store file: Windows `MoveFileEx` cannot
/// replace a read-only destination, so a stale flag fails every save with
/// ACCESS_DENIED. A flag this app never sets is stale state, not intent.
/// The clippy lint guards the Unix world-writable footgun — unreachable on
/// this Windows-only build.
#[allow(clippy::permissions_set_readonly_false)]
fn clear_readonly_flag(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    let mut permissions = metadata.permissions();
    if !permissions.readonly() {
        return false;
    }
    permissions.set_readonly(false);
    std::fs::set_permissions(path, permissions).is_ok()
}

/// Same `BaseDirectory::AppData` file the plugin used — existing installs
/// keep their data. Caller paths are static store file names.
pub(crate) fn resolve_store_path(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    app.path()
        .resolve(file, tauri::path::BaseDirectory::AppData)
        .map_err(|error| error.to_string())
}

/// Opens a store file through the per-app registry — one live map per path.
pub(crate) fn open_store(app: &AppHandle, file: &str) -> Result<DurableStore, String> {
    let path = resolve_store_path(app, file)?;
    app.state::<DurableStoreRegistry>().open_path(path)
}

/// Per-app registry of opened stores — one shared handle per path so
/// mutations and dirty state are visible to every caller.
#[derive(Default)]
pub(crate) struct DurableStoreRegistry {
    stores: Mutex<HashMap<PathBuf, DurableStore>>,
}

impl DurableStoreRegistry {
    /// First open reads the file under the registry lock; a missing file
    /// starts empty, invalid data errors and is never cached so a later
    /// open retries the real disk state.
    fn open_path(&self, path: PathBuf) -> Result<DurableStore, String> {
        let mut stores = lock_or_recover(&self.stores);
        if let Some(store) = stores.get(&path) {
            return Ok(store.clone());
        }
        let store = DurableStore::load(&path)?;
        stores.insert(path, store.clone());
        Ok(store)
    }

    /// Persists every store with unsaved mutations — the exit path's
    /// replacement for the plugin autosave. Every dirty store is attempted.
    pub(crate) fn flush_dirty(&self) -> Result<(), String> {
        let stores: Vec<DurableStore> = lock_or_recover(&self.stores).values().cloned().collect();
        let mut first_error = None;
        for store in stores {
            if let Err(error) = store.save() {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

/// Shared handle to one persisted JSON object; clones share the live map
/// and the dirty flag the exit flush reads.
#[derive(Clone)]
pub(crate) struct DurableStore {
    path: PathBuf,
    data: Arc<Mutex<StoreData>>,
}

struct StoreData {
    entries: HashMap<String, Value>,
    dirty: bool,
}

/// Store files are flat `{key: value}` objects: empty bytes, invalid JSON,
/// and non-object payloads are all rejected — a torn or foreign file never
/// loads as an empty domain.
fn parse_store_bytes(bytes: &[u8], path: &Path) -> Result<HashMap<String, Value>, String> {
    serde_json::from_slice(bytes)
        .map_err(|error| format!("Invalid store file {}: {}", path.display(), error))
}

impl DurableStore {
    fn load(path: &Path) -> Result<Self, String> {
        let entries = match retry_transient_fs(|| std::fs::read(path)) {
            Ok(bytes) => parse_store_bytes(&bytes, path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(error) => return Err(error.to_string()),
        };
        Ok(Self {
            path: path.to_path_buf(),
            data: Arc::new(Mutex::new(StoreData {
                entries,
                dirty: false,
            })),
        })
    }

    pub(crate) fn get(&self, key: impl AsRef<str>) -> Option<Value> {
        lock_or_recover(&self.data)
            .entries
            .get(key.as_ref())
            .cloned()
    }

    pub(crate) fn set(&self, key: impl Into<String>, value: Value) {
        let mut data = lock_or_recover(&self.data);
        let key = key.into();
        if data.entries.get(&key) == Some(&value) {
            return;
        }
        data.entries.insert(key, value);
        data.dirty = true;
    }

    pub(crate) fn delete(&self, key: impl AsRef<str>) -> bool {
        let mut data = lock_or_recover(&self.data);
        if data.entries.remove(key.as_ref()).is_some() {
            data.dirty = true;
            return true;
        }
        false
    }

    pub(crate) fn keys(&self) -> Vec<String> {
        lock_or_recover(&self.data)
            .entries
            .keys()
            .cloned()
            .collect()
    }

    #[cfg(test)]
    fn is_dirty(&self) -> bool {
        lock_or_recover(&self.data).dirty
    }

    /// Atomic commit with the map lock held through serialize+rename;
    /// `dirty` stays set on failure so the exit flush can retry.
    /// A clean store no-ops — no serialize, no IO, no file creation.
    pub(crate) fn save(&self) -> Result<(), String> {
        let mut data = lock_or_recover(&self.data);
        if !data.dirty {
            return Ok(());
        }
        let bytes = serde_json::to_vec_pretty(&data.entries).map_err(|e| e.to_string())?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        write_atomic_file(&self.path, &bytes, true)?;
        data.dirty = false;
        Ok(())
    }
}

/// The one atomic commit for stores and exports: fsync a self-created
/// `.partial-*` sibling, then rename it over the destination. Read-only
/// clearing is for app-owned files; callers own the parent directory.
pub(crate) fn write_atomic_file(
    path: &Path,
    bytes: &[u8],
    clear_readonly_on_denied: bool,
) -> Result<(), String> {
    let temp_path = path.with_file_name(format!(
        "{}.partial-{}-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("store"),
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let mut created = false;
    let write_outcome: std::io::Result<()> = (|| {
        retry_transient_fs(|| {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp_path)
        })
        .inspect(|_| created = true)?;
        // Our temp now: a transient mid-write failure re-opens+truncates it.
        retry_transient_fs(|| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&temp_path)?;
            file.write_all(bytes)?;
            file.sync_all()
        })?;
        // Rename over a read-only destination always fails; the flag clears
        // once for app-owned stores, then lock retries ride out the scan.
        let mut cleared_readonly = false;
        retry_transient_fs(|| match std::fs::rename(&temp_path, path) {
            Err(error)
                if error.raw_os_error() == Some(5)
                    && clear_readonly_on_denied
                    && !cleared_readonly =>
            {
                cleared_readonly = clear_readonly_flag(path);
                Err(error)
            }
            outcome => outcome,
        })
    })();
    if write_outcome.is_err() && created {
        let _ = std::fs::remove_file(&temp_path);
    }
    write_outcome.map_err(|error| error.to_string())?;

    // Best-effort parent fsync so the rename survives power loss; opening a
    // directory fails on Windows — errors are ignored by design there.
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            if let Ok(dir) = std::fs::File::open(parent) {
                let _ = dir.sync_all();
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
