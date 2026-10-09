use super::{AddonStream, MAX_PROXY_HEADERS_BYTES};
use crate::providers::addon_resource::{build_resource_url, is_fetchable_http_url, is_magnet_url};
use crate::providers::ttl_cache::{
    hash_segment, FetchContract, FetchFailure, FetchFailureCooldown, InFlight, TtlCache,
};
use crate::providers::{ensure_rustls_crypto_provider, fetch_policy, non_blank, read_bounded_body};
use regex::Regex;
use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

static SEEDER_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"👤\s*(\d+)").expect("valid seeder regex"));
static SIZE_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"💾\s*([\d\.]+)\s*([KMGT]B)").expect("valid size regex"));
/// Fallback size regex for addons that use plain-text format (e.g. "1.2 GB") without emoji.
static PLAIN_SIZE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|\s)([\d\.]+)\s*([KMGT]i?B)\b").expect("valid plain size regex")
});

/// `infoHash` persists inside `last_stream_key` (128-char cap): an unbounded
/// addon-supplied hash would silently break the saved-stream round-trip.
const INFO_HASH_MAX_CHARS: usize = 112;

/// Deterministic cache segment from the addon config URL so different addons
/// never share an entry for the same content.
pub(super) fn config_cache_segment(config_url: &str) -> String {
    let url = config_url.trim();
    if url.is_empty() {
        return "cfg:default".to_string();
    }
    format!("cfg:{}", hash_segment(url))
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct RawStreamResponse {
    #[serde(default)]
    streams: Vec<Value>,
}

/// Decode one response body item-by-item so a single malformed sibling does
/// not discard valid streams. Applies per-field truncation before use.
pub(super) fn decode_stream_items(bytes: &[u8]) -> Result<Vec<AddonStream>, String> {
    let body: RawStreamResponse =
        serde_json::from_slice(bytes).map_err(|_| "Invalid stream response format.".to_string())?;
    Ok(body
        .streams
        .into_iter()
        .filter_map(|item| serde_json::from_value::<AddonStream>(item).ok())
        .take(DECODED_STREAMS_MAX)
        .map(|mut stream| {
            truncate_stream_item(&mut stream);
            stream
        })
        .collect())
}

fn truncate_field(value: &mut Option<String>, max_chars: usize) {
    if let Some(text) = value {
        // Byte length bounds char count from above: short fields skip the rebuild.
        if text.len() > max_chars {
            *text = text.chars().take(max_chars).collect();
        }
        if !non_blank(text) {
            *value = None;
        }
    }
}

pub(super) fn truncate_stream_item(stream: &mut AddonStream) {
    truncate_field(&mut stream.name, 2_048);
    truncate_field(&mut stream.title, 2_048);
    truncate_field(&mut stream.url, 2_048);
    truncate_field(&mut stream.info_hash, INFO_HASH_MAX_CHARS);
    // Strip non-fetchable targets at ingress so they can't pollute selector
    // rows and dedup keys; magnets are identifiers, not fetch targets.
    let url_blocked = stream
        .url
        .as_deref()
        .is_some_and(|url| !is_magnet_url(url) && !is_fetchable_http_url(url));
    if url_blocked {
        stream.url = None;
    }
    if let Some(hints) = stream.behavior_hints.as_mut() {
        truncate_field(&mut hints.binge_group, 256);
        truncate_field(&mut hints.filename, 2_048);
        // Drop pathological raw header blobs outright; the bounded extractor
        // serves the legitimate entries.
        if hints
            .proxy_headers
            .as_ref()
            .is_some_and(|headers| json_size_estimate(headers) > MAX_PROXY_HEADERS_BYTES)
        {
            hints.proxy_headers = None;
        }
    }
}

/// Serialized-size estimate without materializing the string. Slightly
/// over-counts; good enough for the ingress sanity cap.
fn json_size_estimate(value: &Value) -> usize {
    match value {
        Value::Null | Value::Bool(_) => 5,
        Value::Number(number) => number.to_string().len(),
        Value::String(text) => text.len() + 2,
        Value::Array(items) => 2 + items.iter().map(json_size_estimate).sum::<usize>(),
        Value::Object(map) => {
            2 + map
                .iter()
                .map(|(key, entry)| key.len() + 4 + json_size_estimate(entry))
                .sum::<usize>()
        }
    }
}

/// TTL for cached stream responses, shared by selector fetches and
/// best-stream resolution so one addon fetch serves both.
const STREAM_CACHE_TTL: Duration = Duration::from_secs(180);

/// Shorter TTL for empty responses — a stream-less title must not re-run
/// the full fan-out per open, yet newly indexed content still surfaces fast.
const STREAM_CACHE_EMPTY_TTL: Duration = Duration::from_secs(30);

/// Entries past this bound evict the soonest-expiring rows.
pub(super) const STREAM_CACHE_MAX_ENTRIES: usize = 64;

/// Per-addon transport-failure cooldown: after retries exhaust, sibling
/// fetches fail fast for this window instead of re-paying connect/timeout.
const STREAM_FETCH_FAILURE_TTL: Duration = Duration::from_secs(30);
/// A `get_streams` future dropped mid-fetch (outer timeout) never releases
/// its key; orphan entries sweep on insert past this bound.
const STREAM_IN_FLIGHT_SWEEP_AT: usize = 64;

/// Cut a pathological payload before the per-item regex hydration battery.
const DECODED_STREAMS_MAX: usize = 512;
/// Response body cap (same budget as subtitles), checked before allocation
/// and during streaming.
const STREAM_MAX_BYTES: usize = 512 * 1024;
/// Whole-request timeout: the client `.timeout` and the retry loop's
/// burned-timeout check both read this.
const STREAM_REQUEST_TIMEOUT_SECS: u64 = 35;
/// Shared with the retry loop so a size-limit rejection is recognized by
/// identity, not substring match.
const STREAM_BODY_TOO_LARGE: &str = "Addon stream response exceeds the size limit.";

/// Cooldown message served while an addon sits inside its failure window.
const STREAM_COOLDOWN_MESSAGE: &str =
    "Addon stream fetch skipped: the source is cooling down after a recent transport failure.";

pub(crate) struct AddonTransport {
    client: Client,
    /// Stream results keyed `{type}|{id}|{addon_url_hash}`; hits clone the
    /// shared `Arc` handle once.
    pub(super) cache: TtlCache<Arc<[AddonStream]>>,
    /// Bumped by `clear_cache`: a fetch started before a clear must not
    /// repopulate on completion.
    pub(super) generation: AtomicU64,
    /// Single-flight locks keyed like `cache`: followers wait on the leader
    /// and re-read its cached result.
    in_flight: InFlight,
    /// Per-addon transport-failure cooldown keyed by `config_cache_segment`.
    /// Session-local only — a dead host is not a persisted condition.
    pub(super) fetch_failures: FetchFailureCooldown,
    /// Short-TTL negative cache for deterministic per-request failures
    /// (status, size-limit, decode). Host-wide reachability failures stay on
    /// `fetch_failures` — a content 404 must not mark the whole addon dead.
    failure_cache: TtlCache<String>,
}

impl AddonTransport {
    pub(super) fn build_stream_endpoint(
        base_url: &str,
        type_: &str,
        id: &str,
    ) -> Result<String, String> {
        // Shared resource-URL builder: keeps configured path/query, strips a
        // trailing manifest.json, encodes the media id.
        build_resource_url(base_url, "stream", type_, id, &[])
    }

    fn build_request_origin(base_url: &str) -> Result<String, String> {
        let parsed =
            reqwest::Url::parse(base_url).map_err(|e| format!("Invalid addon URL: {}", e))?;
        let host = parsed
            .host_str()
            .ok_or_else(|| "Invalid addon URL: missing host".to_string())?;

        let mut origin = format!("{}://{}", parsed.scheme(), host);
        if let Some(port) = parsed.port() {
            origin.push_str(&format!(":{}", port));
        }

        Ok(origin)
    }

    pub(crate) fn new() -> Self {
        // Browser-like headers for CDN/anti-bot compatibility.
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::ACCEPT,
            header::HeaderValue::from_static("application/json, text/plain, */*"),
        );
        headers.insert(
            header::ACCEPT_LANGUAGE,
            header::HeaderValue::from_static("en-US,en;q=0.9"),
        );
        headers.insert(
            header::ACCEPT_ENCODING,
            header::HeaderValue::from_static("gzip, deflate, br"),
        );
        headers.insert(
            header::CONNECTION,
            header::HeaderValue::from_static("keep-alive"),
        );
        headers.insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-cache"),
        );
        // Keep the legacy Stremio header for compatibility with existing addons.
        headers.insert(
            header::HeaderName::from_static("stremio-addon-transport"),
            header::HeaderValue::from_static("network/http"),
        );

        Self {
            client: {
                ensure_rustls_crypto_provider();
                // Own identity (Stremio headers + separately-tracked Chrome
                // version), not `build_provider_http_client`.
                Client::builder()
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36")
                .default_headers(headers)
                .redirect(fetch_policy::ssrf_redirect_policy())
                .connect_timeout(Duration::from_secs(12))
                .timeout(Duration::from_secs(STREAM_REQUEST_TIMEOUT_SECS))
                .pool_idle_timeout(Duration::from_secs(90))
                .tcp_keepalive(Duration::from_secs(30))
                .build()
                // Fail closed: a default-client fallback would silently drop
                // the SSRF redirect policy installed above.
                .expect("addon transport HTTP client must build")
            },
            cache: TtlCache::new(
                STREAM_CACHE_MAX_ENTRIES,
                STREAM_CACHE_TTL,
                STREAM_CACHE_EMPTY_TTL,
            ),
            generation: AtomicU64::new(0),
            in_flight: InFlight::new(STREAM_IN_FLIGHT_SWEEP_AT),
            fetch_failures: FetchFailureCooldown::new(
                STREAM_FETCH_FAILURE_TTL,
                STREAM_IN_FLIGHT_SWEEP_AT,
            ),
            // Failures take the short empty TTL: a fixed addon recovers fast.
            failure_cache: TtlCache::new(
                STREAM_CACHE_MAX_ENTRIES,
                STREAM_CACHE_EMPTY_TTL,
                STREAM_CACHE_EMPTY_TTL,
            ),
        }
    }

    /// Insert a stream result into the TTL cache. Puts from a superseded
    /// generation (a `clear_cache` landed mid-fetch) are dropped.
    #[cfg(test)]
    pub(super) fn cache_put(&self, key: &str, streams: Vec<AddonStream>, generation: u64) {
        let still_fresh = || self.generation.load(Ordering::SeqCst) == generation;
        // Cheap pre-check; `put` re-checks under the entries lock.
        if !still_fresh() {
            return;
        }
        let is_empty = streams.is_empty();
        self.cache
            .put(key, Arc::from(streams), is_empty, still_fresh);
    }

    /// Clear caches on config change. The generation bump revokes in-flight
    /// fetch writebacks; cooldowns clear too (the change may fix a dead host).
    pub(crate) fn clear_cache(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.cache.clear();
        self.failure_cache.clear();
        self.fetch_failures.clear();
    }

    /// Generation snapshot for operations whose late completion must not
    /// write back into a cleared cache.
    pub(crate) fn cache_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Record a fetch failure for callers outside this module (the fetcher
    /// times out `get_streams` futures, which then never reach their own
    /// generation-checked record).
    pub(crate) fn note_fetch_failure_for_url(&self, addon_url: &str, generation: u64) {
        self.fetch_failures.note(
            &config_cache_segment(addon_url),
            &self.generation,
            generation,
        );
    }

    /// Shared contract wiring so the run sites stay declarative; constants
    /// carry the stream policy (timeout, cooldown message).
    fn fetch_contract(&self) -> FetchContract<'_> {
        FetchContract {
            failure_cache: &self.failure_cache,
            fetch_failures: &self.fetch_failures,
            in_flight: &self.in_flight,
            generation: &self.generation,
            request_timeout: Duration::from_secs(STREAM_REQUEST_TIMEOUT_SECS),
            cooldown_message: STREAM_COOLDOWN_MESSAGE,
        }
    }

    pub(crate) async fn get_streams(
        &self,
        type_: &str,
        id: &str,
        addon_url: &str,
    ) -> Result<Vec<AddonStream>, String> {
        // Validate before the contract: an addon URL that cannot produce an
        // endpoint/origin never had a fetch to cache, so the shared checks
        // would only miss.
        let base_url = addon_url.trim();
        if base_url.is_empty() {
            return Ok(vec![]);
        }
        let url = Self::build_stream_endpoint(base_url, type_, id)?;

        #[cfg(debug_assertions)]
        eprintln!("Addon stream URL: {}", sanitize_addon_log(&url));

        // Derive origin from the base URL so the request looks like it's coming
        // from the same-origin addon context. This satisfies Cloudflare
        // CORS-aware checks without leaking the user's API key in the Referer.
        let origin = Self::build_request_origin(base_url)?;

        let addon_key = config_cache_segment(addon_url);
        let cache_key = format!("{}|{}|{}", type_, id, addon_key);
        self.fetch_contract()
            .run(
                &self.cache,
                &cache_key,
                &addon_key,
                |streams| streams.is_empty(),
                || async { self.fetch_streams_once(&url, &origin).await.map(Arc::from) },
            )
            .await
            .map(|streams| streams.to_vec())
    }

    /// One fetch attempt: request → status gate → bounded body → decode →
    /// hydrate. Dedupe and ranking live in the coordinator, so transport
    /// order stays decode order.
    async fn fetch_streams_once(
        &self,
        url: &str,
        origin: &str,
    ) -> Result<Vec<AddonStream>, FetchFailure> {
        let res = match self
            .client
            .get(url)
            .header(header::ORIGIN, origin)
            .header(header::REFERER, format!("{}/", origin))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                // reqwest errors embed the request URL, which may carry
                // addon-side credentials — sanitize before it surfaces via IPC.
                let error = sanitize_addon_log(&e.to_string());
                #[cfg(debug_assertions)]
                eprintln!("Addon stream request failed: {}", error);
                return Err(FetchFailure::Retryable(error));
            }
        };

        if !res.status().is_success() {
            let status = res.status();
            #[cfg(debug_assertions)]
            eprintln!(
                "Addon stream error {} for {}",
                status,
                sanitize_addon_log(url)
            );

            return Err(FetchFailure::Fatal(format!(
                "Configured addon returned HTTP {}. Check the addon URL in Settings → Streaming.",
                status.as_u16()
            )));
        }

        let bytes =
            match read_bounded_body(res, STREAM_MAX_BYTES, |_| STREAM_BODY_TOO_LARGE.to_string())
                .await
            {
                Ok(bytes) => bytes,
                Err(error) => {
                    let fatal = matches!(error, crate::providers::BoundedBodyError::TooLarge(_));
                    let message = error.into_message();
                    #[cfg(debug_assertions)]
                    eprintln!("Addon stream body error: {}", message);
                    // Size-limit rejections are deterministic: don't retry.
                    // Mid-stream truncations stay retryable.
                    return Err(if fatal {
                        FetchFailure::Fatal(message)
                    } else {
                        FetchFailure::Retryable(message)
                    });
                }
            };

        let mut streams = match decode_stream_items(&bytes) {
            Ok(streams) => streams,
            Err(e) => {
                #[cfg(debug_assertions)]
                eprintln!("Addon stream JSON parse error: {}", e);
                // Deterministic over the bytes just read — don't retry.
                return Err(FetchFailure::Fatal(e));
            }
        };
        Self::hydrate_streams(&mut streams);
        Ok(streams)
    }

    fn hydrate_streams(streams: &mut [AddonStream]) {
        // One scratch buffer for the name+title probe text across all streams.
        let mut combined = String::new();
        for stream in streams {
            Self::hydrate_stream_inner(stream, &mut combined);
        }
    }

    /// Single-stream wrapper for tests; the batch path uses `hydrate_streams`.
    #[cfg(test)]
    pub(super) fn hydrate_stream(stream: &mut AddonStream) {
        let mut combined = String::new();
        Self::hydrate_stream_inner(stream, &mut combined);
    }

    fn hydrate_stream_inner(stream: &mut AddonStream, combined: &mut String) {
        // Seeders/size parse from name and title (addons place them in
        // either); wire-claimed values were already discarded at decode.
        combined.clear();
        combined.push_str(stream.name.as_deref().unwrap_or(""));
        combined.push('\n');
        combined.push_str(stream.title.as_deref().unwrap_or(""));

        stream.seeders = SEEDER_REGEX
            .captures(combined)
            .and_then(|caps| caps[1].parse::<u32>().ok());

        // Fallback: plain-text size ("1.2 GB") without emoji prefix.
        stream.size_bytes = SIZE_REGEX
            .captures(combined)
            .and_then(|caps| Self::parse_size_to_bytes(&caps[1], &caps[2]))
            .or_else(|| {
                PLAIN_SIZE_REGEX
                    .captures(combined)
                    .and_then(|caps| Self::parse_size_to_bytes(&caps[1], &caps[2]))
            });

        let name_text = stream.name.as_deref().unwrap_or("");
        let title_text = stream.title.as_deref().unwrap_or("");
        let has_lightning = name_text.contains('\u{26A1}') || title_text.contains('\u{26A1}');
        let has_download_arrow = name_text.contains('\u{2B07}') || title_text.contains('\u{2B07}');

        // ⚡ hints a cached/debrid stream; ⬇ explicitly opts out.
        stream.cached = has_lightning && !has_download_arrow;

        // Warm the match-text memo while the fields are final: cached rows
        // then carry the computed text instead of re-running the battery.
        stream.match_texts();
    }

    fn parse_size_to_bytes(value: &str, unit: &str) -> Option<u64> {
        // Reject non-finite parses ("NaN"/"inf" parse as f64): NaN saturates
        // to 0 and inf to u64::MAX — both misleading rank inputs.
        #![allow(
            clippy::cast_precision_loss,
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss
        )]
        let parsed = value
            .parse::<f64>()
            .ok()
            .filter(|parsed| parsed.is_finite() && *parsed >= 0.0)?;
        let exponent = match unit.as_bytes().first().map(u8::to_ascii_uppercase) {
            Some(b'K') => 1,
            Some(b'M') => 2,
            Some(b'G') => 3,
            Some(b'T') => 4,
            _ => 0,
        };
        // `u64::MAX as f64` rounds to 2^64; clamp just below it so the
        // float-to-int cast saturates instead of wrapping.
        const MAX_EXACT_F64_PLUS_ONE: f64 = 18_446_744_073_709_551_616.0;
        let bytes = (parsed * 1024f64.powi(exponent))
            .clamp(0.0, MAX_EXACT_F64_PLUS_ONE - 1.0)
            .round() as u64;
        Some(bytes)
    }
}

