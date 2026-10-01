use super::config_store::{
    addon_configs_generation, load_addon_configs, AddonConfig, DEFAULT_CINEMETA_INSTALL_URL,
    DEFAULT_OPENSUBTITLES_INSTALL_URL,
};
use super::SETTINGS_STORE_FILE;
use crate::providers::addon_manifest::snapshot_is_classified;
use crate::providers::addon_resource::{
    catalog_declares_extra, snapshot_supports_catalog, snapshot_supports_meta,
    snapshot_supports_subtitles, AddonResourceClient, AddonSubtitle, CatalogExtra, CatalogPage,
};
use crate::providers::{lock_or_recover, MediaDetails, MediaItem};
use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const ADDON_RESOURCE_CONCURRENCY: usize = 4;
const MAX_CATALOG_SOURCES: usize = 8;
const MAX_SUBTITLE_SOURCES: usize = 8;
const MAX_SUBTITLES_PER_ADDON: usize = 50;
const MAX_SUBTITLES_TOTAL: usize = 200;
/// First-capable-source hedge for meta fetches: a routine details open is
/// answered by the highest-priority meta addon, so the rest of the registry
/// only joins after the primary stalls past this window or fails.
const META_HEDGE_DELAY: Duration = Duration::from_millis(400);
/// Failed install-time manifest fetches leave an addon unclassified; the
/// background retry is throttled so a permanently down addon costs one
/// bounded manifest request per cooldown window, not one per resource call.
const CLASSIFY_RETRY_COOLDOWN: Duration = Duration::from_secs(60);

/// Parsed enabled-registry memo, tagged with the addon-config generation.
/// `save_addon_configs_to_store` bumps the generation on every write, so a
/// memo entry tagged with a superseded generation is never served.
static ENABLED_ADDONS_MEMO: Mutex<Option<(u64, Arc<Vec<AddonConfig>>)>> = Mutex::new(None);
static CLASSIFY_RETRY_AT: Mutex<Option<Instant>> = Mutex::new(None);
static CLASSIFY_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Self-heal for addons whose manifest fetch failed at install time: an
/// unclassified (`capabilities: None`) addon is queried for every resource
/// under fail-open routing, so a subtitles-only addon would eat stream
/// requests (404 noise, false "offline" marks) until the next save/restart.
/// Every resource path funnels through `load_enabled_addons_snapshot`, so
/// one throttled spawn here reclassifies in the background and the next
/// request picks up the capability snapshot.
fn maybe_schedule_capability_classification(app: &AppHandle, addons: &[AddonConfig]) {
    let needs_classification = addons.iter().any(|addon| {
        addon
            .capabilities
            .as_ref()
            .is_none_or(|snapshot| !snapshot_is_classified(snapshot))
    });
    if !needs_classification {
        return;
    }

    {
        let mut retry_at = lock_or_recover(&CLASSIFY_RETRY_AT);
        if retry_at.is_some_and(|instant| instant.elapsed() < CLASSIFY_RETRY_COOLDOWN) {
            return;
        }
        *retry_at = Some(Instant::now());
    }
    if CLASSIFY_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = super::config_commands::classify_installed_addon_capabilities(app).await;
        CLASSIFY_IN_FLIGHT.store(false, Ordering::SeqCst);
    });
}

pub(crate) fn load_enabled_addons(app: &AppHandle) -> Result<Arc<Vec<AddonConfig>>, String> {
    // Blocking store/file IO: async fetch paths must use
    // `load_enabled_addons_snapshot` below, never this directly.
    //
    // Capture the generation before touching the store: a write that lands
    // between the read and the memo update then caches fresh data under a
    // stale tag and self-heals on the next call, rather than serving a stale
    // registry under a fresh tag forever.
    let generation = addon_configs_generation();
    {
        let memo = lock_or_recover(&ENABLED_ADDONS_MEMO);
        if let Some((cached_generation, cached)) = memo.as_ref() {
            if *cached_generation == generation {
                return Ok(cached.clone());
            }
        }
    }

    let store = super::open_store(app, SETTINGS_STORE_FILE)?;

    // `load_addon_configs` already normalizes URLs and dedupes by url + id —
    // the enabled view is a pure filter over that result.
    let addons = Arc::new(
        load_addon_configs(&store)
            .into_iter()
            .filter(|addon| addon.enabled)
            .collect::<Vec<_>>(),
    );
    *lock_or_recover(&ENABLED_ADDONS_MEMO) = Some((generation, addons.clone()));
    Ok(addons)
}

