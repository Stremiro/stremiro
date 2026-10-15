pub(crate) use super::addon_registry::schedule_capability_classification;
use super::config_store::{
    apply_app_ui_preferences_patch, apply_profile_preferences_patch, is_pinned_default_addon_url,
    load_addon_configs, load_app_ui_preferences, load_last_notified_app_update_version,
    load_profile_preferences, load_stream_selector_preferences_state, normalize_addon_url,
    normalize_start_minimized, resolve_addon_configs, sanitize_stream_selector_preferences,
    save_addon_configs_to_store, save_app_ui_preferences_to_store,
    save_last_notified_app_update_version_to_store, save_profile_preferences_to_store,
    save_stream_selector_preferences_to_store, startup_route, AddonConfig, AddonConfigView,
    AppUiPreferences, AppUiPreferencesPatch, ProfilePreferences, ProfilePreferencesPatch,
    StreamSelectorPreferences,
};
use super::DurableStore;
use crate::providers::addon_manifest::{
    fetch_addon_manifest_snapshot, snapshot_is_classified, AddonManifest,
};
use crate::providers::addon_resource::AddonResourceClient;
use crate::providers::addons::AddonTransport;
use crate::providers::{build_provider_http_client, trim_to_max};
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;
use tauri::{command, AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

const ADDON_CLASSIFY_CONCURRENCY: usize = 4;
/// Shared classify pool — reuses keep-alive/TLS sessions across settings opens
/// instead of paying re-handshakes per burst.
static CLASSIFY_CLIENT: LazyLock<reqwest::Client> =
    LazyLock::new(|| build_provider_http_client(Some(ADDON_CLASSIFY_CONCURRENCY)));
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
}

#[command]
pub async fn get_app_ui_preferences(app: AppHandle) -> Result<AppUiPreferences, String> {
    // Settings store file IO is blocking: run every read-modify-write off
    // the async worker, matching the library/history command pattern.
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        Ok(load_app_ui_preferences(&store))
    })
    .await
}

#[command]
pub async fn get_startup_route(app: AppHandle) -> Result<Option<String>, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        Ok(startup_route(load_app_ui_preferences(&store)))
    })
    .await
}

#[command]
pub async fn save_app_ui_preferences(
    app: AppHandle,
    patch: AppUiPreferencesPatch,
) -> Result<AppUiPreferences, String> {
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
        store.save()?;
        if sync_tray {
            // The preference is already saved; closing still verifies the tray before hiding.
            let _ = super::app_shell_commands::sync_preferences(&app, &preferences);
        }

        Ok(preferences)
    })
    .await
}

#[command]
pub async fn get_last_notified_app_update_version(
    app: AppHandle,
) -> Result<Option<String>, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        Ok(load_last_notified_app_update_version(&store))
    })
    .await
}

#[command]
pub async fn save_last_notified_app_update_version(
    app: AppHandle,
    version: Option<String>,
) -> Result<Option<String>, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;

        if save_last_notified_app_update_version_to_store(&store, version) {
            store.save()?;
        }

        Ok(load_last_notified_app_update_version(&store))
    })
    .await
}

#[command]
pub async fn get_profile_preferences(app: AppHandle) -> Result<ProfilePreferences, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        Ok(load_profile_preferences(&store))
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
        let preferences = apply_profile_preferences_patch(load_profile_preferences(&store), patch);

        save_profile_preferences_to_store(&store, &preferences);
        store.save()?;

        Ok(preferences)
    })
    .await
}

#[command]
pub async fn get_stream_selector_preferences(
    app: AppHandle,
) -> Result<StreamSelectorPreferencesState, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        let (preferences, initialized) = load_stream_selector_preferences_state(&store);
        Ok(StreamSelectorPreferencesState {
            preferences,
            initialized,
        })
    })
    .await
}

#[command]
pub async fn save_stream_selector_preferences(
    app: AppHandle,
    preferences: StreamSelectorPreferences,
) -> Result<StreamSelectorPreferences, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        let preferences = sanitize_stream_selector_preferences(preferences);

        save_stream_selector_preferences_to_store(&store, &preferences);
        store.save()?;

        Ok(preferences)
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

