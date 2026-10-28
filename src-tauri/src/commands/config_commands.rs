pub(crate) use super::addon_registry::schedule_capability_classification;
use super::config_store::{
    addon_display_url, apply_app_ui_preferences_patch, apply_profile_preferences_patch,
    apply_stream_selector_preferences_patch, default_player_keybindings,
    default_stream_selector_preferences, is_pinned_default_addon_url, load_addon_configs,
    load_app_ui_preferences, load_last_notified_app_update_version, load_profile_preferences,
    load_stream_selector_preferences_state, normalize_addon_url, normalize_start_minimized,
    push_recent_search, resolve_addon_configs, save_addon_configs_to_store,
    save_app_ui_preferences_to_store, save_last_notified_app_update_version_to_store,
    save_profile_preferences_to_store, save_stream_selector_preferences_to_store, startup_route,
    AddonConfig, AddonConfigView, AppUiPreferencesPatch, AppUiPreferencesView, ProfilePreferences,
    ProfilePreferencesPatch, StreamSelectorPreferences, StreamSelectorPreferencesPatch,
};
use super::DurableStore;
use crate::providers::addon_manifest::{
    build_configure_url, fetch_addon_manifest_snapshot, snapshot_is_classified,
    snapshot_resource_kinds, AddonCatalogCapability, AddonResourceCapability,
    ADDON_CONFIGURATION_REQUIRED_MESSAGE,
};
use crate::providers::addon_resource::AddonResourceClient;
use crate::providers::addons::AddonTransport;
use crate::providers::{build_provider_http_client, trim_to_max, ADDON_URL_INVALID_MESSAGE};
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;
use std::time::Duration;
use tauri::{command, AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

const ADDON_CLASSIFY_CONCURRENCY: usize = 4;
/// Shared classify pool — reuses keep-alive/TLS sessions across settings opens
/// instead of paying re-handshakes per burst.
static CLASSIFY_CLIENT: LazyLock<reqwest::Client> =
    LazyLock::new(|| build_provider_http_client(Some(ADDON_CLASSIFY_CONCURRENCY)));
static STARTUP_CAPABILITY_REFRESH: AtomicBool = AtomicBool::new(true);
const STARTUP_CAPABILITY_REFRESH_DELAY: Duration = Duration::from_secs(8);
/// Registry and reorder-payload bound, shared with backup import.
const MAX_ADDON_CONFIGS: usize = 32;
/// Bound client-supplied addon identity fields so an oversized IPC payload
/// can't persist unbounded strings.
const MAX_ADDON_FIELD_CHARS: usize = 256;

/// Backup restore: appends addons whose URL isn't installed, under the same
/// normalization and bounds as `update_addon_configs`. Imported capability
/// snapshots are dropped — never trusted outside a server-side fetch — so the
/// classifier re-fetches them. Returns addons added; caller owns `store.save()`.
pub(crate) fn merge_imported_addon_configs(
    store: &DurableStore,
    imported: Vec<AddonConfig>,
) -> usize {
    let mut configs = load_addon_configs(store);
    let before = configs.len();
    for mut config in imported {
        if configs.len() >= MAX_ADDON_CONFIGS {
            break;
        }
        let verdict = validate_installable_addon_reference(&config.url);
        let Some(url) = verdict.normalized_url else {
            continue;
        };
        if configs.iter().any(|existing| existing.url == url) {
            continue;
        }
        config.url = url;
        config.id = trim_to_max(&config.id, MAX_ADDON_FIELD_CHARS).unwrap_or_default();
        config.name = trim_to_max(&config.name, MAX_ADDON_FIELD_CHARS).unwrap_or_default();
        config.capabilities = None;
        configs.push(config);
    }
    if configs.len() == before {
        return 0;
    }
    let configs = resolve_addon_configs(Some(configs));
    let added = configs.len().saturating_sub(before);
    save_addon_configs_to_store(store, &configs);
    added
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSelectorPreferencesState {
    pub preferences: StreamSelectorPreferences,
    pub initialized: bool,
    pub default_preferences: StreamSelectorPreferences,
    pub episode_default_preferences: StreamSelectorPreferences,
}

impl StreamSelectorPreferencesState {
    fn new(preferences: StreamSelectorPreferences, initialized: bool) -> Self {
        Self {
            preferences,
            initialized,
            default_preferences: default_stream_selector_preferences(false),
            episode_default_preferences: default_stream_selector_preferences(true),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapSnapshot {
    pub profile_preferences: ProfilePreferences,
    pub app_ui_preferences: AppUiPreferencesView,
    pub stream_selector_preferences: StreamSelectorPreferencesState,
    pub startup_route: Option<String>,
}

#[command]
pub fn get_default_player_keybindings() -> BTreeMap<String, Vec<String>> {
    default_player_keybindings()
}

#[command]
pub fn bind_player_keybinding(
    overrides: BTreeMap<String, Vec<String>>,
    action: String,
    slot: usize,
    key: Option<String>,
) -> Result<BTreeMap<String, Vec<String>>, String> {
    super::config_store::bind_player_key(overrides, &action, slot, key.as_deref())
}

#[command]
pub async fn get_app_ui_preferences(app: AppHandle) -> Result<AppUiPreferencesView, String> {
    // Settings store file IO is blocking: run every read-modify-write off
    // the async worker, matching the library/history command pattern.
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        let preferences = load_app_ui_preferences(&store);
        super::app_shell_commands::hydrate_preferences(&app, &preferences);
        Ok(AppUiPreferencesView::from_preferences(preferences))
    })
    .await
}

#[command]
pub async fn get_bootstrap_snapshot(app: AppHandle) -> Result<BootstrapSnapshot, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        let avatars = super::open_store(&app, super::PROFILE_AVATAR_STORE_FILE)?;
        let profile_preferences = load_profile_preferences(&store, &avatars);
        let app_ui_preferences = load_app_ui_preferences(&store);
        super::app_shell_commands::hydrate_preferences(&app, &app_ui_preferences);
        let startup_route = startup_route(&app_ui_preferences);
        let (selector_preferences, selector_initialized) =
            load_stream_selector_preferences_state(&store);
        Ok(BootstrapSnapshot {
            profile_preferences,
            app_ui_preferences: AppUiPreferencesView::from_preferences(app_ui_preferences),
            stream_selector_preferences: StreamSelectorPreferencesState::new(
                selector_preferences,
                selector_initialized,
            ),
            startup_route,
        })
    })
    .await
}

