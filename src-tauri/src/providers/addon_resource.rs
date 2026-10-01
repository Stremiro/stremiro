use super::ttl_cache::{hash_segment, InFlight, TtlCache};
use super::{
    addon_manifest::{snapshot_supports_request, AddonCatalogCapability, AddonManifest},
    build_provider_http_client, lock_or_recover, normalize_media_year, strip_manifest_suffix,
    trim_to_max, BoundedBodyError, Episode, MediaDetails, MediaItem, Trailer,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use urlencoding::encode;

/// Measured 2026-09-03 (decompressed JSON): series `top` ~537KB,
/// series `imdbRating` ~533KB, series `top` + `genre=Animation` ~695KB.
/// 2MiB keeps a hard bound (~3x headroom) while fitting real catalog pages.
const CATALOG_MAX_BYTES: usize = 2 * 1024 * 1024;
const META_MAX_BYTES: usize = 4 * 1024 * 1024;
const SUBTITLE_MAX_BYTES: usize = 512 * 1024;
/// Per-request budget for catalog/meta/subtitle payloads. Catalog pages run
/// ~0.5-0.7MiB decompressed, so a tight budget misreads slow international
/// routes as dead hosts; 20s keeps genuine reachability failures bounded by
/// the post-failure cooldown below.
const RESOURCE_TIMEOUT_SECS: u64 = 20;
/// Retry contract mirrored from the stream transport: one retry after a
/// short back-off before a transport failure earns the addon cooldown, so a
/// single hiccup can't mark a whole source down for the window.
const RESOURCE_FETCH_ATTEMPTS: u8 = 2;
const RESOURCE_RETRY_BACKOFF: Duration = Duration::from_millis(800);
const MAX_CATALOG_ITEMS: usize = 500;
const MAX_EPISODES: usize = 2_000;
const MAX_TRAILERS: usize = 32;
const MAX_CAST: usize = 64;
const MAX_GENRES: usize = 32;
const MAX_STRING_CHARS: usize = 2_048;
const MAX_ID_CHARS: usize = 256;
const MAX_EXTRA_NAME_CHARS: usize = 64;
const MAX_EXTRA_VALUE_CHARS: usize = 256;
const MAX_EXTRAS: usize = 16;
const MAX_SUBTITLE_LABEL_CHARS: usize = 256;

/// TTLs mirror the stream transport cache: addon payloads are stable for
/// minutes, and a successful-but-empty answer gets a shorter window so newly
/// indexed content surfaces quickly.
const RESOURCE_CACHE_TTL: Duration = Duration::from_secs(180);
const RESOURCE_CACHE_EMPTY_TTL: Duration = Duration::from_secs(30);
const META_CACHE_MAX_ENTRIES: usize = 48;
const CATALOG_CACHE_MAX_ENTRIES: usize = 48;
const SUBTITLE_CACHE_MAX_ENTRIES: usize = 64;
/// Single-flight map hygiene bound. A fetch future dropped mid-flight (an
/// outer caller timeout) never releases its key, so inserts sweep orphans
/// once the map grows past this — same contract as the stream transport.
const RESOURCE_IN_FLIGHT_SWEEP_AT: usize = 64;
/// Per-addon transport-failure cooldown, mirroring the stream transport: a
/// host that just failed to answer is presumed down, so catalog/meta/
/// subtitle fetches fail fast for the window instead of re-paying
/// connect+timeout on every browse page or details open. Session-local.
const RESOURCE_FETCH_FAILURE_TTL: Duration = Duration::from_secs(30);
/// Cooldown-map hygiene bound — same contract as the in-flight map.
const RESOURCE_FETCH_FAILURES_SWEEP_AT: usize = RESOURCE_IN_FLIGHT_SWEEP_AT;
/// Negative-cache bound for deterministic per-request failures.
const RESOURCE_FAILURE_CACHE_MAX_ENTRIES: usize = 64;

/// Hash-keyed cache identity: the request URL embeds the addon's configured
/// base (possibly credential-bearing), so keys keep only a hash segment —
/// the stream cache's config-segment policy applied to the whole request.
fn resource_cache_key(resource: &str, url: &str) -> String {
    format!("{resource}:{}", hash_segment(url))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CatalogExtra {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct CatalogPage {
    // Skip counts source entries, including cards rejected during parsing.
    pub source_item_count: usize,
    pub items: Vec<MediaItem>,
}

/// Lean catalog-card shape. Search endpoints return full meta objects here
/// (cast, links, trailers, behavior hints); decoding only card fields keeps
/// memory proportional to what browse renders.
#[derive(Debug, Deserialize, Default)]
struct CatalogItemJson {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    name: Option<Value>,
    #[serde(rename = "type", default)]
    type_: Option<Value>,
    #[serde(default)]
    poster: Option<Value>,
    #[serde(default)]
    background: Option<Value>,
    #[serde(default)]
    logo: Option<Value>,
    #[serde(default)]
    description: Option<Value>,
    #[serde(default)]
    year: Option<Value>,
    #[serde(rename = "releaseInfo", default)]
    release_info: Option<Value>,
    #[serde(default)]
    genre: Option<Value>,
    #[serde(default)]
    genres: Option<Value>,
}

#[derive(Debug, Deserialize, Default)]
struct CatalogResponse {
    // Raw `Value` entries: one non-object row in a catalog page must not
    // fail the whole `metas` decode — each item parses per-entry below.
    #[serde(default)]
    metas: Vec<Value>,
}

#[derive(Debug, Deserialize, Default)]
struct MetaResponse {
    #[serde(default)]
    meta: Option<Value>,
}

#[derive(Debug, Deserialize, Default)]
struct SubtitleItem {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    lang: Option<String>,
}

/// Provider-agnostic display hints, first non-empty wins. Addons label
/// subtitle entries differently (`subtitleFileName` on OpenSubtitles-style
/// payloads, `title`/`name` elsewhere); surfacing one keeps same-language
/// entries distinguishable.
const SUBTITLE_LABEL_KEYS: [&str; 8] = [
    "label",
    "title",
    "name",
    "subtitleFileName",
    "movieReleaseName",
    "releaseName",
    "fileName",
    "filename",
];

#[derive(Debug, Deserialize, Default)]
struct SubtitleResponse {
    #[serde(default)]
    subtitles: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddonSubtitle {
    pub id: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// How a resource fetch failed. `Transport` marks host-reachability
/// failures (send/connect/timeout/mid-stream read) that earn the per-addon
/// cooldown; `Deterministic` (status, size cap, decode, absent meta)
/// replays identically for the same request and lands in the per-key
/// negative cache instead of marking the whole addon down.
enum ResourceFetchError {
    Transport(String),
    Deterministic(String),
}

pub(crate) struct AddonResourceClient {
    client: Client,
    // Shared parsed metadata; shape-specific clones happen outside the cache lock.
    meta_cache: TtlCache<Arc<MediaDetails>>,
    catalog_cache: TtlCache<CatalogPage>,
    subtitle_cache: TtlCache<Vec<AddonSubtitle>>,
    /// Per-addon transport-failure cooldown keyed by base-URL hash — same
    /// contract as the stream transport's `fetch_failures`.
    fetch_failures: Mutex<HashMap<String, Instant>>,
    /// Short-TTL negative cache keyed like the resource caches: a
    /// deterministic failure (status, size cap, decode, missing meta)
    /// replays identically for the same request, so a browse re-open or
    /// details retry fails fast instead of re-paying the round-trip.
    failure_cache: TtlCache<String>,
    /// Single-flight locks keyed by request URL: concurrent callers for one
    /// resource (details page + schedule refresh, selector + auto-resolve)
    /// wait on the leader and re-read the cache instead of duplicating the
    /// fetch + parse.
    in_flight: InFlight,
    /// Bumped by `clear_cache`: a fetch started before a config change must
    /// not repopulate cleared entries on completion.
    generation: AtomicU64,
}

fn resource_cooldown_error() -> String {
    "Addon fetch skipped: the source is cooling down after a recent transport failure.".to_string()
}

/// Run `fetch` behind the cache + single-flight + failure-shortcut contract
/// shared by all resource kinds. Deterministic failures land in a short-TTL
/// negative cache; transport failures mark the addon's host down for
/// `RESOURCE_FETCH_FAILURE_TTL` so a dead addon stops stalling every
/// browse/details request — the same policy the stream transport applies,
/// including its retry: a transport failure gets one back-off retry unless
/// the attempt already burned the full request timeout (the host had its
/// chance — a second wait would only double a dead source's stall).
async fn cached_resource<T, Fetch, Fut, IsEmpty>(
    client: &AddonResourceClient,
    cache: &TtlCache<T>,
    key: &str,
    addon_key: &str,
    is_empty: IsEmpty,
    fetch: Fetch,
) -> Result<T, String>
where
    T: Clone,
    Fetch: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, ResourceFetchError>>,
    IsEmpty: Fn(&T) -> bool,
{
    if let Some(cached) = cache.get(key) {
        return Ok(cached);
    }
    if let Some(error) = client.failure_cache.get(key) {
        return Err(error);
    }
    if client.fetch_failure_cooling_down(addon_key) {
        return Err(resource_cooldown_error());
    }

    let key_lock = client.in_flight.claim(key);
    let result = {
        let _guard = key_lock.lock().await;
        // The leader stored while this caller waited — take its result, or
        // fail fast on the failure it just recorded instead of re-running
        // the same doomed fetch.
        if let Some(cached) = cache.get(key) {
            Ok(cached)
        } else if let Some(error) = client.failure_cache.get(key) {
            Err(error)
        } else if client.fetch_failure_cooling_down(addon_key) {
            Err(resource_cooldown_error())
        } else {
            let generation = client.generation.load(Ordering::SeqCst);
            let mut attempt = 0u8;
            loop {
                if attempt > 0 {
                    tokio::time::sleep(RESOURCE_RETRY_BACKOFF).await;
                }
                let started_at = Instant::now();
                match fetch().await {
                    Ok(value) => {
                        // A success proves the host reachable — drop a cooldown
                        // a concurrent same-addon fetch recorded.
                        client.clear_fetch_failure(addon_key, generation);
                        // A clear_cache between fetch start and store drops the
                        // write under the entries lock, so post-change callers
                        // never read pre-change data.
                        cache.put(key, value.clone(), is_empty(&value), || {
                            client.generation.load(Ordering::SeqCst) == generation
                        });
                        break Ok(value);
                    }
                    Err(ResourceFetchError::Deterministic(error)) => {
                        client.cache_failure(key, &error, generation);
                        break Err(error);
                    }
                    Err(ResourceFetchError::Transport(error)) => {
                        attempt += 1;
                        let burned_timeout =
                            started_at.elapsed() >= Duration::from_secs(RESOURCE_TIMEOUT_SECS);
                        if attempt >= RESOURCE_FETCH_ATTEMPTS || burned_timeout {
                            client.note_fetch_failure(addon_key, generation);
                            break Err(error);
                        }
                    }
                }
            }
        }
    };
    client.in_flight.release(key, &key_lock);
    result
}

/// Card and full shapes share the cached full entry; the struct is rebuilt
/// field-by-field so a card hit never copies the discarded `episodes`.
fn meta_for_shape(details: &MediaDetails, include_episodes: bool) -> MediaDetails {
    MediaDetails {
        id: details.id.clone(),
        imdb_id: details.imdb_id.clone(),
        title: details.title.clone(),
        poster: details.poster.clone(),
        backdrop: details.backdrop.clone(),
        logo: details.logo.clone(),
        year: details.year.clone(),
        display_year: details.display_year.clone(),
        release_date: details.release_date.clone(),
        type_: details.type_.clone(),
        description: details.description.clone(),
        rating: details.rating.clone(),
        cast: details.cast.clone(),
        genres: details.genres.clone(),
        trailers: details.trailers.clone(),
        episodes: if include_episodes {
            details.episodes.clone()
        } else {
            None
        },
    }
}

impl AddonResourceClient {
    pub(crate) fn new() -> Self {
        Self {
            client: build_provider_http_client(Some(10)),
            meta_cache: TtlCache::new(
                META_CACHE_MAX_ENTRIES,
                RESOURCE_CACHE_TTL,
                RESOURCE_CACHE_EMPTY_TTL,
            ),
            catalog_cache: TtlCache::new(
                CATALOG_CACHE_MAX_ENTRIES,
                RESOURCE_CACHE_TTL,
                RESOURCE_CACHE_EMPTY_TTL,
            ),
            subtitle_cache: TtlCache::new(
                SUBTITLE_CACHE_MAX_ENTRIES,
                RESOURCE_CACHE_TTL,
                RESOURCE_CACHE_EMPTY_TTL,
            ),
            fetch_failures: Mutex::new(HashMap::new()),
            // Failures always take the short empty TTL: a fixed addon or a
            // corrected request recovers within seconds, not minutes.
            failure_cache: TtlCache::new(
                RESOURCE_FAILURE_CACHE_MAX_ENTRIES,
                RESOURCE_CACHE_EMPTY_TTL,
                RESOURCE_CACHE_EMPTY_TTL,
            ),
            in_flight: InFlight::new(RESOURCE_IN_FLIGHT_SWEEP_AT),
            generation: AtomicU64::new(0),
        }
    }

    /// Clear all resource caches (e.g. the addon set changed). Bumps the
    /// generation first so in-flight fetches cannot repopulate them.
    /// Failure cooldowns clear too: a config change may fix the dead host.
    pub(crate) fn clear_cache(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.meta_cache.clear();
        self.catalog_cache.clear();
        self.subtitle_cache.clear();
        self.failure_cache.clear();
        lock_or_recover(&self.fetch_failures).clear();
    }

    /// True while `addon_key` sits inside its post-failure cooldown window.
    /// Expired entries drop on read so the map can't accumulate stale keys.
    fn fetch_failure_cooling_down(&self, addon_key: &str) -> bool {
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

    /// Record a host-reachability failure for the addon, generation-checked:
    /// a fetch that started before a `clear_cache` must not reinstall a
    /// wiped cooldown (mutex before generation read — the stream transport's
    /// ordering). Only transport failures reach this; status, size, and parse
    /// errors are content-scoped and land in `failure_cache`.
    fn note_fetch_failure(&self, addon_key: &str, generation: u64) {
        let mut failures = lock_or_recover(&self.fetch_failures);
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        failures.insert(
            addon_key.to_string(),
            Instant::now() + RESOURCE_FETCH_FAILURE_TTL,
        );
        if failures.len() > RESOURCE_FETCH_FAILURES_SWEEP_AT {
            let now = Instant::now();
            failures.retain(|_, until| *until > now);
        }
    }

    /// Generation-checked cooldown clear for a successful fetch: a success
    /// that started before a `clear_cache` must not wipe a cooldown recorded
    /// in the new generation.
    fn clear_fetch_failure(&self, addon_key: &str, generation: u64) {
        let mut failures = lock_or_recover(&self.fetch_failures);
        if self.generation.load(Ordering::SeqCst) == generation {
            failures.remove(addon_key);
        }
    }

    /// Deterministic per-request failure write with the same generation
    /// guard as the value caches: a `clear_cache` mid-fetch revokes it.
    fn cache_failure(&self, key: &str, error: &str, generation: u64) {
        let still_fresh = || self.generation.load(Ordering::SeqCst) == generation;
        if !still_fresh() {
            return;
        }
        self.failure_cache
            .put(key, error.to_string(), true, still_fresh);
    }

    pub(crate) async fn fetch_catalog(
        &self,
        base_url: &str,
        type_: &str,
        catalog_id: &str,
        extras: &[CatalogExtra],
    ) -> Result<CatalogPage, String> {
        let url = build_resource_url(base_url, "catalog", type_, catalog_id, extras)?;
        let cache_key = resource_cache_key("catalog", &url);
        let addon_key = hash_segment(base_url);
        cached_resource(
            self,
            &self.catalog_cache,
            &cache_key,
            &addon_key,
            |page| page.items.is_empty(),
            || async {
                let what = format!("catalog {type_}/{catalog_id}");
                let bytes =
                    fetch_bounded_json(&self.client, &url, &what, CATALOG_MAX_BYTES).await?;
                let response: CatalogResponse = serde_json::from_slice(&bytes).map_err(|_| {
                    ResourceFetchError::Deterministic(
                        "Invalid catalog response format.".to_string(),
                    )
                })?;

                Ok(CatalogPage {
                    source_item_count: response.metas.len(),
                    items: response
                        .metas
                        .into_iter()
                        .filter_map(|value| serde_json::from_value::<CatalogItemJson>(value).ok())
                        .filter_map(parse_catalog_item)
                        .take(MAX_CATALOG_ITEMS)
                        .collect(),
                })
            },
        )
        .await
    }

    pub(crate) async fn fetch_meta(
        &self,
        base_url: &str,
        type_: &str,
        id: &str,
        include_episodes: bool,
    ) -> Result<MediaDetails, String> {
        let url = build_resource_url(base_url, "meta", type_, id, &[])?;
        let cache_key = resource_cache_key("meta", &url);
        let addon_key = hash_segment(base_url);
        let details = cached_resource(
            self,
            &self.meta_cache,
            &cache_key,
            &addon_key,
            // Meta is success-or-error: parse failures return before this
            // point, so a stored entry always earns the full TTL.
            |_| false,
            || async {
                let what = format!("meta {type_}/{id}");
                let bytes = fetch_bounded_json(&self.client, &url, &what, META_MAX_BYTES).await?;
                let response: MetaResponse = serde_json::from_slice(&bytes).map_err(|_| {
                    ResourceFetchError::Deterministic(
                        "Invalid metadata response format.".to_string(),
                    )
                })?;
                let meta = response.meta.ok_or_else(|| {
                    ResourceFetchError::Deterministic("Metadata not found.".to_string())
                })?;
                parse_meta_item(meta).map(Arc::new).ok_or_else(|| {
                    ResourceFetchError::Deterministic("Metadata not found.".to_string())
                })
            },
        )
        .await?;
        Ok(meta_for_shape(details.as_ref(), include_episodes))
    }

    pub(crate) async fn fetch_subtitles(
        &self,
        base_url: &str,
        type_: &str,
        id: &str,
    ) -> Result<Vec<AddonSubtitle>, String> {
        let url = build_resource_url(base_url, "subtitles", type_, id, &[])?;
        let cache_key = resource_cache_key("subtitles", &url);
        let addon_key = hash_segment(base_url);
        cached_resource(
            self,
            &self.subtitle_cache,
            &cache_key,
            &addon_key,
            |subtitles| subtitles.is_empty(),
            || async {
                let what = format!("subtitles {type_}/{id}");
                let bytes =
                    fetch_bounded_json(&self.client, &url, &what, SUBTITLE_MAX_BYTES).await?;
                let response: SubtitleResponse = serde_json::from_slice(&bytes).map_err(|_| {
                    ResourceFetchError::Deterministic(
                        "Invalid subtitle response format.".to_string(),
                    )
                })?;

                Ok(response
                    .subtitles
                    .into_iter()
                    .filter_map(parse_subtitle_item)
                    .collect())
            },
        )
        .await
    }
}

impl Default for AddonResourceClient {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) fn catalog_declares_extra(catalog: &AddonCatalogCapability, extra_name: &str) -> bool {
    catalog
        .extras
        .iter()
        .any(|extra| extra.name.eq_ignore_ascii_case(extra_name))
}

fn catalog_required_extras(catalog: &AddonCatalogCapability) -> impl Iterator<Item = &str> {
    catalog
        .extras
        .iter()
        .filter(|extra| extra.is_required)
        .map(|extra| extra.name.as_str())
}

pub(crate) fn catalog_supports_request(
    catalog: &AddonCatalogCapability,
    type_: &str,
    extras: &[CatalogExtra],
) -> Result<(), String> {
    if !catalog.type_.eq_ignore_ascii_case(type_) {
        return Err(format!(
            "Catalog {} does not declare type {}.",
            catalog.id, type_
        ));
    }

    // `search` stays a hard capability gate: a catalog that never declared
    // it ignores the term and echoes its normal rows back as bogus search
    // results. Other undeclared extras are advisory — servers drop extras
    // they never declared and callers re-filter locally, so a missing
    // `genre`/`skip` declaration must not drop a servable source.
    if extras
        .iter()
        .any(|extra| extra.name.eq_ignore_ascii_case("search"))
        && !catalog_declares_extra(catalog, "search")
    {
        return Err(format!(
            "Catalog {} does not declare extra search.",
            catalog.id
        ));
    }

    for required in catalog_required_extras(catalog) {
        if !extras
            .iter()
            .any(|extra| extra.name.eq_ignore_ascii_case(required))
        {
            return Err(format!(
                "Catalog {} requires extra {}.",
                catalog.id, required
            ));
        }
    }

    Ok(())
}

pub(crate) fn snapshot_catalog<'a>(
    snapshot: &'a AddonManifest,
    type_: &str,
    catalog_id: &str,
) -> Option<&'a AddonCatalogCapability> {
    snapshot.catalogs.iter().find(|catalog| {
        catalog.type_.eq_ignore_ascii_case(type_) && catalog.id.eq_ignore_ascii_case(catalog_id)
    })
}

/// Canonical stored catalog id for a case-insensitive match, so fetched URLs
/// use the manifest's own casing instead of echoing caller casing (`TOP`
/// would otherwise 404 on case-sensitive upstreams).
pub(crate) fn resolve_canonical_catalog_id(
    snapshot: &AddonManifest,
    type_: &str,
    catalog_id: &str,
) -> Option<String> {
    snapshot_catalog(snapshot, type_, catalog_id).map(|catalog| catalog.id.clone())
}

pub(crate) fn snapshot_supports_catalog(
    snapshot: &AddonManifest,
    type_: &str,
    catalog_id: &str,
    extras: &[CatalogExtra],
) -> Result<(), String> {
    // `catalogs[]` is the authoritative declaration: the (type, id) pair is
    // the strongest capability statement a manifest makes, and a
    // catalogs-only manifest may omit the redundant `resources` entry.
    let Some(catalog) = snapshot_catalog(snapshot, type_, catalog_id) else {
        return Err(format!(
            "Addon does not declare catalog {catalog_id} for type {type_}."
        ));
    };

    catalog_supports_request(catalog, type_, extras)
}

pub(crate) fn snapshot_supports_meta(snapshot: &AddonManifest, type_: &str, id: &str) -> bool {
    snapshot_supports_request(snapshot, "meta", type_, id)
}

pub(crate) fn snapshot_supports_subtitles(snapshot: &AddonManifest, type_: &str, id: &str) -> bool {
    snapshot_supports_request(snapshot, "subtitles", type_, id)
}

fn json_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => trim_to_max(text, MAX_STRING_CHARS),
        Value::Number(number) => trim_to_max(&number.to_string(), MAX_STRING_CHARS),
        _ => None,
    }
}

fn json_string_list(value: Option<&Value>, max_items: usize) -> Option<Vec<String>> {
    match value? {
        Value::Array(items) => {
            let values: Vec<String> = items
                .iter()
                .filter_map(json_string)
                .take(max_items)
                .collect();
            (!values.is_empty()).then_some(values)
        }
        other => json_string(other).map(|value| vec![value]),
    }
}

fn json_u32(value: Option<&Value>) -> Option<u32> {
    match value {
        // Reject on overflow: a wrapping `as u32` would alias episodes
        // (e.g. 2^32+5 -> 5) and corrupt season/episode mappings.
        Some(Value::Number(number)) => number.as_u64().and_then(|value| u32::try_from(value).ok()),
        Some(Value::String(text)) => text.trim().parse().ok(),
        _ => None,
    }
}

fn parse_catalog_item(value: CatalogItemJson) -> Option<MediaItem> {
    let id = value.id.as_ref().and_then(json_string)?;
    let title = value.name.as_ref().and_then(json_string)?;
    let type_ = value.type_.as_ref().and_then(json_string)?;

    Some(MediaItem {
        id: id.chars().take(MAX_ID_CHARS).collect(),
        title,
        poster: sanitize_image_url(value.poster.as_ref()),
        backdrop: sanitize_image_url(value.background.as_ref()),
        logo: sanitize_image_url(value.logo.as_ref()),
        description: value.description.as_ref().and_then(json_string),
        year: normalize_media_year(
            value.year.as_ref().and_then(json_string),
            value.release_info.as_ref().and_then(json_string),
        ),
        primary_year: None,
        display_year: None,
        genres: json_string_list(value.genre.as_ref(), MAX_GENRES)
            .or_else(|| json_string_list(value.genres.as_ref(), MAX_GENRES)),
        type_,
    })
}

fn parse_meta_item(value: Value) -> Option<MediaDetails> {
    let id = json_string(value.get("id")?)?;
    let title = json_string(value.get("name")?)?;
    let type_ = json_string(value.get("type")?)?;
    // `imdb_id` is an opaque lookup id (persisted as episode-mapping
    // `source_lookup_id` and embedded in stream query paths), so it shares
    // `id`'s bound rather than the looser generic-string cap.
    let imdb_id = if id.starts_with("tt") {
        Some(id.chars().take(MAX_ID_CHARS).collect())
    } else {
        json_string_field(&value, "imdb_id")
            .or_else(|| json_string_field(&value, "imdbId"))
            .and_then(|value| trim_to_max(&value, MAX_ID_CHARS))
    };

    Some(MediaDetails {
        id: id.chars().take(MAX_ID_CHARS).collect(),
        imdb_id,
        title,
        poster: sanitize_image_url_opt(json_string_field(&value, "poster")),
        backdrop: sanitize_image_url_opt(json_string_field(&value, "background")),
        logo: sanitize_image_url_opt(json_string_field(&value, "logo")),
        year: normalize_media_year(
            json_string_field(&value, "year"),
            json_string_field(&value, "releaseInfo"),
        ),
        display_year: None,
        // Raw `released` (full ISO date) is the schedule source of truth —
        // normalization folds it into release_date; the year-only fallback
        // keeps metas without a released stamp working.
        release_date: json_string_field(&value, "released"),
        type_,
        description: json_string_field(&value, "description"),
        rating: json_string_field(&value, "imdbRating")
            .or_else(|| json_string_field(&value, "rating")),
        cast: json_string_list(value.get("cast"), MAX_CAST),
        genres: json_string_list(value.get("genre"), MAX_GENRES)
            .or_else(|| json_string_list(value.get("genres"), MAX_GENRES)),
        trailers: parse_trailers(value.get("trailers")),
        // Episode shaping for lite responses happens post-cache in
        // `meta_for_shape` — the parse always carries the full list.
        episodes: parse_episodes(value.get("videos")),
    })
}

fn json_string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(json_string)
}

/// True for the strict 11-char YouTube video token (`[A-Za-z0-9_-]`), the
/// only value ever interpolated into a trailer watch URL. Mirrors the
/// frontend `isValidYouTubeVideoId` gate so a malicious `source` cannot
/// smuggle extra query parameters or markup through the interpolated URL.
fn is_youtube_video_token(source: &str) -> bool {
    source.len() == 11
        && source
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Image fields reach the webview `<img>` pipeline, so they share the same
/// ingress gate as subtitles and streams (http(s) only, no credentials, no
/// non-routable IP literal). A rejected URL degrades to no artwork rather
/// than dropping the whole catalog/meta row.
fn sanitize_image_url_opt(url: Option<String>) -> Option<String> {
    url.filter(|value| is_fetchable_http_url(value))
}

fn sanitize_image_url(value: Option<&Value>) -> Option<String> {
    sanitize_image_url_opt(value.and_then(json_string))
}

fn parse_trailers(value: Option<&Value>) -> Option<Vec<Trailer>> {
    let Value::Array(items) = value? else {
        return None;
    };

    let trailers: Vec<Trailer> = items
        .iter()
        .filter_map(|item| {
            // Addon-controlled video tokens reach the browser `<iframe>` via
            // the trailer URL: accept the strict 11-char YouTube token only.
            // A raw `source` like `x&evil=` would otherwise escape the query
            // value into extra URL parameters or attacker markup.
            let source = json_string_field(item, "source")?;
            if !is_youtube_video_token(&source) {
                return None;
            }
            let type_ = json_string_field(item, "type")?;
            if !type_.eq_ignore_ascii_case("trailer") {
                return None;
            }

            Some(Trailer {
                id: source.clone(),
                source: "youtube".to_string(),
                url: format!("https://www.youtube.com/watch?v={source}"),
            })
        })
        .take(MAX_TRAILERS)
        .collect();

    (!trailers.is_empty()).then_some(trailers)
}

fn parse_episodes(value: Option<&Value>) -> Option<Vec<Episode>> {
    let Value::Array(items) = value? else {
        return None;
    };

    let mut episodes: Vec<Episode> = items
        .iter()
        .filter_map(|item| {
            let id = json_string_field(item, "id")?;
            Some(Episode {
                id,
                title: json_string_field(item, "name").or_else(|| json_string_field(item, "title")),
                season: json_u32(item.get("season")).unwrap_or(0),
                episode: json_u32(item.get("episode"))
                    .or_else(|| json_u32(item.get("number")))
                    .unwrap_or(0),
                released: json_string_field(item, "released"),
                release_date: None,
                overview: json_string_field(item, "overview"),
                thumbnail: sanitize_image_url_opt(json_string_field(item, "thumbnail")),
                stream_lookup_id: None,
                stream_season: None,
                stream_episode: None,
            })
        })
        .take(MAX_EPISODES)
        .collect();

    // Sort after the cap to preserve surviving rows; stable coordinate ties keep addon order.
    // Consumers use this cached order over IPC.
    episodes.sort_by_key(|episode| (episode.season, episode.episode));

    (!episodes.is_empty()).then_some(episodes)
}

fn parse_subtitle_item(value: Value) -> Option<AddonSubtitle> {
    // Read the display hint off the raw payload before `from_value` consumes
    // it; `SubtitleItem` only owns the protocol fields.
    let label = SUBTITLE_LABEL_KEYS
        .iter()
        .find_map(|key| json_string_field(&value, key))
        .and_then(|text| trim_to_max(&text, MAX_SUBTITLE_LABEL_CHARS));
    let parsed: SubtitleItem = serde_json::from_value(value).ok()?;
    let url = trim_to_max(parsed.url.as_deref().unwrap_or(""), MAX_STRING_CHARS)?;
    let id = trim_to_max(parsed.id.as_deref().unwrap_or(""), MAX_ID_CHARS)
        .unwrap_or_else(|| url.clone());

    // mpv fetches subtitle URLs itself, outside the backend redirect, size,
    // and hop policy: gate scheme, embedded credentials, and non-routable IP
    // literals here so a malicious subtitle payload cannot aim the player at
    // loopback, LAN, or metadata endpoints.
    if !is_fetchable_http_url(&url) {
        return None;
    }

    Some(AddonSubtitle {
        id,
        url,
        lang: parsed
            .lang
            .as_deref()
            .and_then(|value| trim_to_max(value, MAX_EXTRA_NAME_CHARS)),
        label,
    })
}

/// Magnet URLs are stream identifiers, not fetch targets — they carry no
/// SSRF surface, so every gate that would drop non-http(s) schemes must
/// recognize them first. Single owner for the scheme probe.
pub(crate) fn is_magnet_url(url: &str) -> bool {
    url.trim()
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("magnet:"))
}

/// Backend gate for player-fetchable http(s) URLs before they reach a
/// privileged fetch path (mpv subtitle/stream fetch or direct-stream probe).
/// Mirrors the frontend check plus the backend fetch policy: http(s) only,
/// no embedded credentials, and no non-routable IP literal host.
pub(crate) fn is_fetchable_http_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    !crate::providers::fetch_policy::is_blocked_ip_literal(host)
}