pub(super) fn apply_manifest_snapshot(config: &mut AddonConfig, snapshot: AddonManifest) -> bool {
    if snapshot_is_classified(&snapshot) {
        if is_host_fallback_name(config) {
            config.name = snapshot.name.clone();
        }
        config.capabilities = Some(snapshot);
        return true;
    }
    false
}

// New installs must validate before success; background retries retain offline sources.
pub(super) async fn classify_missing_addon_capabilities(
    configs: Vec<AddonConfig>,
    require_valid_manifest: bool,
) -> Result<Vec<AddonConfig>, String> {
    let mut classified = configs;

    let pending: Vec<usize> = classified
        .iter()
        .enumerate()
        .filter(|(_, config)| {
            (require_valid_manifest || config.enabled)
                && config
                    .capabilities
                    .as_ref()
                    .is_none_or(|snapshot| !snapshot_is_classified(snapshot))
        })
        .map(|(index, _)| index)
        .collect();

    if pending.is_empty() {
        return Ok(classified);
    }

    // Shared pool (see `CLASSIFY_CLIENT`): cloned per task, never rebuilt
    // per burst, so keep-alive/TLS sessions survive across settings opens.
    let client = CLASSIFY_CLIENT.clone();

    let snapshots: Vec<(usize, Result<AddonManifest, String>)> = stream::iter(pending)
        .map(|index| {
            let url = classified[index].url.clone();
            let client = client.clone();
            async move {
                let snapshot = fetch_addon_manifest_snapshot(&client, &url).await;
                (index, snapshot)
            }
        })
        .buffer_unordered(ADDON_CLASSIFY_CONCURRENCY)
        .collect()
        .await;

    for (index, snapshot) in snapshots {
        match snapshot {
            Ok(snapshot) => {
                if !apply_manifest_snapshot(&mut classified[index], snapshot)
                    && require_valid_manifest
                {
                    return Err(
                        "Addon manifest does not declare any resources or catalogs.".to_string()
                    );
                }
            }
            Err(error) if require_valid_manifest => return Err(error),
            Err(_) => {}
        }
    }

    Ok(classified)
}

/// Reports whether a config gained a snapshot — an unreachable addon must not
/// force a store write + generation bump (registry memo invalidation) per retry.
fn merge_classified_capabilities(latest: &mut [AddonConfig], classified: Vec<AddonConfig>) -> bool {
    let mut snapshots: std::collections::HashMap<String, AddonManifest> = classified
        .into_iter()
        .filter_map(|config| config.capabilities.map(|snapshot| (config.url, snapshot)))
        .collect();

    let mut changed = false;
    for config in latest {
        if config.capabilities.is_none() {
            if let Some(snapshot) = snapshots.remove(&config.url) {
                changed |= apply_manifest_snapshot(config, snapshot);
            }
        }
    }

    changed
}

pub(crate) async fn classify_installed_addon_capabilities(app: AppHandle) -> Result<(), String> {
    let current = super::run_blocking_store_op({
        let app = app.clone();
        move || {
            let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
            Ok::<_, String>(load_addon_configs(&store))
        }
    })
    .await?;
    if current.iter().all(|config| {
        !config.enabled
            || config
                .capabilities
                .as_ref()
                .is_some_and(snapshot_is_classified)
    }) {
        return Ok(());
    }

    let classified = classify_missing_addon_capabilities(current, false).await?;
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        let mut latest = load_addon_configs(&store);
        if !merge_classified_capabilities(&mut latest, classified) {
            return Ok(());
        }
        save_addon_configs_to_store(&store, &latest);
        store.save()
    })
    .await
}

#[command]
pub async fn get_addon_configs(app: AppHandle) -> Result<Vec<AddonConfigView>, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        Ok(load_addon_configs(&store)
            .into_iter()
            .map(AddonConfigView::from_config)
            .collect())
    })
    .await
}

