use super::{
    LIBRARY_STORE_FILE, LISTS_STORE_FILE, PROFILE_AVATAR_STORE_FILE, SETTINGS_STORE_FILE,
    WATCH_STATUS_STORE_FILE,
};
use std::fs;
use std::path::Path;
use tauri::AppHandle;

/// Quarantined `*.corrupt-*` siblings kept per store: a crash loop must not
/// fill AppData, but the newest few stay for forensics.
const MAX_QUARANTINED_STORE_FILES: usize = 3;

const STARTUP_STORE_FILES: &[&str] = &[
    SETTINGS_STORE_FILE,
    PROFILE_AVATAR_STORE_FILE,
    LIBRARY_STORE_FILE,
    LISTS_STORE_FILE,
    WATCH_STATUS_STORE_FILE,
    super::playback_state::PLAYBACK_STATE_STORE_FILE,
];

/// Remove crash leftovers without reading stores the current session may never open.
pub(crate) fn sweep_startup_store_files(app: &AppHandle) {
    let Some(parent) = STARTUP_STORE_FILES
        .first()
        .and_then(|file| super::resolve_store_path(app, file).ok())
        .and_then(|path| path.parent().map(Path::to_path_buf))
    else {
        return;
    };

    sweep_store_directory(&parent, std::process::id());
}

fn sweep_store_directory(parent: &Path, current_pid: u32) {
    let mut stores = STARTUP_STORE_FILES
        .iter()
        .filter_map(|file| {
            let path = Path::new(file);
            let file_name = path.file_name()?.to_str()?;
            let partial_prefix = format!("{file_name}.partial-");
            let own_partial_prefix = format!("{file_name}.partial-{current_pid}-");
            let corrupt_prefix = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .map(|stem| format!("{stem}.corrupt-"));
            Some((
                partial_prefix,
                own_partial_prefix,
                corrupt_prefix,
                Vec::new(),
            ))
        })
        .collect::<Vec<_>>();

    // All stores share AppData; sweep temp siblings in one directory pass.
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            for (partial_prefix, own_partial_prefix, corrupt_prefix, quarantined) in &mut stores {
                if name.starts_with(partial_prefix.as_str()) {
                    // Never delete an atomic write temp file owned by the live process.
                    if !name.starts_with(own_partial_prefix.as_str()) {
                        let _ = fs::remove_file(entry.path());
                    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::TempPath;

    #[test]
    fn sweep_store_directory_preserves_live_pid_partials_and_caps_quarantined_files() {
        let dir = TempPath::dir("startup-sweep");
        fs::create_dir_all(&dir).expect("create temp dir");

        let stale_partial = dir.join("settings.json.partial-999999-1");
        let live_partial = dir.join("settings.json.partial-4242-1");
        let unrelated = dir.join("settings.json");
        fs::write(&stale_partial, b"stale").unwrap();
        fs::write(&live_partial, b"live").unwrap();
        fs::write(&unrelated, b"{}").unwrap();

        let corrupt_files: Vec<_> = (1..=5)
            .map(|idx| {
                let path = dir.join(format!("settings.corrupt-000{idx}.json"));
                fs::write(&path, b"bad").unwrap();
                path
            })
            .collect();

        sweep_store_directory(&dir, 4242);

        assert!(
            !stale_partial.exists(),
            "stale PID partial should be removed"
        );
        assert!(live_partial.exists(), "live PID partial must be preserved");
        assert!(unrelated.exists(), "live store file must be preserved");
        assert!(!corrupt_files[0].exists());
        assert!(!corrupt_files[1].exists());
        assert!(corrupt_files[2].exists());
        assert!(corrupt_files[3].exists());
        assert!(corrupt_files[4].exists());
    }
}
