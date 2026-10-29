use super::addon_resource::normalize_image_url;
use super::{
    bound_optional, has_manifest_suffix, lenient_option, non_blank, strip_manifest_suffix,
    trim_to_max, ADDON_URL_INVALID_MESSAGE, MANIFEST_JSON_SUFFIX,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const MANIFEST_MAX_BYTES: usize = 512 * 1024;
const MANIFEST_TOO_LARGE_ERROR: &str = "Addon manifest exceeds the 512 KiB size limit.";
pub(crate) const ADDON_CONFIGURATION_REQUIRED_MESSAGE: &str =
    "This is a configure page — open it, finish setup, then paste the generated manifest URL.";
const MAX_NAME_CHARS: usize = 128;
const MAX_VERSION_CHARS: usize = 32;
const MAX_DESCRIPTION_CHARS: usize = 280;
const MAX_RESOURCE_CHARS: usize = 64;
const MAX_TYPE_CHARS: usize = 64;
const MAX_PREFIX_CHARS: usize = 64;
const MAX_CATALOG_ID_CHARS: usize = 128;
const MAX_EXTRA_NAME_CHARS: usize = 64;
const MAX_EXTRA_OPTION_CHARS: usize = 128;
const MAX_TYPES: usize = 64;
const MAX_PREFIXES: usize = 64;
const MAX_RESOURCES: usize = 32;
const MAX_CATALOGS: usize = 128;
const MAX_EXTRAS: usize = 32;
const MAX_EXTRA_OPTIONS: usize = 256;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddonResourceCapability {
    pub name: String,
    pub types: Vec<String>,
    pub id_prefixes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddonCatalogExtra {
    pub name: String,
    pub is_required: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddonCatalogCapability {
    #[serde(rename = "type")]
    pub type_: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extras: Vec<AddonCatalogExtra>,
}

#[derive(Debug, Default, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddonManifest {
    pub name: String,
    #[serde(default)]
    pub resources: Vec<AddonResourceCapability>,
    // Manifest-level `types`/`idPrefixes` are inheritance inputs — consumers read the resource-level copies.
    #[serde(default)]
    pub catalogs: Vec<AddonCatalogCapability>,
    // Display facts; snapshots stored before these existed backfill on the next refresh.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub configurable: bool,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AddonResourceKind {
    Catalog,
    Meta,
    Stream,
    Subtitles,
}

fn item_list_from_value<T: DeserializeOwned>(value: serde_json::Value) -> Vec<T> {
    let serde_json::Value::Array(items) = value else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|item| serde_json::from_value(item).ok())
        .collect()
}

fn deserialize_item_list<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: DeserializeOwned,
{
    Ok(Option::<serde_json::Value>::deserialize(deserializer)?
        .map(item_list_from_value)
        .unwrap_or_default())
}

/// `null` behaves like an absent key: `types` inherits.
/// An explicit empty `types` list serves nothing.
fn deserialize_optional_string_list<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<serde_json::Value>::deserialize(deserializer)?.map(item_list_from_value))
}

#[derive(Debug, Deserialize)]
struct RawManifest {
    name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_item_list")]
    resources: Vec<RawResource>,
    #[serde(default, deserialize_with = "deserialize_item_list")]
    types: Vec<String>,
    #[serde(default, alias = "idPrefixes")]
    id_prefixes: serde_json::Value,
    #[serde(default, deserialize_with = "deserialize_item_list")]
    catalogs: Vec<RawCatalog>,
    #[serde(default, rename = "behaviorHints")]
    behavior_hints: serde_json::Value,
    #[serde(default, deserialize_with = "lenient_option")]
    logo: Option<String>,
    #[serde(default, deserialize_with = "lenient_option")]
    version: Option<String>,
    #[serde(default, deserialize_with = "lenient_option")]
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawResource {
    Name(String),
    Object {
        name: Option<String>,
        #[serde(default, deserialize_with = "deserialize_optional_string_list")]
        types: Option<Vec<String>>,
        #[serde(default, alias = "idPrefixes")]
        id_prefixes: serde_json::Value,
    },
}

#[derive(Debug, Deserialize)]
struct RawCatalog {
    #[serde(rename = "type")]
    type_: Option<String>,
    id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_item_list")]
    extra: Vec<RawExtra>,
    #[serde(
        default,
        alias = "extraSupported",
        deserialize_with = "deserialize_item_list"
    )]
    extra_supported: Vec<String>,
    #[serde(
        default,
        alias = "extraRequired",
        deserialize_with = "deserialize_item_list"
    )]
    extra_required: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RawExtra {
    #[serde(default, deserialize_with = "lenient_option")]
    name: Option<String>,
    #[serde(default, alias = "isRequired")]
    is_required: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_item_list")]
    options: Vec<String>,
}