#[command]
pub async fn save_app_ui_preferences(
    app: AppHandle,
    patch: AppUiPreferencesPatch,
) -> Result<AppUiPreferencesView, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        let sync_tray = patch.close_to_tray.is_some() || patch.minimize_to_tray.is_some();
        let check_start_minimized = sync_tray || patch.start_minimized.is_some();
        let mut preferences =
            apply_app_ui_preferences_patch(load_app_ui_preferences(&store), patch);
        if check_start_minimized
            && preferences.start_minimized
            && !preferences.close_to_tray
            && !preferences.minimize_to_tray
        {
            // An unreadable OS autostart state must not block saving the other preferences.
            normalize_start_minimized(
                &mut preferences,
                app.autolaunch().is_enabled().unwrap_or(true),
            );
        }

        save_app_ui_preferences_to_store(&store, &preferences);
        if sync_tray {
            // Match the in-memory preference even if saving fails; closing still verifies the tray.
            super::app_shell_commands::sync_preferences(
                &app,
                &preferences,
                "save-preferences-tray-sync",
            );
        }
        store.save()?;

        Ok(AppUiPreferencesView::from_preferences(preferences))
    })
    .await
}

/// Prepends a submitted query to the recent-search list in one store round-trip.
#[command]
pub async fn record_recent_search(
    app: AppHandle,
    query: String,
) -> Result<AppUiPreferencesView, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        let mut preferences = load_app_ui_preferences(&store);
        let previous = preferences.recent_searches.clone();
        push_recent_search(&mut preferences, query);
        if preferences.recent_searches != previous {
            save_app_ui_preferences_to_store(&store, &preferences);
            store.save()?;
        }
        Ok(AppUiPreferencesView::from_preferences(preferences))
    })
    .await
}

pub(crate) async fn get_last_notified_app_update_version(
    app: AppHandle,
) -> Result<Option<String>, String> {
    super::with_store(app, super::SETTINGS_STORE_FILE, |store| {
        Ok(load_last_notified_app_update_version(&store))
    })
    .await
}

#[command]
pub async fn save_last_notified_app_update_version(
    app: AppHandle,
    version: Option<String>,
) -> Result<Option<String>, String> {
    super::with_store(app, super::SETTINGS_STORE_FILE, move |store| {
        save_last_notified_app_update_version_to_store(&store, version);
        store.save()?;

        Ok(load_last_notified_app_update_version(&store))
    })
    .await
}

#[command]
pub async fn get_profile_preferences(app: AppHandle) -> Result<ProfilePreferences, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        let avatars = super::open_store(&app, super::PROFILE_AVATAR_STORE_FILE)?;
        Ok(load_profile_preferences(&store, &avatars))
    })
    .await
}

#[command]
pub async fn save_profile_preferences(
    app: AppHandle,
    patch: ProfilePreferencesPatch,
) -> Result<ProfilePreferences, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        let avatars = super::open_store(&app, super::PROFILE_AVATAR_STORE_FILE)?;
        let preferences =
            apply_profile_preferences_patch(load_profile_preferences(&store, &avatars), patch);

        save_profile_preferences_to_store(&store, &avatars, &preferences)?;
        store.save()?;

        Ok(preferences)
    })
    .await
}

#[command]
pub async fn get_stream_selector_preferences(
    app: AppHandle,
) -> Result<StreamSelectorPreferencesState, String> {
    super::with_store(app, super::SETTINGS_STORE_FILE, |store| {
        let (preferences, initialized) = load_stream_selector_preferences_state(&store);
        Ok(StreamSelectorPreferencesState::new(
            preferences,
            initialized,
        ))
    })
    .await
}

#[command]
pub async fn patch_stream_selector_preferences(
    app: AppHandle,
    patch: StreamSelectorPreferencesPatch,
) -> Result<StreamSelectorPreferencesState, String> {
    super::with_store(app, super::SETTINGS_STORE_FILE, move |store| {
        let (preferences, initialized) = load_stream_selector_preferences_state(&store);
        let preferences = apply_stream_selector_preferences_patch(preferences, initialized, patch);

        save_stream_selector_preferences_to_store(&store, &preferences);
        store.save()?;

        Ok(StreamSelectorPreferencesState::new(preferences, true))
    })
    .await
}

