use super::addons::sanitize_addon_log;
use super::{has_manifest_suffix, non_blank, trim_to_max, MANIFEST_JSON_SUFFIX};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const MANIFEST_MAX_BYTES: usize = 512 * 1024;
const MANIFEST_TOO_LARGE_ERROR: &str = "Addon manifest exceeds the 512 KiB size limit.";
const MAX_NAME_CHARS: usize = 128;
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

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddonManifest {
    pub name: String,
    #[serde(default)]
    pub resources: Vec<AddonResourceCapability>,
    // Manifest-level `types`/`idPrefixes` are parse-time inheritance inputs
    // only — every consumer reads the resource-level copies, so they are not
    // retained on the snapshot.
    #[serde(default)]
    pub catalogs: Vec<AddonCatalogCapability>,
}

fn deserialize_item_list<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: DeserializeOwned,
{
    let Some(value) = Option::<serde_json::Value>::deserialize(deserializer)? else {
        return Ok(Vec::new());
    };
    let serde_json::Value::Array(items) = value else {
        return Ok(Vec::new());
    };

    Ok(items
        .into_iter()
        .filter_map(|item| serde_json::from_value(item).ok())
        .collect())
}

fn deserialize_string_list<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_item_list::<D, String>(deserializer)
}

fn deserialize_optional_string_list<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(deserialize_string_list(deserializer)?))
}

#[derive(Debug, Deserialize)]
struct RawManifest {
    name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_item_list")]
    resources: Vec<RawResource>,
    #[serde(default, deserialize_with = "deserialize_string_list")]
    types: Vec<String>,
    #[serde(
        default,
        alias = "idPrefixes",
        deserialize_with = "deserialize_string_list"
    )]
    id_prefixes: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_item_list")]
    catalogs: Vec<RawCatalog>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawResource {
    Name(String),
    Object {
        name: Option<String>,
        #[serde(default, deserialize_with = "deserialize_optional_string_list")]
        types: Option<Vec<String>>,
        #[serde(
            default,
            alias = "idPrefixes",
            deserialize_with = "deserialize_optional_string_list"
        )]
        id_prefixes: Option<Vec<String>>,
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
        deserialize_with = "deserialize_string_list"
    )]
    extra_supported: Vec<String>,
    #[serde(
        default,
        alias = "extraRequired",
        deserialize_with = "deserialize_string_list"
    )]
    extra_required: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RawExtra {
    name: Option<String>,
    #[serde(default, alias = "isRequired")]
    is_required: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_string_list")]
    options: Vec<String>,
}

fn normalize_opaque_list(
    values: impl IntoIterator<Item = String>,
    max_chars: usize,
    max_items: usize,
) -> Vec<String> {
    let mut normalized = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for value in values {
        let Some(item) = trim_to_max(&value, max_chars) else {
            continue;
        };
        if !seen.insert(item.clone()) {
            continue;
        }
        normalized.push(item);
        if normalized.len() >= max_items {
            break;
        }
    }

    normalized
}

fn normalize_resource_name(value: &str) -> Option<String> {
    trim_to_max(value, MAX_RESOURCE_CHARS).map(|name| name.to_ascii_lowercase())
}

fn catalog_identity_key(type_: &str, id: &str) -> String {
    format!(
        "{}\u{1f}{}",
        type_.to_ascii_lowercase(),
        id.to_ascii_lowercase()
    )
}