fn normalize_opaque(value: String, max_chars: usize) -> Option<String> {
    if value.trim().chars().nth(max_chars).is_some() {
        return None;
    }
    bound_optional(Some(value), max_chars)
}

fn normalize_opaque_list(
    values: impl IntoIterator<Item = String>,
    max_chars: usize,
    max_items: usize,
) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    values
        .into_iter()
        .filter_map(|value| normalize_opaque(value, max_chars))
        .filter(|item| seen.insert(item.clone()))
        .take(max_items.max(1))
        .collect()
}

fn normalize_id_prefixes(value: serde_json::Value) -> Option<Vec<String>> {
    let values = match value {
        serde_json::Value::Null => return Some(Vec::new()),
        serde_json::Value::Array(values) => values,
        _ => return None,
    };
    let restricted = !values.is_empty();
    let prefixes = normalize_opaque_list(
        values.into_iter().filter_map(|value| match value {
            serde_json::Value::String(value) => Some(value),
            _ => None,
        }),
        MAX_PREFIX_CHARS,
        MAX_PREFIXES,
    );
    (!restricted || !prefixes.is_empty()).then_some(prefixes)
}

fn normalize_catalog(raw: RawCatalog) -> Option<AddonCatalogCapability> {
    let type_ = normalize_opaque(raw.type_?, MAX_TYPE_CHARS)?;
    let id = normalize_opaque(raw.id?, MAX_CATALOG_ID_CHARS)?;

    let mut required = Vec::<String>::new();
    for name in raw.extra_required.iter().map(String::as_str).chain(
        raw.extra
            .iter()
            .filter(|extra| extra.is_required == Some(true))
            .map(|extra| extra.name.as_deref().unwrap_or_default()),
    ) {
        let name = name.trim();
        if name.is_empty() || name.chars().nth(MAX_EXTRA_NAME_CHARS).is_some() {
            return None;
        }
        if !required.iter().any(|item| item.eq_ignore_ascii_case(name)) {
            if required.len() == MAX_EXTRAS {
                return None;
            }
            required.push(name.to_string());
        }
    }
    let mut extras = Vec::new();
    let mut seen_extras = std::collections::HashSet::new();

    // Objects keep their options; legacy required names also declare supported inputs.
    let extra_source = raw.extra.into_iter().chain(
        raw.extra_supported
            .into_iter()
            .chain(required.iter().cloned())
            .map(|name| RawExtra {
                name: Some(name),
                is_required: None,
                options: Vec::new(),
            }),
    );

    for extra in extra_source {
        let Some(name) = extra
            .name
            .and_then(|name| normalize_opaque(name, MAX_EXTRA_NAME_CHARS))
        else {
            continue;
        };
        // Extra names match case-insensitively at request time — dedupe the same way.
        if !seen_extras.insert(name.to_ascii_lowercase()) {
            continue;
        }

        extras.push(AddonCatalogExtra {
            is_required: required.iter().any(|item| item.eq_ignore_ascii_case(&name)),
            name,
            options: normalize_opaque_list(
                extra.options,
                MAX_EXTRA_OPTION_CHARS,
                MAX_EXTRA_OPTIONS,
            ),
        });

        if extras.len() >= MAX_EXTRAS {
            break;
        }
    }

    required
        .iter()
        .all(|name| {
            extras
                .iter()
                .any(|extra| extra.name.eq_ignore_ascii_case(name))
        })
        .then_some(AddonCatalogCapability { type_, id, extras })
}

