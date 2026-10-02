use super::AddonStream;
use crate::providers::addon_resource::{build_resource_url, is_fetchable_http_url, is_magnet_url};
use crate::providers::ttl_cache::{hash_segment, InFlight, TtlCache};
use crate::providers::{
    ensure_rustls_crypto_provider, fetch_policy, lock_or_recover, non_blank, read_bounded_body,
};
use regex::Regex;
use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

static SEEDER_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"👤\s*(\d+)").expect("valid seeder regex"));
static SIZE_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"💾\s*([\d\.]+)\s*([KMGT]B)").expect("valid size regex"));
/// Fallback size regex for addons that use plain-text format (e.g. "1.2 GB") without emoji.
static PLAIN_SIZE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|\s)([\d\.]+)\s*([KMGT]i?B)\b").expect("valid plain size regex")
});

/// Maximum serialized bytes retained for a raw `proxyHeaders` payload.
/// Entry-level bounds apply at extraction; this caps the stored opaque value
/// so one malicious stream cannot bloat in-memory selector state.
const MAX_PROXY_HEADERS_BYTES: usize = 8 * 1024;
/// `infoHash` feeds the `h:{hash}:{file_idx}` dedup key, which persists as
/// `last_stream_key` under a 128-char cap — an unbounded addon-supplied hash
/// would silently break the saved-stream round-trip. Real btih/btmh values
/// are far shorter; this also bounds the per-stream IPC payload.
const INFO_HASH_MAX_CHARS: usize = 112;

/// Builds a short deterministic cache segment from the addon config URL so that
/// different addons never share a cache entry for the same content.
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
        // Byte length bounds char count from above, so a short-enough field
        // is its own truncation — skip the rebuilding collect.
        if text.len() <= max_chars {
            if !non_blank(text) {
                *value = None;
            }
            return;
        }
        let truncated: String = text.chars().take(max_chars).collect();
        if !non_blank(&truncated) {
            *value = None;
        } else {
            *value = Some(truncated);
        }
    }
}

pub(super) fn truncate_stream_item(stream: &mut AddonStream) {
    truncate_field(&mut stream.name, 2_048);
    truncate_field(&mut stream.title, 2_048);
    truncate_field(&mut stream.url, 2_048);
    truncate_field(&mut stream.info_hash, INFO_HASH_MAX_CHARS);
    // Never trust ranking inputs from the wire: Stremio streams carry no
    // `seeders`/`size` fields, and hydration only fills absent values, so an
    // addon could otherwise inflate its ranking. Drop them at ingress.
    stream.seeders = None;
    stream.size_bytes = None;
    // `url` reaches the probe and libmpv fetch paths: strip non-fetchable
    // targets at ingress so they can't pollute selector rows and dedup keys.
    // Magnet identifiers are not fetch targets and carry no SSRF surface, so
    // they are preserved.
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
        // Raw header blobs are opaque addon input: drop pathological payloads
        // outright so one malicious stream cannot bloat selector state. The
        // bounded extractor above serves the legitimate entries.
        if hints
            .proxy_headers
            .as_ref()
            .is_some_and(|headers| json_size_estimate(headers) > MAX_PROXY_HEADERS_BYTES)
        {
            hints.proxy_headers = None;
        }
    }
}

/// Serialized-size estimate for a JSON value, without materializing the
/// string. Slightly over-counts (ignores separators); good enough for the
/// ingress sanity cap, which only rejects pathological payloads.
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

/// TTL for cached addon stream responses. Shared across selector fetches and
/// best-stream resolution to avoid duplicate HTTP requests for the same content.
const STREAM_CACHE_TTL: Duration = Duration::from_secs(180);

/// Shorter TTL for empty stream responses. A stream-less title otherwise
/// re-runs the full addon fan-out on every selector open; a short cooldown
/// still lets newly indexed content surface quickly.
const STREAM_CACHE_EMPTY_TTL: Duration = Duration::from_secs(30);

/// Maximum number of entries before a full eviction pass.
pub(super) const STREAM_CACHE_MAX_ENTRIES: usize = 64;

