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
    list_item_store_key, list_meta_key, load_list, load_lists_order, normalize_list_icon,
    normalize_list_id, normalize_list_name, UserList, UserListWithItems, LISTS_ORDER_KEY,
    MAX_LISTS, MAX_LIST_ITEMS,
};
use super::playback_preferences_commands::{
    read_playback_language_preferences_from_store, sanitize_language_pref,
    write_playback_language_preferences,
};
use super::playback_state::{PlaybackLanguagePreferencesSnapshot, PlaybackStateService};
use super::resume_store::HistoryMergeError;
use super::store_helpers::{
    load_library_index, load_library_map, load_watch_status_index, load_watch_statuses_map,
    normalize_library_item, normalize_watch_status, persist_index_map, LIBRARY_LAYOUT,
    WATCH_STATUS_LAYOUT,
};
use super::watch_status_commands::MAX_WATCH_STATUS_ITEMS;
use super::{
    normalize_media_id, normalize_non_empty, now_unix_millis, run_blocking_op, run_store_op_at,
    streaming_helpers::is_persistable_stream_key, PlaybackLanguagePreferences, WatchProgress,
    BLOCKING_OP_TIMEOUT, LIBRARY_STORE_FILE, LISTS_STORE_FILE, SETTINGS_STORE_FILE,
    WATCH_STATUS_STORE_FILE,
};
use crate::providers::addon_resource::AddonResourceClient;
use crate::providers::addons::AddonTransport;
use crate::providers::{usize_to_u64_saturating, MediaItem};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use tauri::{command, AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Backup imports are untrusted input: reject oversized payloads before
/// parsing/allocating (mirrors the 512 KiB manifest/stream body caps).
pub(super) const MAX_IMPORT_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMPORT_HISTORY: usize = 10_000;
const MAX_IMPORT_LIBRARY: usize = 10_000;
const MAX_IMPORT_LISTS: usize = 500;
const MAX_IMPORT_STATUSES: usize = 10_000;
const MAX_IMPORT_TITLE_LANGUAGES: usize = 10_000;
/// Native dialog selections must still be bounded, absolute `.json` paths.
pub(super) const MAX_BACKUP_PATH_LEN: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupErrorKind {
    InvalidBackup,
    UnsupportedVersion,
    TooLarge,
    CapacityExceeded,
    Failed,
}

#[derive(Debug, Serialize)]
pub struct BackupError {
    pub kind: BackupErrorKind,
    pub message: String,
}

impl BackupError {
    fn new(kind: BackupErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl From<String> for BackupError {
    fn from(message: String) -> Self {
        Self::new(BackupErrorKind::Failed, message)
    }
}

impl From<HistoryMergeError> for BackupError {
    fn from(error: HistoryMergeError) -> Self {
        match error {
            HistoryMergeError::CapacityExceeded(message) => {
                Self::new(BackupErrorKind::CapacityExceeded, message)
            }
            HistoryMergeError::Failed(message) => message.into(),
        }
    }
}

pub(super) fn normalize_backup_path(input: &str) -> Option<String> {
    const JSON_EXTENSION: &[u8; 5] = b".json";
    let trimmed = input.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_BACKUP_PATH_LEN
        || trimmed.contains('\0')
        || !std::path::Path::new(trimmed).is_absolute()
        // Byte-level suffix check — `str` indexing could land mid-codepoint.
        || !trimmed
            .as_bytes()
            .get(trimmed.len().saturating_sub(JSON_EXTENSION.len())..)
            .is_some_and(|suffix| suffix.eq_ignore_ascii_case(JSON_EXTENSION))
    {
        return None;
    }
    Some(trimmed.to_string())
}

pub(super) fn validate_backup_export_path(
    target: &std::path::Path,
    store_path: &std::path::Path,
) -> Result<(), String> {
    let target_parent = target
        .parent()
        .ok_or_else(|| "Export path has no parent directory.".to_string())?;
    let target_parent = std::fs::canonicalize(target_parent).map_err(|error| error.to_string())?;
    let store_parent = store_path
        .parent()
        .ok_or_else(|| "App store path has no parent directory.".to_string())?;
    let store_parent = match std::fs::canonicalize(store_parent) {
        Ok(parent) => parent,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let inside_store = target_parent.ancestors().any(|parent| {
        #[cfg(windows)]
        {
            parent
                .as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(&store_parent.as_os_str().to_string_lossy())
        }
        #[cfg(not(windows))]
        {
            parent == store_parent
        }
    });
    if inside_store {
        return Err("Backup export cannot write inside the app data directory.".to_string());
    }
    Ok(())
}

/// Single size bound for backup payloads in both directions — what export writes
/// must be what import accepts.
pub(super) fn validate_backup_size(len: usize) -> Result<(), BackupError> {
    if len > MAX_IMPORT_BYTES {
        return Err(BackupError::new(
            BackupErrorKind::TooLarge,
            format!(
                "Backup file is too large ({} bytes). Maximum is {} bytes.",
                len, MAX_IMPORT_BYTES
            ),
        ));
    }
    Ok(())
}

#[derive(Default)]
struct BackupWriter {
    bytes: Vec<u8>,
    len: usize,
}

impl std::io::Write for BackupWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.len = self.bytes.len().saturating_add(bytes.len());
        if self.len > MAX_IMPORT_BYTES {
            return Err(std::io::Error::other("Backup file is too large."));
        }
        if self.len > self.bytes.capacity() {
            let capacity = self
                .len
                .max(self.bytes.capacity().saturating_mul(2))
                .min(MAX_IMPORT_BYTES);
            self.bytes.reserve_exact(capacity - self.bytes.len());
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn serialize_backup(export: &impl Serialize) -> Result<String, BackupError> {
    let mut writer = BackupWriter::default();
    if let Err(error) = serde_json::to_writer_pretty(&mut writer, export) {
        validate_backup_size(writer.len)?;
        return Err(error.to_string().into());
    }
    String::from_utf8(writer.bytes).map_err(|error| error.to_string().into())
}

/// Full data snapshot used for backup export.
#[derive(Debug, Serialize)]
pub struct AppDataExport {
    /// Schema version (`1`); `settings` is additive so pre-settings backups still import.
    pub version: u32,
    /// Unix timestamp (milliseconds) when the backup was created.
    pub exported_at: u64,
    pub history: Vec<WatchProgress>,
    pub library: Vec<MediaItem>,
    pub lists: Vec<UserListWithItems>,
    pub watch_statuses: HashMap<String, String>,
    pub settings: AppSettingsExport,
}

/// Addons, preferences, profile, and learned language picks — everything the settings
/// store and per-title language memory hold besides transient update-notification state.
#[derive(Debug, Serialize)]
pub struct AppSettingsExport {
    /// Capability snapshots stripped: restore re-classifies from the manifest.
    pub addon_configs: Vec<AddonConfig>,
    pub app_ui_preferences: AppUiPreferences,
    pub profile_preferences: ProfilePreferences,
    /// Absent until the user touches selector filters — a restore shouldn't mark an untouched selector as configured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_selector_preferences: Option<StreamSelectorPreferences>,
    pub playback_language_preferences: PlaybackLanguagePreferences,
    pub title_language_preferences: BTreeMap<String, PlaybackLanguagePreferencesSnapshot>,
}

/// Restore-side decode view of [`AppDataExport`]: sections arrive as raw `Value`s so one
/// malformed record drops only itself. Envelope fields stay strict — no `version`, no backup.
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
    watch_statuses: BTreeMap<String, Value>,
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
) -> Result<(), BackupError> {
    let mut known: HashSet<&str> = existing.iter().map(String::as_str).collect();
    let existing_count = known.len();
    for id in incoming {
        known.insert(id);
    }
    if known.len() > limit && known.len() > existing_count {
        return Err(BackupError::new(
            BackupErrorKind::CapacityExceeded,
            format!("Backup import would exceed the {domain} limit of {limit}."),
        ));
    }
    Ok(())
}

/// Parses the backup's list section before any store mutation: malformed records skip,
/// readable local lists keep their edits; ghost order entries can be restored in place.
pub(super) fn prepare_import_lists(
    raw_lists: Vec<Value>,
    existing_order: &[String],
    store: &super::DurableStore,
) -> Result<Vec<UserListWithItems>, BackupError> {
    let mut known_ids: HashSet<String> = existing_order
        .iter()
        .filter(|id| load_list(store, id).is_ok())
        .cloned()
        .collect();
    let mut prepared = Vec::with_capacity(raw_lists.len());
    for list in raw_lists {
        let Ok(list) = serde_json::from_value::<UserListWithItems>(list) else {
            continue;
        };
        // Normalize the incoming id once: the skip and preserve checks must agree —
        // a padded id would re-import as a duplicate under a fresh uuid.
        let normalized_id = normalize_non_empty(&list.id);
        if normalized_id
            .as_ref()
            .is_some_and(|id| known_ids.contains(id))
        {
            continue; // list already present — skip to keep user edits
        }
        // Backup names/icons are untrusted: shared ingress rule trims, bounds, and
        // skips empty names so a malformed record drops only itself.
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
            return Err(BackupError::new(
                BackupErrorKind::CapacityExceeded,
                format!(
                    "Backup import would exceed the list item limit of {}.",
                    MAX_LIST_ITEMS
                ),
            ));
        }
        let new_id = normalized_id
            .as_deref()
            .and_then(normalize_list_id)
            .unwrap_or_else(|| format!("list_{}", uuid::Uuid::new_v4().simple()));
        // Repeated invalid backup ids fold into the prepared list after the fresh id.
        if let Some(id) = normalized_id {
            known_ids.insert(id);
        }
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

/// Settings restore replaces preferences and profile, while addons and learned
/// per-title language picks merge — installed addons and device picks are kept.
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
        if let Err(error) =
            super::app_shell_commands::sync_preferences(app, &load_app_ui_preferences(&store))
        {
            crate::operational_log::log_warn(
                "window",
                "import-preferences-tray-sync",
                "failed",
                &[crate::operational_log::field("error", error)],
            );
        }
        store.save()?;
    }

    let titles_imported =
        service.import_title_language_preferences(app, settings.title_language_preferences)?;
    Ok((addons_imported, restored || titles_imported > 0))
}

/// Serialises all persisted user data to pretty-printed JSON for a file download.
/// Internal helper — only the file-path command wrappers call it; not IPC surface.
pub(crate) async fn export_app_data(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
) -> Result<String, BackupError> {
    let deadline = tokio::time::Instant::now() + BLOCKING_OP_TIMEOUT;
    let export = run_store_op_at(deadline, {
        let app = app.clone();
        let service = playback_state.inner().clone();
        move || {
            // Only opaque stream-key identities may leave the app. A failed history read
            // must fail the export — a backup with zero history is only noticed on restore.
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

            let lib_store = super::open_store(&app, LIBRARY_STORE_FILE)?;
            let library: Vec<MediaItem> = load_library_map(&lib_store)?.into_values().collect();

            let lists_store = super::open_store(&app, LISTS_STORE_FILE)?;
            let lists = super::list_commands::read_lists(&lists_store)?;

            let status_store = super::open_store(&app, WATCH_STATUS_STORE_FILE)?;
            let watch_statuses = load_watch_statuses_map(&status_store)?;

            Ok::<_, BackupError>(AppDataExport {
                version: 1,
                exported_at: now_unix_millis(),
                history,
                library,
                lists,
                watch_statuses,
                settings: export_settings(&app, &service)?,
            })
        }
    })
    .await?;
    run_blocking_op(deadline, "Background persistence timed out.", move || {
        Ok(serialize_backup(&export))
    })
    .await?
}

async fn parse_backup(
    deadline: tokio::time::Instant,
    data: String,
) -> Result<AppDataImportPayload, BackupError> {
    validate_backup_size(data.len())?;
    run_blocking_op(deadline, "Background persistence timed out.", move || {
        Ok(parse_backup_payload(&data))
    })
    .await?
}

fn parse_backup_payload(data: &str) -> Result<AppDataImportPayload, BackupError> {
    let export: AppDataImportPayload = serde_json::from_str(data).map_err(|e| {
        BackupError::new(
            BackupErrorKind::InvalidBackup,
            format!("Invalid backup file: {}", e),
        )
    })?;
    if export.history.len() > MAX_IMPORT_HISTORY
        || export.library.len() > MAX_IMPORT_LIBRARY
        || export.lists.len() > MAX_IMPORT_LISTS
        || export.watch_statuses.len() > MAX_IMPORT_STATUSES
        || export.settings.title_language_preferences.len() > MAX_IMPORT_TITLE_LANGUAGES
    {
        return Err(BackupError::new(
            BackupErrorKind::TooLarge,
            "Backup file contains too many records and was rejected.",
        ));
    }
    if export.version != 1 {
        return Err(BackupError::new(
            BackupErrorKind::UnsupportedVersion,
            format!(
                "Unsupported backup version: {}. Only version 1 is supported.",
                export.version
            ),
        ));
    }
    Ok(export)
}

/// Merges an exported JSON backup into the current data stores. Non-destructive:
/// history keeps the newer `last_watched`; library, lists, and watch statuses only
/// add absent ids; settings restore preferences/profile; addons and language picks merge.
/// Internal helper — reached via `import_app_data_from_file`, which owns path validation.
pub(crate) async fn import_app_data(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    data: String,
) -> Result<ImportResult, BackupError> {
    let deadline = tokio::time::Instant::now() + BLOCKING_OP_TIMEOUT;
    let export = parse_backup(deadline, data).await?;
    let service = playback_state.inner().clone();
    let app_owned = app.clone();
    run_store_op_at(deadline, move || {
        let app = &app_owned;
        let result = import_app_data_entries(app, &service, export);
        if result.as_ref().map_or(true, |result| {
            result.addons_imported > 0 || result.settings_restored
        }) {
            // Clear caches at actual completion — a later write can fail after earlier domains changed.
            app.state::<AddonTransport>().clear_cache();
            app.state::<AddonResourceClient>().clear_cache();
            app.state::<super::calendar_commands::CalendarScheduleCache>()
                .clear_cache();
        }
        result
    })
    .await
}

fn prepare_import_watch_statuses(raw_statuses: BTreeMap<String, Value>) -> HashMap<String, String> {
    let mut statuses = HashMap::with_capacity(raw_statuses.len());
    for (id, status) in raw_statuses {
        let Some(clean_id) = normalize_media_id(&id) else {
            continue;
        };
        let Some(clean_status) = status.as_str().and_then(normalize_watch_status) else {
            continue;
        };
        // Canonical keys win; sorted raw keys make the first valid alias deterministic.
        if id == clean_id {
            statuses.insert(clean_id, clean_status);
        } else {
            statuses.entry(clean_id).or_insert(clean_status);
        }
    }
    statuses
}

/// Synchronous backup-merge body. Runs inside `run_store_op_at`.
fn import_app_data_entries(
    app: &AppHandle,
    service: &PlaybackStateService,
    export: AppDataImportPayload,
) -> Result<ImportResult, BackupError> {
    // Preflight before the first mutation: every touched store file must parse and capacities must hold.
    let lib_store = super::open_store(app, LIBRARY_STORE_FILE)?;
    let existing_library_index = load_library_index(&lib_store)?;
    let status_store = super::open_store(app, WATCH_STATUS_STORE_FILE)?;
    let existing_status_index = load_watch_status_index(&status_store)?;
    let lists_store = super::open_store(app, LISTS_STORE_FILE)?;
    let existing_order = load_lists_order(&lists_store)?;
    // `import_settings` reopens these via the registry cache; opening now validates the files first.
    super::open_store(app, SETTINGS_STORE_FILE)?;
    super::open_store(app, super::playback_state::PLAYBACK_STATE_STORE_FILE)?;

    // Normalize incoming records once — they serve both the capacity check and the merge.
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

    let incoming_statuses = prepare_import_watch_statuses(export.watch_statuses);
    validate_import_capacity(
        &existing_status_index,
        incoming_statuses.keys().map(String::as_str),
        MAX_WATCH_STATUS_ITEMS,
        "watch status",
    )?;

    let prepared_lists = prepare_import_lists(export.lists, &existing_order, &lists_store)?;

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
    let history_imported = service.import_history_entries(app, history_entries)?;

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
        if !new_order.contains(&list_id) {
            new_order.push(list_id);
        }
        lists_imported += 1;
    }
    lists_store.set(LISTS_ORDER_KEY, json!(new_order));
    lists_store.save()?;

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

fn backup_file_name() -> String {
    // Convert UTC epoch days to a Gregorian date.
    let days = now_unix_millis() / 86_400_000 + 719_468;
    let era = days / 146_097;
    let day_of_era = days % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = era * 400 + year_of_era + u64::from(month <= 2);
    format!("stremiro-backup-{year:04}-{month:02}-{day:02}.json")
}

/// Exports app data to a native-dialog selection. Atomic: temp file fsynced and renamed
/// over the target, so a crash mid-export can't leave a torn file.
#[command]
pub async fn export_app_data_to_file(
    app: AppHandle,
    window: tauri::Window,
) -> Result<bool, BackupError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("Export Stremiro Backup")
        .set_file_name(backup_file_name())
        .add_filter("JSON", &["json"])
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let Some(path) = receiver.await.map_err(|error| error.to_string())? else {
        return Ok(false);
    };
    let mut path = path.into_path().map_err(|error| error.to_string())?;
    if !path
        .as_os_str()
        .to_string_lossy()
        .as_bytes()
        .last_chunk::<5>()
        .is_some_and(|suffix| suffix.eq_ignore_ascii_case(b".json"))
    {
        path.as_mut_os_string().push(".json");
    }
    let target_path = path
        .to_str()
        .and_then(normalize_backup_path)
        .ok_or_else(|| "Export path must be an absolute .json file path.".to_string())?;
    let payload = export_app_data(app.clone(), app.state::<PlaybackStateService>()).await?;
    let target_path = std::path::PathBuf::from(target_path);
    let store_path = super::durable_store::resolve_store_path(&app, SETTINGS_STORE_FILE)?;
    // File write rides the blocking pool separately so no store lock is held across user-path IO.
    super::run_blocking_op(
        tokio::time::Instant::now() + super::BLOCKING_OP_TIMEOUT,
        "Backup export timed out.",
        move || {
            validate_backup_export_path(&target_path, &store_path)?;
            super::write_atomic_file(&target_path, payload.as_bytes(), false)
        },
    )
    .await?;
    Ok(true)
}

/// Reads backup JSON from a native-dialog selection and imports it.
#[command]
pub async fn import_app_data_from_file(
    app: AppHandle,
    window: tauri::Window,
) -> Result<Option<ImportResult>, BackupError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("Import Stremiro Backup")
        .add_filter("JSON", &["json"])
        .pick_file(move |path| {
            let _ = sender.send(path);
        });
    let Some(path) = receiver.await.map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|error| error.to_string())?;
    let source_path = path
        .to_str()
        .and_then(normalize_backup_path)
        .ok_or_else(|| {
            BackupError::new(
                BackupErrorKind::InvalidBackup,
                "Import path must be an absolute .json file path.",
            )
        })?;
    // File IO must not hold the store gate; capped read avoids TOCTOU/RAM overshoot.
    let data = super::run_blocking_op(
        tokio::time::Instant::now() + super::BLOCKING_OP_TIMEOUT,
        "Backup import timed out.",
        move || Ok(read_backup_file(&source_path)),
    )
    .await??;
    import_app_data(app.clone(), app.state::<PlaybackStateService>(), data)
        .await
        .map(Some)
}

