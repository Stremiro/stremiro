use super::ttl_cache::{
    hash_segment, FetchContract, FetchFailure, FetchFailureCooldown, InFlight, TtlCache,
};
use super::{
    addon_manifest::{AddonCatalogCapability, AddonManifest},
    bound_optional, build_provider_http_client, encode_uri_component, normalize_media_year,
    strip_manifest_suffix, trim_to_max, Episode, MediaDetails, MediaItem, MediaSeason, Trailer,
    ADDON_URL_INVALID_MESSAGE, MAGNET_PREFIX,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{value::RawValue, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

/// 2MiB bound, ~3x headroom over measured catalog pages (decompressed,
/// 2026-09-03): series `top` ~537KB, `top` + `genre=Animation` ~695KB.
const CATALOG_MAX_BYTES: usize = 2 * 1024 * 1024;
const META_MAX_BYTES: usize = 4 * 1024 * 1024;
const SUBTITLE_MAX_BYTES: usize = 512 * 1024;
/// Catalog pages run ~0.5-0.7MiB decompressed — a tighter timeout misreads
/// slow international routes as dead hosts.
const RESOURCE_TIMEOUT_SECS: u64 = 20;
const MAX_CATALOG_ITEMS: usize = 500;
const MAX_EPISODES: usize = 2_000;
const MAX_TRAILERS: usize = 32;
const MAX_TRAILER_NAME_CHARS: usize = 80;
const MAX_CAST: usize = 64;
const MAX_CREDITS: usize = 8;
const MAX_GENRES: usize = 32;
const MAX_STRING_CHARS: usize = 2_048;
const MAX_SERIALIZED_IMAGE_URL_CHARS: usize = MAX_STRING_CHARS * 4 * 3;
const MAX_ID_CHARS: usize = 256;
const MAX_LOOKUP_ID_CHARS: usize = MAX_ID_CHARS + 2 * (1 + 10);
const MAX_EXTRA_NAME_CHARS: usize = 64;
const MAX_EXTRA_VALUE_CHARS: usize = 256;
const MAX_EXTRAS: usize = 16;
const MAX_SUBTITLE_LABEL_CHARS: usize = 256;
pub(crate) const MAX_SUBTITLES_PER_ADDON: usize = 50;

/// Addon payloads are stable for minutes; empty answers get the shorter window so new content surfaces fast.
const RESOURCE_CACHE_TTL: Duration = Duration::from_secs(180);
const RESOURCE_CACHE_EMPTY_TTL: Duration = Duration::from_secs(30);
const META_CACHE_MAX_ENTRIES: usize = 48;
const CATALOG_CACHE_MAX_ENTRIES: usize = 48;
const SUBTITLE_CACHE_MAX_ENTRIES: usize = 64;
const SUBTITLE_DISK_MAX_BYTES: usize = SUBTITLE_MAX_BYTES + 128;
// All filesystem work runs on blocking workers; one gate bounds writers across clients.
static SUBTITLE_DISK_GATE: Mutex<()> = Mutex::new(());
/// A dropped fetch future never releases its key; inserts sweep orphans past this bound.
const RESOURCE_IN_FLIGHT_SWEEP_AT: usize = 64;
/// Per-addon transport-failure cooldown: a host that failed to answer is
/// presumed down, so fetches fail fast for this window. Session-local;
/// mechanics in `FetchFailureCooldown`.
const RESOURCE_FETCH_FAILURE_TTL: Duration = Duration::from_secs(30);
/// Negative-cache bound for deterministic per-request failures.
const RESOURCE_FAILURE_CACHE_MAX_ENTRIES: usize = 64;

/// The request URL embeds the (possibly credential-bearing) addon base, so cache keys keep only a hash segment.
fn resource_cache_key(resource: &str, url: &str) -> String {
    format!("{resource}:{}", hash_segment(url))
}

#[derive(Serialize, Deserialize)]
struct SubtitleDiskEntry {
    expires_at: SystemTime,
    response: Box<RawValue>,
}

fn read_subtitle_disk(path: &Path) -> Option<Arc<[AddonSubtitle]>> {
    let bytes = {
        let _guard = super::lock_or_recover(&SUBTITLE_DISK_GATE);
        super::read_cache_file(path, SUBTITLE_DISK_MAX_BYTES)?
    };
    let entry: SubtitleDiskEntry = serde_json::from_slice(&bytes).ok()?;
    let remaining = entry.expires_at.duration_since(SystemTime::now()).ok()?;
    if remaining > RESOURCE_CACHE_TTL {
        return None;
    }
    // Disk is untrusted too: reapply the URL, item-count and field validation.
    let response = serde_json::from_str(entry.response.get()).ok()?;
    let subtitles = parse_subtitle_items(response);
    (!subtitles.is_empty() && SystemTime::now() < entry.expires_at).then_some(subtitles)
}

fn write_subtitle_disk(
    path: &Path,
    bytes: &[u8],
    expires_at: SystemTime,
    generation: &AtomicU64,
    expected: u64,
) -> Option<()> {
    let bytes = serde_json::to_vec(&SubtitleDiskEntry {
        expires_at,
        response: serde_json::from_slice(bytes).ok()?,
    })
    .ok()?;
    if bytes.len() > SUBTITLE_DISK_MAX_BYTES {
        return None;
    }
    let _guard = super::lock_or_recover(&SUBTITLE_DISK_GATE);
    if generation.load(Ordering::SeqCst) != expected || SystemTime::now() >= expires_at {
        return None;
    }
    super::write_cache_file(path, &bytes, SUBTITLE_CACHE_MAX_ENTRIES)
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

fn deserialize_optional_json<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    let raw = Option::<&RawValue>::deserialize(deserializer)?;
    Ok(raw.and_then(|raw| serde_json::from_str(raw.get()).ok()))
}

/// Card-only decode — search endpoints return full meta objects, so decoding
/// only card fields keeps memory proportional to what browse renders.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CatalogItemJson<'a> {
    id: Option<Value>,
    name: Option<Value>,
    #[serde(rename = "type")]
    type_: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_optional_json")]
    poster: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_optional_json")]
    background: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_optional_json")]
    logo: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_optional_json")]
    description: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_optional_json")]
    year: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_optional_json")]
    release_info: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_optional_json")]
    genre: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_optional_json")]
    genres: Option<Value>,
    #[serde(borrow)]
    links: Option<&'a RawValue>,
}

#[derive(Debug, Deserialize, Default)]
struct CatalogResponse<'a> {
    #[serde(borrow, default)]
    metas: Vec<&'a RawValue>,
}