fn encode_path_segment(value: &str) -> Result<String, String> {
    let trimmed = trim_to_max(value, MAX_ID_CHARS)
        .ok_or_else(|| "Addon resource path is empty.".to_string())?;
    Ok(encode(&trimmed).into_owned())
}

fn encode_extra(extra: &CatalogExtra) -> Result<String, String> {
    let name = trim_to_max(&extra.name, MAX_EXTRA_NAME_CHARS)
        .ok_or_else(|| "Catalog extra name is empty.".to_string())?;
    let value = extra
        .value
        .trim()
        .chars()
        .take(MAX_EXTRA_VALUE_CHARS)
        .collect::<String>();
    Ok(format!("{}={}", encode(&name), encode(&value)))
}

pub(crate) fn build_resource_url(
    base_url: &str,
    resource: &str,
    type_: &str,
    id: &str,
    extras: &[CatalogExtra],
) -> Result<String, String> {
    let mut parsed = reqwest::Url::parse(base_url).map_err(|_| {
        "Invalid addon URL. Please provide a valid http(s) or stremio:// URL.".to_string()
    })?;
    let query = parsed.query().map(|value| value.to_string());
    let trimmed_path = parsed.path().trim_end_matches('/');
    let base_path = strip_manifest_suffix(trimmed_path);

    let resource = encode_path_segment(resource)?;
    let type_ = encode_path_segment(type_)?;
    let id = encode_path_segment(id)?;
    let extra_segment = if extras.is_empty() {
        None
    } else if extras.len() > MAX_EXTRAS {
        return Err("Catalog extras exceed the per-request limit.".to_string());
    } else {
        let encoded = extras
            .iter()
            .map(encode_extra)
            .collect::<Result<Vec<_>, _>>()?;
        Some(encoded.join("&"))
    };

    let resource_path = match extra_segment {
        Some(extras) => format!("{resource}/{type_}/{id}/{extras}"),
        None => format!("{resource}/{type_}/{id}"),
    };
    let path = if base_path.is_empty() || base_path == "/" {
        format!("/{resource_path}.json")
    } else {
        format!("{base_path}/{resource_path}.json")
    };

    parsed.set_path(&path);
    parsed.set_query(query.as_deref());
    Ok(parsed.to_string())
}

async fn fetch_bounded_json(
    client: &Client,
    url: &str,
    what: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, ResourceFetchError> {
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(RESOURCE_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|error| {
            ResourceFetchError::Transport(format!(
                "Failed to reach addon {what}: {}",
                super::addons::sanitize_addon_log(&error.to_string())
            ))
        })?;

    if !response.status().is_success() {
        return Err(ResourceFetchError::Deterministic(format!(
            "Addon {what} returned HTTP {}.",
            response.status().as_u16()
        )));
    }

    super::read_bounded_body(response, max_bytes, |declared| match declared {
        Some(bytes) => format!(
            "Addon {what} response exceeds the size limit ({bytes} bytes declared, {max_bytes} allowed)."
        ),
        None => format!("Addon {what} response exceeds the size limit (over {max_bytes} bytes)."),
    })
    .await
    .map_err(|error| match error {
        BoundedBodyError::TooLarge(message) => ResourceFetchError::Deterministic(message),
        BoundedBodyError::Read(message) => ResourceFetchError::Transport(message),
    })
}

#[cfg(test)]
mod tests;