fn read_backup_file(source_path: &str) -> Result<String, BackupError> {
    use std::io::Read as _;
    let limit = usize_to_u64_saturating(MAX_IMPORT_BYTES);
    let file = std::fs::File::open(source_path).map_err(|e| e.to_string())?;
    let mut limited = file.take(limit.saturating_add(1));
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut limited, &mut bytes).map_err(|e| {
        let kind = if e.kind() == std::io::ErrorKind::InvalidData {
            BackupErrorKind::InvalidBackup
        } else {
            BackupErrorKind::Failed
        };
        BackupError::new(kind, e.to_string())
    })?;
    validate_backup_size(bytes.len())?;
    String::from_utf8(bytes).map_err(|_| {
        BackupError::new(
            BackupErrorKind::InvalidBackup,
            "stream did not contain valid UTF-8",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn backup_serialization_preserves_pretty_json_bytes() {
        let value = json!({
            "version": 1,
            "library": [{"title": "映画 🎬", "description": "line\n\"quoted\"\\path"}],
            "settings": {"enabled": true, "optional": null},
        });
        assert_eq!(
            serialize_backup(&value).unwrap(),
            serde_json::to_string_pretty(&value).unwrap()
        );
    }

    #[test]
    fn backup_serialization_accepts_exact_limit_and_rejects_growth() {
        let mut text = "a".repeat(MAX_IMPORT_BYTES - 2);
        let payload = serialize_backup(&text).unwrap();
        assert_eq!(payload.len(), MAX_IMPORT_BYTES);
        assert_eq!(payload, serde_json::to_string_pretty(&text).unwrap());

        text.push('a');
        let error = serialize_backup(&text).unwrap_err();
        let expected = validate_backup_size(MAX_IMPORT_BYTES + 1).unwrap_err();
        assert_eq!(error.kind, expected.kind);
        assert_eq!(error.message, expected.message);
    }

    #[test]
    fn backup_writer_rejects_overflow_without_growing_its_buffer() {
        let mut writer = BackupWriter::default();
        writer.write_all(b"{").unwrap();
        let capacity = writer.bytes.capacity();
        assert!(writer.write_all(&vec![b'x'; MAX_IMPORT_BYTES]).is_err());
        assert_eq!(writer.bytes, b"{");
        assert_eq!(writer.bytes.capacity(), capacity);
        assert_eq!(writer.len, MAX_IMPORT_BYTES + 1);
    }

    #[test]
    fn backup_watch_status_collisions_prefer_canonical_keys_then_first_sorted_valid_alias() {
        for (data, expected) in [
            (
                r#"{"version":1,"watch_statuses":{"tt123":"watching"," tt123 ":"dropped","tt123 ":"watched"}}"#,
                "watching",
            ),
            (
                r#"{"version":1,"watch_statuses":{"tt123 ":"watched"," tt123 ":"dropped","tt123":"watching"}}"#,
                "watching",
            ),
            (
                r#"{"version":1,"watch_statuses":{"tt123 ":"watching"," tt123 ":"dropped"}}"#,
                "dropped",
            ),
            (
                r#"{"version":1,"watch_statuses":{" tt123 ":"dropped","tt123 ":"watching","tt123":null,"  tt123":"invalid"}}"#,
                "dropped",
            ),
        ] {
            let export = parse_backup_payload(data).unwrap();
            assert_eq!(
                prepare_import_watch_statuses(export.watch_statuses),
                HashMap::from([("tt123".to_string(), expected.to_string())]),
                "{data}",
            );
        }
    }

    #[test]
    fn backup_envelope_rejects_each_record_cap_before_version_validation() {
        for (section, limit) in [
            ("history", MAX_IMPORT_HISTORY),
            ("library", MAX_IMPORT_LIBRARY),
            ("lists", MAX_IMPORT_LISTS),
            ("watch_statuses", MAX_IMPORT_STATUSES),
            ("title_language_preferences", MAX_IMPORT_TITLE_LANGUAGES),
        ] {
            let mut value = json!({"version": 2});
            if matches!(section, "watch_statuses" | "title_language_preferences") {
                let records = (0..=limit)
                    .map(|index| (index.to_string(), Value::Null))
                    .collect::<serde_json::Map<_, _>>();
                if section == "title_language_preferences" {
                    value["settings"] = json!({section: records});
                } else {
                    value[section] = records.into();
                }
            } else {
                value[section] = vec![Value::Null; limit + 1].into();
            }
            let error = parse_backup_payload(&value.to_string()).unwrap_err();
            assert_eq!(error.kind, BackupErrorKind::TooLarge, "{section}");
            assert_eq!(
                error.message,
                "Backup file contains too many records and was rejected."
            );
        }
    }

    #[tokio::test]
    async fn backup_envelope_parsing_does_not_wait_for_the_store_gate() {
        let _guard = super::super::STORE_OP_LOCK.lock().await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        assert_eq!(
            parse_backup(deadline, r#"{"version":1}"#.into())
                .await
                .unwrap()
                .version,
            1
        );
        let error = parse_backup(deadline, r#"{"version":2}"#.into())
            .await
            .unwrap_err();
        assert_eq!(error.kind, BackupErrorKind::UnsupportedVersion);
        assert_eq!(
            error.message,
            "Unsupported backup version: 2. Only version 1 is supported."
        );
        let malformed = format!("{}{{", " ".repeat(MAX_IMPORT_BYTES - 1));
        let expected = serde_json::from_str::<AppDataImportPayload>(&malformed).unwrap_err();
        let error = parse_backup(deadline, malformed).await.unwrap_err();
        assert_eq!(error.kind, BackupErrorKind::InvalidBackup);
        assert_eq!(error.message, format!("Invalid backup file: {expected}"));
    }

    #[tokio::test]
    async fn backup_import_store_phase_keeps_the_parsing_deadline() {
        let _guard = super::super::STORE_OP_LOCK.lock().await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(100);
        let export = parse_backup(deadline, r#"{"version":1}"#.into())
            .await
            .unwrap();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let operation = run_store_op_at(deadline, move || {
            let _ = sender.send(export.version);
            Ok::<_, BackupError>(())
        });
        let error = tokio::time::timeout(std::time::Duration::from_secs(1), operation)
            .await
            .expect("the store phase must not start a fresh ten-second budget")
            .unwrap_err();
        assert_eq!(error.kind, BackupErrorKind::Failed);
        assert_eq!(error.message, "Background persistence timed out.");
        assert!(receiver.await.is_err());
    }
}
