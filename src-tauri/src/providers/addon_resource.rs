use super::ttl_cache::{
    hash_segment, FetchContract, FetchFailure, FetchFailureCooldown, InFlight, TtlCache,
};
use super::{
    addon_manifest::{snapshot_supports_request, AddonCatalogCapability, AddonManifest},
    build_provider_http_client, normalize_media_year, strip_manifest_suffix, trim_to_max,
    BoundedBodyError, Episode, MediaDetails, MediaItem, MediaSeason, Trailer,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use urlencoding::encode;

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
const MAX_CAST: usize = 64;
const MAX_GENRES: usize = 32;
const MAX_STRING_CHARS: usize = 2_048;
const MAX_ID_CHARS: usize = 256;
const MAX_LOOKUP_ID_CHARS: usize = MAX_ID_CHARS + 2 * (1 + 10);
const MAX_EXTRA_NAME_CHARS: usize = 64;
const MAX_EXTRA_VALUE_CHARS: usize = 256;
const MAX_EXTRAS: usize = 16;
const MAX_SUBTITLE_LABEL_CHARS: usize = 256;

/// Addon payloads are stable for minutes; empty answers get the shorter window so new content surfaces fast.
const RESOURCE_CACHE_TTL: Duration = Duration::from_secs(180);
const RESOURCE_CACHE_EMPTY_TTL: Duration = Duration::from_secs(30);
const META_CACHE_MAX_ENTRIES: usize = 48;
const CATALOG_CACHE_MAX_ENTRIES: usize = 48;
const SUBTITLE_CACHE_MAX_ENTRIES: usize = 64;
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

/// Card-only decode — search endpoints return full meta objects, so decoding
/// only card fields keeps memory proportional to what browse renders.
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
    // Per-entry `Value`: one non-object row must not fail the whole `metas` decode.
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

/// Display-hint keys, first non-empty wins — addons label subtitle entries
/// differently (`subtitleFileName`, `title`, `name`, …).
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

/// Cooldown message served while an addon sits inside its failure window.
const RESOURCE_COOLDOWN_MESSAGE: &str =
    "Addon fetch skipped: the source is cooling down after a recent transport failure.";

pub(crate) struct AddonResourceClient {
    client: Client,
    // Shared parsed metadata; shape-specific clones happen outside the cache lock.
    meta_cache: TtlCache<Arc<MediaDetails>>,
    catalog_cache: TtlCache<CatalogPage>,
    subtitle_cache: TtlCache<Vec<AddonSubtitle>>,
    /// Per-addon cooldown keyed by base-URL hash — same contract as the transport's `fetch_failures`.
    fetch_failures: FetchFailureCooldown,
    /// Short-TTL negative cache — a deterministic failure (status, size cap,
    /// decode, missing meta) replays identically for the same request.
    failure_cache: TtlCache<String>,
    /// Single-flight locks keyed by request URL — followers wait on the
    /// leader and re-read the cache.
    in_flight: InFlight,
    /// Bumped by `clear_cache`: in-flight fetches must not repopulate cleared entries.
    generation: AtomicU64,
}

/// Lite shape rebuilt field-by-field so a card hit never copies the discarded
/// `episodes`/`cast`; a new `MediaDetails` field fails this literal on purpose.
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
        cast: None,
        genres: details.genres.clone(),
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
            fetch_failures: FetchFailureCooldown::new(
                RESOURCE_FETCH_FAILURE_TTL,
                RESOURCE_IN_FLIGHT_SWEEP_AT,
            ),
            // Failures take the short empty TTL: a fixed addon recovers fast.
            failure_cache: TtlCache::new(
                RESOURCE_FAILURE_CACHE_MAX_ENTRIES,
                RESOURCE_CACHE_EMPTY_TTL,
                RESOURCE_CACHE_EMPTY_TTL,
            ),
            in_flight: InFlight::new(RESOURCE_IN_FLIGHT_SWEEP_AT),
            generation: AtomicU64::new(0),
        }
    }

    /// Clear all resource caches (e.g. addon set changed): bump the generation
    /// first so in-flight fetches can't repopulate; cooldowns clear too.
    pub(crate) fn clear_cache(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.meta_cache.clear();
        self.catalog_cache.clear();
        self.subtitle_cache.clear();
        self.failure_cache.clear();
        self.fetch_failures.clear();
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
        self.fetch_contract()
            .run(
                &self.catalog_cache,
                &cache_key,
                &addon_key,
                |page| page.items.is_empty(),
                || async {
                    let what = format!("catalog {type_}/{catalog_id}");
                    let bytes =
                        fetch_bounded_json(&self.client, &url, &what, CATALOG_MAX_BYTES).await?;
                    let response: CatalogResponse =
                        serde_json::from_slice(&bytes).map_err(|_| {
                            FetchFailure::Fatal("Invalid catalog response format.".to_string())
                        })?;

                    Ok(parse_catalog_page(response, normalize))
                },
            )
            .await
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
                    let response: MetaResponse = serde_json::from_slice(&bytes).map_err(|_| {
                        FetchFailure::Fatal("Invalid metadata response format.".to_string())
                    })?;
                    let meta = response
                        .meta
                        .ok_or_else(|| FetchFailure::Fatal("Metadata not found.".to_string()))?;
                    parse_meta_item(meta)
                        .map(normalize)
                        .map(Arc::new)
                        .ok_or_else(|| FetchFailure::Fatal("Metadata not found.".to_string()))
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
        self.fetch_contract()
            .run(
                &self.subtitle_cache,
                &cache_key,
                &addon_key,
                |subtitles| subtitles.is_empty(),
                || async {
                    let what = format!("subtitles {type_}/{id}");
                    let bytes =
                        fetch_bounded_json(&self.client, &url, &what, SUBTITLE_MAX_BYTES).await?;
                    let response: SubtitleResponse =
                        serde_json::from_slice(&bytes).map_err(|_| {
                            FetchFailure::Fatal("Invalid subtitle response format.".to_string())
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

    // `search` is a hard capability gate (an undeclaring catalog echoes bogus
    // rows); other extras are advisory — callers re-filter locally.
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

/// Canonical catalog id for a case-insensitive match, so fetched URLs use the
/// manifest's own casing (caller casing can 404 on case-sensitive upstreams).
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
    // `catalogs[]` is authoritative: a catalogs-only manifest may omit `resources`.
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
        // Reject on overflow: a wrapping cast would corrupt season/episode mappings.
        Some(Value::Number(number)) => number.as_u64().and_then(|value| u32::try_from(value).ok()),
        Some(Value::String(text)) => text.trim().parse().ok(),
        _ => None,
    }
}

fn parse_catalog_page(
    response: CatalogResponse,
    normalize: fn(MediaItem) -> MediaItem,
) -> CatalogPage {
    CatalogPage {
        source_item_count: response.metas.len(),
        items: response
            .metas
            .into_iter()
            .filter_map(|value| serde_json::from_value::<CatalogItemJson>(value).ok())
            .filter_map(parse_catalog_item)
            .take(MAX_CATALOG_ITEMS)
            .map(normalize)
            .collect(),
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
    // `imdb_id` is a lookup id embedded in stream query paths — it shares `id`'s bound.
    let imdb_id = if id.starts_with("tt") {
        Some(id.chars().take(MAX_ID_CHARS).collect())
    } else {
        json_string_field(&value, "imdb_id")
            .or_else(|| json_string_field(&value, "imdbId"))
            .and_then(|value| trim_to_max(&value, MAX_ID_CHARS))
    };

    // `seasons` is populated iff `episodes` is, so the lite shape drops both together.
    let episodes = parse_episodes(value.get("videos"));
    let seasons = episodes.as_deref().map(media_seasons_from_episodes);

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
        // Raw `released` ISO date is the schedule source of truth; the
        // year-only fallback keeps unstamped metas working.
        release_date: json_string_field(&value, "released"),
        type_,
        description: json_string_field(&value, "description"),
        rating: json_string_field(&value, "imdbRating")
            .or_else(|| json_string_field(&value, "rating")),
        cast: json_string_list(value.get("cast"), MAX_CAST),
        genres: json_string_list(value.get("genre"), MAX_GENRES)
            .or_else(|| json_string_list(value.get("genres"), MAX_GENRES)),
        trailers: parse_trailers(value.get("trailers")),
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

/// Strict 11-char YouTube token (`[A-Za-z0-9_-]`) — mirrors the frontend
/// `isValidYouTubeVideoId` gate so `source` can't smuggle URL params/markup.
fn is_youtube_video_token(source: &str) -> bool {
    source.len() == 11
        && source
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Image fields reach the webview `<img>`, so they share the subtitle/stream
/// ingress gate; a rejected URL degrades to no artwork, not a dropped row.
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
            // Video tokens reach the browser `<iframe>` src: strict 11-char YouTube token only.
            let source = json_string_field(item, "source")?;
            if !is_youtube_video_token(&source) {
                return None;
            }
            let type_ = json_string_field(item, "type")?;
            if !type_.eq_ignore_ascii_case("trailer") {
                return None;
            }

            Some(Trailer { id: source })
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

    // Sort after the cap; ties keep addon order. Consumers read this cached order over IPC.
    episodes.sort_by_key(|episode| (episode.season, episode.episode));

    (!episodes.is_empty()).then_some(episodes)
}

fn parse_subtitle_item(value: Value) -> Option<AddonSubtitle> {
    // Read the display hint before `from_value` consumes the payload.
    let label = SUBTITLE_LABEL_KEYS
        .iter()
        .find_map(|key| json_string_field(&value, key))
        .and_then(|text| trim_to_max(&text, MAX_SUBTITLE_LABEL_CHARS));
    let parsed: SubtitleItem = serde_json::from_value(value).ok()?;
    let url = trim_to_max(parsed.url.as_deref().unwrap_or(""), MAX_STRING_CHARS)?;
    let id = trim_to_max(parsed.id.as_deref().unwrap_or(""), MAX_ID_CHARS)
        .unwrap_or_else(|| url.clone());

    // mpv fetches subtitle URLs itself, outside the backend redirect/size
    // policy — gate here so a payload can't aim the player at loopback/LAN/metadata IPs.
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

/// Magnet URLs are identifiers, not fetch targets: no SSRF surface, so
/// scheme-rejecting gates must recognize them first.
pub(crate) fn is_magnet_url(url: &str) -> bool {
    url.trim()
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("magnet:"))
}

/// Gate for player-fetchable URLs before a privileged fetch path (mpv
/// subtitle/stream fetch, direct-stream probe): http(s) only, no credentials, no non-routable IP literal.
pub(crate) fn is_fetchable_http_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if !crate::providers::fetch_policy::is_plain_http_url(&parsed) {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    !crate::providers::fetch_policy::is_blocked_ip_literal(host)
}

fn encode_path_segment(value: &str, max_chars: usize) -> Result<String, String> {
    let trimmed =
        trim_to_max(value, max_chars).ok_or_else(|| "Addon resource path is empty.".to_string())?;
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
    Ok(parsed.to_string())
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
            FetchFailure::Retryable(format!(
                "Failed to reach addon {what}: {}",
                super::addons::sanitize_addon_log(&error.to_string())
            ))
        })?;

    if !response.status().is_success() {
        return Err(FetchFailure::Fatal(format!(
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
        BoundedBodyError::TooLarge(message) => FetchFailure::Fatal(message),
        BoundedBodyError::Read(message) => FetchFailure::Retryable(message),
    })
}

#[cfg(test)]
mod tests;