/// Blocking-safe snapshot for async fetch paths. The memo is consulted on
/// the async worker first so per-item fan-out (e.g. media schedules) skips
/// even the blocking-pool dispatch once the registry is warm; the store read
/// itself still runs on the dedicated pool when it does happen.
pub async fn load_enabled_addons_snapshot(
    app: &AppHandle,
) -> Result<Arc<Vec<AddonConfig>>, String> {
    let generation = addon_configs_generation();
    {
        let memo = lock_or_recover(&ENABLED_ADDONS_MEMO);
        if let Some((cached_generation, cached)) = memo.as_ref() {
            if *cached_generation == generation {
                let addons = cached.clone();
                maybe_schedule_capability_classification(app, &addons);
                return Ok(addons);
            }
        }
    }
    let app_owned = app.clone();
    let addons = super::run_blocking_store_op(move || load_enabled_addons(&app_owned)).await?;
    maybe_schedule_capability_classification(app, &addons);
    Ok(addons)
}

fn addon_allows_catalog(
    addon: &AddonConfig,
    type_: &str,
    catalog_id: &str,
    extras: &[CatalogExtra],
) -> bool {
    addon.capabilities.as_ref().is_none_or(|snapshot| {
        snapshot_supports_catalog(snapshot, type_, catalog_id, extras).is_ok()
    })
}

fn addon_allows_meta(addon: &AddonConfig, type_: &str, id: &str) -> bool {
    addon
        .capabilities
        .as_ref()
        .is_none_or(|snapshot| snapshot_supports_meta(snapshot, type_, id))
}

fn addon_allows_subtitles(addon: &AddonConfig, type_: &str, id: &str) -> bool {
    addon
        .capabilities
        .as_ref()
        .is_none_or(|snapshot| snapshot_supports_subtitles(snapshot, type_, id))
}

fn searchable_catalog_ids(addon: &AddonConfig, type_: &str) -> Vec<String> {
    match addon.capabilities.as_ref() {
        None => vec!["top".to_string()],
        Some(snapshot) => snapshot
            .catalogs
            .iter()
            .filter(|catalog| {
                catalog.type_.eq_ignore_ascii_case(type_)
                    && catalog_declares_extra(catalog, "search")
            })
            .map(|catalog| catalog.id.clone())
            .collect(),
    }
}

#[derive(Debug, Clone)]
pub struct CatalogFetchPage {
    pub items: Vec<MediaItem>,
    pub next_skip: Option<u32>,
}

/// Stable identity for a catalog card. Both segments fold to lowercase so the
/// merge matches the frontend's `searchCatalogKey` and a case-variant id from
/// one source cannot duplicate another's row.
pub(crate) fn catalog_dedup_key(type_: &str, id: &str) -> String {
    format!(
        "{}:{}",
        type_.trim().to_ascii_lowercase(),
        id.trim().to_ascii_lowercase()
    )
}

fn extra_skip_value(extras: &[CatalogExtra]) -> u32 {
    extras
        .iter()
        .rev()
        .find(|extra| extra.name.eq_ignore_ascii_case("skip"))
        .and_then(|extra| extra.value.trim().parse().ok())
        .unwrap_or(0)
}