#[derive(Debug, Deserialize, Default)]
struct MetaResponse<'a> {
    #[serde(borrow)]
    meta: Option<&'a RawValue>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SubtitleItem {
    id: Option<String>,
    url: Option<String>,
    lang: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_json")]
    label: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_optional_json")]
    title: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_optional_json")]
    name: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_optional_json")]
    subtitle_file_name: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_optional_json")]
    movie_release_name: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_optional_json")]
    release_name: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_optional_json")]
    file_name: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_optional_json")]
    filename: Option<Value>,
}

#[derive(Debug, Deserialize, Default)]
struct SubtitleResponse<'a> {
    #[serde(borrow, default)]
    subtitles: Vec<&'a RawValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddonSubtitle {
    pub id: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl AddonSubtitle {
    pub(crate) fn dedup_identity(&self) -> (&str, &str, String) {
        let lang = self
            .lang
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_lowercase)
            .unwrap_or_default();
        (&self.id, &self.url, lang)
    }
}

/// Cooldown message served while an addon sits inside its failure window.
const RESOURCE_COOLDOWN_MESSAGE: &str =
    "Addon fetch skipped: the source is cooling down after a recent transport failure.";

pub(crate) struct AddonResourceClient {
    client: Client,
    // Shared parsed metadata; shape-specific clones happen outside the cache lock.
    meta_cache: TtlCache<Arc<MediaDetails>>,
    // A title that exhausted the priority grace should not pay it again on every open.
    meta_stragglers: TtlCache<()>,
    catalog_cache: TtlCache<Arc<CatalogPage>>,
    subtitle_cache: TtlCache<Arc<[AddonSubtitle]>>,
    subtitle_disk_dir: Option<PathBuf>,
    /// Per-addon cooldown keyed by base-URL hash — same contract as the transport's `fetch_failures`.
    fetch_failures: FetchFailureCooldown,
    /// Short-TTL negative cache — a deterministic failure (status, size cap,
    /// decode, missing meta) replays identically for the same request.
    failure_cache: TtlCache<String>,
    /// Single-flight locks keyed by request URL — followers wait on the
    /// leader and re-read the cache.
    in_flight: InFlight,
    /// Bumped by `clear_cache`: in-flight fetches must not repopulate cleared entries.
    generation: Arc<AtomicU64>,
}

