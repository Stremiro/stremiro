use super::config_commands::merge_imported_addon_configs;
use super::config_store::{
    load_addon_configs, load_app_ui_preferences, load_profile_preferences,
    load_stream_selector_preferences_state, parse_app_ui_preferences, parse_profile_preferences,
    parse_stored_addon_configs, parse_stream_selector_preferences,
    save_app_ui_preferences_to_store, save_profile_preferences_to_store,
    save_stream_selector_preferences_to_store, AddonConfig, AppUiPreferences, ProfilePreferences,
    StreamSelectorPreferences,
};
use super::history_helpers::{build_history_key, sanitize_watch_progress};
use super::library_commands::MAX_LIBRARY_ITEMS;
use super::list_helpers::{
    list_item_store_key, list_meta_key, load_lists_order, normalize_list_icon, normalize_list_id,
    normalize_list_name, UserList, UserListWithItems, LISTS_ORDER_KEY, MAX_LISTS, MAX_LIST_ITEMS,
};
use super::playback_preferences_commands::{
    read_playback_language_preferences_from_store, sanitize_language_pref,
    write_playback_language_preferences,
};
use super::playback_state::{PlaybackLanguagePreferencesSnapshot, PlaybackStateService};
use super::store_helpers::{
    load_library_index, load_library_map, load_watch_status_index, load_watch_statuses_map,
    normalize_library_item, normalize_watch_status, persist_index_map, LIBRARY_LAYOUT,
    WATCH_STATUS_LAYOUT,
};
use super::watch_status_commands::MAX_WATCH_STATUS_ITEMS;
use super::{
    normalize_media_id, normalize_non_empty, now_unix_millis, run_blocking_store_op,
    streaming_helpers::is_persistable_stream_key, PlaybackLanguagePreferences, WatchProgress,
    LIBRARY_STORE_FILE, LISTS_STORE_FILE, SETTINGS_STORE_FILE, WATCH_STATUS_STORE_FILE,
};
use crate::providers::addon_resource::AddonResourceClient;
use crate::providers::addons::AddonTransport;
use crate::providers::{usize_to_u64_saturating, MediaItem};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use tauri::{command, AppHandle, Manager, State};

/// Backup imports are untrusted input: reject oversized payloads before parsing
/// or allocating per-record state (mirrors the 512 KiB manifest/stream body caps).
pub(super) const MAX_IMPORT_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMPORT_HISTORY: usize = 10_000;
const MAX_IMPORT_LIBRARY: usize = 10_000;
const MAX_IMPORT_LISTS: usize = 500;
const MAX_IMPORT_STATUSES: usize = 10_000;
const MAX_IMPORT_TITLE_LANGUAGES: usize = 10_000;
/// Backup file paths come from the save/open dialog as absolute `.json`
/// paths. The backend re-checks that contract so direct IPC calls cannot
/// silently turn export/import into arbitrary relative-path file access.
pub(super) const MAX_BACKUP_PATH_LEN: usize = 1024;

pub(super) fn normalize_backup_path(input: &str) -> Option<String> {
    const JSON_EXTENSION: &[u8; 5] = b".json";
    let trimmed = input.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_BACKUP_PATH_LEN
        || trimmed.contains('\0')
        || !std::path::Path::new(trimmed).is_absolute()
        // Byte-level suffix check: a trailing multibyte char cannot alias
        // `.json`, and `str` indexing could land mid-codepoint.
        || !trimmed
            .as_bytes()
            .get(trimmed.len().saturating_sub(JSON_EXTENSION.len())..)
            .is_some_and(|suffix| suffix.eq_ignore_ascii_case(JSON_EXTENSION))
    {
        return None;
    }
    Some(trimmed.to_string())
}

/// Single size bound for backup payloads in both directions: what export
/// writes must be what import accepts, and a too-large snapshot fails before
/// it replaces a destination file.
pub(super) fn validate_backup_size(len: usize) -> Result<(), String> {
    if len > MAX_IMPORT_BYTES {
        return Err(format!(
            "Backup file is too large ({} bytes). Maximum is {} bytes.",
            len, MAX_IMPORT_BYTES
        ));
    }
    Ok(())
}

// ─── Data Backup & Restore ────────────────────────────────────────────────────

