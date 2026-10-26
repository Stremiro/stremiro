use super::{lenient_option, DurableStore, ADDON_CONFIGS_KEY, DEFAULT_ADDON_INSTALLS};
use crate::commands::{app_links::APP_LINK_SCHEME, normalize_non_empty};
use crate::providers::addon_manifest::{
    snapshot_is_classified, snapshot_resource_kinds, AddonManifest, AddonResourceKind,
};
use crate::providers::{strip_manifest_suffix, ADDON_URL_INVALID_MESSAGE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;

/// Bumped on every addon-registry write so memoized parsed snapshots drop the moment config changes.
static ADDON_CONFIGS_GENERATION: AtomicU64 = AtomicU64::new(0);

pub(crate) fn addon_configs_generation() -> u64 {
    ADDON_CONFIGS_GENERATION.load(Ordering::SeqCst)
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct AddonConfig {
    pub id: String,
    pub url: String,
    pub name: String,
    pub enabled: bool,
    // A corrupt snapshot degrades to `None` (re-classified next fetch) rather than
    // poisoning every config read via the strict `AddonManifest` decode.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_option"
    )]
    pub capabilities: Option<AddonManifest>,
}

#[derive(Deserialize)]
struct AddonConfigIdentity {
    id: String,
    url: String,
    name: String,
    enabled: bool,
}

impl From<AddonConfigIdentity> for AddonConfig {
    fn from(identity: AddonConfigIdentity) -> Self {
        Self {
            id: identity.id,
            url: identity.url,
            name: identity.name,
            enabled: identity.enabled,
            capabilities: None,
        }
    }
}

impl AddonConfig {
    pub(crate) fn load_identities(store: &DurableStore) -> Vec<Self> {
        let configs = store.with_value(ADDON_CONFIGS_KEY, |value| {
            value
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|value| AddonConfigIdentity::deserialize(value).ok())
                .map(Self::from)
                .collect()
        });
        resolve_addon_configs(Some(configs))
    }

    pub(crate) fn needs_classification(&self) -> bool {
        self.capabilities
            .as_ref()
            .is_none_or(|snapshot| !snapshot_is_classified(snapshot))
    }
}

/// IPC view of an [`AddonConfig`]: `display_url` masks all config path/query values.
/// Output-only; the masked string is never persisted.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonConfigView {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub display_url: String,
    /// Pinned defaults occupy fixed registry slots and can only be toggled.
    pub pinned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `None` until classified: routing then treats the addon as serving every resource.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resources: Option<Vec<AddonResourceKind>>,
    pub configurable: bool,
}

pub(in crate::commands) fn addon_display_url(url: &str) -> String {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return "•••".to_string();
    };
    let path = parsed.path().trim_end_matches('/');
    let base_path = strip_manifest_suffix(path);
    let suffix_start = ["/stream/", "/catalog/", "/meta/", "/subtitles/"]
        .into_iter()
        .filter_map(|resource| path.rfind(resource))
        .filter(|&start| {
            base_path.len() == path.len()
                && path.ends_with(".json")
                && path[start + 1..].split('/').count() >= 3
        })
        .max()
        .unwrap_or(base_path.len());
    let (config_path, suffix) = path.split_at(suffix_start);
    let masked_path = config_path
        .split('/')
        .map(|segment| if segment.is_empty() { "" } else { "•••" })
        .collect::<Vec<_>>()
        .join("/");
    let mut display = format!(
        "{}{masked_path}{suffix}",
        parsed.origin().ascii_serialization()
    );
    if let Some(query) = parsed.query() {
        display.push('?');
        display.push_str(
            &query
                .split('&')
                .map(|pair| {
                    pair.split_once('=')
                        .map_or_else(|| "•••".to_string(), |(key, _)| format!("{key}=•••"))
                })
                .collect::<Vec<_>>()
                .join("&"),
        );
    }
    display
}

impl AddonConfigView {
    pub(crate) fn from_config(config: AddonConfig) -> Self {
        let display_url = addon_display_url(&config.url);
        let pinned = is_pinned_default_addon_url(&config.url);
        let resources = config
            .capabilities
            .as_ref()
            .filter(|snapshot| snapshot_is_classified(snapshot))
            .map(snapshot_resource_kinds);
        let manifest = config.capabilities.unwrap_or_default();
        Self {
            id: config.id,
            name: config.name,
            enabled: config.enabled,
            display_url,
            pinned,
            logo: manifest.logo,
            version: manifest.version,
            description: manifest.description,
            resources,
            configurable: manifest.configurable,
        }
    }
}

pub(in crate::commands) fn strip_ascii_prefix_ignore_case<'a>(
    value: &'a str,
    prefix: &str,
) -> Option<&'a str> {
    value
        .get(..prefix.len())
        .filter(|head| head.eq_ignore_ascii_case(prefix))
        .map(|_| &value[prefix.len()..])
}

pub(in crate::commands) const LEGACY_INSTALL_SCHEME: &str = concat!("strem", "io://");

fn rewrite_install_reference(trimmed: &str) -> String {
    let rest = strip_ascii_prefix_ignore_case(trimmed, APP_LINK_SCHEME)
        .or_else(|| strip_ascii_prefix_ignore_case(trimmed, LEGACY_INSTALL_SCHEME))
        .unwrap_or(trimmed);
    // Configured paths and queries can themselves contain URLs.
    if rest
        .split_once("://")
        .is_some_and(|(scheme, _)| !scheme.contains(['/', '?', '#']))
    {
        rest.to_string()
    } else {
        format!("https://{rest}")
    }
}