/// Lite shape rebuilt field-by-field so a card hit never copies the discarded
/// episodes; a new `MediaDetails` field fails this literal on purpose. Credits stay:
/// the details hero paints from this shape and must not grow when the full one lands.
pub(crate) fn meta_for_shape(details: &MediaDetails, include_episodes: bool) -> MediaDetails {
    if include_episodes {
        return details.clone();
    }
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
        rating_percent: details.rating_percent,
        runtime: details.runtime.clone(),
        cast: details.cast.clone(),
        directors: details.directors.clone(),
        writers: details.writers.clone(),
        genres: details.genres.clone(),
        country: details.country.clone(),
        awards: details.awards.clone(),
        is_anime: details.is_anime,
        trailers: details.trailers.clone(),
        episodes: None,
        seasons: None,
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
            meta_stragglers: TtlCache::new(
                META_CACHE_MAX_ENTRIES,
                RESOURCE_CACHE_EMPTY_TTL,
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
            subtitle_disk_dir: None,
            fetch_failures: FetchFailureCooldown::new(RESOURCE_FETCH_FAILURE_TTL),
            // Failures take the short empty TTL: a fixed addon recovers fast.
            failure_cache: TtlCache::new(
                RESOURCE_FAILURE_CACHE_MAX_ENTRIES,
                RESOURCE_CACHE_EMPTY_TTL,
                RESOURCE_CACHE_EMPTY_TTL,
            ),
            in_flight: InFlight::new(RESOURCE_IN_FLIGHT_SWEEP_AT),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub(crate) fn with_subtitle_cache_dir(cache_dir: Option<PathBuf>) -> Self {
        Self {
            subtitle_disk_dir: cache_dir.map(|directory| directory.join("subtitles-v1")),
            ..Self::new()
        }
    }

    /// Clear in-memory resource caches (e.g. addon set changed): bump the generation
    /// first so in-flight fetches can't repopulate; cooldowns clear too.
    /// Disk responses retain their exact source-URL key and original expiration.
    pub(crate) fn clear_cache(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.meta_cache.clear();
        self.meta_stragglers.clear();
        self.catalog_cache.clear();
        self.subtitle_cache.clear();
        self.failure_cache.clear();
        self.fetch_failures.clear();
    }

    pub(crate) fn purge_expired_caches(&self) {
        self.meta_cache.purge_expired();
        self.meta_stragglers.purge_expired();
        self.catalog_cache.purge_expired();
        self.subtitle_cache.purge_expired();
        self.failure_cache.purge_expired();
    }

    pub(crate) fn cache_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub(crate) fn meta_is_recent_straggler(&self, base_url: &str, type_: &str, id: &str) -> bool {
        self.fetch_failures.cooling_down(&hash_segment(base_url))
            || build_resource_url(base_url, "meta", type_, id, &[])
                .ok()
                .is_some_and(|url| {
                    self.meta_stragglers
                        .get(&resource_cache_key("meta", &url))
                        .is_some()
                })
    }

    pub(crate) fn note_meta_straggler(
        &self,
        base_url: &str,
        type_: &str,
        id: &str,
        generation: u64,
    ) {
        if let Ok(url) = build_resource_url(base_url, "meta", type_, id, &[]) {
            self.meta_stragglers
                .put(&resource_cache_key("meta", &url), (), false, || {
                    self.cache_generation() == generation
                });
        }
    }

    /// Shared fetch contract wired with this client's caches and resource policy.
    fn fetch_contract(&self) -> FetchContract<'_> {
        FetchContract {
            failure_cache: &self.failure_cache,
            fetch_failures: &self.fetch_failures,
            in_flight: &self.in_flight,
            generation: &self.generation,
            request_timeout: Duration::from_secs(RESOURCE_TIMEOUT_SECS),
            cooldown_message: RESOURCE_COOLDOWN_MESSAGE,
        }
    }

    // Command-owned normalization runs before insertion, never on a cache hit.
    pub(crate) async fn fetch_catalog(
        &self,
        base_url: &str,
        type_: &str,
        catalog_id: &str,
        extras: &[CatalogExtra],
        normalize: fn(MediaItem) -> MediaItem,
    ) -> Result<CatalogPage, String> {
        let url = build_resource_url(base_url, "catalog", type_, catalog_id, extras)?;
        let cache_key = resource_cache_key("catalog", &url);
        let addon_key = hash_segment(base_url);
        let page = self
            .fetch_contract()
            .run(
                &self.catalog_cache,
                &cache_key,
                &addon_key,
                |page| page.items.is_empty(),
                || async {
                    let what = format!("catalog {type_}/{catalog_id}");
                    let bytes =
                        fetch_bounded_json(&self.client, &url, &what, CATALOG_MAX_BYTES).await?;
                    let query = extras
                        .iter()
                        .find(|extra| extra.name == "search")
                        .map(|extra| {
                            crate::commands::search_commands::normalize_search_text(&extra.value)
                        });
                    tokio::task::spawn_blocking(move || {
                        let response: CatalogResponse<'_> = serde_json::from_slice(&bytes)
                            .map_err(|_| {
                                FetchFailure::Fatal("Invalid catalog response format.".to_string())
                            })?;
                        Ok(Arc::new(parse_catalog_page(
                            response,
                            normalize,
                            query.as_deref(),
                        )))
                    })
                    .await
                    .map_err(|_| {
                        FetchFailure::Fatal("Catalog response processing task failed.".to_string())
                    })?
                },
            )
            .await?;
        Ok(page.as_ref().clone())
    }

    pub(crate) async fn fetch_meta(
        &self,
        base_url: &str,
        type_: &str,
        id: &str,
        normalize: fn(MediaDetails) -> MediaDetails,
    ) -> Result<Arc<MediaDetails>, String> {
        let url = build_resource_url(base_url, "meta", type_, id, &[])?;
        let cache_key = resource_cache_key("meta", &url);
        let addon_key = hash_segment(base_url);
        self.fetch_contract()
            .run(
                &self.meta_cache,
                &cache_key,
                &addon_key,
                // Meta is success-or-error: a stored entry always earns the full TTL.
                |_| false,
                || async {
                    let what = format!("meta {type_}/{id}");
                    let bytes =
                        fetch_bounded_json(&self.client, &url, &what, META_MAX_BYTES).await?;
                    tokio::task::spawn_blocking(move || {
                        let response: MetaResponse<'_> =
                            serde_json::from_slice(&bytes).map_err(|_| {
                                FetchFailure::Fatal("Invalid metadata response format.".to_string())
                            })?;
                        response
                            .meta
                            .and_then(parse_meta_item)
                            .map(normalize)
                            .map(Arc::new)
                            .ok_or_else(|| FetchFailure::Fatal("Metadata not found.".to_string()))
                    })
                    .await
                    .map_err(|_| {
                        FetchFailure::Fatal("Metadata response processing task failed.".to_string())
                    })?
                },
            )
            .await
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
        if let Some(subtitles) = self.subtitle_cache.get(&cache_key) {
            return Ok(subtitles.to_vec());
        }
        let generation = self.cache_generation();
        let disk_path = self
            .subtitle_disk_dir
            .as_ref()
            .map(|directory| directory.join(format!("{}.json", hash_segment(&cache_key))));
        if let Some(path) = disk_path.clone() {
            let cached = tokio::task::spawn_blocking(move || read_subtitle_disk(&path))
                .await
                .ok()
                .flatten();
            if self.cache_generation() != generation {
                return Err("Addon request was superseded. Please try again.".to_string());
            }
            if let Some(subtitles) = cached {
                // Never promote disk hits into a fresh 180s memory window or rewrite them.
                return Ok(subtitles.to_vec());
            }
        }
        let subtitles = self
            .fetch_contract()
            .run(
                &self.subtitle_cache,
                &cache_key,
                &addon_key,
                |subtitles| subtitles.is_empty(),
                || async {
                    let what = format!("subtitles {type_}/{id}");
                    let bytes =
                        fetch_bounded_json(&self.client, &url, &what, SUBTITLE_MAX_BYTES).await?;
                    let expires_at = SystemTime::now() + RESOURCE_CACHE_TTL;
                    let disk_path = disk_path.clone();
                    let cache_generation = self.generation.clone();
                    tokio::task::spawn_blocking(move || {
                        let response: SubtitleResponse<'_> = serde_json::from_slice(&bytes)
                            .map_err(|_| {
                                FetchFailure::Fatal("Invalid subtitle response format.".to_string())
                            })?;
                        let subtitles = parse_subtitle_items(response);
                        if !subtitles.is_empty() {
                            if let Some(path) = disk_path {
                                let _ = write_subtitle_disk(
                                    &path,
                                    &bytes,
                                    expires_at,
                                    &cache_generation,
                                    generation,
                                );
                            }
                        }
                        Ok(subtitles)
                    })
                    .await
                    .map_err(|_| {
                        FetchFailure::Fatal("Subtitle response processing task failed.".to_string())
                    })?
                },
            )
            .await?;
        Ok(subtitles.to_vec())
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

pub(crate) fn snapshot_supports_catalog<'a>(
    snapshot: &'a AddonManifest,
    type_: &str,
    catalog_id: &str,
    extras: &[CatalogExtra],
) -> Result<&'a AddonCatalogCapability, String> {
    // `catalogs[]` is authoritative: a catalogs-only manifest may omit `resources`.
    let Some(catalog) = snapshot
        .catalogs
        .iter()
        .find(|catalog| catalog.type_.eq_ignore_ascii_case(type_) && catalog.id == catalog_id)
        .or_else(|| {
            snapshot.catalogs.iter().find(|catalog| {
                catalog.type_.eq_ignore_ascii_case(type_)
                    && catalog.id.eq_ignore_ascii_case(catalog_id)
            })
        })
    else {
        return Err(format!(
            "Addon does not declare catalog {catalog_id} for type {type_}."
        ));
    };

    // `search` is a hard capability gate (an undeclaring catalog echoes bogus
    // rows); other extras are advisory — callers enforce unsupported filters locally.
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

    for required in catalog.extras.iter().filter(|extra| extra.is_required) {
        if !extras
            .iter()
            .any(|extra| extra.name.eq_ignore_ascii_case(&required.name))
        {
            return Err(format!(
                "Catalog {} requires extra {}.",
                catalog.id, required.name
            ));
        }
    }

    Ok(catalog)
}