/// Full data snapshot used for backup export.
#[derive(Debug, Serialize)]
pub struct AppDataExport {
    /// Schema version; currently `1`. `settings` is an additive section, so
    /// backups written before it existed still import.
    pub version: u32,
    /// Unix timestamp (milliseconds) when the backup was created.
    pub exported_at: u64,
    pub history: Vec<WatchProgress>,
    pub library: Vec<MediaItem>,
    pub lists: Vec<UserListWithItems>,
    pub watch_statuses: HashMap<String, String>,
    pub settings: AppSettingsExport,
}

/// Addons, preferences, profile, and learned language picks — everything the
/// settings store and per-title language memory hold besides transient
/// update-notification state.
#[derive(Debug, Serialize)]
pub struct AppSettingsExport {
    /// Capability snapshots are stripped: restore never trusts them and they
    /// re-classify from the manifest.
    pub addon_configs: Vec<AddonConfig>,
    pub app_ui_preferences: AppUiPreferences,
    pub profile_preferences: ProfilePreferences,
    /// Absent until the user first touches the selector filters, so a restore
    /// doesn't mark an untouched selector as configured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_selector_preferences: Option<StreamSelectorPreferences>,
    pub playback_language_preferences: PlaybackLanguagePreferences,
    pub title_language_preferences: BTreeMap<String, PlaybackLanguagePreferencesSnapshot>,
}

/// Restore-side decode view of [`AppDataExport`]: sections arrive as raw
/// `Value`s so one malformed record drops only itself instead of voiding the
/// whole backup. Envelope fields stay strict — a file without `version` is
/// not a backup.
#[derive(Debug, Deserialize)]
struct AppDataImportPayload {
    version: u32,
    #[serde(default)]
    history: Vec<Value>,
    #[serde(default)]
    library: Vec<Value>,
    #[serde(default)]
    lists: Vec<Value>,
    #[serde(default)]
    watch_statuses: HashMap<String, Value>,
    #[serde(default)]
    settings: AppSettingsImportPayload,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct AppSettingsImportPayload {
    addon_configs: Option<Value>,
    app_ui_preferences: Option<Value>,
    profile_preferences: Option<Value>,
    stream_selector_preferences: Option<Value>,
    playback_language_preferences: Option<Value>,
    title_language_preferences: HashMap<String, Value>,
}

/// Counts of records written during a successful import.
#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub history_imported: usize,
    pub library_imported: usize,
    pub lists_imported: usize,
    pub statuses_imported: usize,
    pub addons_imported: usize,
    /// True when the backup carried preferences that were applied.
    pub settings_restored: bool,
}

/// Live-capacity guard for every import domain: counts unique normalized
/// ids; rejects growth past `limit`, permits no-growth restores over-cap.
pub(super) fn validate_import_capacity<'a>(
    existing: &'a [String],
    incoming: impl IntoIterator<Item = &'a str>,
    limit: usize,
    domain: &str,
) -> Result<(), String> {
    let mut known: HashSet<&str> = existing.iter().map(String::as_str).collect();
    let existing_count = known.len();
    for id in incoming {
        known.insert(id);
    }
    if known.len() > limit && known.len() > existing_count {
        return Err(format!(
            "Backup import would exceed the {domain} limit of {limit}."
        ));
    }
    Ok(())
}