/// Only the add flow's seeded host-placeholder label is replaced by the fetched
/// manifest name — an explicit custom or pinned name is never overwritten.
fn is_host_fallback_name(config: &AddonConfig) -> bool {
    reqwest::Url::parse(&config.url)
        .ok()
        .and_then(|url| {
            url.host_str().map(|host| {
                // JS `URL.host` (the frontend fallback) keeps a non-default
                // port; `host_str` never carries one.
                match url.port() {
                    Some(port) => config.name == host || config.name == format!("{host}:{port}"),
                    None => config.name == host,
                }
            })
        })
        .unwrap_or(false)
}

// New installs must validate before success; background retries retain offline sources.
// Only classified snapshots are kept; the commit-time merge owns the host-name rule.
pub(super) async fn classify_missing_addon_capabilities(
    configs: Vec<AddonConfig>,
    require_valid_manifest: bool,
) -> Result<Vec<AddonConfig>, String> {
    let mut classified = configs;

    let pending: Vec<_> = classified
        .iter()
        .enumerate()
        .filter(|(_, config)| {
            (require_valid_manifest || config.enabled) && config.needs_classification()
        })
        .map(|(index, _)| index)
        .collect();
    let snapshots: Vec<_> = stream::iter(pending)
        .map(|index| {
            let url = &classified[index].url;
            async move {
                let snapshot =
                    fetch_addon_manifest_snapshot(&CLASSIFY_CLIENT, url, require_valid_manifest)
                        .await;
                (index, snapshot)
            }
        })
        .buffer_unordered(ADDON_CLASSIFY_CONCURRENCY)
        .collect()
        .await;

    for (index, snapshot) in snapshots {
        match snapshot {
            Ok(snapshot)
                if require_valid_manifest && snapshot_resource_kinds(&snapshot).is_empty() =>
            {
                return Err(
                    "This addon provides no supported catalogs, metadata, streams, or subtitles."
                        .to_string(),
                )
            }
            Ok(snapshot) if snapshot_is_classified(&snapshot) => {
                classified[index].capabilities = Some(snapshot);
            }
            Err(error) if require_valid_manifest => return Err(error),
            Ok(_) | Err(_) => {}
        }
    }

    Ok(classified)
}

async fn refresh_installed_addon_capabilities(
    mut configs: Vec<AddonConfig>,
    refresh_classified: bool,
) -> Result<Vec<AddonConfig>, String> {
    configs
        .retain(|config| config.enabled && (refresh_classified || config.needs_classification()));
    for config in &mut configs {
        // Clear only the fetch candidates, never the stored offline fallback.
        config.capabilities = None;
    }
    let mut classified = classify_missing_addon_capabilities(configs, false).await?;
    classified.retain(|config| config.capabilities.is_some());
    Ok(classified)
}

pub(super) fn merge_classified_capabilities(
    latest: &mut [AddonConfig],
    classified: Vec<AddonConfig>,
    new_install: bool,
) -> bool {
    let mut snapshots: HashMap<_, _> = classified
        .into_iter()
        .filter_map(|config| {
            config
                .capabilities
                .map(|snapshot| (config.id, (config.url, snapshot)))
        })
        .collect();

    let mut changed = false;
    for config in latest {
        if let Some((url, snapshot)) = snapshots.remove(&config.id) {
            if config.url == url
                && config.capabilities.as_ref() != Some(&snapshot)
                && snapshot_is_classified(&snapshot)
            {
                if new_install && is_host_fallback_name(config) {
                    config.name = snapshot.name.clone();
                }
                config.capabilities = Some(snapshot);
                changed = true;
            }
        }
    }

    changed
}

type CatalogRoutingFacts = Option<(Vec<AddonResourceCapability>, Vec<AddonCatalogCapability>)>;

fn catalog_routing_facts(configs: &[AddonConfig]) -> Vec<CatalogRoutingFacts> {
    configs
        .iter()
        .map(|config| {
            config
                .capabilities
                .as_ref()
                .map(|snapshot| (snapshot.resources.clone(), snapshot.catalogs.clone()))
        })
        .collect()
}

pub(crate) async fn classify_installed_addon_capabilities(app: AppHandle) -> Result<(), String> {
    let fresh = refresh_addon_capabilities(app.clone(), false, &[]).await?;
    if STARTUP_CAPABILITY_REFRESH.swap(false, Ordering::SeqCst) {
        tokio::time::sleep(STARTUP_CAPABILITY_REFRESH_DELAY).await;
        refresh_addon_capabilities(app, true, &fresh).await?;
    }
    Ok(())
}

/// Returns the `(id, url)` identities it just classified so a follow-up pass can skip them.
async fn refresh_addon_capabilities(
    app: AppHandle,
    refresh_classified: bool,
    skip: &[(String, String)],
) -> Result<Vec<(String, String)>, String> {
    let mut current = super::with_store(app.clone(), super::SETTINGS_STORE_FILE, |store| {
        Ok::<_, String>(load_addon_configs(&store))
    })
    .await?;
    current.retain(|config| {
        !skip
            .iter()
            .any(|(id, url)| *id == config.id && *url == config.url)
    });
    let classified = refresh_installed_addon_capabilities(current, refresh_classified).await?;
    if classified.is_empty() {
        return Ok(Vec::new());
    }
    let identities = classified
        .iter()
        .map(|config| (config.id.clone(), config.url.clone()))
        .collect();

    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        let mut latest = load_addon_configs(&store);
        let routing_before = catalog_routing_facts(&latest);
        let changed = merge_classified_capabilities(&mut latest, classified, false);
        if changed {
            save_addon_configs_to_store(&store, &latest);
        }
        store.save()?;
        if changed {
            // Payload: whether catalog routing moved; display-only changes refresh just the addon rows.
            let routing_changed = catalog_routing_facts(&latest) != routing_before;
            let _ = app.emit("app://addon-capabilities-changed", routing_changed);
        }
        Ok(())
    })
    .await?;
    Ok(identities)
}

