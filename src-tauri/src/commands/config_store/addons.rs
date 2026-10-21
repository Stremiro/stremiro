use super::{lenient_option, DurableStore, ADDON_CONFIGS_KEY, DEFAULT_ADDON_INSTALLS};
use crate::commands::normalize_non_empty;
use crate::providers::addon_manifest::{snapshot_is_classified, AddonManifest};
use crate::providers::addons::sanitize_addon_log;
use crate::providers::strip_manifest_suffix;
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

/// IPC view of an [`AddonConfig`]: `display_url` is the credential-masked URL computed
/// by the same `sanitize_addon_log` pipeline that guards logs — one redaction
/// implementation so a renderer-side masker can't drift and leak a user key.
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
}

/// Readable masked URL: `https://` implied, redaction markers collapse to `•••`.
pub(in crate::commands) fn addon_display_url(url: &str) -> String {
    let masked = sanitize_addon_log(url);
    masked
        .strip_prefix("https://")
        .unwrap_or(&masked)
        .replace("[redacted-userinfo]", "•••")
        .replace("[redacted-path]", "•••")
        .replace("[redacted]", "•••")
}

impl AddonConfigView {
    pub(crate) fn from_config(config: AddonConfig) -> Self {
        let display_url = addon_display_url(&config.url);
        let pinned = is_pinned_default_addon_url(&config.url);
        Self {
            id: config.id,
            name: config.name,
            enabled: config.enabled,
            display_url,
            pinned,
        }
    }
}

fn strip_ascii_prefix_ignore_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let prefix_len = prefix.len();
    if value.len() >= prefix_len
        && value.is_char_boundary(prefix_len)
        && value[..prefix_len].eq_ignore_ascii_case(prefix)
    {
        Some(&value[prefix_len..])
    } else {
        None
    }
}

fn rewrite_stremio_install_reference(trimmed: &str) -> Result<String, String> {
    let Some(rest) = strip_ascii_prefix_ignore_case(trimmed, "stremio://") else {
        if trimmed.contains("://") {
            return Ok(trimmed.to_string());
        }
        return Ok(format!("https://{trimmed}"));
    };

    if strip_ascii_prefix_ignore_case(rest, "https://").is_some()
        || strip_ascii_prefix_ignore_case(rest, "http://").is_some()
    {
        return Ok(rest.to_string());
    }

    if rest.contains("://") {
        return Err("Addon URL must start with http://, https://, or stremio://".to_string());
    }

    Ok(format!("https://{rest}"))
}

pub(crate) fn normalize_addon_url(config: &str) -> Result<Option<String>, String> {
    let trimmed = config.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let candidate = rewrite_stremio_install_reference(trimmed)?;

    let mut parsed = reqwest::Url::parse(&candidate).map_err(|_| {
        "Invalid addon URL. Please provide a valid http(s) or stremio:// URL.".to_string()
    })?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Addon URL must start with http://, https://, or stremio://".to_string());
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
static NORMALIZED_DEFAULT_ADDON_URLS: LazyLock<Vec<String>> = LazyLock::new(|| {
    DEFAULT_ADDON_INSTALLS
        .iter()
        .filter_map(|(install_url, _)| normalize_addon_url(install_url).ok().flatten())
        .collect()
});

pub(in crate::commands) fn is_pinned_default_addon_url(url: &str) -> bool {
    NORMALIZED_DEFAULT_ADDON_URLS
        .iter()
        .any(|default| default == url)
}

/// Default addons are pinned: each `DEFAULT_ADDON_INSTALLS` entry always occupies its
/// index and can't be removed. A user's `enabled: false` toggle is preserved.
fn pin_default_addons(mut configs: Vec<AddonConfig>) -> Vec<AddonConfig> {
    for (index, (install_url, name)) in DEFAULT_ADDON_INSTALLS.iter().enumerate() {
        let Some(default) = default_addon_config(install_url, name) else {
            continue;
        };
        // A stored copy keeps the user's toggle/name/snapshot; a missing one seeds enabled.
        let pinned = match configs.iter().position(|config| config.url == default.url) {
            Some(position) => configs.remove(position),
            None => default,
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