/// Parses the backup's list section once, before any store mutation:
/// malformed records skip, known ids keep the local list, valid unused ids
/// are preserved, the rest get fresh `list_*` ids; live item/list caps apply.
pub(super) fn prepare_import_lists(
    raw_lists: Vec<Value>,
    existing_order: &[String],
) -> Result<Vec<UserListWithItems>, String> {
    let mut known_ids: HashSet<String> = existing_order.iter().cloned().collect();
    let mut prepared = Vec::with_capacity(raw_lists.len());
    for list in raw_lists {
        let Ok(list) = serde_json::from_value::<UserListWithItems>(list) else {
            continue;
        };
        // Normalize the incoming id once: the skip and preserve checks below
        // must agree, otherwise a padded id misses the skip and re-imports
        // as a duplicate under a fresh uuid.
        let normalized_id = normalize_non_empty(&list.id);
        if normalized_id
            .as_ref()
            .is_some_and(|id| known_ids.contains(id))
        {
            continue; // list already present — skip to keep user edits
        }
        // Backup names/icons are untrusted: the shared ingress rule trims,
        // bounds, and skips empty names — a malformed record drops only
        // itself, even when its item payload would breach the cap.
        let Some(import_name) = normalize_list_name(&list.name) else {
            continue;
        };
        let import_icon = normalize_list_icon(Some(list.icon.as_str()));
        // Reuse live add-to-list normalization/dedupe; no truncation.
        let mut valid_items: Vec<MediaItem> = Vec::with_capacity(list.items.len());
        let mut valid_ids: Vec<String> = Vec::with_capacity(list.items.len());
        let mut seen_ids: HashSet<String> = HashSet::with_capacity(list.items.len());
        for item in list.items {
            if let Some(normalized) = normalize_library_item(item) {
                if seen_ids.insert(normalized.id.clone()) {
                    valid_ids.push(normalized.id.clone());
                    valid_items.push(normalized);
                }
            }
        }
        if valid_items.len() > MAX_LIST_ITEMS {
            return Err(format!(
                "Backup import would exceed the list item limit of {}.",
                MAX_LIST_ITEMS
            ));
        }
        let new_id = normalized_id
            // A preserved id must survive the live path's key gate verbatim:
            // an id carrying characters `normalize_list_id` rejects would
            // land under a key delete/rename/reorder can't address.
            .filter(|id| normalize_list_id(id).as_deref() == Some(id.as_str()))
            .filter(|id| !known_ids.contains(id))
            .unwrap_or_else(|| format!("list_{}", uuid::Uuid::new_v4().simple()));
        // Register the assigned id immediately so a repeat of the same
        // backup id folds into the list just prepared instead of importing
        // a second copy under another uuid.
        known_ids.insert(new_id.clone());
        prepared.push(UserListWithItems {
            id: new_id,
            name: import_name,
            icon: import_icon,
            item_ids: valid_ids,
            items: valid_items,
        });
    }
    validate_import_capacity(
        existing_order,
        prepared.iter().map(|list| list.id.as_str()),
        MAX_LISTS,
        "list",
    )?;
    Ok(prepared)
}

fn export_settings(
    app: &AppHandle,
    service: &PlaybackStateService,
) -> Result<AppSettingsExport, String> {
    let store = super::open_store(app, SETTINGS_STORE_FILE)?;
    let (stream_selector_preferences, selector_initialized) =
        load_stream_selector_preferences_state(&store);
    Ok(AppSettingsExport {
        addon_configs: load_addon_configs(&store)
            .into_iter()
            .map(|config| AddonConfig {
                capabilities: None,
                ..config
            })
            .collect(),
        app_ui_preferences: load_app_ui_preferences(&store),
        profile_preferences: load_profile_preferences(&store),
        stream_selector_preferences: selector_initialized.then_some(stream_selector_preferences),
        playback_language_preferences: read_playback_language_preferences_from_store(&store),
        title_language_preferences: service.export_title_language_preferences(app)?,
    })
}

/// Settings restore replaces preferences and profile (a restore is the point
/// of importing them), while addons and learned per-title language picks
/// merge: installed addons and picks made on this device are kept.
fn import_settings(
    app: &AppHandle,
    service: &PlaybackStateService,
    settings: AppSettingsImportPayload,
) -> Result<(usize, bool), String> {
    let store = super::open_store(app, SETTINGS_STORE_FILE)?;
    let mut restored = false;
    if let Some(preferences) = settings
        .app_ui_preferences
        .and_then(parse_app_ui_preferences)
    {
        save_app_ui_preferences_to_store(&store, &preferences);
        restored = true;
    }
    if let Some(preferences) = settings
        .profile_preferences
        .and_then(parse_profile_preferences)
    {
        save_profile_preferences_to_store(&store, &preferences);
        restored = true;
    }
    if let Some(preferences) = settings
        .stream_selector_preferences
        .and_then(parse_stream_selector_preferences)
    {
        save_stream_selector_preferences_to_store(&store, &preferences);
        restored = true;
    }
    if let Some(preferences) = settings
        .playback_language_preferences
        .and_then(|value| serde_json::from_value::<PlaybackLanguagePreferences>(value).ok())
    {
        write_playback_language_preferences(
            &store,
            &PlaybackLanguagePreferences {
                preferred_audio_language: sanitize_language_pref(
                    preferences.preferred_audio_language,
                    false,
                ),
                preferred_subtitle_language: sanitize_language_pref(
                    preferences.preferred_subtitle_language,
                    true,
                ),
            },
        );
        restored = true;
    }
    let addons_imported = settings
        .addon_configs
        .map(|value| merge_imported_addon_configs(&store, parse_stored_addon_configs(value)))
        .unwrap_or(0);
    if restored || addons_imported > 0 {
        store.save()?;
    }

    let titles_imported =
        service.import_title_language_preferences(app, settings.title_language_preferences)?;
    Ok((addons_imported, restored || titles_imported > 0))
}