fn json_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => trim_to_max(text, MAX_STRING_CHARS),
        Value::Number(number) => trim_to_max(&number.to_string(), MAX_STRING_CHARS),
        _ => None,
    }
}

fn json_media_id(value: &Value) -> Option<String> {
    match value {
        Value::String(id) => crate::commands::normalize_media_id(id),
        Value::Number(id) => crate::commands::normalize_media_id(&id.to_string()),
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
        // Reject on overflow: a wrapping cast would corrupt season/episode mappings.
        Some(Value::Number(number)) => number.as_u64().and_then(|value| u32::try_from(value).ok()),
        Some(Value::String(text)) => text.trim().parse().ok(),
        _ => None,
    }
}

fn meta_link_names(value: &Value, category: &str, max_items: usize) -> Option<Vec<String>> {
    let names: Vec<String> = value
        .get("links")?
        .as_array()?
        .iter()
        .filter(|link| {
            link.get("category")
                .and_then(Value::as_str)
                .is_some_and(|value| value.trim().eq_ignore_ascii_case(category))
        })
        .filter_map(|link| json_string_field(link, "name"))
        .take(max_items)
        .collect();
    (!names.is_empty()).then_some(names)
}

fn parse_catalog_page(
    response: CatalogResponse<'_>,
    normalize: fn(MediaItem) -> MediaItem,
    query: Option<&str>,
) -> CatalogPage {
    let mut items = Vec::new();
    let mut source_item_count = 0;
    for value in response.metas {
        source_item_count += 1;
        if let Ok(value) = serde_json::from_str::<CatalogItemJson<'_>>(value.get()) {
            let links = value.links;
            let Some(mut item) = parse_catalog_item(value) else {
                continue;
            };
            item.matches_search_credit = query
                .filter(|query| !query.is_empty())
                .is_some_and(|query| catalog_matches_search_credit(links, query));
            items.push(normalize(item));
            if items.len() == MAX_CATALOG_ITEMS {
                break;
            }
        }
    }
    CatalogPage {
        source_item_count,
        items,
    }
}