/// Per-addon transport-failure cooldown. A host that just exhausted its
/// retries is presumed down: subsequent fetches fail fast for this window
/// instead of re-paying connect/timeout on every selector open.
const STREAM_FETCH_FAILURE_TTL: Duration = Duration::from_secs(30);
/// Single-flight map hygiene bound. A `get_streams` future dropped mid-fetch
/// (e.g. by the fetcher's outer timeout) never reaches `release_in_flight`,
/// so orphan entries are swept on insert once the map grows past this.
const STREAM_IN_FLIGHT_SWEEP_AT: usize = 64;
/// Cooldown-map sweep bound — same hygiene contract as the in-flight map.
const STREAM_FETCH_FAILURES_SWEEP_AT: usize = STREAM_IN_FLIGHT_SWEEP_AT;

/// Bound on decoded stream items before hydrate. Hydration runs per-item
/// regex parsing, so a pathological payload must be cut before it rather
/// than after.
const DECODED_STREAMS_MAX: usize = 512;
/// Upper bound for a single stream response body. Matches the catalog/subtitle
/// budget; checked via content-length before allocation and during streaming.
const STREAM_MAX_BYTES: usize = 512 * 1024;
/// Shared with the retry loop: a size-limit rejection is deterministic for a
/// given endpoint, so the loop compares by identity instead of substring and
/// fails fast rather than sleeping and re-requesting identical bytes.
const STREAM_BODY_TOO_LARGE: &str = "Addon stream response exceeds the size limit.";

/// How a single fetch attempt failed. The retry loop only re-runs
/// transient transport errors — status, size-limit, and decode rejections
/// are deterministic for this endpoint, so a retry would re-fetch identical
/// bytes and fail the same way.
enum StreamFetchFailure {
    Retryable(String),
    Fatal(String),
}

pub(crate) struct AddonTransport {
    client: Client,
    /// In-memory, TTL-based cache for stream results keyed by
    /// `{type}|{id}|{addon_url_hash}` — one addon HTTP fetch per content
    /// across selector fetches and best-stream resolution. Shared ownership:
    /// hits clone the `Arc` handle and materialize the `Vec` once, while puts
    /// move the fetched `Vec` in without a second deep clone.
    pub(super) cache: TtlCache<Arc<[AddonStream]>>,
    /// Generation bumped by every `clear_cache`. A fetch that started before
    /// a clear must not repopulate the cleared generation on completion.
    pub(super) generation: AtomicU64,
    /// Single-flight locks keyed like `cache`: concurrent selector/resolve
    /// calls for one key wait on the leader and re-read the cache instead of
    /// each paying the full HTTP + decode + rank.
    in_flight: InFlight,
    /// Per-addon transport-failure cooldown keyed by `config_cache_segment`.
    /// Session-local only: a dead host is not a persisted condition.
    fetch_failures: Mutex<HashMap<String, Instant>>,
    /// Short-TTL negative cache keyed like `cache`: deterministic failures
    /// (status, size-limit, decode) replay identically for the same request,
    /// so a selector re-open fails fast without the HTTP round-trip.
    /// Host-wide reachability failures stay on the addon-level
    /// `fetch_failures` cooldown — a content-scoped 404 must never mark the
    /// whole addon dead.
    failure_cache: TtlCache<String>,
}