/// Continuation follows the Stremio catalog contract, not the `hasMore`
/// hint: live Cinemeta pages (e.g. series `top` page 1) return full pages
/// with `hasMore: false` while deeper `skip` pages still hold titles, and
/// `hasMore: true` is set on later pages of the same catalog. The only
/// reliable end signal is an empty page, so any non-empty page offers the
/// next cursor. The frontend additionally stops when a page contributes zero
/// new titles, so a misbehaving provider cannot spin Load More forever.
fn catalog_page_next_skip(skip: u32, item_count: usize) -> Option<u32> {
    if item_count > 0 {
        let count = u32::try_from(item_count).unwrap_or(u32::MAX);
        Some(skip.saturating_add(count))
    } else {
        None
    }
}

fn catalog_fetch_page_from_source(page: CatalogPage, skip: u32) -> CatalogFetchPage {
    CatalogFetchPage {
        next_skip: catalog_page_next_skip(skip, page.source_item_count),
        items: page.items,
    }
}

pub(crate) fn merge_catalog_pages(
    results: Vec<Result<CatalogFetchPage, String>>,
    empty_error: &str,
) -> Result<CatalogFetchPage, String> {
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    let mut had_success = false;
    let mut last_error: Option<String> = None;
    let mut next_skip: Option<u32> = None;

    for result in results {
        match result {
            Ok(page) => {
                had_success = true;
                next_skip = match (next_skip, page.next_skip) {
                    (Some(left), Some(right)) => Some(left.min(right)),
                    (None, Some(right)) => Some(right),
                    (left, None) => left,
                };
                for item in page.items {
                    let key = catalog_dedup_key(&item.type_, &item.id);
                    if seen.insert(key) {
                        items.push(item);
                    }
                }
            }
            Err(error) => last_error = Some(error),
        }
    }

    if !had_success {
        return Err(last_error.unwrap_or_else(|| empty_error.to_string()));
    }

    Ok(CatalogFetchPage { items, next_skip })
}

pub(crate) fn merge_catalog_items(
    results: Vec<Result<Vec<MediaItem>, String>>,
    empty_error: &str,
) -> Result<Vec<MediaItem>, String> {
    merge_catalog_pages(
        results
            .into_iter()
            .map(|result| {
                result.map(|items| CatalogFetchPage {
                    items,
                    next_skip: None,
                })
            })
            .collect(),
        empty_error,
    )
    .map(|page| page.items)
}

pub async fn fetch_catalog_page(
    app: &AppHandle,
    client: &AddonResourceClient,
    type_: &str,
    catalog_id: &str,
    extras: &[CatalogExtra],
) -> Result<CatalogFetchPage, String> {
    let snapshot = load_enabled_addons_snapshot(app).await?;
    let targets = select_catalog_targets(snapshot.as_slice(), type_, catalog_id, extras)?;
    fetch_catalog_page_for_targets(client, targets, type_, catalog_id, extras).await
}

pub(crate) fn select_catalog_targets(
    snapshot: &[AddonConfig],
    type_: &str,
    catalog_id: &str,
    extras: &[CatalogExtra],
) -> Result<Vec<AddonConfig>, String> {
    let targets: Vec<AddonConfig> = snapshot
        .iter()
        .filter(|addon| addon_allows_catalog(addon, type_, catalog_id, extras))
        .take(MAX_CATALOG_SOURCES)
        .cloned()
        .collect();

    if targets.is_empty() {
        return Err(format!(
            "No enabled addon declares catalog support for {type_}/{catalog_id}. Ensure Cinemeta ({DEFAULT_CINEMETA_INSTALL_URL}) or another catalog addon is enabled in Settings → Streaming."
        ));
    }

    Ok(targets)
}

/// A target-selection result plus the extras it was chosen for, per group,
/// in caller order.
type CatalogGroupSelection = Result<(Vec<AddonConfig>, Vec<CatalogExtra>), String>;

/// One unit of catalog work in a shared pool: `(group, order)` regroups
/// interleaved results back into per-group, per-source order.
struct CatalogWorkItem {
    group: usize,
    order: usize,
    addon: AddonConfig,
    media_type: String,
    catalog_id: String,
    extras: Vec<CatalogExtra>,
}