#[command]
pub async fn get_addon_configs(app: AppHandle) -> Result<Vec<AddonConfigView>, String> {
    // Full load: rows show manifest facts (logo, version, resource kinds) from the snapshots.
    super::with_store(app, super::SETTINGS_STORE_FILE, |store| {
        Ok(load_addon_configs(&store)
            .into_iter()
            .map(AddonConfigView::from_config)
            .collect())
    })
    .await
}

fn load_addon_configure_url(store: &DurableStore, id: &str) -> Result<String, String> {
    let addon = load_addon_configs(store)
        .into_iter()
        .find(|addon| addon.id == id)
        .ok_or_else(|| "Addon not found.".to_string())?;
    if !addon
        .capabilities
        .is_some_and(|snapshot| snapshot.configurable)
    {
        return Err("This addon has no configuration page.".to_string());
    }
    build_configure_url(&addon.url)
}

/// Opened from Rust so the webview's opener scope stays limited to its fixed hosts.
#[command]
pub async fn open_addon_configure_page(app: AppHandle, id: String) -> Result<(), String> {
    let url = super::with_store(app.clone(), super::SETTINGS_STORE_FILE, move |store| {
        load_addon_configure_url(&store, &id)
    })
    .await?;
    // The opener error can echo the URL, which may carry addon credentials.
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "Could not open the addon's configuration page.".to_string())
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonShareLink {
    pub link: String,
    /// A path or query past the host is where addons keep per-user setup such as API keys.
    pub includes_config: bool,
}

fn load_addon_share_link(store: &DurableStore, id: &str) -> Result<AddonShareLink, String> {
    let url = AddonConfig::load_identities(store)
        .into_iter()
        .find(|addon| addon.id == id)
        .map(|addon| addon.url)
        .ok_or_else(|| "Addon not found.".to_string())?;
    let includes_config = reqwest::Url::parse(&url)
        .is_ok_and(|parsed| parsed.path() != "/" || parsed.query().is_some());
    Ok(AddonShareLink {
        link: super::app_links::addon_share_link(&url).unwrap_or(url),
        includes_config,
    })
}

#[command]
pub async fn get_addon_share_link(app: AppHandle, id: String) -> Result<AddonShareLink, String> {
    super::with_store(app, super::SETTINGS_STORE_FILE, move |store| {
        load_addon_share_link(&store, &id)
    })
    .await
}

/// Pasted install URLs are short; anything longer is junk, not an addon.
pub(super) const MAX_ADDON_URL_INPUT_CHARS: usize = 4_096;

/// Add-box verdict, built from the same normalizer the save path stores
/// with, so a URL the UI accepts can't be rejected or duplicated at save.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonUrlInspection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_url: Option<String>,
    #[serde(skip)]
    normalized_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// A `/configure` page, not a manifest: the user must finish setup first.
    pub configure_page: bool,
    /// Name of the installed addon this URL already points at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<String>,
}

fn validate_installable_addon_reference(url: &str) -> AddonUrlInspection {
    if url.chars().nth(MAX_ADDON_URL_INPUT_CHARS).is_some() {
        return AddonUrlInspection {
            error: Some("Addon URL is too long.".to_string()),
            ..AddonUrlInspection::default()
        };
    }
    let normalized_url = match normalize_addon_url(url) {
        Ok(Some(normalized_url)) => normalized_url,
        Ok(None) => return AddonUrlInspection::default(),
        Err(error) => {
            return AddonUrlInspection {
                error: Some(error),
                ..AddonUrlInspection::default()
            }
        }
    };
    let configure_page = reqwest::Url::parse(&normalized_url).is_ok_and(|parsed| {
        parsed
            .path()
            .trim_end_matches('/')
            .rsplit_once('/')
            .is_some_and(|(_, segment)| segment.eq_ignore_ascii_case("configure"))
    });
    AddonUrlInspection {
        display_url: (!configure_page).then(|| addon_display_url(&normalized_url)),
        normalized_url: (!configure_page).then_some(normalized_url),
        error: configure_page.then(|| ADDON_CONFIGURATION_REQUIRED_MESSAGE.to_string()),
        configure_page,
        duplicate_of: None,
    }
}

fn inspect_addon_url_against(url: &str, installed: &[AddonConfig]) -> AddonUrlInspection {
    let mut verdict = validate_installable_addon_reference(url);
    verdict.duplicate_of = verdict.normalized_url.as_ref().and_then(|url| {
        installed
            .iter()
            .find(|addon| &addon.url == url)
            .map(|addon| addon.name.clone())
    });
    verdict
}

