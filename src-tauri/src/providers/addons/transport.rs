use super::{AddonStream, MAX_PROXY_HEADERS_BYTES};
use crate::providers::addon_resource::{build_resource_url, is_fetchable_http_url, is_magnet_url};
use crate::providers::ttl_cache::{
    hash_segment, FetchContract, FetchFailure, FetchFailureCooldown, InFlight, TtlCache,
};
use crate::providers::{
    ensure_rustls_crypto_provider, fetch_policy, lock_or_recover, non_blank, read_bounded_body,
};
use regex::Regex;
use reqwest::{header, Client};
use serde::Deserialize;
use serde_json::{value::RawValue, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

static SEEDER_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"👤\s*(\d{1,3}(?:[,.]\d{3})+|\d+)").expect("valid seeder regex"));
pub(crate) static STREAM_SIZE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    // Exclude numeric punctuation at the left edge so malformed groups cannot match a suffix.
    Regex::new(r"(?i)(?:^|[^\w.,])([0-9]+(?:[.,][0-9]+)?)\s*([KMGT]i?B)\b")
        .expect("valid stream size regex")
});

/// `infoHash` persists inside `last_stream_key` (128-char cap) — unbounded would break the saved-stream round-trip.
const INFO_HASH_MAX_CHARS: usize = 112;

/// Deterministic segment from the addon config URL — different addons never share an entry.
pub(super) fn config_cache_segment(config_url: &str) -> String {
    let url = config_url.trim();
    if url.is_empty() {
        return "cfg:default".to_string();
    }
    format!("cfg:{}", hash_segment(url))
}

/// Cached rows are prepared for one `(source_name, source_id)`, so the source is part of the key.
pub(super) fn stream_cache_key(
    type_: &str,
    id: &str,
    addon_key: &str,
    (source_name, source_id): (&str, &str),
) -> String {
    format!(
        "{type_}|{id}|{addon_key}|{}|{}",
        hash_segment(source_id),
        hash_segment(source_name)
    )
}

#[derive(Debug, Deserialize, Default)]
struct RawStreamResponse<'a> {
    #[serde(borrow, default)]
    streams: Vec<&'a RawValue>,
}

/// Decode item-by-item so a malformed sibling can't discard valid streams; applies per-field truncation.
pub(super) fn decode_stream_items(bytes: &[u8]) -> Result<Vec<AddonStream>, String> {
    const INVALID_FORMAT: &str = "Invalid stream response format.";
    let body: RawStreamResponse<'_> =
        serde_json::from_slice(bytes).map_err(|_| INVALID_FORMAT.to_string())?;
    let decoded: Vec<_> = body
        .streams
        .iter()
        .filter_map(|item| serde_json::from_str::<AddonStream>(item.get()).ok())
        .take(DECODED_STREAMS_MAX)
        .map(|mut stream| {
            truncate_stream_item(&mut stream);
            stream
        })
        .collect();
    if decoded.is_empty() && !body.streams.is_empty() {
        return Err(INVALID_FORMAT.to_string());
    }
    Ok(decoded)
}

fn truncate_field(value: &mut Option<String>, max_chars: usize) {
    if let Some(text) = value {
        // Byte length bounds char count from above: short fields skip the scan.
        if text.len() > max_chars {
            if let Some((byte_idx, _)) = text.char_indices().nth(max_chars) {
                text.truncate(byte_idx);
                text.shrink_to_fit();
            }
        }
        if !non_blank(text) {
            *value = None;
        }
    }
}

pub(super) fn truncate_stream_item(stream: &mut AddonStream) {
    truncate_field(&mut stream.name, 2_048);
    truncate_field(&mut stream.title, 2_048);
    if stream
        .info_hash
        .as_deref()
        .is_some_and(|hash| hash.chars().nth(INFO_HASH_MAX_CHARS).is_some() || !non_blank(hash))
    {
        stream.info_hash = None;
    }
    // Strip non-fetchable URLs at ingress so they can't pollute selector rows/dedup keys.
    let url_blocked = stream.url.as_deref().is_some_and(|url| {
        url.chars().nth(2_048).is_some() || (!is_magnet_url(url) && !is_fetchable_http_url(url))
    });
    if url_blocked {
        stream.url = None;
    }
    if let Some(hints) = stream.behavior_hints.as_mut() {
        truncate_field(&mut hints.binge_group, 256);
        truncate_field(&mut hints.filename, 2_048);
        // Drop pathological header blobs; the bounded extractor serves legit entries.
        if hints
            .proxy_headers
            .as_ref()
            .is_some_and(|headers| json_size_estimate(headers) > MAX_PROXY_HEADERS_BYTES)
        {
            hints.proxy_headers = None;
        }
    }
}