/// Pasted install URLs are short; anything longer is junk, not an addon.
const MAX_ADDON_URL_INPUT_CHARS: usize = 4_096;

/// Add-box verdict, built from the same normalizer the save path stores
/// with, so a URL the UI accepts can't be rejected or duplicated at save.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonUrlInspection {
    /// The URL `update_addon_configs` would store; absent when invalid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// A `/configure` page, not a manifest: the user must finish setup first.
    pub configure_page: bool,
    /// Name of the installed addon this URL already points at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<String>,
}

fn validate_installable_addon_reference(url: &str) -> AddonUrlInspection {
    if url.chars().count() > MAX_ADDON_URL_INPUT_CHARS {
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
            .to_ascii_lowercase()
            .ends_with("/configure")
    });
    AddonUrlInspection {
        normalized_url: (!configure_page).then_some(normalized_url),
        error: configure_page.then(|| "This is a configure page — open it, finish setup, then paste the generated manifest URL.".to_string()),
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
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        Ok(inspect_addon_url_against(&url, &load_addon_configs(&store)))
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
    mut configs: Vec<AddonConfig>,
    op: AddonConfigsOp,
    new_addon_id: &str,
) -> Result<Vec<AddonConfig>, String> {
    match op {
        AddonConfigsOp::Add { url } => {
            let verdict = inspect_addon_url_against(&url, &configs);
            if let Some(error) = verdict.error {
                return Err(error);
            }
            let url = verdict
                .normalized_url
                .ok_or_else(|| "Enter a valid http(s) or stremio:// addon URL.".to_string())?;
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
            configs = resolve_addon_configs(Some(configs));
        }
        AddonConfigsOp::Remove { id } => {
            configs.retain(|config| config.id != id || is_pinned_default_addon_url(&config.url));
        }
        AddonConfigsOp::SetEnabled { id, enabled } => {
            if let Some(config) = configs.iter_mut().find(|config| config.id == id) {
                config.enabled = enabled;
            }
        }
        AddonConfigsOp::Reorder { ids } => {
            if ids.len() > MAX_ADDON_CONFIGS {
                return Err(format!(
                    "Too many addon ids. Maximum is {MAX_ADDON_CONFIGS}."
                ));
            }
            let (pinned, user): (Vec<_>, Vec<_>) = configs
                .into_iter()
                .partition(|config| is_pinned_default_addon_url(&config.url));
            let current = user
                .iter()
                .map(|config| config.id.clone())
                .collect::<Vec<_>>();
            let mut by_id: HashMap<_, _> = user
                .into_iter()
                .map(|config| (config.id.clone(), config))
                .collect();
            configs = pinned;
            configs.extend(
                super::list_helpers::reorder_known_ids(&current, ids)
                    .into_iter()
                    .filter_map(|id| by_id.remove(&id)),
            );
        }
    }
    Ok(configs)
}