fn catalog_matches_search_credit(links: Option<&RawValue>, query: &str) -> bool {
    let Some(links) =
        links.and_then(|links| serde_json::from_str::<Vec<&RawValue>>(links.get()).ok())
    else {
        return false;
    };
    links
        .into_iter()
        .take(MAX_CAST + MAX_CREDITS + MAX_GENRES)
        .any(|link| {
            let Some(link) = parse_object_fields(link, |key| matches!(key, "category" | "name"))
            else {
                return false;
            };
            let is_credit = link
                .get("category")
                .and_then(Value::as_str)
                .is_some_and(|category| {
                    category.trim().eq_ignore_ascii_case("Cast")
                        || category.trim().eq_ignore_ascii_case("Directors")
                });
            is_credit
                && link
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| {
                        name.chars().take(MAX_STRING_CHARS + 1).count() <= MAX_STRING_CHARS
                            && crate::commands::search_commands::normalize_search_text(name)
                                == query
                    })
        })
}

fn parse_object_fields(raw: &RawValue, keep: fn(&str) -> bool) -> Option<Value> {
    struct Fields(fn(&str) -> bool);

    impl<'de> serde::de::Visitor<'de> for Fields {
        type Value = Value;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an object")
        }

        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut fields: A,
        ) -> Result<Self::Value, A::Error> {
            let mut object = serde_json::Map::new();
            while let Some(key) = fields.next_key::<String>()? {
                if self.0(&key) {
                    object.insert(key, fields.next_value()?);
                } else {
                    fields.next_value::<serde::de::IgnoredAny>()?;
                }
            }
            Ok(Value::Object(object))
        }
    }

    let mut deserializer = serde_json::Deserializer::from_str(raw.get());
    serde::Deserializer::deserialize_map(&mut deserializer, Fields(keep)).ok()
}

fn parse_catalog_item(value: CatalogItemJson<'_>) -> Option<MediaItem> {
    let id = value.id.as_ref().and_then(json_media_id)?;
    let title = value.name.as_ref().and_then(json_string)?;
    let type_ = value.type_.as_ref().and_then(json_string)?;

    Some(MediaItem {
        id,
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
        matches_search_credit: false,
        catalog_genre: None,
        type_,
    })
}