/// Serialized-size estimate (slightly over-counts) for the ingress sanity cap.
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

/// Shared by selector fetches and best-stream resolution — one addon fetch serves both.
const STREAM_CACHE_TTL: Duration = Duration::from_secs(180);
const STREAM_REFRESH_CLAIMS_MAX: usize = 256;

pub(crate) fn remaining_stream_cache_ttl_ms(fetched_at: Option<Instant>, now: Instant) -> u64 {
    fetched_at.map_or(0, |fetched_at| {
        STREAM_CACHE_TTL
            .saturating_sub(now.saturating_duration_since(fetched_at))
            .as_millis() as u64
    })
}

/// Empty answers: a stream-less title must not re-fan-out per open, yet new content surfaces fast.
const STREAM_CACHE_EMPTY_TTL: Duration = Duration::from_secs(30);

/// Entries past this bound evict the soonest-expiring rows.
pub(super) const STREAM_CACHE_MAX_ENTRIES: usize = 64;

/// After retries exhaust, sibling fetches fail fast for this window.
const STREAM_FETCH_FAILURE_TTL: Duration = Duration::from_secs(30);
/// A dropped `get_streams` future never releases its key; orphans sweep on insert past this.
const STREAM_IN_FLIGHT_SWEEP_AT: usize = 64;

/// Cut a pathological payload before the per-item regex hydration battery.
pub(super) const DECODED_STREAMS_MAX: usize = 512;
/// Same budget as subtitles; checked before allocation and during streaming.
const STREAM_MAX_BYTES: usize = 512 * 1024;
/// Feeds both the client `.timeout` and the retry loop's burned-timeout check.
const STREAM_REQUEST_TIMEOUT_SECS: u64 = 35;
/// Shared with the retry loop: size-limit rejections are recognized by identity, not substring.
const STREAM_BODY_TOO_LARGE: &str = "Addon stream response exceeds the size limit.";

/// Cooldown message served while an addon sits inside its failure window.
const STREAM_COOLDOWN_MESSAGE: &str =
    "Addon stream fetch skipped: the source is cooling down after a recent transport failure.";

pub(crate) struct AddonTransport {
    client: Client,
    /// Prepared rows keyed by `stream_cache_key`; hits clone the `Arc` handle once.
    pub(super) cache: TtlCache<Arc<[AddonStream]>>,
    /// Bumped by `clear_cache`: in-flight fetches must not repopulate cleared entries.
    pub(super) generation: AtomicU64,
    /// Single-flight locks keyed like `cache`; followers wait on the leader and re-read.
    in_flight: InFlight,
    /// Per-addon cooldown keyed by `config_cache_segment`; session-local.
    pub(super) fetch_failures: FetchFailureCooldown,
    /// Short-TTL negative cache for deterministic per-request failures
    /// (status, size-limit, decode) — a content 404 must not mark the addon dead.
    failure_cache: TtlCache<String>,
    refresh_claims: Mutex<HashMap<String, StreamRefreshState>>,
    refresh_claim_seq: AtomicU64,
}

struct StreamRefreshState {
    claim_id: u64,
    completed_at: Option<Instant>,
}

pub(crate) struct StreamRefreshClaim<'a> {
    transport: &'a AddonTransport,
    key: String,
    claim_id: u64,
}

impl StreamRefreshClaim<'_> {
    pub(crate) fn complete(self) {
        let mut claims = lock_or_recover(&self.transport.refresh_claims);
        if let Some(claim) = claims
            .get_mut(&self.key)
            .filter(|claim| claim.claim_id == self.claim_id)
        {
            claim.completed_at = Some(Instant::now());
        }
    }
}

