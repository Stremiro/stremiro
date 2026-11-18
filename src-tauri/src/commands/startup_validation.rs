use super::{
    LIBRARY_STORE_FILE, LISTS_STORE_FILE, PROFILE_AVATAR_STORE_FILE, SETTINGS_STORE_FILE,
    WATCH_STATUS_STORE_FILE,
};
use std::fs;
use tauri::AppHandle;

/// Quarantined `*.corrupt-*` siblings kept per store: a crash loop must not
/// fill AppData, but the newest few stay for forensics.
const MAX_QUARANTINED_STORE_FILES: usize = 3;

/// Remove crash leftovers without reading stores the current session may never open.
pub(crate) fn sweep_startup_store_files(app: &AppHandle) {
    let mut stores = [
        SETTINGS_STORE_FILE,
        PROFILE_AVATAR_STORE_FILE,
        LIBRARY_STORE_FILE,
        LISTS_STORE_FILE,
        WATCH_STATUS_STORE_FILE,
        super::playback_state::PLAYBACK_STATE_STORE_FILE,
    ]
    .into_iter()
    .filter_map(|file| {
        let path = super::resolve_store_path(app, file).ok()?;
        let file_name = path.file_name()?.to_str()?;
        let partial_prefix = format!("{file_name}.partial-");
        let corrupt_prefix = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(|stem| format!("{stem}.corrupt-"));
        Some((path, partial_prefix, corrupt_prefix, Vec::new()))
    })
    .collect::<Vec<_>>();

    // All stores share AppData; sweep temp siblings in one directory pass.
    let entries = stores
        .first()
        .and_then(|(path, ..)| path.parent())
        .and_then(|parent| fs::read_dir(parent).ok());
    if let Some(entries) = entries {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            for (_, partial_prefix, corrupt_prefix, quarantined) in &mut stores {
                if name.starts_with(partial_prefix.as_str()) {
                    let _ = fs::remove_file(entry.path());
                } else if corrupt_prefix
                    .as_deref()
                    .is_some_and(|prefix| name.starts_with(prefix))
                {
                    quarantined.push(entry.path());
                }
            }
        }
    }

    for (_, _, _, mut quarantined) in stores {
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