fn parse_meta_item(raw: &RawValue) -> Option<MediaDetails> {
    // Decode consumed fields only; episodes have a separate bounded decoder.
    let mut fields: BTreeMap<String, &RawValue> = serde_json::from_str(raw.get()).ok()?;
    let videos = fields.remove("videos");
    let value = Value::Object(
        fields
            .into_iter()
            .filter(|(key, _)| {
                matches!(
                    key.as_str(),
                    "id" | "name"
                        | "type"
                        | "imdb_id"
                        | "imdbId"
                        | "poster"
                        | "background"
                        | "logo"
                        | "year"
                        | "releaseInfo"
                        | "released"
                        | "description"
                        | "imdbRating"
                        | "rating"
                        | "runtime"
                        | "cast"
                        | "director"
                        | "genre"
                        | "genres"
                        | "links"
                        | "writer"
                        | "country"
                        | "awards"
                        | "trailers"
                        | "trailerStreams"
                )
            })
            .filter_map(|(key, raw)| Some((key, serde_json::from_str(raw.get()).ok()?)))
            .collect(),
    );
    let id = json_media_id(value.get("id")?)?;
    let title = json_string(value.get("name")?)?;
    let type_ = json_string(value.get("type")?)?;
    // `imdb_id` is a lookup id embedded in stream query paths — it shares `id`'s bound.
    let imdb_id = if id.starts_with("tt") {
        Some(id.clone())
    } else {
        value
            .get("imdb_id")
            .and_then(json_media_id)
            .or_else(|| value.get("imdbId").and_then(json_media_id))
    };

    // `seasons` is populated iff `episodes` is, so the lite shape drops both together.
    let episodes = parse_episodes(videos);
    let seasons = episodes.as_deref().map(media_seasons_from_episodes);

    Some(MediaDetails {
        id,
        imdb_id,
        title,
        poster: sanitize_image_url(value.get("poster")),
        backdrop: sanitize_image_url(value.get("background")),
        logo: sanitize_image_url(value.get("logo")),
        year: normalize_media_year(
            json_string_field(&value, "year"),
            json_string_field(&value, "releaseInfo"),
        ),
        display_year: None,
        // Raw `released` ISO date is the schedule source of truth; the
        // year-only fallback keeps unstamped metas working.
        release_date: json_string_field(&value, "released"),
        type_,
        description: json_string_field(&value, "description"),
        rating: json_string_field(&value, "imdbRating")
            .or_else(|| json_string_field(&value, "rating")),
        rating_percent: None,
        runtime: json_string_field(&value, "runtime"),
        cast: json_string_list(value.get("cast"), MAX_CAST)
            .or_else(|| meta_link_names(&value, "Cast", MAX_CAST)),
        directors: json_string_list(value.get("director"), MAX_CREDITS)
            .or_else(|| meta_link_names(&value, "Directors", MAX_CREDITS)),
        writers: json_string_list(value.get("writer"), MAX_CREDITS)
            .or_else(|| meta_link_names(&value, "Writers", MAX_CREDITS)),
        genres: json_string_list(value.get("genre"), MAX_GENRES)
            .or_else(|| json_string_list(value.get("genres"), MAX_GENRES))
            .or_else(|| meta_link_names(&value, "Genres", MAX_GENRES)),
        country: json_text_field(&value, "country"),
        awards: json_text_field(&value, "awards"),
        // Derived in `normalize_media_details`; inbound flags never land.
        is_anime: false,
        trailers: parse_trailers(value.get("trailers"), value.get("trailerStreams")),
        // Lite-shape trimming happens post-cache in `meta_for_shape`.
        episodes,
        seasons,
    })
}

/// One entry per contiguous season run; input must already be (season, episode)-sorted.
fn media_seasons_from_episodes(episodes: &[Episode]) -> Vec<MediaSeason> {
    episodes
        .chunk_by(|left, right| left.season == right.season)
        .map(|run| MediaSeason {
            number: run[0].season,
            episode_count: u32::try_from(run.len()).unwrap_or(u32::MAX),
        })
        .collect()
}

fn json_string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(json_string)
}

/// Display-only scalars accept strings as-is — never coerce numbers or objects.
fn json_text_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .and_then(|text| trim_to_max(text, MAX_STRING_CHARS))
}