impl Drop for StreamRefreshClaim<'_> {
    fn drop(&mut self) {
        let mut claims = lock_or_recover(&self.transport.refresh_claims);
        if claims
            .get(&self.key)
            .is_some_and(|claim| claim.claim_id == self.claim_id && claim.completed_at.is_none())
        {
            claims.remove(&self.key);
        }
    }
}

impl AddonTransport {
    fn build_request_origin(base_url: &str) -> Result<String, String> {
        let parsed =
            reqwest::Url::parse(base_url).map_err(|e| format!("Invalid addon URL: {}", e))?;
        parsed
            .host_str()
            .ok_or_else(|| "Invalid addon URL: missing host".to_string())?;
        Ok(parsed.origin().ascii_serialization())
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
        // Legacy Stremio header kept for addon compatibility.
        headers.insert(
            header::HeaderName::from_static("stremio-addon-transport"),
            header::HeaderValue::from_static("network/http"),
        );

        Self {
            client: {
                ensure_rustls_crypto_provider();
                // Own identity (Stremio headers + own Chrome version), not `build_provider_http_client`.
                Client::builder()
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36")
                .default_headers(headers)
                .redirect(fetch_policy::ssrf_redirect_policy())
                .connect_timeout(Duration::from_secs(12))
                .timeout(Duration::from_secs(STREAM_REQUEST_TIMEOUT_SECS))
                .pool_idle_timeout(Duration::from_secs(90))
                .tcp_keepalive(Duration::from_secs(30))
                .build()
                // Fail closed: a fallback client would silently drop the SSRF redirect policy.
                .expect("addon transport HTTP client must build")
            },
            cache: TtlCache::new(
                STREAM_CACHE_MAX_ENTRIES,
                STREAM_CACHE_TTL,
                STREAM_CACHE_EMPTY_TTL,
            ),
            generation: AtomicU64::new(0),
            in_flight: InFlight::new(STREAM_IN_FLIGHT_SWEEP_AT),
            fetch_failures: FetchFailureCooldown::new(STREAM_FETCH_FAILURE_TTL),
            // Failures take the short empty TTL: a fixed addon recovers fast.
            failure_cache: TtlCache::new(
                STREAM_CACHE_MAX_ENTRIES,
                STREAM_CACHE_EMPTY_TTL,
                STREAM_CACHE_EMPTY_TTL,
            ),
            refresh_claims: Mutex::new(HashMap::new()),
            refresh_claim_seq: AtomicU64::new(0),
        }
    }

    /// TTL-cache insert; a superseded generation (mid-fetch `clear_cache`) drops the put.
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

    /// Clear caches on config change: the generation bump revokes in-flight
    /// writebacks; cooldowns clear too (the change may fix a dead host).
    pub(crate) fn clear_cache(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.cache.clear();
        self.failure_cache.clear();
        self.fetch_failures.clear();
        lock_or_recover(&self.refresh_claims).clear();
    }

    pub(crate) fn purge_expired_caches(&self) {
        self.cache.purge_expired();
        self.failure_cache.purge_expired();
    }