fn normalize_catalogs(raw_catalogs: Vec<RawCatalog>) -> Vec<AddonCatalogCapability> {
    let mut seen = std::collections::HashSet::new();
    raw_catalogs
        .into_iter()
        .filter_map(normalize_catalog)
        .filter(|catalog| seen.insert((catalog.type_.to_ascii_lowercase(), catalog.id.clone())))
        .take(MAX_CATALOGS)
        .collect()
}

fn normalize_resource(
    raw: RawResource,
    manifest_types: &[String],
    manifest_prefixes: Option<&[String]>,
) -> Option<AddonResourceCapability> {
    let (name, types, prefixes) = match raw {
        RawResource::Name(name) => (
            name,
            manifest_types.to_vec(),
            manifest_prefixes.map(<[String]>::to_vec),
        ),
        RawResource::Object {
            name,
            types,
            id_prefixes,
        } => (
            name.unwrap_or_default(),
            types
                .map(|values| normalize_opaque_list(values, MAX_TYPE_CHARS, MAX_TYPES))
                .unwrap_or_else(|| manifest_types.to_vec()),
            // Addon protocol object resources use only their own prefixes; absent or empty accepts any id.
            normalize_id_prefixes(id_prefixes),
        ),
    };
    let mut name = normalize_opaque(name, MAX_RESOURCE_CHARS)?;
    name.make_ascii_lowercase();
    Some(AddonResourceCapability {
        name,
        // Keep invalid scopes classified so registry fallback cannot turn them into unrestricted addons.
        types: if prefixes.is_some() {
            types
        } else {
            Vec::new()
        },
        id_prefixes: prefixes.unwrap_or_default(),
    })
}

#[cfg(test)]
pub(crate) fn parse_addon_manifest(bytes: &[u8]) -> Result<AddonManifest, String> {
    parse_addon_manifest_checked(bytes, false)
}

fn parse_addon_manifest_checked(
    bytes: &[u8],
    require_configured: bool,
) -> Result<AddonManifest, String> {
    if bytes.len() > MANIFEST_MAX_BYTES {
        return Err(MANIFEST_TOO_LARGE_ERROR.to_string());
    }

    let raw: RawManifest =
        serde_json::from_slice(bytes).map_err(|_| "Invalid addon manifest format.".to_string())?;

    let behavior_hint = |name: &str| {
        raw.behavior_hints
            .get(name)
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    };
    if require_configured && behavior_hint("configurationRequired") {
        return Err(ADDON_CONFIGURATION_REQUIRED_MESSAGE.to_string());
    }
    let configurable = behavior_hint("configurable");

    let types = normalize_opaque_list(raw.types, MAX_TYPE_CHARS, MAX_TYPES);
    let id_prefixes = normalize_id_prefixes(raw.id_prefixes);

    let mut resources = Vec::new();
    for raw_resource in raw.resources {
        let Some(resource) = normalize_resource(raw_resource, &types, id_prefixes.as_deref())
        else {
            continue;
        };
        if resources.contains(&resource) {
            continue;
        }
        resources.push(resource);
        if resources.len() >= MAX_RESOURCES {
            break;
        }
    }

    let name = trim_to_max(raw.name.as_deref().unwrap_or(""), MAX_NAME_CHARS)
        .ok_or_else(|| "Invalid addon manifest format.".to_string())?;

    Ok(AddonManifest {
        name,
        resources,
        catalogs: normalize_catalogs(raw.catalogs),
        logo: raw.logo.as_deref().and_then(normalize_image_url),
        version: bound_optional(raw.version, MAX_VERSION_CHARS),
        description: bound_optional(raw.description, MAX_DESCRIPTION_CHARS),
        configurable,
    })
}