/// Serialises all persisted user data to a pretty-printed JSON string that the
/// frontend can offer as a file download. Internal helper: the only callers
/// are the file-path command wrappers, so it is not part of the IPC surface.
pub(crate) async fn export_app_data(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
) -> Result<String, String> {
    run_blocking_store_op({
        let app = app.clone();
        let service = playback_state.inner().clone();
        move || {
            // ― history (all individual entries, undeduped) ——————————————————————
            // Only opaque stream-key identities may leave the app.
            // A failed history read must fail the export — silently shipping a
            // backup with zero history is only discovered on restore.
            let history: Vec<WatchProgress> = service
                .load_resume_entries(&app)?
                .into_iter()
                .map(|(_, mut item)| {
                    item.last_stream_key = item
                        .last_stream_key
                        .filter(|key| is_persistable_stream_key(key));
                    item
                })
                .collect();

            // ― library ——————————————————————————————————————————————————————————
            let lib_store = super::open_store(&app, LIBRARY_STORE_FILE)?;
            let library: Vec<MediaItem> = load_library_map(&lib_store)?.into_values().collect();

            // ― custom lists ——————————————————————————————————————————————————————
            let lists_store = super::open_store(&app, LISTS_STORE_FILE)?;
            let order = load_lists_order(&lists_store)?;
            let mut lists: Vec<UserListWithItems> = Vec::with_capacity(order.len());
            for list_id in &order {
                let Some(meta_val) = lists_store.get(list_meta_key(list_id)) else {
                    continue;
                };
                let Ok(list) = serde_json::from_value::<UserList>(meta_val) else {
                    continue;
                };
                let mut items: Vec<MediaItem> = Vec::with_capacity(list.item_ids.len());
                for item_id in &list.item_ids {
                    let Some(item_val) = lists_store.get(list_item_store_key(list_id, item_id))
                    else {
                        continue;
                    };
                    // Exported payloads re-run store
                    // normalization: a tampered store can't leak
                    // unbounded or hostile fields into a backup.
                    if let Some(item) = serde_json::from_value::<MediaItem>(item_val)
                        .ok()
                        .and_then(normalize_library_item)
                    {
                        items.push(item);
                    }
                }
                lists.push(UserListWithItems {
                    id: list.id,
                    name: list.name,
                    icon: list.icon,
                    item_ids: list
                        .item_ids
                        .iter()
                        .filter_map(|id| normalize_media_id(id))
                        .collect(),
                    items,
                });
            }

            // ― watch statuses ————————————————————————————————————————————————————
            let status_store = super::open_store(&app, WATCH_STATUS_STORE_FILE)?;
            let watch_statuses = load_watch_statuses_map(&status_store)?;

            let export = AppDataExport {
                version: 1,
                exported_at: now_unix_millis(),
                history,
                library,
                lists,
                watch_statuses,
                settings: export_settings(&app, &service)?,
            };

            serde_json::to_string_pretty(&export).map_err(|e| e.to_string())
        }
    })
    .await
}