pub(crate) fn normalize_addon_url(config: &str) -> Result<Option<String>, String> {
    let trimmed = config.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let candidate = rewrite_install_reference(trimmed);

    let mut parsed =
        reqwest::Url::parse(&candidate).map_err(|_| ADDON_URL_INVALID_MESSAGE.to_string())?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(ADDON_URL_INVALID_MESSAGE.to_string());
    }

    if parsed.host_str().is_none() {
        return Err("Addon URL must include a valid host.".to_string());
    }

    // Addon URLs persist and travel in diagnostics — strip embedded credentials;
    // query/path config data is preserved.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        parsed.set_username("").ok();
        parsed.set_password(None).ok();
    }

    parsed.set_fragment(None);

    let normalized_path = strip_manifest_suffix(parsed.path()).to_string();

    if normalized_path.is_empty() {
        parsed.set_path("/");
    } else {
        parsed.set_path(&normalized_path);
    }

    let mut normalized = parsed.to_string();
    if parsed.query().is_none() && normalized.ends_with('/') {
        normalized.pop();
    }

    // A serialized `Url` is never empty.
    Ok(Some(normalized))
}

fn normalize_loaded_addon_config(mut config: AddonConfig) -> Option<AddonConfig> {
    let url = normalize_addon_url(&config.url).ok().flatten()?;

    config.id = normalize_non_empty(&config.id).unwrap_or_else(|| url.clone());
    config.name = normalize_non_empty(&config.name)
        .or_else(|| {
            reqwest::Url::parse(&url)
                .ok()
                .and_then(|value| value.host_str().map(|host| host.to_string()))
        })
        .unwrap_or_else(|| "Addon".to_string());
    config.url = url;
    if config
        .capabilities
        .as_ref()
        .is_some_and(|snapshot| !snapshot_is_classified(snapshot))
    {
        config.capabilities = None;
    }

    Some(config)
}

pub(crate) fn parse_stored_addon_configs(value: &Value) -> Vec<AddonConfig> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            if !item.is_object() {
                return AddonConfig::deserialize(item).ok();
            }
            let mut config = AddonConfig::from(AddonConfigIdentity::deserialize(item).ok()?);
            config.capabilities = item
                .get("capabilities")
                .and_then(|value| AddonManifest::deserialize(value).ok());
            Some(config)
        })
        .collect()
}

fn normalize_loaded_addon_configs(configs: Vec<AddonConfig>) -> Vec<AddonConfig> {
    let mut normalized_configs = Vec::with_capacity(configs.len());
    let mut seen_urls = std::collections::HashSet::with_capacity(configs.len());
    let mut seen_ids = std::collections::HashSet::with_capacity(configs.len());

    for mut config in configs
        .into_iter()
        .filter_map(normalize_loaded_addon_config)
    {
        if !seen_urls.insert(config.url.clone()) {
            continue;
        }

        if !seen_ids.insert(config.id.clone()) {
            config.id = config.url.clone();
            if !seen_ids.insert(config.id.clone()) {
                continue;
            }
        }

        normalized_configs.push(config);
    }

    normalized_configs
}

fn default_addon_config(install_url: &str, name: &str) -> Option<AddonConfig> {
    let url = normalize_addon_url(install_url).ok().flatten()?;

    Some(AddonConfig {
        id: url.clone(),
        url,
        name: name.to_string(),
        enabled: true,
        capabilities: None,
    })
}

/// Same URL identity `pin_default_addons` pins by — normalized once since the check runs per config.
static DEFAULT_ADDON_CONFIGS: LazyLock<Vec<AddonConfig>> = LazyLock::new(|| {
    DEFAULT_ADDON_INSTALLS
        .iter()
        .filter_map(|(install_url, name)| default_addon_config(install_url, name))
        .collect()
});

pub(in crate::commands) fn is_pinned_default_addon_url(url: &str) -> bool {
    DEFAULT_ADDON_CONFIGS
        .iter()
        .any(|default| default.url == url)
}

/// Default addons are pinned: each `DEFAULT_ADDON_INSTALLS` entry always occupies its
/// index and can't be removed. A user's `enabled: false` toggle is preserved.
fn pin_default_addons(mut configs: Vec<AddonConfig>) -> Vec<AddonConfig> {
    for (index, default) in DEFAULT_ADDON_CONFIGS.iter().enumerate() {
        // A stored copy keeps the user's toggle/name/snapshot; a missing one seeds enabled.
        let pinned = match configs.iter().position(|config| config.url == default.url) {
            Some(position) => configs.remove(position),
            None => default.clone(),
        };
        configs.insert(index.min(configs.len()), pinned);
    }
    configs
}

pub(crate) fn resolve_addon_configs(stored_configs: Option<Vec<AddonConfig>>) -> Vec<AddonConfig> {
    // A missing registry is first-run — the pin pass seeds both defaults.
    pin_default_addons(normalize_loaded_addon_configs(
        stored_configs.unwrap_or_default(),
    ))
}

pub(crate) fn load_addon_configs(store: &DurableStore) -> Vec<AddonConfig> {
    let stored_configs = store.with_value(ADDON_CONFIGS_KEY, |value| {
        value.map(parse_stored_addon_configs)
    });
    resolve_addon_configs(stored_configs)
}

pub(crate) fn save_addon_configs_to_store(store: &DurableStore, configs: &[AddonConfig]) {
    store.set(ADDON_CONFIGS_KEY, serde_json::json!(configs));
    // Bump after `set` so a reader observing the new generation re-reads data including this write.
    ADDON_CONFIGS_GENERATION.fetch_add(1, Ordering::SeqCst);
}