    pub(crate) fn claim_stream_refresh(&self, key: &str) -> Option<StreamRefreshClaim<'_>> {
        let mut claims = lock_or_recover(&self.refresh_claims);
        let now = Instant::now();
        claims.retain(|_, claim| {
            claim
                .completed_at
                .is_none_or(|completed_at| now.duration_since(completed_at) < STREAM_CACHE_TTL)
        });
        if claims.contains_key(key) {
            return None;
        }
        if claims.len() >= STREAM_REFRESH_CLAIMS_MAX {
            let oldest = claims
                .iter()
                .filter_map(|(key, claim)| claim.completed_at.map(|at| (key, at)))
                .min_by_key(|(_, completed_at)| *completed_at)
                .map(|(key, _)| key.clone())?;
            claims.remove(&oldest);
        }
        let claim_id = self.refresh_claim_seq.fetch_add(1, Ordering::Relaxed);
        claims.insert(
            key.to_string(),
            StreamRefreshState {
                claim_id,
                completed_at: None,
            },
        );
        Some(StreamRefreshClaim {
            transport: self,
            key: key.to_string(),
            claim_id,
        })
    }

    /// Generation snapshot for operations whose late write-back must not survive a clear.
    pub(crate) fn cache_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Record a fetch failure for outside callers — a timed-out `get_streams_fresh`
    /// future never reaches its own generation-checked record.
    pub(crate) fn note_fetch_failure_for_url(&self, addon_url: &str, generation: u64) {
        self.fetch_failures.note(
            &config_cache_segment(addon_url),
            &self.generation,
            generation,
        );
    }

    /// Shared contract wiring with the stream policy constants.
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

    /// `source` is `(source_name, source_id)`. The command-owned `prepare` runs once per
    /// fetch inside the decode task, never on a cache hit.
    pub(crate) async fn get_streams_fresh(
        &self,
        type_: &str,
        id: &str,
        addon_url: &str,
        source: (&str, &str),
        not_before: Option<Instant>,
        prepare: fn(Vec<AddonStream>, &str, &str) -> Vec<AddonStream>,
    ) -> Result<Vec<AddonStream>, String> {
        // Validate before the contract: an unbuildable URL never had a fetch to cache.
        let base_url = addon_url.trim();
        if base_url.is_empty() {
            return Ok(vec![]);
        }
        let url = build_resource_url(base_url, "stream", type_, id, &[])?;

        let addon_key = config_cache_segment(addon_url);
        let cache_key = stream_cache_key(type_, id, &addon_key, source);
        self.fetch_contract()
            .run_fresh(
                &self.cache,
                &cache_key,
                &addon_key,
                not_before,
                |streams| streams.is_empty(),
                || async {
                    let origin =
                        Self::build_request_origin(base_url).map_err(FetchFailure::Fatal)?;
                    let (source_name, source_id) = (source.0.to_string(), source.1.to_string());
                    self.fetch_streams_once(&url, &origin, move |streams| {
                        prepare(streams, &source_name, &source_id)
                    })
                    .await
                    .map(Arc::from)
                },
            )
            .await
            .map(|streams| streams.to_vec())
    }

    /// One attempt: request → status gate → bounded body → decode → hydrate → prepare.
    /// Dedupe/ranking live in the coordinator; transport order stays decode order.
    async fn fetch_streams_once(
        &self,
        url: &str,
        origin: &str,
        prepare: impl FnOnce(Vec<AddonStream>) -> Vec<AddonStream> + Send + 'static,
    ) -> Result<Vec<AddonStream>, FetchFailure> {
        #[cfg(debug_assertions)]
        eprintln!("Addon stream origin: {}", origin);

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
                let e = e.without_url();
                let error = e.to_string();
                #[cfg(debug_assertions)]
                eprintln!("Addon stream request failed: {}", error);
                return Err(FetchFailure::from_send_error(&e, error));
            }
        };

        if !res.status().is_success() {
            let status = res.status();
            #[cfg(debug_assertions)]
            eprintln!("Addon stream error {} for {}", status, origin);

            return Err(FetchFailure::from_http_status(
                status,
                format!(
                    "Configured addon returned HTTP {}. Check the addon URL in Settings → Addons.",
                    status.as_u16()
                ),
            ));
        }

        let bytes =
            match read_bounded_body(res, STREAM_MAX_BYTES, |_| STREAM_BODY_TOO_LARGE.to_string())
                .await
            {
                Ok(bytes) => bytes,
                Err(error) => {
                    let failure = FetchFailure::from(error);
                    #[cfg(debug_assertions)]
                    {
                        let (FetchFailure::Fatal(message) | FetchFailure::Retryable(message)) =
                            &failure;
                        eprintln!("Addon stream body error: {}", message);
                    }
                    return Err(failure);
                }
            };

        tokio::task::spawn_blocking(move || {
            let mut streams = decode_stream_items(&bytes).map_err(|error| {
                #[cfg(debug_assertions)]
                eprintln!("Addon stream JSON parse error: {}", error);
                FetchFailure::Fatal(error)
            })?;
            Self::hydrate_streams(&mut streams);
            let fetched_at = Instant::now();
            for stream in &mut streams {
                stream.pool_fetched_at = Some(fetched_at);
            }
            Ok(prepare(streams))
        })
        .await
        .map_err(|_| FetchFailure::Fatal("Stream response processing task failed.".to_string()))?
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
        // Derived top-level fields were discarded at decode.
        combined.clear();
        combined.push_str(stream.name.as_deref().unwrap_or(""));
        combined.push('\n');
        combined.push_str(stream.title.as_deref().unwrap_or(""));

        stream.seeders = SEEDER_REGEX.captures(combined).and_then(|caps| {
            let captured = caps.get(1)?;
            let suffix = &combined[captured.end()..];
            if suffix.as_bytes().first().is_some_and(u8::is_ascii_digit)
                || (matches!(suffix.as_bytes().first(), Some(b',' | b'.'))
                    && suffix.as_bytes().get(1).is_some_and(u8::is_ascii_digit))
            {
                return None;
            }
            let count = captured.as_str();
            if count.contains([',', '.']) {
                count.replace([',', '.'], "").parse::<u32>().ok()
            } else {
                count.parse::<u32>().ok()
            }
        });

        stream.size_bytes = stream
            .behavior_hints
            .as_ref()
            .and_then(|hints| hints.video_size)
            .or_else(|| {
                STREAM_SIZE_REGEX
                    .captures(combined)
                    .and_then(|caps| Self::parse_size_to_bytes(&caps[1], &caps[2]))
            });

        // The lightning marker is a cached-availability hint; the down arrow opts out.
        stream.cached = combined.contains('\u{26A1}') && !combined.contains('\u{2B07}');

        // Warm the match-text memo while the fields are final.
        stream.match_texts();
    }

    fn parse_size_to_bytes(value: &str, unit: &str) -> Option<u64> {
        // Reject non-finite parses — NaN/inf would produce misleading rank inputs.
        let parsed = if let Some((whole, fraction)) = value.split_once(',') {
            let integer = whole.parse::<f64>().ok()?;
            let fractional = fraction.parse::<f64>().ok()?;
            // A single three-digit comma group is thousands; other comma groups are decimals.
            if whole.len() <= 3 && fraction.len() == 3 {
                integer * 1000.0 + fractional
            } else {
                integer + fractional / 10f64.powi(i32::try_from(fraction.len()).ok()?)
            }
        } else {
            value.parse::<f64>().ok()?
        };
        if !parsed.is_finite() || parsed < 0.0 {
            return None;
        }
        let exponent = match unit.as_bytes().first().map(u8::to_ascii_uppercase) {
            Some(b'K') => 1,
            Some(b'M') => 2,
            Some(b'G') => 3,
            Some(b'T') => 4,
            _ => 0,
        };
        // `u64::MAX as f64` rounds to 2^64 — clamp below so the cast saturates, not wraps.
        const MAX_EXACT_F64_PLUS_ONE: f64 = 18_446_744_073_709_551_616.0;
        Some(
            (parsed * 1024f64.powi(exponent))
                .clamp(0.0, MAX_EXACT_F64_PLUS_ONE - 1.0)
                .round() as u64,
        )
    }
}

