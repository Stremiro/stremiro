use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Saturating `usize` widening for response-size budget comparisons. Budgets
/// fit in `u64` on every target, so saturation only guards the abstract case.
pub(crate) fn usize_to_u64_saturating(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

/// Trim, char-bound, and empty-reject for untrusted provider fields. Single
/// owner: addon manifests, catalog payloads, and resource extras are all
/// bounded the same way.
pub(crate) fn trim_to_max(value: &str, max_chars: usize) -> Option<String> {
    let trimmed: String = value.trim().chars().take(max_chars).collect();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// `trim_to_max` for optional fields: an all-empty result drops to `None`
/// rather than persisting whitespace. Shared by media normalization,
/// watch-progress persistence, and track-language candidate bounding.
pub(crate) fn bound_optional(value: Option<String>, max_chars: usize) -> Option<String> {
    value.and_then(|value| trim_to_max(&value, max_chars))
}

/// Whitespace-only text counts as missing. Single owner for the trim-gate
/// every optional identity field shares (lookup ids, stream keys, source
/// and family identity, info hashes, snapshot names, truncated fields).
pub(crate) fn non_blank(value: &str) -> bool {
    !value.trim().is_empty()
}

/// `non_blank` for optional fields: keeps the original text when present
/// and non-blank — the Option-shaped variant for `or_else` fallback chains.
pub(crate) fn non_blank_opt(value: Option<&str>) -> Option<&str> {
    value.filter(|text| non_blank(text))
}

/// `/manifest.json` suffix shared by every addon-URL normalization path:
/// manifest-URL building, resource-URL building, registry persistence, and
/// transport pre-trim (case-insensitive, trailing-slash tolerant).
pub(crate) const MANIFEST_JSON_SUFFIX: &str = "/manifest.json";

pub(crate) fn has_manifest_suffix(path: &str) -> bool {
    let trimmed = path.trim_end_matches('/');
    trimmed.len() >= MANIFEST_JSON_SUFFIX.len()
        && trimmed
            .get(trimmed.len() - MANIFEST_JSON_SUFFIX.len()..)
            .is_some_and(|suffix| suffix.eq_ignore_ascii_case(MANIFEST_JSON_SUFFIX))
}

pub(crate) fn strip_manifest_suffix(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if has_manifest_suffix(trimmed) {
        &trimmed[..trimmed.len() - MANIFEST_JSON_SUFFIX.len()]
    } else {
        trimmed
    }
}

/// Dedup-push for ordered string sets (language candidates, stream query
/// ids). Empty values never enter the set.
pub(crate) fn push_unique(values: &mut Vec<String>, value: &str) {
    if value.is_empty() || values.iter().any(|existing| existing == value) {
        return;
    }

    values.push(value.to_string());
}

/// Poison-recovering mutex lock for every in-memory state lock (registry
/// memo, addon cache, playback runtime): a panicking holder can never wedge
/// later callers.
pub(crate) fn lock_or_recover<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// How `read_bounded_body` failed. `TooLarge` is deterministic for the
/// endpoint — a retry re-reads the same bytes and fails the same way —
/// while `Read` is a mid-stream transport error a retry can legitimately
/// recover from. Callers classify by variant instead of comparing message
/// strings.
pub(crate) enum BoundedBodyError {
    TooLarge(String),
    Read(String),
}

impl BoundedBodyError {
    pub(crate) fn into_message(self) -> String {
        match self {
            Self::TooLarge(message) | Self::Read(message) => message,
        }
    }
}

/// Read a response body with a content-length pre-check and a streaming cap
/// so oversized untrusted payloads are rejected before allocation. Single
/// owner for addon, manifest, and skip-times fetch paths. `too_large_error`
/// receives the declared content length when the server sent one.
pub(crate) async fn read_bounded_body(
    response: reqwest::Response,
    max_bytes: usize,
    too_large_error: impl Fn(Option<u64>) -> String,
) -> Result<Vec<u8>, BoundedBodyError> {
    let declared_length = response.content_length();
    if declared_length.is_some_and(|length| length > usize_to_u64_saturating(max_bytes)) {
        return Err(BoundedBodyError::TooLarge(too_large_error(declared_length)));
    }

    // Pre-size from the declared length: chunked reads otherwise grow by
    // doubling through up to the max-byte bound.
    let mut bytes = Vec::with_capacity(
        declared_length
            .unwrap_or(0)
            .min(usize_to_u64_saturating(max_bytes)) as usize,
    );
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk
            .map_err(|_| BoundedBodyError::Read("Failed to read response body.".to_string()))?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(BoundedBodyError::TooLarge(too_large_error(None)));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct MediaItem {
    pub id: String,
    pub title: String,
    // `None` fields omit rather than emit `null` — the TS contract is
    // `field?: T`, and absent keeps `=== undefined` guards truthful.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backdrop: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
    /// Ranking/filter signal — internal only: `normalize_media_item`
    /// re-derives it from `year` on every load, so it never needs to cross
    /// the wire or persist.
    #[serde(rename = "primaryYear", skip_serializing)]
    pub primary_year: Option<u32>,
    #[serde(rename = "displayYear", skip_serializing_if = "Option::is_none")]
    pub display_year: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genres: Option<Vec<String>>,
    #[serde(rename = "type")]
    pub type_: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct MediaDetails {
    pub id: String,
    #[serde(rename = "imdbId", default, skip_serializing_if = "Option::is_none")]
    pub imdb_id: Option<String>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backdrop: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
    #[serde(rename = "displayYear", skip_serializing_if = "Option::is_none")]
    pub display_year: Option<String>,
    /// `build_media_schedule` input only — consumed in-process, never read
    /// webview-side.
    #[serde(rename = "releaseDate", skip_serializing)]
    pub release_date: Option<String>,
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cast: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genres: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trailers: Option<Vec<Trailer>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episodes: Option<Vec<Episode>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct Trailer {
    pub id: String,
    pub source: String,
    pub url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct Episode {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub season: u32,
    pub episode: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released: Option<String>,
    #[serde(rename = "releaseDate", skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    /// Backend-normalized playback lookup ID for this episode.
    #[serde(rename = "streamLookupId", skip_serializing_if = "Option::is_none")]
    pub stream_lookup_id: Option<String>,
    /// Backend-normalized source season used when resolving streams for this episode.
    #[serde(rename = "streamSeason", skip_serializing_if = "Option::is_none")]
    pub stream_season: Option<u32>,
    /// Backend-normalized source episode used when resolving streams for this episode.
    #[serde(rename = "streamEpisode", skip_serializing_if = "Option::is_none")]
    pub stream_episode: Option<u32>,
}

pub(crate) mod addon_manifest;
pub(crate) mod addon_resource;
pub(crate) mod addons;
pub(crate) mod fetch_policy;
pub(crate) mod skip_times;
pub(crate) mod ttl_cache;

pub(crate) fn normalize_media_year(
    year: Option<String>,
    release_info: Option<String>,
) -> Option<String> {
    bound_optional(year, usize::MAX).or_else(|| bound_optional(release_info, usize::MAX))
}

pub(crate) fn extract_primary_year(value: Option<&str>) -> Option<u32> {
    let value = value?.trim();
    let bytes = value.as_bytes();
    if bytes.len() < 4 {
        return None;
    }

    for index in 0..=bytes.len() - 4 {
        if !value.is_char_boundary(index) || !value.is_char_boundary(index + 4) {
            continue;
        }

        let year_text = &value[index..index + 4];
        if !year_text.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }

        let Ok(year) = year_text.parse::<u32>() else {
            continue;
        };

        if (1889..=2100).contains(&year) {
            return Some(year);
        }
    }

    None
}

/// reqwest runs `rustls-no-provider` (one TLS stack shared with the updater):
/// install the ring crypto provider before any `Client` is built. Idempotent —
/// `install_default` errors when a provider is already set.
pub(crate) fn ensure_rustls_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub(crate) fn build_provider_http_client(max_idle_per_host: Option<usize>) -> Client {
    ensure_rustls_crypto_provider();
    // Generic provider fetch identity — the addon transport keeps its own,
    // newer Chrome version (see `AddonTransport::new`); don't merge them.
    let mut builder = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .redirect(fetch_policy::ssrf_redirect_policy())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .pool_idle_timeout(Duration::from_secs(90));

    if let Some(max_idle_per_host) = max_idle_per_host {
        builder = builder.pool_max_idle_per_host(max_idle_per_host);
    }

    // Fail closed: a `Client::new()` fallback would silently drop the SSRF
    // redirect policy installed above.
    builder.build().expect("provider HTTP client must build")
}
