use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Saturating `usize` → `u64` widening for response-size budget comparisons.
pub(crate) fn usize_to_u64_saturating(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

/// Trim + char-bound + empty-reject for untrusted provider fields.
pub(crate) fn trim_to_max(value: &str, max_chars: usize) -> Option<String> {
    let trimmed: String = value.trim().chars().take(max_chars).collect();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// `trim_to_max` for optional fields — an all-empty result becomes `None`.
pub(crate) fn bound_optional(value: Option<String>, max_chars: usize) -> Option<String> {
    value.and_then(|value| {
        // Byte length bounds char count: an already-trimmed short value keeps its buffer.
        if !value.is_empty() && value.len() <= max_chars && value.trim().len() == value.len() {
            Some(value)
        } else {
            trim_to_max(&value, max_chars)
        }
    })
}

/// Whitespace-only text counts as missing.
pub(crate) fn non_blank(value: &str) -> bool {
    !value.trim().is_empty()
}

/// `non_blank` for optional fields, for `or_else` fallback chains.
pub(crate) fn non_blank_opt(value: Option<&str>) -> Option<&str> {
    value.filter(|text| non_blank(text))
}

/// `/manifest.json` suffix for addon-URL normalization (case-insensitive, trailing-slash tolerant).
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

/// Dedup-push for ordered string sets; empty values never enter.
pub(crate) fn push_unique(values: &mut Vec<String>, value: &str) {
    if value.is_empty() || values.iter().any(|existing| existing == value) {
        return;
    }

    values.push(value.to_string());
}

/// Poison-recovering mutex lock: a panicking holder must not wedge later callers.
pub(crate) fn lock_or_recover<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Shared retry contract: one back-off retry before a transport failure earns
/// `FetchFailureCooldown`; a full-timeout attempt skips the retry.
pub(crate) const FETCH_ATTEMPTS: u8 = 2;
pub(crate) const FETCH_RETRY_BACKOFF: Duration = Duration::from_millis(800);

/// `TooLarge` is deterministic (a retry re-reads the same bytes); `Read` is a
/// transient mid-stream error. Callers classify by variant, not message text.
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
/// so oversized untrusted payloads are rejected before allocation.
/// `too_large_error` receives the declared content length when sent.
pub(crate) async fn read_bounded_body(
    response: reqwest::Response,
    max_bytes: usize,
    too_large_error: impl Fn(Option<u64>) -> String,
) -> Result<Vec<u8>, BoundedBodyError> {
    let declared_length = response.content_length();
    if declared_length.is_some_and(|length| length > usize_to_u64_saturating(max_bytes)) {
        return Err(BoundedBodyError::TooLarge(too_large_error(declared_length)));
    }

    // Pre-size from the declared length; chunked reads would otherwise double-grow up to the cap.
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
    // `None` omits rather than emits `null` — the TS contract is `field?: T`.
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
    /// Ranking signal re-derived from `year` on load — serialized for sorting;
    /// inbound values are ignored (every ingress re-derives it).
    #[serde(
        rename = "primaryYear",
        skip_serializing_if = "Option::is_none",
        skip_deserializing
    )]
    pub primary_year: Option<u32>,
    #[serde(rename = "displayYear", skip_serializing_if = "Option::is_none")]
    pub display_year: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genres: Option<Vec<String>>,
    #[serde(rename = "type")]
    pub type_: String,
}

// Serialize-only: meta payloads are parsed field-by-field (`parse_meta_item`),
// never serde-decoded — untrusted input can't reach `release_date`.
#[derive(Debug, Serialize, Clone)]
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
    /// `build_media_schedule` input only — never crosses IPC.
    #[serde(skip_serializing)]
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
    /// Season summary of the sorted `episodes` — populated iff `episodes` is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seasons: Option<Vec<MediaSeason>>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaSeason {
    pub number: u32,
    pub episode_count: u32,
}

#[derive(Debug, Serialize, Clone)]
pub(crate) struct Trailer {
    /// Strict 11-char YouTube video id; the frontend builds the embed URL.
    pub id: String,
}

#[derive(Debug, Serialize, Clone)]
pub(crate) struct Episode {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub season: u32,
    pub episode: u32,
    /// Raw addon air date; only the normalized `release_date` crosses IPC.
    #[serde(skip_serializing)]
    pub released: Option<String>,
    #[serde(rename = "releaseDate", skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    /// Backend-normalized playback lookup ID.
    #[serde(rename = "streamLookupId", skip_serializing_if = "Option::is_none")]
    pub stream_lookup_id: Option<String>,
    /// Backend-normalized source season for stream resolution.
    #[serde(rename = "streamSeason", skip_serializing_if = "Option::is_none")]
    pub stream_season: Option<u32>,
    /// Backend-normalized source episode for stream resolution.
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

/// First 4-ASCII-digit run at or after `start`, with the run's start index so
/// a caller can resume one byte later ("1232019" skips 1232, finds 2019).
fn first_ascii_year_run_from(text: &str, start: usize) -> Option<(usize, u32)> {
    let bytes = text.as_bytes();
    if bytes.len() < 4 || start > bytes.len() - 4 {
        return None;
    }

    for index in start..=bytes.len() - 4 {
        if !text.is_char_boundary(index) || !text.is_char_boundary(index + 4) {
            continue;
        }

        let year_text = &text[index..index + 4];
        if !year_text.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }

        if let Ok(year) = year_text.parse::<u32>() {
            return Some((index, year));
        }
    }

    None
}

/// Raw first-4-ASCII-digit-run scan — no range policy; callers own any bounds.
pub(crate) fn first_ascii_year_run(text: &str) -> Option<u32> {
    first_ascii_year_run_from(text, 0).map(|(_, year)| year)
}

pub(crate) fn extract_primary_year(value: Option<&str>) -> Option<u32> {
    let value = value?.trim();
    // An out-of-bounds run doesn't end the scan: the first in-bounds run wins.
    let mut start = 0;
    while let Some((index, year)) = first_ascii_year_run_from(value, start) {
        if (1889..=2100).contains(&year) {
            return Some(year);
        }
        start = index + 1;
    }

    None
}

/// reqwest runs `rustls-no-provider`: install the ring provider before any
/// `Client` builds (idempotent).
pub(crate) fn ensure_rustls_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub(crate) fn build_provider_http_client(max_idle_per_host: Option<usize>) -> Client {
    ensure_rustls_crypto_provider();
    // Generic provider identity; the addon transport keeps its own Chrome version.
    let mut builder = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .redirect(fetch_policy::ssrf_redirect_policy())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .pool_idle_timeout(Duration::from_secs(90));

    if let Some(max_idle_per_host) = max_idle_per_host {
        builder = builder.pool_max_idle_per_host(max_idle_per_host);
    }

    // Fail closed: a fallback client would silently drop the SSRF redirect policy.
    builder.build().expect("provider HTTP client must build")
}