/// Accept only 11-character YouTube tokens, never URL parameters or markup.
fn is_youtube_video_token(source: &str) -> bool {
    source.len() == 11
        && source
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Image fields reach the webview `<img>`, so they share the subtitle/stream
/// ingress gate; a rejected URL degrades to no artwork, not a dropped row.
fn sanitize_image_url(value: Option<&Value>) -> Option<String> {
    normalize_image_url(value?.as_str()?)
}

pub(crate) fn normalize_image_url(url: &str) -> Option<String> {
    let raw_chars = url.chars().take(MAX_SERIALIZED_IMAGE_URL_CHARS + 1).count();
    if raw_chars > MAX_SERIALIZED_IMAGE_URL_CHARS {
        return None;
    }
    let parsed = parse_fetchable_http_url(url.trim())?;
    (raw_chars <= MAX_STRING_CHARS || parsed.as_str() == url).then(|| parsed.into())
}

fn normalize_trailer_name(title: &str) -> Option<String> {
    let mut name = String::with_capacity(title.len().min(MAX_TRAILER_NAME_CHARS));
    let mut remaining = MAX_TRAILER_NAME_CHARS;
    for word in title.split_whitespace() {
        if remaining == 0 {
            break;
        }
        if !name.is_empty() {
            name.push(' ');
            remaining -= 1;
        }
        for character in word.chars().take(remaining) {
            name.push(character);
            remaining -= 1;
        }
    }
    // The bound may land on the separator before the next word.
    if name.ends_with(' ') {
        name.pop();
    }
    (!name.is_empty()).then_some(name)
}

fn parse_trailers(value: Option<&Value>, streams: Option<&Value>) -> Option<Vec<Trailer>> {
    let mut trailers: Vec<Trailer> = Vec::new();
    for item in value.and_then(Value::as_array).into_iter().flatten() {
        let Some(source) =
            json_string_field(item, "source").filter(|source| is_youtube_video_token(source))
        else {
            continue;
        };
        if !json_string_field(item, "type")
            .is_some_and(|type_| type_.eq_ignore_ascii_case("trailer"))
            || trailers.iter().any(|trailer| trailer.id == source)
        {
            continue;
        }
        trailers.push(Trailer {
            id: source,
            name: None,
        });
        if trailers.len() == MAX_TRAILERS {
            break;
        }
    }
    for item in streams.and_then(Value::as_array).into_iter().flatten() {
        let Some(id) = json_string_field(item, "ytId").filter(|id| is_youtube_video_token(id))
        else {
            continue;
        };
        let name =
            json_string_field(item, "title").and_then(|title| normalize_trailer_name(&title));
        if let Some(trailer) = trailers.iter_mut().find(|trailer| trailer.id == id) {
            if trailer.name.is_none() {
                trailer.name = name;
            }
        } else if trailers.len() < MAX_TRAILERS {
            trailers.push(Trailer { id, name });
        }
    }
    (!trailers.is_empty()).then_some(trailers)
}

fn parse_episodes(value: Option<&RawValue>) -> Option<Vec<Episode>> {
    struct Episodes;

    impl<'de> serde::de::Visitor<'de> for Episodes {
        type Value = Vec<Episode>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an episode array")
        }

        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            let mut episodes = Vec::new();
            while episodes.len() < MAX_EPISODES {
                let Some(raw) = sequence.next_element::<&RawValue>()? else {
                    break;
                };
                let Some(item) = parse_object_fields(raw, |key| {
                    matches!(
                        key,
                        "id" | "name"
                            | "title"
                            | "season"
                            | "episode"
                            | "number"
                            | "released"
                            | "overview"
                            | "thumbnail"
                    )
                }) else {
                    continue;
                };
                let Some(id) = item.get("id").and_then(json_media_id) else {
                    continue;
                };
                episodes.push(Episode {
                    id,
                    title: json_string_field(&item, "name")
                        .or_else(|| json_string_field(&item, "title")),
                    season: json_u32(item.get("season")).unwrap_or(0),
                    episode: json_u32(item.get("episode"))
                        .or_else(|| json_u32(item.get("number")))
                        .unwrap_or(0),
                    released: json_string_field(&item, "released"),
                    release_date: None,
                    overview: json_string_field(&item, "overview"),
                    thumbnail: sanitize_image_url(item.get("thumbnail")),
                    stream_lookup_id: None,
                    stream_season: None,
                    stream_episode: None,
                });
            }
            // Validate the rest without allocating discarded rows or a pointer per source entry.
            while sequence.next_element::<serde::de::IgnoredAny>()?.is_some() {}
            Ok(episodes)
        }
    }

    let mut deserializer = serde_json::Deserializer::from_str(value?.get());
    let mut episodes = serde::Deserializer::deserialize_seq(&mut deserializer, Episodes).ok()?;

    // Sort after the cap; ties keep addon order. Consumers read this cached order over IPC.
    episodes.sort_by_key(|episode| (episode.season, episode.episode));

    (!episodes.is_empty()).then_some(episodes)
}

fn parse_subtitle_items(response: SubtitleResponse<'_>) -> Arc<[AddonSubtitle]> {
    let mut seen = HashSet::new();
    response
        .subtitles
        .into_iter()
        .filter_map(|value| serde_json::from_str::<SubtitleItem>(value.get()).ok())
        .filter_map(parse_subtitle_item)
        .filter(|item| {
            let (id, url, lang) = item.dedup_identity();
            seen.insert((id.to_owned(), url.to_owned(), lang))
        })
        .take(MAX_SUBTITLES_PER_ADDON)
        .collect()
}

