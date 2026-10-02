use super::config_store::{
    apply_app_ui_preferences_patch, load_addon_configs, load_app_ui_preferences,
    load_last_notified_app_update_version, load_profile_preferences,
    load_stream_selector_preferences_state, normalize_addon_url, resolve_addon_configs,
    sanitize_profile_preferences, sanitize_stream_selector_preferences,
    save_addon_configs_to_store, save_app_ui_preferences_to_store,
    save_last_notified_app_update_version_to_store, save_profile_preferences_to_store,
    save_stream_selector_preferences_to_store, AddonConfig, AddonConfigView, AppUiPreferences,
    AppUiPreferencesPatch, LocalProfile, ProfilePreferences, ProfileViewMode,
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
use serde::Serialize;
use std::sync::LazyLock;
use tauri::{command, AppHandle, State};

const ADDON_CLASSIFY_CONCURRENCY: usize = 4;
/// Shared classify pool: `reqwest::Client` is cheap to clone (Arc-backed) and
/// reuses keep-alive/TLS sessions across settings opens. The previous form
/// built and dropped a pool per burst, paying re-handshakes every time an
/// unclassified addon needed fetching.
static CLASSIFY_CLIENT: LazyLock<reqwest::Client> =
    LazyLock::new(|| build_provider_http_client(Some(ADDON_CLASSIFY_CONCURRENCY)));
/// IPC bound: each saved addon triggers manifest classification fetches, so reject
/// oversized batches before allocating per-config state (mirrors import bounds).
const MAX_ADDON_CONFIGS: usize = 32;
/// Bound client-supplied addon identity fields so an oversized IPC payload
/// can't persist unbounded strings.
const MAX_ADDON_FIELD_CHARS: usize = 256;

/// Backup restore: appends addons whose URL isn't installed yet, under the
/// same URL normalization and field bounds as `save_addon_configs`. Imported
/// capability snapshots are dropped — never trusted from outside a server-side
/// fetch — so the background classifier re-fetches them. Returns the number
/// of addons added; the caller owns `store.save()`.
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
        let Ok(Some(url)) = normalize_addon_url(&config.url) else {
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
pub async fn save_app_ui_preferences(
    app: AppHandle,
    patch: AppUiPreferencesPatch,
) -> Result<AppUiPreferences, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        let preferences = apply_app_ui_preferences_patch(load_app_ui_preferences(&store), patch);

        save_app_ui_preferences_to_store(&store, &preferences);
        store.save()?;

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
    profile: LocalProfile,
    view_mode: ProfileViewMode,
) -> Result<ProfilePreferences, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        let preferences = sanitize_profile_preferences(ProfilePreferences { profile, view_mode });

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

/// The add flow seeds the URL's host as a placeholder label: only that
/// fallback is replaced by the fetched manifest name — an explicit custom
/// or pinned name is never overwritten.
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

/// Reports whether a config gained a snapshot: a still-unreachable addon would
/// otherwise force a store write plus generation bump on every retry cycle,
/// invalidating the enabled-registry memo for zero change.
fn merge_classified_capabilities(latest: &mut [AddonConfig], classified: Vec<AddonConfig>) -> bool {
    let snapshots: std::collections::HashMap<String, AddonManifest> = classified
        .into_iter()
        .filter_map(|config| config.capabilities.map(|snapshot| (config.url, snapshot)))
        .collect();

    let mut changed = false;
    for config in latest {
        if config.capabilities.is_none() {
            if let Some(snapshot) = snapshots.get(&config.url).cloned() {
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
    /// The URL `save_addon_configs` would store; absent when invalid.
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

fn inspect_addon_url_against(url: &str, installed: &[AddonConfig]) -> AddonUrlInspection {
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
    let duplicate_of = installed
        .iter()
        .find(|addon| addon.url == normalized_url)
        .map(|addon| addon.name.clone());
    AddonUrlInspection {
        normalized_url: Some(normalized_url),
        error: None,
        configure_page,
        duplicate_of,
    }
}

#[command]
pub async fn inspect_addon_url(app: AppHandle, url: String) -> Result<AddonUrlInspection, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        Ok(inspect_addon_url_against(&url, &load_addon_configs(&store)))
    })
    .await
}

#[command]
pub async fn save_addon_configs(
    app: AppHandle,
    provider: State<'_, AddonTransport>,
    client: State<'_, AddonResourceClient>,
    configs: Vec<AddonConfig>,
) -> Result<Vec<AddonConfigView>, String> {
    if configs.len() > MAX_ADDON_CONFIGS {
        return Err(format!(
            "Too many addon configs ({}). Maximum is {}.",
            configs.len(),
            MAX_ADDON_CONFIGS
        ));
    }

    let (mut normalized, stored) = super::run_blocking_store_op({
        let app = app.clone();
        move || {
            let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;

            let stored = load_addon_configs(&store);
            let mut normalized = Vec::with_capacity(configs.len());
            for mut config in configs {
                config.id =
                    trim_to_max(&config.id, MAX_ADDON_FIELD_CHARS).unwrap_or_default();
                config.name =
                    trim_to_max(&config.name, MAX_ADDON_FIELD_CHARS).unwrap_or_default();
                let url = normalize_addon_url(&config.url)?.ok_or_else(|| {
                    format!(
                        "Invalid URL for addon '{}'. Please provide a valid http(s) or stremio:// URL.",
                        config.name
                    )
                })?;
                config.url = url;
                // Capability snapshots are only trusted when fetched
                // server-side: a client-supplied manifest would bypass the
                // fetch-time body/field bounds, so always restore the stored
                // snapshot for this URL and let unclassified entries
                // re-fetch below. A newly added addon's client snapshot is
                // dropped on purpose — one bounded re-fetch is the price of
                // never trusting renderer-supplied capability data.
                config.capabilities = stored
                    .iter()
                    .find(|existing| existing.url == config.url)
                    .and_then(|existing| existing.capabilities.clone());
                normalized.push(config);
            }

            Ok::<_, String>((resolve_addon_configs(Some(normalized)), stored))
        }
    })
    .await?;

    // Inline classification covers new URLs only: stored-but-unclassified
    // addons are owned by the throttled background classifier that runs off
    // every resource request — re-fetching their manifests here would stall
    // every settings save on a dead host for the full request timeout each.
    let new_configs: Vec<AddonConfig> = normalized
        .iter()
        .filter(|config| !stored.iter().any(|existing| existing.url == config.url))
        .cloned()
        .collect();
    merge_classified_capabilities(
        &mut normalized,
        classify_missing_addon_capabilities(new_configs, true).await?,
    );
    if normalized == stored {
        // A normalized-identical save skips the store rewrite and the cache
        // clear: dropping the transport/resource caches here would re-fan-out
        // every in-flight stream and meta fetch for a change that changed
        // nothing. Capability snapshots still classify above, so a genuine
        // capability diff lands in `normalized` and takes the save path.
        return Ok(normalized
            .into_iter()
            .map(AddonConfigView::from_config)
            .collect());
    }
    let merged = super::run_blocking_store_op({
        let app = app.clone();
        move || {
            let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
            // The classifier or a racing save may have committed fresher
            // capability snapshots since the first op's `stored` read —
            // adopt the latest stored snapshot per URL instead of writing
            // the stale-restored one back. The config list itself stays
            // caller-owned: adds/removes/order are the user's intent.
            let latest = load_addon_configs(&store);
            let merged: Vec<AddonConfig> = normalized
                .into_iter()
                .map(|mut config| {
                    if let Some(snapshot) = latest
                        .iter()
                        .find(|existing| existing.url == config.url)
                        .and_then(|existing| existing.capabilities.clone())
                    {
                        config.capabilities = Some(snapshot);
                    }
                    config
                })
                .collect();
            save_addon_configs_to_store(&store, &merged);
            store.save()?;
            Ok::<_, String>(merged)
        }
    })
    .await?;
    provider.clear_cache();
    client.clear_cache();
    Ok(merged
        .into_iter()
        .map(AddonConfigView::from_config)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::test_addon;

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