impl AddonTransport {
    pub(super) fn build_stream_endpoint(
        base_url: &str,
        type_: &str,
        id: &str,
    ) -> Result<String, String> {
        // Single source of truth with catalog/meta/subtitle clients: preserves
        // configured paths/query, strips a trailing manifest.json once, and
        // URL-encodes the media id.
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
                // Own client identity, not `build_provider_http_client`:
                // Stremio protocol headers plus a separately-tracked Chrome
                // version (fingerprint freshness matters for addon hosts).
                Client::builder()
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36")
                .default_headers(headers)
                .redirect(fetch_policy::ssrf_redirect_policy())
                .connect_timeout(Duration::from_secs(12))
                .timeout(Duration::from_secs(35))
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
            fetch_failures: Mutex::new(HashMap::new()),
            // Failures always take the short empty TTL: a fixed addon or a
            // newly indexed title recovers within seconds, not minutes.
            failure_cache: TtlCache::new(
                STREAM_CACHE_MAX_ENTRIES,
                STREAM_CACHE_EMPTY_TTL,
                STREAM_CACHE_EMPTY_TTL,
            ),
        }
    }

    /// Insert a stream result into the TTL cache, enforcing a hard
    /// `STREAM_CACHE_MAX_ENTRIES` bound even when no entries have expired.
    /// Puts from a superseded generation (a `clear_cache` happened after the
    /// fetch started) are dropped so stale data never repopulates a clear.
    pub(super) fn cache_put(&self, key: &str, streams: Vec<AddonStream>, generation: u64) {
        let still_fresh = || self.generation.load(Ordering::SeqCst) == generation;
        // Cheap pre-check before taking the entries lock; `put` re-checks
        // under it, where `clear_cache`'s bump-then-clear order is visible.
        if !still_fresh() {
            return;
        }
        let is_empty = streams.is_empty();
        self.cache
            .put(key, Arc::from(streams), is_empty, still_fresh);
    }

    /// Clear the in-memory cache (e.g. when the user changes their config).
    /// Bumps the generation first so in-flight fetches cannot repopulate it.
    /// Failure cooldowns clear too: a config change may fix the dead host.
    pub(crate) fn clear_cache(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.cache.clear();
        self.failure_cache.clear();
        lock_or_recover(&self.fetch_failures).clear();
    }

    /// Current cache generation — snapshot before an operation whose late
    /// completion must not write back into a cleared generation.
    pub(crate) fn cache_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// True while `addon_key` sits inside its post-failure cooldown window.
    /// Expired entries drop on read so the map can't accumulate stale keys.
    pub(super) fn fetch_failure_cooling_down(&self, addon_key: &str) -> bool {
        let mut failures = lock_or_recover(&self.fetch_failures);
        match failures.get(addon_key) {
            Some(until) if *until > Instant::now() => true,
            Some(_) => {
                failures.remove(addon_key);
                false
            }
            None => false,
        }
    }

    /// Record a fetch failure keyed by raw `addon_url` — for callers outside
    /// this module (the fetcher times out `get_streams` futures, so a dropped
    /// future never reaches its own generation-checked record). The caller
    /// snapshots the generation before spawning, so a `clear_cache` landing
    /// mid-timeout still suppresses the record.
    pub(crate) fn note_fetch_failure_for_url(&self, addon_url: &str, generation: u64) {
        self.note_fetch_failure_for_generation(&config_cache_segment(addon_url), generation);
    }

    /// Record a transport-exhaustion failure for the addon, generation-checked:
    /// a fetch started before a `clear_cache` must not reinstall a wiped
    /// cooldown. The failure mutex is taken before the generation read so
    /// ordering vs. the clear's bump is unambiguous. Only transport-exhaustion
    /// callers (retry loop spent, fetcher timeout) reach this.
    pub(super) fn note_fetch_failure_for_generation(&self, addon_key: &str, generation: u64) {
        let mut failures = lock_or_recover(&self.fetch_failures);
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        failures.insert(
            addon_key.to_string(),
            Instant::now() + STREAM_FETCH_FAILURE_TTL,
        );
        if failures.len() > STREAM_FETCH_FAILURES_SWEEP_AT {
            let now = Instant::now();
            failures.retain(|_, until| *until > now);
        }
    }

    /// Generation-checked cooldown clear for a successful fetch: a success
    /// that started before a `clear_cache` must not wipe a cooldown recorded
    /// in the new generation. Same mutex-then-generation ordering as the
    /// record path.
    pub(super) fn clear_fetch_failure_for_generation(&self, addon_key: &str, generation: u64) {
        let mut failures = lock_or_recover(&self.fetch_failures);
        if self.generation.load(Ordering::SeqCst) == generation {
            failures.remove(addon_key);
        }
    }

    /// Fresh cache entry for `key`, cloned out of the shared `Arc` handle.
    fn cached_streams(&self, key: &str) -> Option<Vec<AddonStream>> {
        self.cache.get(key).map(|streams| streams.to_vec())
    }

    /// Freshly cached deterministic failure for `key`.
    fn cached_failure(&self, key: &str) -> Option<String> {
        self.failure_cache.get(key)
    }

    /// Store a deterministic per-endpoint failure with the same generation
    /// guard as `cache_put`: a `clear_cache` mid-fetch revokes the write.
    fn cache_failure_put(&self, key: &str, error: &str, generation: u64) {
        let still_fresh = || self.generation.load(Ordering::SeqCst) == generation;
        if !still_fresh() {
            return;
        }
        self.failure_cache
            .put(key, error.to_string(), true, still_fresh);
    }

    pub(crate) async fn get_streams(
        &self,
        type_: &str,
        id: &str,
        addon_url: &str,
    ) -> Result<Vec<AddonStream>, String> {
        // id for movies: tt1234567
        // id for series: tt1234567:1:2

        // Include a config_url segment so different addons never share entries.
        let addon_key = config_cache_segment(addon_url);
        let cache_key = format!("{}|{}|{}", type_, id, addon_key);
        if let Some(streams) = self.cached_streams(&cache_key) {
            return Ok(streams);
        }
        if let Some(error) = self.cached_failure(&cache_key) {
            return Err(error);
        }

        // A host inside its failure window is skipped outright: the fetch
        // would pay connect/timeout + retry back-off only to fail again.
        if self.fetch_failure_cooling_down(&addon_key) {
            return Err(
                "Addon stream fetch skipped: the source is cooling down after a recent transport failure."
                    .to_string(),
            );
        }

        // Single-flight: a concurrent call for this key may already be
        // fetching (selector open + best-stream resolve). Wait, then re-read
        // the cache — the leader's result lands there, including the
        // short-TTL empty marker — instead of duplicating the whole request.
        let key_lock = self.in_flight.claim(&cache_key);
        let _fetch_permit = key_lock.lock().await;

        if let Some(streams) = self.cached_streams(&cache_key) {
            self.in_flight.release(&cache_key, &key_lock);
            return Ok(streams);
        }
        if let Some(error) = self.cached_failure(&cache_key) {
            self.in_flight.release(&cache_key, &key_lock);
            return Err(error);
        }

        // The leader may have just recorded a transport failure — a follower
        // that waited must not re-run the same doomed fetch.
        if self.fetch_failure_cooling_down(&addon_key) {
            self.in_flight.release(&cache_key, &key_lock);
            return Err(
                "Addon stream fetch skipped: the source is cooling down after a recent transport failure."
                    .to_string(),
            );
        }

        // Capture the generation before the fetch: a concurrent `clear_cache`
        // revokes this fetch's right to repopulate the cache or the cooldown
        // map (both writebacks below are generation-checked).
        let start_generation = self.generation.load(Ordering::SeqCst);
        let result = self
            .fetch_streams_uncached(
                &cache_key,
                type_,
                id,
                addon_url,
                &addon_key,
                start_generation,
            )
            .await;
        if result.is_ok() {
            // A success clears any cooldown a concurrent same-addon fetch
            // recorded — the host is reachable.
            self.clear_fetch_failure_for_generation(&addon_key, start_generation);
        }
        self.in_flight.release(&cache_key, &key_lock);
        result
    }

    async fn fetch_streams_uncached(
        &self,
        cache_key: &str,
        type_: &str,
        id: &str,
        addon_url: &str,
        addon_key: &str,
        start_generation: u64,
    ) -> Result<Vec<AddonStream>, String> {
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

        // Max 2 attempts: one fresh request + one retry after a short back-off.
        let mut last_error = String::new();
        for attempt in 0u8..2 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(800)).await;
            }

            match self.fetch_streams_once(&url, &origin).await {
                Ok(streams) => {
                    // Empty results cache too (short TTL): a stream-less
                    // title must not re-run the full fan-out on every
                    // selector open.
                    self.cache_put(cache_key, streams.clone(), start_generation);
                    return Ok(streams);
                }
                Err(StreamFetchFailure::Fatal(error)) => {
                    // Deterministic for this exact endpoint: a re-open of
                    // the same selector fails fast from the negative cache
                    // instead of re-paying the request.
                    self.cache_failure_put(cache_key, &error, start_generation);
                    return Err(error);
                }
                Err(StreamFetchFailure::Retryable(error)) => last_error = error,
            }
        }

        // Retries exhausted on transport errors: cool the addon down so the
        // next selector open fails fast instead of re-paying the dead host.
        // Generation-checked like the cache writes above: a fetch that
        // outlived a `clear_cache` must not reinstall the wiped cooldown.
        self.note_fetch_failure_for_generation(addon_key, start_generation);
        Err(if last_error.is_empty() {
            "Addon stream request failed after retries".to_string()
        } else {
            last_error
        })
    }

    /// One fetch attempt: request → status gate → bounded body → decode →
    /// hydrate. Transport order is decode order only — dedupe, ranking, and
    /// trimming all live in the coordinator's prepare/merge/recommendation
    /// stack so per-stream identity and rank keys are computed exactly once.
    async fn fetch_streams_once(
        &self,
        url: &str,
        origin: &str,
    ) -> Result<Vec<AddonStream>, StreamFetchFailure> {
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
                // reqwest errors embed the full request URL, which may carry
                // the user's own addon-side credentials as path/query data.
                // Sanitize in all builds: this string surfaces via IPC.
                let error = sanitize_addon_log(&e.to_string());
                #[cfg(debug_assertions)]
                eprintln!("Addon stream request failed: {}", error);
                return Err(StreamFetchFailure::Retryable(error));
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

            return Err(StreamFetchFailure::Fatal(format!(
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
                    // Size-limit rejections are deterministic for this endpoint:
                    // retrying just burns another request plus the back-off sleep.
                    // Transport truncations stay retryable.
                    return Err(if fatal {
                        StreamFetchFailure::Fatal(message)
                    } else {
                        StreamFetchFailure::Retryable(message)
                    });
                }
            };

        let mut streams = match decode_stream_items(&bytes) {
            Ok(streams) => streams,
            Err(e) => {
                #[cfg(debug_assertions)]
                eprintln!("Addon stream JSON parse error: {}", e);
                // Parsing is deterministic over the bytes just read; a retry
                // would fetch identical bytes and fail the same way.
                return Err(StreamFetchFailure::Fatal(e));
            }
        };
        Self::hydrate_streams(&mut streams);
        Ok(streams)
    }

    fn hydrate_streams(streams: &mut [AddonStream]) {
        // One scratch buffer for the per-stream name+title probe text —
        // the join is re-materialized per stream otherwise.
        let mut combined = String::new();
        for stream in streams {
            Self::hydrate_stream_inner(stream, &mut combined);
        }
    }

    /// Single-stream wrapper for tests — the batch path shares one scratch
    /// buffer via `hydrate_streams`.
    #[cfg(test)]
    pub(super) fn hydrate_stream(stream: &mut AddonStream) {
        let mut combined = String::new();
        Self::hydrate_stream_inner(stream, &mut combined);
    }

    fn hydrate_stream_inner(stream: &mut AddonStream, combined: &mut String) {
        // Parse seeders/size from both title and name — addons place metadata
        // in different fields. `truncate_stream_item` already discarded
        // wire-claimed values, so hydration fills unconditionally.
        combined.clear();
        combined.push_str(stream.name.as_deref().unwrap_or(""));
        combined.push('\n');
        combined.push_str(stream.title.as_deref().unwrap_or(""));

        stream.seeders = SEEDER_REGEX
            .captures(combined)
            .and_then(|caps| caps[1].parse::<u32>().ok());

        // Fallback: plain-text size like "1.2 GB" without emoji prefix.
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

        // Advisory only: an addon availability hint may mark a stream cached,
        // but a plain direct-HTTP URL must surface as `http` delivery rather
        // than cached. ⬇ explicitly opts out.
        stream.cached = has_lightning && !has_download_arrow;

        // Warm the match-text memo while the fields are final: hydrated
        // streams are what the TTL cache stores, so every cache-hit clone
        // carries the computed text instead of re-running the battery.
        stream.match_texts();
    }

    fn parse_size_to_bytes(value: &str, unit: &str) -> Option<u64> {
        // Non-finite parses ("NaN"/"inf" parse as f64) must not become a
        // size: NaN saturates to 0 and inf to u64::MAX, both misleading rank
        // inputs. The final cast maps a clamped finite f64, so precision and
        // truncation lints are scoped to this function.
        #![allow(
            clippy::cast_precision_loss,
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss
        )]
        let parsed = value
            .parse::<f64>()
            .ok()
            .filter(|parsed| parsed.is_finite() && *parsed >= 0.0)?;
        let multiplier = if unit.eq_ignore_ascii_case("kb") || unit.eq_ignore_ascii_case("kib") {
            1024.0
        } else if unit.eq_ignore_ascii_case("mb") || unit.eq_ignore_ascii_case("mib") {
            1024.0 * 1024.0
        } else if unit.eq_ignore_ascii_case("gb") || unit.eq_ignore_ascii_case("gib") {
            1024.0 * 1024.0 * 1024.0
        } else if unit.eq_ignore_ascii_case("tb") || unit.eq_ignore_ascii_case("tib") {
            1024.0 * 1024.0 * 1024.0 * 1024.0
        } else {
            1.0
        };
        // `u64::MAX as f64` rounds to 2^64; clamp just below it so the
        // float-to-int cast below saturates instead of wrapping.
        const MAX_EXACT_F64_PLUS_ONE: f64 = 18_446_744_073_709_551_616.0;
        let bytes = (parsed * multiplier)
            .clamp(0.0, MAX_EXACT_F64_PLUS_ONE - 1.0)
            .round() as u64;
        Some(bytes)
    }
}

