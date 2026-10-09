use super::{LIBRARY_STORE_FILE, LISTS_STORE_FILE, SETTINGS_STORE_FILE, WATCH_STATUS_STORE_FILE};
use std::fs;
use tauri::AppHandle;

/// Quarantined `*.corrupt-*` siblings kept per store: a crash loop must not
/// fill AppData, but the newest few stay for forensics.
const MAX_QUARANTINED_STORE_FILES: usize = 3;

/// One-time-per-launch store integrity check: an unparseable store file is
/// renamed aside (recoverable) instead of silently loading as an empty
/// domain and being overwritten on the next save, and stale `.partial-*`
/// temp siblings from an interrupted durable save are removed. Best-effort:
/// filesystem failures are skipped rather than surfaced.
pub(crate) fn validate_startup_stores(app: &AppHandle) {
    for file in [
        SETTINGS_STORE_FILE,
        LIBRARY_STORE_FILE,
        LISTS_STORE_FILE,
        WATCH_STATUS_STORE_FILE,
        super::playback_state::PLAYBACK_STATE_STORE_FILE,
    ] {
        let Ok(path) = super::resolve_store_path(app, file) else {
            continue;
        };
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let partial_prefix = format!("{file_name}.partial-");
        let corrupt_prefix = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(|stem| format!("{stem}.corrupt-"));

        // Sweep durable-save temp leftovers before opening the domain, and
        // bound quarantined corrupt files while the directory listing is
        // already paid for.
        if let Some(parent) = path.parent() {
            if let Ok(entries) = fs::read_dir(parent) {
                let mut quarantined = Vec::new();
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let Some(name) = name.to_str() else { continue };
                    if name.starts_with(&partial_prefix) {
                        let _ = fs::remove_file(entry.path());
                    } else if corrupt_prefix
                        .as_deref()
                        .is_some_and(|prefix| name.starts_with(prefix))
                    {
                        quarantined.push(entry.path());
                    }
                }
                // Millisecond suffixes sort chronologically.
                quarantined.sort();
                for stale in quarantined.iter().take(
                    quarantined
                        .len()
                        .saturating_sub(MAX_QUARANTINED_STORE_FILES),
                ) {
                    let _ = fs::remove_file(stale);
                }
            }
        }

        let Ok(bytes) = fs::read(&path) else {
            continue; // absent or unreadable — the store layer reports the latter.
        };
        let parses =
            serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&bytes).is_ok();
        if !parses {
            let quarantined = path.with_extension(format!("corrupt-{}", super::now_unix_millis()));
            if fs::rename(&path, &quarantined).is_ok() {
                crate::operational_log::log_warn(
                    "startup",
                    "store-file-validate",
                    "quarantined",
                    &[crate::operational_log::field("file", file)],
                );
            }
        }
    }
}