fn normalize_catalog(raw: RawCatalog) -> Option<AddonCatalogCapability> {
    let type_ = trim_to_max(raw.type_.as_deref().unwrap_or(""), MAX_TYPE_CHARS)?;
    let id = trim_to_max(raw.id.as_deref().unwrap_or(""), MAX_CATALOG_ID_CHARS)?;

    let required = normalize_opaque_list(raw.extra_required, MAX_EXTRA_NAME_CHARS, MAX_EXTRAS);
    let mut extras = Vec::new();
    let mut seen_extras = std::collections::HashSet::new();

    // `extra` (object list) and `extraSupported` (bare names) are
    // complementary declarations — option-bearing extras live in the
    // former while names like `search`/`skip` often appear only in the
    // latter. Merge both (objects win the dedupe on name collision so
    // their options survive); picking one would lose capabilities.
    let extra_source: Vec<RawExtra> = raw
        .extra
        .into_iter()
        .chain(raw.extra_supported.into_iter().filter_map(|name| {
            trim_to_max(&name, MAX_EXTRA_NAME_CHARS).map(|name| RawExtra {
                name: Some(name),
                is_required: None,
                options: Vec::new(),
            })
        }))
        .collect();

    for extra in extra_source {
        let Some(name) = trim_to_max(extra.name.as_deref().unwrap_or(""), MAX_EXTRA_NAME_CHARS)
        else {
            continue;
        };
        // Extra names match case-insensitively at request time, so dedupe
        // them the same way (`Genre` + `genre` is one extra, not two).
        if !seen_extras.insert(name.to_ascii_lowercase()) {
            continue;
        }

        extras.push(AddonCatalogExtra {
            is_required: extra.is_required.unwrap_or(false)
                || required.iter().any(|item| item.eq_ignore_ascii_case(&name)),
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

    Some(AddonCatalogCapability { type_, id, extras })
}

fn normalize_catalogs(raw_catalogs: Vec<RawCatalog>) -> Vec<AddonCatalogCapability> {
    let mut catalogs = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for raw in raw_catalogs {
        let Some(catalog) = normalize_catalog(raw) else {
            continue;
        };
        if !seen.insert(catalog_identity_key(&catalog.type_, &catalog.id)) {
            continue;
        }
        catalogs.push(catalog);
        if catalogs.len() >= MAX_CATALOGS {
            break;
        }
    }

    catalogs
}

fn normalize_resource(
    raw: RawResource,
    manifest_types: &[String],
    manifest_prefixes: &[String],
) -> Option<AddonResourceCapability> {
    match raw {
        RawResource::Name(name) => Some(AddonResourceCapability {
            name: normalize_resource_name(&name)?,
            types: manifest_types.to_vec(),
            id_prefixes: manifest_prefixes.to_vec(),
        }),
        RawResource::Object {
            name,
            types,
            id_prefixes,
        } => Some(AddonResourceCapability {
            name: normalize_resource_name(name.as_deref().unwrap_or(""))?,
            types: types
                .map(|values| normalize_opaque_list(values, MAX_TYPE_CHARS, MAX_TYPES))
                .unwrap_or_else(|| manifest_types.to_vec()),
            // An absent resource-level `idPrefixes` inherits the manifest's,
            // like `types` above: otherwise a `tt`-prefixed addon would get
            // queried for `kitsu:`/`local:` ids it cannot serve. An explicit
            // empty list stays the "serves any id" opt-out.
            id_prefixes: id_prefixes
                .map(|values| normalize_opaque_list(values, MAX_PREFIX_CHARS, MAX_PREFIXES))
                .unwrap_or_else(|| manifest_prefixes.to_vec()),
        }),
    }
}

pub(crate) fn parse_addon_manifest(bytes: &[u8]) -> Result<AddonManifest, String> {
    if bytes.len() > MANIFEST_MAX_BYTES {
        return Err(MANIFEST_TOO_LARGE_ERROR.to_string());
    }

    let raw: RawManifest =
        serde_json::from_slice(bytes).map_err(|_| "Invalid addon manifest format.".to_string())?;

    let types = normalize_opaque_list(raw.types, MAX_TYPE_CHARS, MAX_TYPES);
    let id_prefixes = normalize_opaque_list(raw.id_prefixes, MAX_PREFIX_CHARS, MAX_PREFIXES);

    let mut resources = Vec::new();
    let mut seen_resources = std::collections::HashSet::new();
    for raw_resource in raw.resources {
        let Some(resource) = normalize_resource(raw_resource, &types, &id_prefixes) else {
            continue;
        };
        if !seen_resources.insert(resource.name.clone()) {
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
    })
}

pub(crate) fn build_manifest_url(normalized_base: &str) -> Result<String, String> {
    let mut parsed = reqwest::Url::parse(normalized_base).map_err(|_| {
        "Invalid addon URL. Please provide a valid http(s) or stremio:// URL.".to_string()
    })?;
    let query = parsed.query().map(|value| value.to_string());
    let trimmed_path = parsed.path().trim_end_matches('/');
    let already_manifest = has_manifest_suffix(trimmed_path);
    let manifest_path = if trimmed_path.is_empty() {
        MANIFEST_JSON_SUFFIX.to_string()
    } else if already_manifest {
        trimmed_path.to_string()
    } else {
        format!("{trimmed_path}{MANIFEST_JSON_SUFFIX}")
    };
    parsed.set_path(&manifest_path);
    parsed.set_query(query.as_deref());
    Ok(parsed.to_string())
}

pub(crate) fn snapshot_supports_request(
    snapshot: &AddonManifest,
    resource: &str,
    media_type: &str,
    media_id: &str,
) -> bool {
    let Some(resource_name) = normalize_resource_name(resource) else {
        return false;
    };
    let Some(media_type) = trim_to_max(media_type, MAX_TYPE_CHARS) else {
        return false;
    };
    let media_id = media_id.trim();
    if media_id.is_empty() {
        return false;
    }

    let Some(capability) = snapshot
        .resources
        .iter()
        .find(|item| item.name == resource_name)
    else {
        return false;
    };

    if capability.types.is_empty()
        || !capability
            .types
            .iter()
            .any(|item| item.eq_ignore_ascii_case(&media_type))
    {
        return false;
    }

    if resource_name == "catalog" {
        return true;
    }

    capability.id_prefixes.is_empty() || {
        capability.id_prefixes.iter().any(|prefix| {
            media_id
                .get(..prefix.len())
                .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        })
    }
}

pub(crate) fn snapshot_is_classified(snapshot: &AddonManifest) -> bool {
    // A display-only snapshot (name without any capability declaration) must
    // not count as classified: it would otherwise block all catalog/meta/
    // search routing while never triggering a refetch. `catalogs[]` counts on
    // its own — the (type, id) pair is the strongest capability statement a
    // manifest makes, and catalogs-only manifests legitimately omit the
    // redundant `resources` entry.
    non_blank(&snapshot.name) && (!snapshot.resources.is_empty() || !snapshot.catalogs.is_empty())
}

pub(crate) async fn fetch_addon_manifest_snapshot(
    client: &reqwest::Client,
    normalized_base: &str,
) -> Result<AddonManifest, String> {
    let manifest_url = build_manifest_url(normalized_base)?;
    let response = client
        .get(manifest_url)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|error| {
            format!(
                "Failed to reach addon: {}",
                sanitize_addon_log(&error.to_string())
            )
        })?;

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

    parse_addon_manifest(&bytes)
}

#[cfg(test)]
mod tests;