pub(crate) fn build_manifest_url(normalized_base: &str) -> Result<String, String> {
    let mut parsed =
        reqwest::Url::parse(normalized_base).map_err(|_| ADDON_URL_INVALID_MESSAGE.to_string())?;
    let trimmed_path = parsed.path().trim_end_matches('/');
    let manifest_path = if has_manifest_suffix(trimmed_path) {
        trimmed_path.to_string()
    } else {
        format!("{trimmed_path}{MANIFEST_JSON_SUFFIX}")
    };
    parsed.set_path(&manifest_path);
    Ok(parsed.into())
}

/// Addon convention: the configure page sits where `manifest.json` would, query kept.
pub(crate) fn build_configure_url(normalized_base: &str) -> Result<String, String> {
    let mut parsed =
        reqwest::Url::parse(normalized_base).map_err(|_| ADDON_URL_INVALID_MESSAGE.to_string())?;
    let configure_path = format!("{}/configure", strip_manifest_suffix(parsed.path()));
    parsed.set_path(&configure_path);
    Ok(parsed.into())
}

/// Resource kinds a snapshot serves, in display order. `catalogs[]` is
/// authoritative for catalogs; a resource declaring no types serves nothing.
pub(crate) fn snapshot_resource_kinds(snapshot: &AddonManifest) -> Vec<AddonResourceKind> {
    let serves = |name: &str| {
        snapshot
            .resources
            .iter()
            .any(|resource| resource.name == name && !resource.types.is_empty())
    };
    [
        (AddonResourceKind::Catalog, !snapshot.catalogs.is_empty()),
        (AddonResourceKind::Meta, serves("meta")),
        (AddonResourceKind::Stream, serves("stream")),
        (AddonResourceKind::Subtitles, serves("subtitles")),
    ]
    .into_iter()
    .filter_map(|(kind, served)| served.then_some(kind))
    .collect()
}

pub(crate) fn snapshot_supports_request(
    snapshot: &AddonManifest,
    resource: &str,
    media_type: &str,
    media_id: &str,
) -> bool {
    let resource_name = resource.trim();
    let media_type = media_type.trim();
    if media_type.is_empty() || media_type.chars().nth(MAX_TYPE_CHARS).is_some() {
        return false;
    }
    let media_id = media_id.trim();
    if media_id.is_empty() {
        return false;
    }

    snapshot.resources.iter().any(|capability| {
        capability.name.eq_ignore_ascii_case(resource_name)
            && capability
                .types
                .iter()
                .any(|item| item.eq_ignore_ascii_case(media_type))
            && (resource_name.eq_ignore_ascii_case("catalog")
                || capability.id_prefixes.is_empty()
                || capability.id_prefixes.iter().any(|prefix| {
                    media_id
                        .get(..prefix.len())
                        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
                }))
    })
}

pub(crate) fn snapshot_is_classified(snapshot: &AddonManifest) -> bool {
    // A name-only snapshot isn't classified — it would block routing while
    // never triggering a refetch. `catalogs[]` counts on its own (catalogs-only
    // manifests legitimately omit `resources`).
    non_blank(&snapshot.name) && (!snapshot.resources.is_empty() || !snapshot.catalogs.is_empty())
}

pub(crate) async fn fetch_addon_manifest_snapshot(
    client: &reqwest::Client,
    normalized_base: &str,
    require_configured: bool,
) -> Result<AddonManifest, String> {
    let manifest_url = build_manifest_url(normalized_base)?;
    let response = client
        .get(manifest_url)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|error| format!("Failed to reach addon: {}", error.without_url()))?;

    if !response.status().is_success() {
        return Err(format!(
            "Addon returned HTTP {}. Check the URL and try again.",
            response.status().as_u16()
        ));
    }

    let bytes = super::read_bounded_body(response, MANIFEST_MAX_BYTES, |_| {
        MANIFEST_TOO_LARGE_ERROR.to_string()
    })
    .await
    .map_err(|error| error.into_message())?;

    tokio::task::spawn_blocking(move || parse_addon_manifest_checked(&bytes, require_configured))
        .await
        .map_err(|_| "Addon manifest response processing task failed.".to_string())?
}

#[cfg(test)]
mod tests;