fn parse_subtitle_item(parsed: SubtitleItem) -> Option<AddonSubtitle> {
    let label = [
        &parsed.label,
        &parsed.title,
        &parsed.name,
        &parsed.subtitle_file_name,
        &parsed.movie_release_name,
        &parsed.release_name,
        &parsed.file_name,
        &parsed.filename,
    ]
    .into_iter()
    .find_map(|value| value.as_ref().and_then(json_string))
    .and_then(|text| trim_to_max(&text, MAX_SUBTITLE_LABEL_CHARS));
    let url = bound_optional(
        parsed
            .url
            .filter(|url| url.chars().nth(MAX_STRING_CHARS).is_none()),
        MAX_STRING_CHARS,
    )?;
    let id = bound_optional(parsed.id, MAX_ID_CHARS).unwrap_or_else(|| url.clone());

    // Keep subtitle URL admission aligned with the bounded player download path.
    if !is_fetchable_http_url(&url) {
        return None;
    }

    Some(AddonSubtitle {
        id,
        url,
        lang: bound_optional(parsed.lang, MAX_EXTRA_NAME_CHARS),
        label,
    })
}

/// Magnet URLs are identifiers, not fetch targets: no SSRF surface, so
/// scheme-rejecting gates must recognize them first.
pub(crate) fn is_magnet_url(url: &str) -> bool {
    url.trim()
        .get(..MAGNET_PREFIX.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(MAGNET_PREFIX))
}

/// Gate for player-fetchable URLs before a privileged fetch path (mpv
/// subtitle/stream fetch, direct-stream probe): http(s) only, no credentials, no non-routable IP literal.
pub(crate) fn is_fetchable_http_url(url: &str) -> bool {
    parse_fetchable_http_url(url).is_some()
}

pub(crate) fn parse_fetchable_http_url(url: &str) -> Option<reqwest::Url> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if !crate::providers::fetch_policy::is_plain_http_url(&parsed) {
        return None;
    }
    let host = parsed.host_str()?;
    (!crate::providers::fetch_policy::is_blocked_ip_literal(host)).then_some(parsed)
}

fn encode_path_segment(value: &str, max_chars: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Addon resource path is empty.".to_string());
    }
    if matches!(trimmed, "." | "..") || trimmed.chars().nth(max_chars).is_some() {
        return Err("Addon resource path is invalid.".to_string());
    }
    Ok(encode_uri_component(trimmed).into_owned())
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
    Ok(format!(
        "{}={}",
        encode_uri_component(&name),
        encode_uri_component(&value)
    ))
}

pub(crate) fn build_resource_url(
    base_url: &str,
    resource: &str,
    type_: &str,
    id: &str,
    extras: &[CatalogExtra],
) -> Result<String, String> {
    let mut parsed =
        reqwest::Url::parse(base_url).map_err(|_| ADDON_URL_INVALID_MESSAGE.to_string())?;
    let trimmed_path = parsed.path().trim_end_matches('/');
    let base_path = strip_manifest_suffix(trimmed_path);

    let resource = encode_path_segment(resource, MAX_ID_CHARS)?;
    let type_ = encode_path_segment(type_, MAX_ID_CHARS)?;
    let id = encode_path_segment(id, MAX_LOOKUP_ID_CHARS)?;
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
    Ok(parsed.into())
}

async fn fetch_bounded_json(
    client: &Client,
    url: &str,
    what: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, FetchFailure> {
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(RESOURCE_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|error| {
            let error = error.without_url();
            let message = format!("Failed to reach addon {what}: {error}");
            FetchFailure::from_send_error(&error, message)
        })?;

    if !response.status().is_success() {
        return Err(FetchFailure::from_http_status(
            response.status(),
            format!("Addon {what} returned HTTP {}.", response.status().as_u16()),
        ));
    }

    super::read_bounded_body(response, max_bytes, |declared| match declared {
        Some(bytes) => format!(
            "Addon {what} response exceeds the size limit ({bytes} bytes declared, {max_bytes} allowed)."
        ),
        None => format!("Addon {what} response exceeds the size limit (over {max_bytes} bytes)."),
    })
    .await
    .map_err(FetchFailure::from)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod trailer_name_tests {
    use super::*;

    #[test]
    fn trailer_names_collapse_whitespace_without_intermediate_word_storage() {
        assert_eq!(normalize_trailer_name(" \t\n "), None);
        assert_eq!(
            normalize_trailer_name("  Official\t \n Trailer\u{2003}HD  ").as_deref(),
            Some("Official Trailer HD")
        );
        assert_eq!(
            normalize_trailer_name("Already normalized").as_deref(),
            Some("Already normalized")
        );
    }

    #[test]
    fn trailer_names_bound_unicode_characters_and_trim_cut_separators() {
        let unicode = "語".repeat(MAX_TRAILER_NAME_CHARS + 1);
        assert_eq!(
            normalize_trailer_name(&unicode).unwrap(),
            "語".repeat(MAX_TRAILER_NAME_CHARS)
        );
        let prefix = "a".repeat(MAX_TRAILER_NAME_CHARS - 1);
        assert_eq!(
            normalize_trailer_name(&format!("{prefix} tail")).unwrap(),
            prefix
        );
    }
}