/// Runs every work item through one `buffer_unordered` pool so a multi-group
/// request (e.g. a search or browse fan-out across genres) stays inside
/// `ADDON_RESOURCE_CONCURRENCY` instead of multiplying the cap per group.
/// Returns each group's results in source order.
async fn run_catalog_work_pool(
    client: &AddonResourceClient,
    work: Vec<CatalogWorkItem>,
    group_count: usize,
) -> Vec<Vec<Result<CatalogPage, String>>> {
    let outcomes = stream::iter(work.into_iter().map(|item| async move {
        let result = client
            .fetch_catalog(
                &item.addon.url,
                &item.media_type,
                &item.catalog_id,
                &item.extras,
            )
            .await;
        (item.group, item.order, result)
    }))
    .buffer_unordered(ADDON_RESOURCE_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;

    let mut grouped: Vec<Vec<(usize, Result<CatalogPage, String>)>> =
        (0..group_count).map(|_| Vec::new()).collect();
    for (group, order, result) in outcomes {
        grouped[group].push((order, result));
    }
    grouped
        .into_iter()
        .map(|mut bucket| {
            bucket.sort_by_key(|(order, _)| *order);
            bucket.into_iter().map(|(_, result)| result).collect()
        })
        .collect()
}

/// Multi-group variant of `fetch_catalog_page_for_targets`: one bounded pool
/// serves every (group × source) fetch, merged back per group in target
/// order so per-group failures stay isolated for the caller's own merge.
pub(crate) async fn fetch_catalog_pages_for_target_groups(
    client: &AddonResourceClient,
    type_: &str,
    catalog_id: &str,
    groups: Vec<CatalogGroupSelection>,
) -> Vec<Result<CatalogFetchPage, String>> {
    let group_count = groups.len();
    let mut work = Vec::new();
    let mut group_errors: Vec<Option<String>> = Vec::with_capacity(group_count);
    let mut group_skips: Vec<u32> = Vec::with_capacity(group_count);

    for (group, entry) in groups.into_iter().enumerate() {
        match entry {
            Ok((targets, extras)) => {
                group_errors.push(None);
                group_skips.push(extra_skip_value(&extras));
                for (order, addon) in targets.into_iter().enumerate() {
                    // Fetch with the manifest's canonical catalog id so a
                    // case-insensitive routing match never emits a miscased
                    // URL path upstream.
                    let resolved_catalog_id = addon
                        .capabilities
                        .as_ref()
                        .and_then(|snapshot| {
                            crate::providers::addon_resource::resolve_canonical_catalog_id(
                                snapshot, type_, catalog_id,
                            )
                        })
                        .unwrap_or_else(|| catalog_id.to_string());
                    work.push(CatalogWorkItem {
                        group,
                        order,
                        addon,
                        media_type: type_.to_string(),
                        catalog_id: resolved_catalog_id,
                        extras: extras.clone(),
                    });
                }
            }
            Err(error) => {
                group_errors.push(Some(error));
                group_skips.push(0);
            }
        }
    }

    run_catalog_work_pool(client, work, group_count)
        .await
        .into_iter()
        .zip(group_errors)
        .zip(group_skips)
        .map(|((bucket, error), skip)| match error {
            Some(error) => Err(error),
            None => merge_catalog_pages(
                bucket
                    .into_iter()
                    .map(|result| result.map(|page| catalog_fetch_page_from_source(page, skip)))
                    .collect(),
                "Failed to load catalog.",
            ),
        })
        .collect()
}

pub(crate) async fn fetch_catalog_page_for_targets(
    client: &AddonResourceClient,
    targets: Vec<AddonConfig>,
    type_: &str,
    catalog_id: &str,
    extras: &[CatalogExtra],
) -> Result<CatalogFetchPage, String> {
    fetch_catalog_pages_for_target_groups(
        client,
        type_,
        catalog_id,
        vec![Ok((targets, extras.to_vec()))],
    )
    .await
    .into_iter()
    .next()
    .unwrap_or_else(|| Err("Failed to load catalog.".to_string()))
}

/// Multi-genre catalog search: every (genre × addon × catalog) fetch runs
/// through one `ADDON_RESOURCE_CONCURRENCY` pool, then merges per genre so
/// one failed or unsupported genre never discards another's results.
/// Returns one outcome per input genre, in order.
pub async fn search_catalog_items_for_genres(
    app: &AppHandle,
    client: &AddonResourceClient,
    query: &str,
    media_types: &[&str],
    genres: &[Option<String>],
) -> Result<Vec<Result<Vec<MediaItem>, String>>, String> {
    let snapshot = load_enabled_addons_snapshot(app).await?;
    let mut work = Vec::new();
    let mut group_errors: Vec<Option<String>> = Vec::with_capacity(genres.len());

    for (group, genre) in genres.iter().enumerate() {
        let mut extras = vec![CatalogExtra {
            name: "search".to_string(),
            value: query.to_string(),
        }];
        if let Some(genre) = genre.as_deref().and_then(super::normalize_non_empty) {
            extras.push(CatalogExtra {
                name: "genre".to_string(),
                value: genre,
            });
        }

        let mut order = 0;
        'addons: for addon in snapshot.iter() {
            for media_type in media_types {
                for catalog_id in searchable_catalog_ids(addon, media_type) {
                    if addon_allows_catalog(addon, media_type, &catalog_id, &extras) {
                        work.push(CatalogWorkItem {
                            group,
                            order,
                            addon: addon.clone(),
                            media_type: (*media_type).to_string(),
                            catalog_id,
                            extras: extras.clone(),
                        });
                        order += 1;
                        if order == MAX_CATALOG_SOURCES {
                            break 'addons;
                        }
                    }
                }
            }
        }
        group_errors.push((order == 0).then(|| {
            format!("No enabled addon declares a searchable catalog for the requested type. Ensure Cinemeta ({DEFAULT_CINEMETA_INSTALL_URL}) or another catalog addon is enabled in Settings → Streaming.")
        }));
    }

    Ok(run_catalog_work_pool(client, work, genres.len())
        .await
        .into_iter()
        .zip(group_errors)
        .map(|(bucket, error)| match error {
            Some(error) => Err(error),
            None => merge_catalog_items(
                bucket
                    .into_iter()
                    .map(|result| result.map(|page| page.items))
                    .collect(),
                "Failed to search catalog.",
            ),
        })
        .collect())
}