pub(crate) fn sanitize_addon_log(value: &str) -> String {
    // Addon URLs may embed credentials in path/query. Redact the known
    // credential-bearing query-key family; over-redaction is safe since this
    // only feeds log/error strings.
    static TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)((?:rd(?:_token)?|key|apikey|api_key|token|secret|password|passwd|auth|bearer|signature|sig|expires|exp|policy|hdnts|md5|x-amz-algorithm|x-amz-credential|x-amz-date|x-amz-expires|x-amz-signature|x-goog-algorithm|x-goog-credential|x-goog-date|x-goog-expires|x-goog-signature)=)[^/\s]+")
            .expect("valid regex")
    });
    // Path-configured addons carry an opaque config blob (possibly resolver
    // credentials) as a long path segment; protocol segments are all short,
    // so a 32+ char base64url-ish segment is treated as a secret.
    static PATH_BLOB_RE: LazyLock<Regex> = LazyLock::new(|| {
        // No trailing boundary needed: the greedy run already extends to its
        // full length, keeping adjacent blobs visible to the same pass.
        Regex::new(r"/[-A-Za-z0-9_+=]{32,}").expect("valid regex")
    });

    let redacted = TOKEN_RE.replace_all(value, "$1[redacted]").into_owned();
    let redacted = PATH_BLOB_RE
        .replace_all(&redacted, "/[redacted-path]")
        .into_owned();
    // Redact embedded userinfo too — reqwest errors embed the full URL.
    redact_userinfo_authority(&redacted)
}

/// Replace `scheme://user:pass@host` with `scheme://[redacted-userinfo]@host`.
fn redact_userinfo_authority(value: &str) -> String {
    static USERINFO_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)([a-z][a-z0-9+.-]*://)[^/\s@]+@").expect("valid regex"));

    USERINFO_RE
        .replace_all(value, "$1[redacted-userinfo]@")
        .into_owned()
}

impl Default for AddonTransport {
    fn default() -> Self {
        Self::new()
    }
}