#[command]
pub async fn update_addon_configs(
    app: AppHandle,
    provider: State<'_, AddonTransport>,
    client: State<'_, AddonResourceClient>,
    op: AddonConfigsOp,
) -> Result<Vec<AddonConfigView>, String> {
    let new_addon_id = if matches!(op, AddonConfigsOp::Add { .. }) {
        format!("addon-{}", uuid::Uuid::new_v4())
    } else {
        String::new()
    };
    let classified = if matches!(op, AddonConfigsOp::Add { .. }) {
        let candidate = super::run_blocking_store_op({
            let app = app.clone();
            let op = op.clone();
            let new_addon_id = new_addon_id.clone();
            move || {
                let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
                let mut updated =
                    apply_addon_configs_op(load_addon_configs(&store), op, &new_addon_id)?;
                Ok::<_, String>(updated.pop().into_iter().collect())
            }
        })
        .await?;
        classify_missing_addon_capabilities(candidate, true).await?
    } else {
        Vec::new()
    };

    // Manifest IO stays off the store gate; only the delta is reapplied at commit.
    let (updated, changed) = super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        let latest = load_addon_configs(&store);
        let mut updated = apply_addon_configs_op(latest.clone(), op, &new_addon_id)?;
        merge_classified_capabilities(&mut updated, classified);
        let changed = updated != latest;
        if changed {
            save_addon_configs_to_store(&store, &updated);
            store.save()?;
        }
        Ok::<_, String>((updated, changed))
    })
    .await?;
    if changed {
        provider.clear_cache();
        client.clear_cache();
    }
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
    fn addon_add_rejects_normalized_duplicates_and_invalid_install_urls() {
        for url in [
            "stremio://addon.example/a/manifest.json/",
            "https://addon.example/configure",
            "ftp://addon.example",
            "",
        ] {
            assert!(apply_addon_configs_op(
                installed(),
                AddonConfigsOp::Add { url: url.into() },
                "new"
            )
            .is_err());
        }
    }

    #[test]
    fn addon_remove_and_toggle_target_ids_and_preserve_pinned_defaults() {
        let current = installed();
        let pinned_id = current[0].id.clone();
        let mut latest = current.clone();
        for id in [pinned_id.clone(), "b".into()] {
            latest = apply_addon_configs_op(
                latest,
                AddonConfigsOp::SetEnabled { id, enabled: false },
                "",
            )
            .unwrap();
        }
        assert!(!latest[0].enabled);
        assert!(
            !latest
                .iter()
                .find(|config| config.id == "b")
                .unwrap()
                .enabled
        );
        latest =
            apply_addon_configs_op(latest, AddonConfigsOp::Remove { id: pinned_id }, "").unwrap();
        assert_eq!(latest.len(), current.len());
        latest =
            apply_addon_configs_op(latest, AddonConfigsOp::Remove { id: "b".into() }, "").unwrap();
        assert!(!latest.iter().any(|config| config.id == "b"));
        assert!(!latest[0].enabled);
    }

    #[test]
    fn addon_reorder_keeps_pinned_first_and_appends_missing_ids() {
        let current = installed();
        let mut expected: Vec<_> = current.iter().map(|config| config.id.clone()).collect();
        expected[2..].rotate_right(1);
        let reordered = apply_addon_configs_op(
            current.clone(),
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
        .unwrap();
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
        let latest = apply_addon_configs_op(
            installed(),
            AddonConfigsOp::SetEnabled {
                id: "a".into(),
                enabled: false,
            },
            "",
        )
        .unwrap();
        let latest =
            apply_addon_configs_op(latest, AddonConfigsOp::Remove { id: "b".into() }, "").unwrap();
        let updated = apply_addon_configs_op(
            latest.clone(),
            AddonConfigsOp::Add {
                url: "stremio://new.example/manifest.json/".into(),
            },
            "new",
        )
        .unwrap();
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
            assert_eq!(
                apply_addon_configs_op(current.clone(), op, "").unwrap(),
                current
            );
        }
        let op: AddonConfigsOp =
            serde_json::from_str(r#"{"kind":"setEnabled","id":"a","enabled":false}"#).unwrap();
        assert!(matches!(
            op,
            AddonConfigsOp::SetEnabled { enabled: false, .. }
        ));
    }

    #[test]
    fn addon_url_inspection_matches_the_save_normalizer() {
        let installed = [AddonConfig {
            url: "https://addon.example/abc".to_string(),
            ..test_addon("addon-1", "Torrent Source")
        }];

        assert_eq!(
            inspect_addon_url_against("   ", &installed),
            AddonUrlInspection::default()
        );
        assert!(inspect_addon_url_against("ftp://addon.example", &installed)
            .error
            .is_some());

        let duplicate =
            inspect_addon_url_against("stremio://addon.example/abc/manifest.json/", &installed);
        assert_eq!(
            duplicate.normalized_url.as_deref(),
            Some("https://addon.example/abc")
        );
        assert_eq!(duplicate.duplicate_of.as_deref(), Some("Torrent Source"));
        assert!(!duplicate.configure_page);

        let configure = inspect_addon_url_against("https://addon.example/Configure/", &installed);
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