pub async fn fetch_meta_details(
    app: &AppHandle,
    client: &AddonResourceClient,
    type_: &str,
    id: &str,
    include_episodes: bool,
) -> Result<MediaDetails, String> {
    let mut targets = load_enabled_addons_snapshot(app)
        .await?
        .iter()
        .filter(|addon| addon_allows_meta(addon, type_, id))
        .take(MAX_CATALOG_SOURCES)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter();

    let Some(first) = targets.next() else {
        return Err(format!(
            "No enabled addon declares meta support for {type_}/{id}. Ensure Cinemeta ({DEFAULT_CINEMETA_INSTALL_URL}) or another metadata addon is enabled in Settings → Streaming."
        ));
    };

    type MetaFetch<'a> = std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<MediaDetails, String>> + Send + 'a>,
    >;
    let make_fetch = |addon: AddonConfig| -> MetaFetch<'_> {
        let type_ = type_.to_string();
        let id = id.to_string();
        Box::pin(async move {
            client
                .fetch_meta(&addon.url, &type_, &id, include_episodes)
                .await
        })
    };

    let mut first_fetch = make_fetch(first);
    let hedge = tokio::time::sleep(META_HEDGE_DELAY);
    tokio::pin!(hedge);

    // Hedged start: the first capable source runs alone until it settles or
    // the hedge window expires, then the rest of the registry joins.
    // `FuturesOrdered` still yields in addon order, so the first success in
    // user order wins and drops the tail exactly as before.
    let mut last_error: Option<String> = None;
    let hedged = tokio::select! {
        result = &mut first_fetch => match result {
            Ok(details) => return Ok(details),
            Err(error) => {
                last_error = Some(error);
                false
            }
        },
        _ = &mut hedge => true,
    };

    let mut outcomes = futures_util::stream::FuturesOrdered::new();
    if hedged {
        // Still in flight: it keeps its rank-0 slot so a slow-but-valid
        // primary is preferred over a faster secondary.
        outcomes.push_back(first_fetch);
    }
    for addon in targets {
        outcomes.push_back(make_fetch(addon));
    }

    while let Some(result) = outcomes.next().await {
        match result {
            Ok(details) => return Ok(details),
            Err(error) => last_error = Some(error),
        }
    }

    Err(last_error.unwrap_or_else(|| "Metadata not found.".to_string()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcedAddonSubtitle {
    pub id: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub source_id: String,
    pub source_name: String,
}

/// Fetch subtitles from every enabled addon declaring `subtitles` support for
/// the requested type/id. Failures are isolated per addon: one offline or
/// malformed source never discards another addon's results.
pub async fn fetch_addon_subtitles(
    app: &AppHandle,
    client: &AddonResourceClient,
    type_: &str,
    id: &str,
) -> Result<Vec<SourcedAddonSubtitle>, String> {
    let targets: Vec<AddonConfig> = load_enabled_addons_snapshot(app)
        .await?
        .iter()
        .filter(|addon| addon_allows_subtitles(addon, type_, id))
        .take(MAX_SUBTITLE_SOURCES)
        .cloned()
        .collect();

    if targets.is_empty() {
        return Err(format!(
            "No enabled addon declares subtitle support for {type_}/{id}. Ensure OpenSubtitles ({DEFAULT_OPENSUBTITLES_INSTALL_URL}) or another subtitle addon is enabled in Settings → Streaming."
        ));
    }

    let mut outcomes = stream::iter(targets.into_iter().enumerate().map(|(index, addon)| {
        let type_ = type_.to_string();
        let id = id.to_string();
        async move {
            let result = client.fetch_subtitles(&addon.url, &type_, &id).await;
            (index, addon, result)
        }
    }))
    .buffer_unordered(ADDON_RESOURCE_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;
    outcomes.sort_by_key(|(index, _, _)| *index);

    let mut subtitles = Vec::new();
    let mut seen = HashSet::new();
    let mut had_success = false;
    let mut last_error: Option<String> = None;

    for (_, addon, result) in outcomes {
        match result {
            Ok(items) => {
                had_success = true;
                for item in items.into_iter().take(MAX_SUBTITLES_PER_ADDON) {
                    add_subtitle_if_unique(&mut subtitles, &mut seen, &addon, item);
                    if subtitles.len() >= MAX_SUBTITLES_TOTAL {
                        break;
                    }
                }
            }
            Err(error) => last_error = Some(error),
        }
        if subtitles.len() >= MAX_SUBTITLES_TOTAL {
            break;
        }
    }

    if !had_success {
        return Err(last_error.unwrap_or_else(|| "Failed to load subtitles.".to_string()));
    }

    Ok(subtitles)
}

fn add_subtitle_if_unique(
    subtitles: &mut Vec<SourcedAddonSubtitle>,
    seen: &mut HashSet<String>,
    addon: &AddonConfig,
    item: AddonSubtitle,
) {
    let lang = item
        .lang
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase)
        .unwrap_or_default();
    let key = format!("{}|{}|{}|{}", addon.id, item.id, item.url, lang);
    if !seen.insert(key) {
        return;
    }

    subtitles.push(SourcedAddonSubtitle {
        id: item.id,
        url: item.url,
        lang: item.lang,
        label: item.label,
        source_id: addon.id.clone(),
        source_name: addon.name.clone(),
    });
}

#[cfg(test)]
mod tests;