pub(crate) fn sanitize_addon_log(value: &str) -> String {
    // Any query value may carry credentials.
    static TOKEN_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"([?&][^=&#\s]+=)[^&#\s]+").expect("valid regex"));
    // Path/pipe-delimited config pairs (`/opt=a|service=KEY/`); long values only, so protocol extras like `skip=50` stay readable.
    static CONFIG_PAIR_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"([/|;,][^=&#\s/|;,?]+=)[^&#\s/|;,?]{16,}").expect("valid regex")
    });
    // Path segments 32+ chars are opaque config blobs (possibly credentials) — treated as secrets.
    static PATH_BLOB_RE: LazyLock<Regex> = LazyLock::new(|| {
        // Greedy run already extends fully — adjacent blobs stay visible to the same pass.
        Regex::new(r"/[-A-Za-z0-9_+=%~]{32,}").expect("valid regex")
    });

    let redacted_query = TOKEN_RE.replace_all(value, "$1[redacted]");
    let redacted_config = CONFIG_PAIR_RE.replace_all(&redacted_query, "$1[redacted]");
    let redacted_path = PATH_BLOB_RE.replace_all(&redacted_config, "/[redacted-path]");
    // Redact embedded userinfo too — reqwest errors embed the full URL.
    redact_userinfo_authority(&redacted_path)
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