#[command]
pub async fn inspect_addon_url(app: AppHandle, url: String) -> Result<AddonUrlInspection, String> {
    super::with_store(app, super::SETTINGS_STORE_FILE, move |store| {
        Ok(inspect_addon_url_against(
            &url,
            &AddonConfig::load_identities(&store),
        ))
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AddonConfigsOp {
    Add { url: String },
    Remove { id: String },
    SetEnabled { id: String, enabled: bool },
    Reorder { ids: Vec<String> },
}

fn apply_addon_configs_op(
    configs: &mut Vec<AddonConfig>,
    op: AddonConfigsOp,
    new_addon_id: &str,
) -> Result<bool, String> {
    Ok(match op {
        AddonConfigsOp::Add { url } => {
            let verdict = inspect_addon_url_against(&url, configs);
            if let Some(error) = verdict.error {
                return Err(error);
            }
            let url = verdict
                .normalized_url
                .ok_or_else(|| ADDON_URL_INVALID_MESSAGE.to_string())?;
            if let Some(name) = verdict.duplicate_of {
                return Err(format!("This addon URL is already configured as {name}."));
            }
            if configs.len() >= MAX_ADDON_CONFIGS {
                return Err(format!(
                    "Too many addon configs. Maximum is {MAX_ADDON_CONFIGS}."
                ));
            }
            configs.push(AddonConfig {
                id: new_addon_id.to_string(),
                url,
                name: String::new(),
                enabled: true,
                capabilities: None,
            });
            *configs = resolve_addon_configs(Some(std::mem::take(configs)));
            true
        }
        AddonConfigsOp::Remove { id } => {
            let before = configs.len();
            configs.retain(|config| config.id != id || is_pinned_default_addon_url(&config.url));
            configs.len() != before
        }
        AddonConfigsOp::SetEnabled { id, enabled } => {
            let Some(config) = configs.iter_mut().find(|config| config.id == id) else {
                return Ok(false);
            };
            std::mem::replace(&mut config.enabled, enabled) != enabled
        }
        AddonConfigsOp::Reorder { ids } => {
            if ids.len() > MAX_ADDON_CONFIGS {
                return Err(format!(
                    "Too many addon ids. Maximum is {MAX_ADDON_CONFIGS}."
                ));
            }
            let current = configs
                .iter()
                .filter(|config| !is_pinned_default_addon_url(&config.url))
                .map(|config| config.id.clone())
                .collect::<Vec<_>>();
            let reordered = super::list_helpers::reorder_known_ids(&current, ids);
            if reordered == current {
                return Ok(false);
            }
            let (pinned, user): (Vec<_>, Vec<_>) = std::mem::take(configs)
                .into_iter()
                .partition(|config| is_pinned_default_addon_url(&config.url));
            let mut by_id: HashMap<_, _> = user
                .into_iter()
                .map(|config| (config.id.clone(), config))
                .collect();
            *configs = pinned;
            configs.extend(reordered.into_iter().filter_map(|id| by_id.remove(&id)));
            true
        }
    })
}

pub(super) fn clear_addon_caches(app: &AppHandle) {
    app.state::<AddonTransport>().clear_cache();
    app.state::<AddonResourceClient>().clear_cache();
    app.state::<super::calendar_commands::CalendarScheduleCache>()
        .clear_cache();
}

fn persist_addon_configs(
    store: &DurableStore,
    updated: &[AddonConfig],
    changed: bool,
    invalidate: impl FnOnce(),
) -> Result<(), String> {
    if changed {
        save_addon_configs_to_store(store, updated);
    }
    let result = store.save();
    if changed {
        invalidate();
    }
    result
}

#[command]
pub async fn update_addon_configs(
    app: AppHandle,
    op: AddonConfigsOp,
) -> Result<Vec<AddonConfigView>, String> {
    let new_addon_id = if matches!(op, AddonConfigsOp::Add { .. }) {
        format!("addon-{}", uuid::Uuid::new_v4())
    } else {
        String::new()
    };
    let classified = if matches!(op, AddonConfigsOp::Add { .. }) {
        let candidate = super::with_store(app.clone(), super::SETTINGS_STORE_FILE, {
            let op = op.clone();
            let new_addon_id = new_addon_id.clone();
            move |store| {
                let mut updated = load_addon_configs(&store);
                apply_addon_configs_op(&mut updated, op, &new_addon_id)?;
                Ok::<_, String>(updated.pop().into_iter().collect())
            }
        })
        .await?;
        classify_missing_addon_capabilities(candidate, true).await?
    } else {
        Vec::new()
    };

    // Manifest IO stays off the store gate; only the delta is reapplied at commit.
    let updated = super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        let mut updated = load_addon_configs(&store);
        let mut changed = apply_addon_configs_op(&mut updated, op, &new_addon_id)?;
        changed |= merge_classified_capabilities(&mut updated, classified, true);
        persist_addon_configs(&store, &updated, changed, || {
            // The live registry changed even if saving fails or its caller timed out.
            clear_addon_caches(&app)
        })?;
        Ok::<_, String>(updated)
    })
    .await?;
    Ok(updated
        .into_iter()
        .map(AddonConfigView::from_config)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::test_addon;

    fn installed() -> Vec<AddonConfig> {
        resolve_addon_configs(Some(
            ["a", "b", "c"]
                .into_iter()
                .map(|id| AddonConfig {
                    url: format!("https://addon.example/{id}"),
                    ..test_addon(id, id)
                })
                .collect(),
        ))
    }

    #[test]
    fn addon_share_links_read_installed_ids_and_flag_config() {
        let fixture = crate::test_helpers::test_store();
        save_addon_configs_to_store(
            &fixture.store,
            &[
                AddonConfig {
                    url: "https://addon.example/config?token=private".to_string(),
                    enabled: false,
                    ..test_addon("private", "Private addon")
                },
                AddonConfig {
                    url: "https://public.example".to_string(),
                    ..test_addon("public", "Public addon")
                },
                AddonConfig {
                    url: "http://127.0.0.1:7000".to_string(),
                    ..test_addon("local", "Local addon")
                },
            ],
        );

        let share = |id| load_addon_share_link(&fixture.store, id).unwrap();
        assert_eq!(
            share("private"),
            AddonShareLink {
                link: "stremiro://addon.example/config/manifest.json?token=private".to_string(),
                includes_config: true,
            }
        );
        assert_eq!(
            share("public"),
            AddonShareLink {
                link: "stremiro://public.example/manifest.json".to_string(),
                includes_config: false,
            }
        );
        assert_eq!(share("local").link, "http://127.0.0.1:7000");
        assert_eq!(
            load_addon_share_link(&fixture.store, "missing").unwrap_err(),
            "Addon not found."
        );
    }

    #[test]
    fn configure_url_requires_a_configurable_installed_addon() {
        let fixture = crate::test_helpers::test_store();
        let snapshot = |configurable| {
            Some(crate::providers::addon_manifest::AddonManifest {
                configurable,
                ..crate::test_helpers::cinemeta_manifest()
            })
        };
        save_addon_configs_to_store(
            &fixture.store,
            &[
                AddonConfig {
                    url: "https://addon.example/abc?key=1".to_string(),
                    capabilities: snapshot(true),
                    ..test_addon("configurable", "Configurable")
                },
                AddonConfig {
                    url: "https://addon.example/plain".to_string(),
                    capabilities: snapshot(false),
                    ..test_addon("plain", "Plain")
                },
                AddonConfig {
                    url: "https://addon.example/unclassified".to_string(),
                    ..test_addon("unclassified", "Unclassified")
                },
            ],
        );

        for (id, expected) in [
            (
                "configurable",
                Ok("https://addon.example/abc/configure?key=1"),
            ),
            ("plain", Err("This addon has no configuration page.")),
            ("unclassified", Err("This addon has no configuration page.")),
            ("missing", Err("Addon not found.")),
        ] {
            assert_eq!(
                load_addon_configure_url(&fixture.store, id).as_deref(),
                expected.map_err(str::to_string).as_deref(),
                "{id}"
            );
        }
    }

    #[test]
    fn addon_add_rejects_normalized_duplicates_and_invalid_install_urls() {
        for url in [
            "stremiro://addon.example/a/manifest.json/",
            "https://addon.example/configure",
            "ftp://addon.example",
            "",
        ] {
            assert!(apply_addon_configs_op(
                &mut installed(),
                AddonConfigsOp::Add { url: url.into() },
                "new"
            )
            .is_err());
        }
    }

    #[tokio::test]
    async fn new_install_requires_usable_resources_but_background_classification_does_not() {
        for (manifest, usable) in [
            (r#"{"name":"Empty","resources":["stream"]}"#, false),
            (
                r#"{"name":"Empty","resources":["catalog"],"types":["movie"]}"#,
                false,
            ),
            (crate::test_helpers::cinemeta_manifest_json(), true),
            (
                r#"{"name":"Streams","resources":["stream"],"types":["movie","series"]}"#,
                true,
            ),
            (
                r#"{"name":"OpenSubtitles","resources":["subtitles"],"types":["movie","series"]}"#,
                true,
            ),
        ] {
            let server = crate::test_helpers::TestHttpServer::new(vec![(200, manifest, None); 2]);
            let addon = AddonConfig {
                url: server.url.clone(),
                ..test_addon("candidate", "Candidate")
            };
            let result = classify_missing_addon_capabilities(vec![addon.clone()], true).await;
            if usable {
                assert!(result.is_ok(), "{manifest}: {result:?}");
            } else {
                assert_eq!(
                    result.unwrap_err(),
                    "This addon provides no supported catalogs, metadata, streams, or subtitles."
                );
            }
            assert!(classify_missing_addon_capabilities(vec![addon], false)
                .await
                .is_ok());
            assert_eq!(server.finish(), vec!["/manifest.json"; 2]);
        }
    }

    #[test]
    fn addon_remove_and_toggle_target_ids_and_preserve_pinned_defaults() {
        let current = installed();
        let pinned_id = current[0].id.clone();
        let mut latest = current.clone();
        for id in [pinned_id.clone(), "b".into()] {
            assert!(apply_addon_configs_op(
                &mut latest,
                AddonConfigsOp::SetEnabled { id, enabled: false },
                "",
            )
            .unwrap());
        }
        assert!(!latest[0].enabled);
        assert!(
            !latest
                .iter()
                .find(|config| config.id == "b")
                .unwrap()
                .enabled
        );
        assert!(
            !apply_addon_configs_op(&mut latest, AddonConfigsOp::Remove { id: pinned_id }, "")
                .unwrap()
        );
        assert_eq!(latest.len(), current.len());
        assert!(
            apply_addon_configs_op(&mut latest, AddonConfigsOp::Remove { id: "b".into() }, "")
                .unwrap()
        );
        assert!(!latest.iter().any(|config| config.id == "b"));
        assert!(!latest[0].enabled);
    }

    #[test]
    fn addon_reorder_keeps_pinned_first_and_appends_missing_ids() {
        let current = installed();
        let mut expected: Vec<_> = current.iter().map(|config| config.id.clone()).collect();
        expected[2..].rotate_right(1);
        let mut reordered = current.clone();
        assert!(apply_addon_configs_op(
            &mut reordered,
            AddonConfigsOp::Reorder {
                ids: vec![
                    "unknown".into(),
                    current[0].id.clone(),
                    "c".into(),
                    "c".into(),
                ],
            },
            "",
        )
        .unwrap());
        assert_eq!(
            reordered
                .iter()
                .map(|config| config.id.clone())
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(&reordered[..2], &current[..2]);
    }

    #[test]
    fn addon_add_on_latest_preserves_concurrent_toggle_and_remove() {
        let mut latest = installed();
        assert!(apply_addon_configs_op(
            &mut latest,
            AddonConfigsOp::SetEnabled {
                id: "a".into(),
                enabled: false,
            },
            "",
        )
        .unwrap());
        assert!(
            apply_addon_configs_op(&mut latest, AddonConfigsOp::Remove { id: "b".into() }, "")
                .unwrap()
        );
        let mut updated = latest.clone();
        assert!(apply_addon_configs_op(
            &mut updated,
            AddonConfigsOp::Add {
                url: "stremiro://new.example/manifest.json/".into(),
            },
            "new",
        )
        .unwrap());
        assert_eq!(&updated[..latest.len()], latest.as_slice());
        let added = updated.last().unwrap();
        assert_eq!(
            (&*added.id, &*added.url, &*added.name),
            ("new", "https://new.example", "new.example")
        );
        assert!(added.enabled);
        assert!(added.capabilities.is_none());
    }

    #[test]
    fn addon_mutation_noops_preserve_the_latest_snapshot() {
        let current = installed();
        for op in [
            AddonConfigsOp::Remove {
                id: "missing".into(),
            },
            AddonConfigsOp::SetEnabled {
                id: "a".into(),
                enabled: true,
            },
            AddonConfigsOp::SetEnabled {
                id: "missing".into(),
                enabled: false,
            },
            AddonConfigsOp::Reorder {
                ids: vec!["unknown".into()],
            },
        ] {
            let mut updated = current.clone();
            assert!(!apply_addon_configs_op(&mut updated, op, "").unwrap());
            assert_eq!(updated, current);
        }
        let op: AddonConfigsOp =
            serde_json::from_str(r#"{"kind":"setEnabled","id":"a","enabled":false}"#).unwrap();
        assert!(matches!(
            op,
            AddonConfigsOp::SetEnabled { enabled: false, .. }
        ));
    }

    #[test]
    fn addon_mutation_invalidates_after_failed_save_and_retries_unchanged_data() {
        use std::os::windows::fs::OpenOptionsExt;

        let fixture = crate::test_helpers::test_store();
        let latest = installed();
        save_addon_configs_to_store(&fixture.store, &latest);
        fixture.store.save().unwrap();
        let mut updated = latest.clone();
        let changed = apply_addon_configs_op(
            &mut updated,
            AddonConfigsOp::SetEnabled {
                id: "a".into(),
                enabled: false,
            },
            "",
        )
        .unwrap();
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&fixture.path)
            .unwrap();
        let invalidations = std::cell::Cell::new(0);
        let invalidate = || invalidations.set(invalidations.get() + 1);

        let error =
            persist_addon_configs(&fixture.store, &updated, changed, invalidate).unwrap_err();
        assert_eq!(load_addon_configs(&fixture.store), updated);
        assert_eq!(invalidations.get(), 1);
        assert_eq!(
            persist_addon_configs(&fixture.store, &updated, false, invalidate).unwrap_err(),
            error
        );
        assert_eq!(invalidations.get(), 1);

        drop(held);
        persist_addon_configs(&fixture.store, &updated, false, invalidate).unwrap();
        assert_eq!(invalidations.get(), 1);
        assert_eq!(fixture.store.save_count(), 2);
        let reopened = super::super::DurableStoreRegistry::default()
            .open_path(fixture.path.clone())
            .unwrap();
        assert_eq!(load_addon_configs(&reopened), updated);

        let changed = apply_addon_configs_op(
            &mut updated,
            AddonConfigsOp::SetEnabled {
                id: "a".into(),
                enabled: true,
            },
            "",
        )
        .unwrap();
        assert_eq!(updated, latest);
        persist_addon_configs(&fixture.store, &updated, changed, invalidate).unwrap();
        assert_eq!(invalidations.get(), 2);
    }

    #[test]
    fn refreshed_capabilities_merge_only_changed_matching_instances() {
        let old = crate::test_helpers::classified_cinemeta_addon();
        let mut fetched = old.clone();
        fetched.capabilities.as_mut().unwrap().resources[0].id_prefixes = vec!["kitsu:".into()];
        let mut latest = vec![
            test_addon("other", "Other"),
            AddonConfig {
                enabled: false,
                name: "v3-cinemeta.strem.io".into(),
                ..old.clone()
            },
        ];
        let mut expected = latest.clone();
        expected[1].capabilities = fetched.capabilities.clone();
        assert!(merge_classified_capabilities(
            &mut latest,
            vec![fetched.clone()],
            false
        ));
        assert_eq!(latest, expected);
        assert!(!merge_classified_capabilities(
            &mut latest,
            vec![fetched.clone()],
            false
        ));
        for unmatched in [
            Vec::new(),
            vec![AddonConfig {
                id: "reinstalled".into(),
                ..old.clone()
            }],
            vec![AddonConfig {
                url: "https://changed.example".into(),
                ..old
            }],
        ] {
            let mut latest = unmatched.clone();
            assert!(!merge_classified_capabilities(
                &mut latest,
                vec![fetched.clone()],
                false
            ));
            assert_eq!(latest, unmatched);
        }
    }

    #[test]
    fn catalog_routing_facts_ignore_display_only_manifest_changes() {
        let old = AddonConfig {
            capabilities: Some(crate::test_helpers::cinemeta_manifest()),
            ..test_addon("cinemeta", "Cinemeta")
        };
        let mut cosmetic = old.clone();
        let snapshot = cosmetic.capabilities.as_mut().unwrap();
        snapshot.version = Some("9.9.9".into());
        snapshot.logo = Some("https://cdn.example/logo.png".into());
        snapshot.description = Some("New copy".into());
        assert_eq!(
            catalog_routing_facts(std::slice::from_ref(&old)),
            catalog_routing_facts(&[cosmetic])
        );
        let mut routed = old.clone();
        routed.capabilities.as_mut().unwrap().catalogs.clear();
        assert_ne!(
            catalog_routing_facts(&[old]),
            catalog_routing_facts(&[routed])
        );
    }

    #[tokio::test]
    async fn startup_refresh_retains_fallbacks_and_skips_disabled_or_already_refreshed_addons() {
        use std::io::{BufRead, BufReader, Write};
        use std::time::{Duration, Instant};
        let valid = r#"{"name":"Updated","resources":["meta","subtitles"],"types":["movie"],"idPrefixes":["kitsu:"],"catalogs":[{"type":"movie","id":"new"}],"behaviorHints":{"configurationRequired":true}}"#;
        for (status, body, refresh_classified) in [
            (200, valid, true),
            (200, "{}", true),
            (200, "invalid", true),
            (503, "{}", true),
            (200, valid, false),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let addon = AddonConfig {
                url: format!("http://{}", listener.local_addr().unwrap()),
                ..crate::test_helpers::classified_cinemeta_addon()
            };
            for (candidate, refresh) in [
                (addon.clone(), false),
                (
                    AddonConfig {
                        enabled: false,
                        ..addon.clone()
                    },
                    true,
                ),
            ] {
                assert!(
                    refresh_installed_addon_capabilities(vec![candidate], refresh)
                        .await
                        .unwrap()
                        .is_empty()
                );
                assert_eq!(
                    listener.accept().unwrap_err().kind(),
                    std::io::ErrorKind::WouldBlock
                );
            }
            let server = std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline);
                            std::thread::sleep(Duration::from_millis(1));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                // Windows accepted sockets inherit the listener's nonblocking mode.
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let mut reader = BufReader::new(&mut socket);
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                }
                write!(socket, "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            let mut candidate = addon.clone();
            if !refresh_classified {
                candidate.capabilities = None;
            }
            let fetched = refresh_installed_addon_capabilities(vec![candidate], refresh_classified)
                .await
                .unwrap();
            server.join().unwrap();
            let mut latest = vec![addon.clone()];
            let success = status == 200 && body == valid;
            assert_eq!(
                merge_classified_capabilities(&mut latest, fetched, false),
                success
            );
            let expected = if success {
                AddonConfig {
                    capabilities: Some(
                        crate::providers::addon_manifest::parse_addon_manifest(valid.as_bytes())
                            .unwrap(),
                    ),
                    ..addon
                }
            } else {
                addon
            };
            assert_eq!(latest, vec![expected]);
        }
        let offline = AddonConfig {
            url: "http://127.0.0.1:0".into(),
            ..crate::test_helpers::classified_cinemeta_addon()
        };
        let fetched = refresh_installed_addon_capabilities(vec![offline.clone()], true)
            .await
            .unwrap();
        let mut latest = vec![offline.clone()];
        assert!(!merge_classified_capabilities(&mut latest, fetched, false));
        assert_eq!(latest, vec![offline]);
    }

    #[test]
    fn addon_url_inspection_matches_the_save_normalizer() {
        let installed = [AddonConfig {
            url: "https://addon.example/abc".to_string(),
            ..test_addon("addon-1", "Addon Source")
        }];

        assert_eq!(
            inspect_addon_url_against("   ", &installed),
            AddonUrlInspection::default()
        );
        assert!(inspect_addon_url_against("ftp://addon.example", &installed)
            .error
            .is_some());

        let duplicate =
            inspect_addon_url_against("stremiro://addon.example/abc/manifest.json/", &installed);
        assert_eq!(
            duplicate.display_url.as_deref(),
            Some("https://addon.example/•••")
        );
        assert_eq!(
            duplicate.normalized_url.as_deref(),
            Some("https://addon.example/abc")
        );
        assert_eq!(duplicate.duplicate_of.as_deref(), Some("Addon Source"));
        assert!(!duplicate.configure_page);
        let value = serde_json::to_value(&duplicate).unwrap();
        assert_eq!(value["displayUrl"], "https://addon.example/•••");
        assert!(value.get("valid").is_none());
        assert!(value.get("normalizedUrl").is_none());

        let private = inspect_addon_url_against(
            "stremiro://addon.example/AbCdEfGhIjKlMnOpQrStUvWxYz012345/manifest.json?token=sekrit",
            &installed,
        );
        assert_eq!(
            private.display_url.as_deref(),
            Some("https://addon.example/•••?token=•••")
        );
        let serialized = serde_json::to_string(&private).unwrap();
        assert!(!serialized.contains("AbCdEfGhIjKlMnOpQrStUvWxYz012345"));
        assert!(!serialized.contains("sekrit"));
        assert!(!serialized.contains("normalizedUrl"));

        let configure = inspect_addon_url_against("https://addon.example/Configure/", &installed);
        assert!(configure.display_url.is_none());
        assert!(configure.configure_page);
        assert_eq!(configure.duplicate_of, None);

        let too_long = format!(
            "https://addon.example/{}",
            "a".repeat(MAX_ADDON_URL_INPUT_CHARS)
        );
        assert!(inspect_addon_url_against(&too_long, &installed)
            .error
            .is_some());
    }
}