/// Merges a previously exported JSON backup into the current data stores.
///
/// Merge strategy (non-destructive — existing data is never deleted):
/// - **History**: entries with a newer `last_watched` timestamp overwrite older ones.
/// - **Library**: items absent by ID are added; existing items are kept unchanged.
/// - **Lists**: lists whose ID is not present are appended — the incoming ID is
///   kept when valid and unused, otherwise a fresh UUID is assigned.
/// - **Watch statuses**: statuses for IDs not currently recorded are added.
/// - **Settings**: see [`import_settings`] — preferences and profile are
///   restored, addons and learned language picks merge.
///
/// Internal helper: only reached through `import_app_data_from_file`, which
/// owns the IPC-facing path validation and byte cap.
pub(crate) async fn import_app_data(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    data: String,
) -> Result<ImportResult, String> {
    validate_backup_size(data.len())?;

    // Backup parsing plus every store/SQLite merge runs off the async worker:
    // 5 MiB JSON parsing and full-table rewrites must not stall other commands.
    let service = playback_state.inner().clone();
    let app_owned = app.clone();
    let result = run_blocking_store_op(move || {
        let app = &app_owned;
        let export: AppDataImportPayload =
            serde_json::from_str(&data).map_err(|e| format!("Invalid backup file: {}", e))?;

        if export.history.len() > MAX_IMPORT_HISTORY
            || export.library.len() > MAX_IMPORT_LIBRARY
            || export.lists.len() > MAX_IMPORT_LISTS
            || export.watch_statuses.len() > MAX_IMPORT_STATUSES
            || export.settings.title_language_preferences.len() > MAX_IMPORT_TITLE_LANGUAGES
        {
            return Err("Backup file contains too many records and was rejected.".to_string());
        }

        if export.version != 1 {
            return Err(format!(
                "Unsupported backup version: {}. Only version 1 is supported.",
                export.version
            ));
        }

        let result = import_app_data_entries(app, &service, export);
        if result.as_ref().map_or(true, |result| {
            result.addons_imported > 0 || result.settings_restored
        }) {
            // A later write can fail after earlier domains changed. Clear at
            // the actual completion, including work whose caller timed out.
            app.state::<AddonTransport>().clear_cache();
            app.state::<AddonResourceClient>().clear_cache();
        }
        result
    })
    .await?;
    Ok(result)
}

/// Synchronous backup-merge body. Runs inside `run_blocking_store_op`.
fn import_app_data_entries(
    app: &AppHandle,
    service: &PlaybackStateService,
    export: AppDataImportPayload,
) -> Result<ImportResult, String> {
    // Preflight before the first mutation: every touched store file must
    // parse and the live library/status/list capacities must hold.
    let lib_store = super::open_store(app, LIBRARY_STORE_FILE)?;
    let existing_library_index = load_library_index(&lib_store)?;
    let status_store = super::open_store(app, WATCH_STATUS_STORE_FILE)?;
    let existing_status_index = load_watch_status_index(&status_store)?;
    let lists_store = super::open_store(app, LISTS_STORE_FILE)?;
    let existing_order = load_lists_order(&lists_store)?;
    // `import_settings` and the title-language merge reopen these through
    // the registry cache; opening them now just validates their files first.
    super::open_store(app, SETTINGS_STORE_FILE)?;
    super::open_store(app, super::playback_state::PLAYBACK_STATE_STORE_FILE)?;

    // Incoming records normalize once and serve both the capacity check and
    // the merge, so nothing re-parses raw backup values mid-write.
    let incoming_library: Vec<MediaItem> = export
        .library
        .into_iter()
        .filter_map(|item| {
            serde_json::from_value::<MediaItem>(item)
                .ok()
                .and_then(normalize_library_item)
        })
        .collect();
    validate_import_capacity(
        &existing_library_index,
        incoming_library.iter().map(|item| item.id.as_str()),
        MAX_LIBRARY_ITEMS,
        "library",
    )?;

    // Store-key bound, same as the live path: overlong ids are dropped, not
    // truncated, so two hostile ids can't collide onto one key. The first
    // normalized row wins a repeated id, matching the vacant merge below.
    let mut seen_status_ids = HashSet::with_capacity(export.watch_statuses.len());
    let incoming_statuses: Vec<(String, String)> = export
        .watch_statuses
        .into_iter()
        .filter_map(|(id, status)| {
            let clean_id = normalize_media_id(&id)?;
            let clean_status = status.as_str().and_then(normalize_watch_status)?;
            seen_status_ids
                .insert(clean_id.clone())
                .then_some((clean_id, clean_status))
        })
        .collect();
    validate_import_capacity(
        &existing_status_index,
        incoming_statuses.iter().map(|(id, _)| id.as_str()),
        MAX_WATCH_STATUS_ITEMS,
        "watch status",
    )?;

    let prepared_lists = prepare_import_lists(export.lists, &existing_order)?;

    // ― history ——————————————————————————————————————————————————————————
    let mut history_entries = Vec::with_capacity(export.history.len());
    for item in export.history {
        let Some(sanitized) = serde_json::from_value::<WatchProgress>(item)
            .ok()
            .and_then(sanitize_watch_progress)
        else {
            continue;
        };
        let key = build_history_key(
            &sanitized.type_,
            &sanitized.id,
            sanitized.season,
            sanitized.episode,
        );
        history_entries.push((key, sanitized));
    }
    let history_imported = service.merge_history_entries(app, history_entries)?;

    // ― library ——————————————————————————————————————————————————————————
    let mut lib_map = load_library_map(&lib_store)?;
    let mut library_imported = 0usize;
    for normalized in incoming_library {
        if let std::collections::hash_map::Entry::Vacant(entry) =
            lib_map.entry(normalized.id.clone())
        {
            entry.insert(normalized);
            library_imported += 1;
        }
    }

    persist_index_map(
        &lib_store,
        LIBRARY_LAYOUT,
        &existing_library_index,
        &lib_map,
    )?;

    // ― lists ————————————————————————————————————————————————————————————
    let mut new_order = existing_order;
    let mut lists_imported = 0usize;

    for list in prepared_lists {
        let list_id = list.id;
        lists_store.set(
            list_meta_key(&list_id),
            json!(UserList {
                id: list_id.clone(),
                name: list.name,
                icon: list.icon,
                item_ids: list.item_ids,
            }),
        );
        for item in &list.items {
            lists_store.set(list_item_store_key(&list_id, &item.id), json!(item));
        }
        new_order.push(list_id);
        lists_imported += 1;
    }
    lists_store.set(LISTS_ORDER_KEY, json!(new_order));
    lists_store.save()?;

    // ― watch statuses ————————————————————————————————————————————————————
    let mut statuses = load_watch_statuses_map(&status_store)?;
    let mut statuses_imported = 0usize;
    for (clean_id, clean_status) in incoming_statuses {
        if let std::collections::hash_map::Entry::Vacant(entry) = statuses.entry(clean_id) {
            entry.insert(clean_status);
            statuses_imported += 1;
        }
    }

    persist_index_map(
        &status_store,
        WATCH_STATUS_LAYOUT,
        &existing_status_index,
        &statuses,
    )?;

    let (addons_imported, settings_restored) = import_settings(app, service, export.settings)?;

    Ok(ImportResult {
        history_imported,
        library_imported,
        lists_imported,
        statuses_imported,
        addons_imported,
        settings_restored,
    })
}