pub(crate) fn sanitize_addon_log(value: &str) -> String {
    // Addon URLs are opaque user data and may embed the user's own addon-side
    // credentials as path/query segments. Redact the known credential-bearing
    // query key family so those values never reach debug logs. The app itself
    // stores no such keys.
    // Over-redaction is safe here: this only feeds log and error strings.
    static TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)((?:rd(?:_token)?|key|apikey|api_key|token|secret|password|passwd|auth|bearer|signature|sig|expires|exp|policy|hdnts|md5|x-amz-algorithm|x-amz-credential|x-amz-date|x-amz-expires|x-amz-signature|x-goog-algorithm|x-goog-credential|x-goog-date|x-goog-expires|x-goog-signature)=)[^/\s]+")
            .expect("valid regex")
    });
    // Path-configured addons carry the user's opaque config blob —
    // potentially resolver credentials — as a long path segment. Protocol
    // segments (catalog ids, types, years, media ids, skips) are all short,
    // so a 32+ char base64url-ish segment is a secret. Query values use the
    // key family above.
    static PATH_BLOB_RE: LazyLock<Regex> = LazyLock::new(|| {
        // Greedy runs need no trailing boundary: the match already extends to
        // the full run, and leaving the delimiter unconsumed keeps adjacent
        // blobs visible to the same single pass.
        Regex::new(r"/[-A-Za-z0-9_+=]{32,}").expect("valid regex")
    });

    let redacted = TOKEN_RE.replace_all(value, "$1[redacted]").into_owned();
    let redacted = PATH_BLOB_RE
        .replace_all(&redacted, "/[redacted-path]")
        .into_owned();
    // reqwest errors embed the full request URL; addon URLs carry path/query
    // config, so redact embedded userinfo too before surfacing via IPC/logs.
    redact_userinfo_authority(&redacted)
}

/// Replace `scheme://user:pass@host` with `scheme://[redacted-userinfo]@host`
/// so persisted addon-user credentials never land in logs or IPC errors.
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