#[cfg(test)]
#[tokio::test]
async fn fresh_stream_fetch_bypasses_seeded_values_but_keeps_negative_cache() {
    let provider = AddonTransport::new();
    let (addon_url, source) = ("https://addon.example", ("Addon", "addon"));
    let key = stream_cache_key("movie", "tt123", &config_cache_segment(addon_url), source);
    let fetch = |not_before| {
        provider.get_streams_fresh(
            "movie",
            "tt123",
            addon_url,
            source,
            not_before,
            |streams, _, _| streams,
        )
    };
    for streams in [vec![crate::test_helpers::test_stream()], Vec::new()] {
        provider.seed_stream_cache("movie", "tt123", addon_url, source, streams);
        let not_before = Instant::now() + Duration::from_nanos(1);
        provider.fetch_contract().cache_failure(
            &key,
            "cached failure",
            provider.cache_generation(),
        );
        assert!(fetch(None).await.is_ok());
        assert_eq!(fetch(Some(not_before)).await.unwrap_err(), "cached failure");

        let not_before = Instant::now();
        provider.seed_stream_cache(
            "movie",
            "tt123",
            addon_url,
            source,
            vec![crate::test_helpers::test_stream()],
        );
        assert_eq!(fetch(Some(not_before)).await.unwrap().len(), 1);
    }
}

#[cfg(test)]
#[test]
fn stream_refresh_claims_are_scoped_expiring_bounded_and_clearable() {
    let provider = AddonTransport::new();
    provider
        .claim_stream_refresh("movie|tt123|None|None|None")
        .unwrap()
        .complete();
    assert!(provider
        .claim_stream_refresh("movie|tt123|None|None|None")
        .is_none());
    provider
        .claim_stream_refresh("series|tt123|Some(1)|Some(2)|None")
        .unwrap()
        .complete();

    lock_or_recover(&provider.refresh_claims)
        .get_mut("movie|tt123|None|None|None")
        .unwrap()
        .completed_at = Some(Instant::now() - STREAM_CACHE_TTL);
    provider
        .claim_stream_refresh("movie|tt123|None|None|None")
        .unwrap()
        .complete();
    provider.claim_stream_refresh("oldest").unwrap().complete();
    lock_or_recover(&provider.refresh_claims)
        .get_mut("oldest")
        .unwrap()
        .completed_at = Some(Instant::now() - Duration::from_secs(1));
    for index in 0..STREAM_REFRESH_CLAIMS_MAX {
        provider
            .claim_stream_refresh(&format!("key-{index}"))
            .unwrap()
            .complete();
        assert!(lock_or_recover(&provider.refresh_claims).len() <= STREAM_REFRESH_CLAIMS_MAX);
    }
    assert!(!lock_or_recover(&provider.refresh_claims).contains_key("oldest"));

    provider.clear_cache();
    assert!(lock_or_recover(&provider.refresh_claims).is_empty());
    assert!(provider.claim_stream_refresh("key-0").is_some());
    let pending: Vec<_> = (0..STREAM_REFRESH_CLAIMS_MAX)
        .map(|index| {
            provider
                .claim_stream_refresh(&format!("pending-{index}"))
                .unwrap()
        })
        .collect();
    assert!(provider.claim_stream_refresh("overflow").is_none());
    drop(pending);
    assert!(provider.claim_stream_refresh("overflow").is_some());
}

#[cfg(test)]
#[test]
fn remaining_stream_cache_ttl_tracks_pool_age_and_saturates() {
    let fetched_at = Instant::now();
    let ttl_ms = STREAM_CACHE_TTL.as_millis() as u64;
    assert_eq!(
        remaining_stream_cache_ttl_ms(Some(fetched_at), fetched_at),
        ttl_ms
    );
    assert_eq!(
        remaining_stream_cache_ttl_ms(Some(fetched_at), fetched_at + Duration::from_millis(1_250)),
        ttl_ms - 1_250
    );
    assert_eq!(
        remaining_stream_cache_ttl_ms(Some(fetched_at), fetched_at + STREAM_CACHE_TTL),
        0
    );
    assert_eq!(
        remaining_stream_cache_ttl_ms(
            Some(fetched_at),
            fetched_at + STREAM_CACHE_TTL + Duration::from_secs(1)
        ),
        0
    );
    assert_eq!(remaining_stream_cache_ttl_ms(None, fetched_at), 0);
}