/// Exports all app data and writes it to the provided path.
///
/// The write is atomic: the payload lands in a sibling temp file that is
/// fsynced and renamed over the target, so a crash mid-export can never
/// leave a torn file where the last good backup was.
#[command]
pub async fn export_app_data_to_file(app: AppHandle, path: String) -> Result<(), String> {
    let target_path = normalize_backup_path(&path)
        .ok_or_else(|| "Export path must be an absolute .json file path.".to_string())?;
    let payload = export_app_data(app.clone(), app.state::<PlaybackStateService>()).await?;
    // Reject before touching the destination: a snapshot this importer could
    // never read back must not replace the last good backup.
    validate_backup_size(payload.len())?;
    let target_path = std::path::PathBuf::from(target_path);
    // The snapshot ran inside `run_blocking_store_op`; the external file
    // write rides the blocking pool on its own so no store lock is held
    // across user-path IO.
    tokio::time::timeout(
        super::BLOCKING_OP_TIMEOUT,
        tauri::async_runtime::spawn_blocking(move || {
            super::write_atomic_file(&target_path, payload.as_bytes(), false)
        }),
    )
    .await
    .map_err(|_| "Backup export timed out.".to_string())?
    .map_err(|error| format!("Background persistence task failed: {}", error))?
}

/// Reads backup JSON from the provided file path and imports it.
#[command]
pub async fn import_app_data_from_file(
    app: AppHandle,
    path: String,
) -> Result<ImportResult, String> {
    let source_path = normalize_backup_path(&path)
        .ok_or_else(|| "Import path must be an absolute .json file path.".to_string())?;
    // Capped blocking read: avoids TOCTOU/RAM overshoot without new dep.
    // `import_app_data` re-checks the length before parsing.
    let data = run_blocking_store_op(move || {
        use std::io::Read as _;
        let limit = usize_to_u64_saturating(MAX_IMPORT_BYTES);
        let file = std::fs::File::open(&source_path).map_err(|e| e.to_string())?;
        let mut limited = file.take(limit.saturating_add(1));
        let mut data = String::new();
        std::io::Read::read_to_string(&mut limited, &mut data).map_err(|e| e.to_string())?;
        validate_backup_size(data.len())?;
        Ok(data)
    })
    .await?;
    import_app_data(app.clone(), app.state::<PlaybackStateService>(), data).await
}
