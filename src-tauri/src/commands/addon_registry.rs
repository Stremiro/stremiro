use super::config_store::{
    addon_configs_generation, is_default_cinemeta_url, load_addon_configs, AddonConfig,
};
use super::media_normalization::{normalize_media_details, normalize_media_item};
use super::{js_trim, SETTINGS_STORE_FILE};
use crate::providers::addon_manifest::{snapshot_request_type, snapshot_supports_request};
use crate::providers::addon_resource::{
    catalog_declares_extra, catalog_request_extras, snapshot_supports_catalog, AddonResourceClient,
    AddonSubtitle, CatalogExtra, CatalogPage,
};
use crate::providers::ttl_cache::hash_segment;
use crate::providers::{lock_or_recover, MediaDetails, MediaItem};
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const ADDON_RESOURCE_CONCURRENCY: usize = 4;
pub(crate) const MAX_CATALOG_SOURCES: usize = 8;
const MAX_METADATA_SOURCES: usize = 8;
const MAX_SUBTITLE_SOURCES: usize = 8;
const MAX_SUBTITLES_TOTAL: usize = 200;
/// First-capable-source hedge for meta fetches: a routine details open is
/// answered by the highest-priority meta addon, so the rest of the registry
/// only joins after the primary stalls past this window or fails.
const META_HEDGE_DELAY: Duration = Duration::from_millis(400);
/// A ready lower-priority meta result waits this long for a still-pending
/// higher-priority source; past the grace the ready result wins, so a dead
/// primary holds a live fallback for at most this window instead of its full
/// request timeout.
const META_FALLBACK_GRACE: Duration = Duration::from_millis(2_500);
pub(super) const CATALOG_STRAGGLER_GRACE: Duration = Duration::from_millis(1_500);
const SUBTITLE_STRAGGLER_GRACE: Duration = Duration::from_secs(10);
/// Failed install-time manifest fetches leave an addon unclassified; the
/// background retry is throttled so a permanently down addon costs one
/// bounded manifest request per cooldown window, not one per resource call.
const CLASSIFY_RETRY_COOLDOWN: Duration = Duration::from_secs(60);

/// Parsed enabled-registry memo, tagged with the addon-config generation.
/// `save_addon_configs_to_store` bumps the generation on every write, so a
/// memo entry tagged with a superseded generation is never served.
static ENABLED_ADDONS_MEMO: Mutex<Option<(u64, Arc<Vec<AddonConfig>>)>> = Mutex::new(None);

/// Every "no enabled addon serves this" registry error starts with this, so
/// command boundaries can tag it without the UI parsing messages.
const NO_CAPABLE_ADDON_PREFIX: &str = "No enabled addon provides ";

fn no_capable_addon_error(provides: &str, addon_kind: &str) -> String {
    format!("{NO_CAPABLE_ADDON_PREFIX}{provides}. Add or enable a {addon_kind} addon in Settings → Addons.")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AddonResourceErrorKind {
    NoCapableAddon,
    Failed,
}

/// Command error for addon-resource reads; `no_capable_addon` points the UI
/// at Settings → Addons instead of a network retry.
#[derive(Debug, Serialize)]
pub struct AddonResourceError {
    pub kind: AddonResourceErrorKind,
    pub message: String,
}

impl From<String> for AddonResourceError {
    fn from(message: String) -> Self {
        let kind = if message.starts_with(NO_CAPABLE_ADDON_PREFIX) {
            AddonResourceErrorKind::NoCapableAddon
        } else {
            AddonResourceErrorKind::Failed
        };
        Self { kind, message }
    }
}

static CLASSIFY_RETRY_AT: Mutex<Option<Instant>> = Mutex::new(None);
static CLASSIFY_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct CapabilityClassificationGuard<'a>(&'a AtomicBool);

impl<'a> CapabilityClassificationGuard<'a> {
    fn try_acquire(in_flight: &'a AtomicBool) -> Option<Self> {
        if in_flight.swap(true, Ordering::SeqCst) {
            None
        } else {
            Some(Self(in_flight))
        }
    }
}

impl Drop for CapabilityClassificationGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub(crate) fn schedule_capability_classification(
    app: &AppHandle,
    on_error: impl FnOnce(String) + Send + 'static,
) {
    let Some(guard) = CapabilityClassificationGuard::try_acquire(&CLASSIFY_IN_FLIGHT) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Captured before spawning so cancellation before the first poll also releases it.
        let _guard = guard;
        if let Err(error) = super::config_commands::classify_installed_addon_capabilities(app).await
        {
            on_error(error);
        }
    });
}

/// Self-heal for addons whose manifest fetch failed at install time: an
/// unclassified (`capabilities: None`) addon is queried for every resource
/// under fail-open routing, so a subtitles-only addon would eat stream
/// requests (404 noise, false "offline" marks) until the next save/restart.
/// Every resource path funnels through `load_enabled_addons_snapshot`, so
/// one throttled spawn here reclassifies in the background and the next
/// request picks up the capability snapshot.
fn maybe_schedule_capability_classification(app: &AppHandle, addons: &[AddonConfig]) {
    if !addons.iter().any(AddonConfig::needs_classification) {
        return;
    }

    {
        let mut retry_at = lock_or_recover(&CLASSIFY_RETRY_AT);
        if retry_at.is_some_and(|instant| instant.elapsed() < CLASSIFY_RETRY_COOLDOWN) {
            return;
        }
        *retry_at = Some(Instant::now());
    }
    schedule_capability_classification(app, |_| {});
}

fn cached_enabled_addons(generation: u64) -> Option<Arc<Vec<AddonConfig>>> {
    lock_or_recover(&ENABLED_ADDONS_MEMO)
        .as_ref()
        .filter(|(cached_generation, _)| *cached_generation == generation)
        .map(|(_, addons)| addons.clone())
}

fn load_enabled_addons(app: &AppHandle) -> Result<Arc<Vec<AddonConfig>>, String> {
    // Blocking store/file IO: async fetch paths must use
    // `load_enabled_addons_snapshot` below, never this directly.
    //
    // Capture the generation before touching the store: a write that lands
    // between the read and the memo update then caches fresh data under a
    // stale tag and self-heals on the next call, rather than serving a stale
    // registry under a fresh tag forever.
    let generation = addon_configs_generation();
    if let Some(addons) = cached_enabled_addons(generation) {
        return Ok(addons);
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
    if let Some(addons) = cached_enabled_addons(generation) {
        maybe_schedule_capability_classification(app, &addons);
        return Ok(addons);
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

fn addon_allows_resource(addon: &AddonConfig, resource: &str, type_: &str, id: &str) -> bool {
    addon
        .capabilities
        .as_ref()
        .is_none_or(|snapshot| snapshot_supports_request(snapshot, resource, type_, id))
}

fn searchable_catalogs<'a>(
    addon: &'a AddonConfig,
    type_: &'a str,
) -> impl Iterator<Item = (&'a str, &'a str, bool)> + 'a {
    let (fallback, catalogs) = match addon.capabilities.as_ref() {
        None => (Some((type_, "top", false)), &[][..]),
        Some(snapshot) => (None, snapshot.catalogs.as_slice()),
    };
    fallback.into_iter().chain(
        catalogs
            .iter()
            .filter(move |catalog| {
                catalog.type_.eq_ignore_ascii_case(type_)
                    && catalog_declares_extra(catalog, "search")
            })
            .map(|catalog| {
                (
                    catalog.type_.as_str(),
                    catalog.id.as_str(),
                    catalog_declares_extra(catalog, "skip"),
                )
            }),
    )
}

#[derive(Debug, Clone, Default)]
pub struct CatalogFetchPage {
    pub items: Vec<MediaItem>,
    pub next_skip: Option<u32>,
    pub partial: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchSourceCursor {
    pub key: String,
    pub skip: u32,
    #[serde(default)]
    pub retry: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_hash: Option<String>,
}

/// Dedup key -> browse branches that returned it before local filtering.
pub(crate) type BrowseCursorClaims = HashMap<String, u8>;

#[derive(Debug)]
pub(crate) struct SearchCatalogFetchPage {
    pub items: Vec<MediaItem>,
    pub cursors: Vec<SearchSourceCursor>,
    pub partial: bool,
}

/// Stable identity shared by source merging and cross-page catalog deduplication.
pub(crate) fn catalog_dedup_key(type_: &str, id: &str) -> String {
    let type_ = js_trim(type_);
    let mut key = format!("{}:{type_}:{}", type_.len(), js_trim(id));
    key.make_ascii_lowercase();
    key
}

fn extra_skip_value(extras: &[CatalogExtra]) -> u32 {
    extras
        .iter()
        .rev()
        .find(|extra| extra.name.eq_ignore_ascii_case("skip"))
        .and_then(|extra| extra.value.trim().parse().ok())
        .unwrap_or(0)
}

/// Continuation follows the addon catalog contract, not the `hasMore`
/// hint: live Cinemeta pages (e.g. series `top` page 1) return full pages
/// with `hasMore: false` while deeper `skip` pages still hold titles, and
/// `hasMore: true` is set on later pages of the same catalog. The only
/// reliable end signal is an empty page, so any non-empty page offers the
/// next cursor.
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
        partial: false,
    }
}

pub(crate) fn merge_catalog_pages(
    results: impl IntoIterator<Item = Result<CatalogFetchPage, String>>,
    empty_error: &str,
) -> Result<CatalogFetchPage, String> {
    let mut items = Vec::new();
    let mut had_success = false;
    let mut last_error: Option<String> = None;
    let mut next_skip: Option<u32> = None;
    let mut partial = false;

    for result in results {
        match result {
            Ok(page) => {
                had_success = true;
                partial |= page.partial;
                next_skip = match (next_skip, page.next_skip) {
                    (Some(left), Some(right)) => Some(left.min(right)),
                    (None, Some(right)) => Some(right),
                    (left, None) => left,
                };
                items.extend(page.items);
            }
            Err(error) => last_error = Some(error),
        }
    }

    if !had_success || (items.is_empty() && last_error.is_some()) {
        return Err(last_error.unwrap_or_else(|| empty_error.to_string()));
    }

    Ok(CatalogFetchPage {
        items,
        next_skip,
        partial: partial || last_error.is_some(),
    })
}

/// What a catalog fetch needs from a selected addon — never the whole config
/// with its capability snapshot.
pub(crate) struct CatalogTarget {
    url: String,
    media_type: String,
    catalog_id: String,
    catalog_genre: Option<String>,
    extras: Vec<CatalogExtra>,
    supports_skip: bool,
}

pub(crate) fn select_catalog_targets(
    snapshot: &[AddonConfig],
    type_: &str,
    catalog_id: &str,
    extras: &[CatalogExtra],
) -> Result<Vec<CatalogTarget>, String> {
    let targets: Vec<CatalogTarget> = snapshot
        .iter()
        .filter_map(|addon| {
            let extras = catalog_request_extras(
                addon.capabilities.as_ref(),
                type_,
                catalog_id,
                extras.to_vec(),
            );
            let catalog = match addon.capabilities.as_ref() {
                Some(snapshot) => {
                    Some(snapshot_supports_catalog(snapshot, type_, catalog_id, &extras).ok()?)
                }
                None => None,
            };
            let supports_skip =
                catalog.is_none_or(|catalog| catalog_declares_extra(catalog, "skip"));
            Some(CatalogTarget {
                url: addon.url.clone(),
                media_type: catalog
                    .map_or_else(|| type_.to_string(), |catalog| catalog.type_.clone()),
                // Use the manifest's canonical id even for a case-insensitive match.
                catalog_id: catalog
                    .map_or(catalog_id, |catalog| catalog.id.as_str())
                    .to_string(),
                catalog_genre: catalog.and_then(|_| {
                    extras
                        .iter()
                        .find(|extra| extra.name.eq_ignore_ascii_case("genre"))
                        .map(|sent| sent.value.clone())
                }),
                extras,
                supports_skip,
            })
        })
        .take(MAX_CATALOG_SOURCES)
        .collect();

    if targets.is_empty() {
        return Err(no_capable_addon_error(
            &format!("the {type_}/{catalog_id} catalog"),
            "catalog",
        ));
    }

    Ok(targets)
}

/// Addon browse source space: every non-movie/series catalog that declares a
/// `genre` extra accepting the sent genre and passes the usual capability
/// checks (a required `search` extra still excludes it). Bound shared with the
/// typed selector.
pub(crate) fn select_addon_catalog_targets(
    snapshot: &[AddonConfig],
    extras: &[CatalogExtra],
) -> Result<Vec<CatalogTarget>, String> {
    let targets: Vec<CatalogTarget> = snapshot
        .iter()
        .filter_map(|addon| {
            addon
                .capabilities
                .as_ref()
                .map(|snapshot| (&addon.url, snapshot))
        })
        .flat_map(|(url, snapshot)| {
            snapshot.catalogs.iter().filter_map(move |catalog| {
                let supports_skip = catalog_declares_extra(catalog, "skip");
                if matches!(
                    catalog.type_.trim().to_ascii_lowercase().as_str(),
                    "movie" | "series"
                ) {
                    return None;
                }
                let extras = catalog_request_extras(
                    Some(snapshot),
                    &catalog.type_,
                    &catalog.id,
                    extras.to_vec(),
                );
                let genre = extras.iter().find(|extra| extra.name == "genre")?;
                snapshot_supports_catalog(snapshot, &catalog.type_, &catalog.id, &extras).ok()?;
                Some(CatalogTarget {
                    url: url.clone(),
                    media_type: catalog.type_.clone(),
                    catalog_id: catalog.id.clone(),
                    catalog_genre: Some(genre.value.clone()),
                    extras,
                    supports_skip,
                })
            })
        })
        .take(MAX_CATALOG_SOURCES)
        .collect();

    if targets.is_empty() {
        return Err(no_capable_addon_error(
            "a catalog for the selected genre",
            "catalog",
        ));
    }

    Ok(targets)
}

/// A target-selection result plus the extras it was chosen for, per group,
/// in caller order.
type CatalogGroupSelection = Result<(Vec<CatalogTarget>, Vec<CatalogExtra>), String>;

/// One unit of catalog work in a shared pool: `(group, order)` regroups
/// interleaved results back into per-group, per-source order.
struct CatalogWorkItem {
    group: usize,
    order: usize,
    addon_url: String,
    media_type: String,
    catalog_id: String,
    extras: Vec<CatalogExtra>,
    catalog_genre: Option<String>,
}

/// Arm once usable outcomes exist for the request. Fast errors or cached
/// results in an unrelated group must not cancel its first valid answer.
pub(super) async fn collect_with_deadline<S, T>(
    mut outcomes: S,
    grace: Duration,
    mut ready: impl FnMut(&T) -> bool,
) -> Vec<T>
where
    S: stream::Stream<Item = T> + Unpin,
{
    let mut collected = Vec::new();
    let mut armed = false;
    let straggler_deadline = tokio::time::sleep(grace);
    tokio::pin!(straggler_deadline);
    loop {
        tokio::select! {
            biased;
            _ = &mut straggler_deadline, if armed => break,
            next = outcomes.next() => {
                let Some(item) = next else { break };
                if !armed && ready(&item) {
                    armed = true;
                    straggler_deadline
                        .as_mut()
                        .reset(tokio::time::Instant::now() + grace);
                }
                collected.push(item);
            }
        }
    }
    collected
}

#[derive(Clone, Copy)]
enum CatalogGraceStart {
    FirstResults,
    AllGroupsReady,
}

async fn collect_catalog_outcomes<S>(
    outcomes: S,
    mut remaining: Vec<usize>,
    grace: Duration,
    grace_start: CatalogGraceStart,
) -> Vec<(usize, usize, Result<CatalogPage, String>)>
where
    S: stream::Stream<Item = (usize, usize, Result<CatalogPage, String>)> + Unpin,
{
    let mut succeeded = vec![false; remaining.len()];
    collect_with_deadline(outcomes, grace, |(group, _, result)| {
        let usable = result.as_ref().is_ok_and(|page| !page.items.is_empty());
        if matches!(grace_start, CatalogGraceStart::FirstResults) {
            return usable;
        }
        remaining[*group] -= 1;
        succeeded[*group] |= usable;
        remaining
            .iter()
            .zip(&succeeded)
            .all(|(count, success)| *count == 0 || *success)
    })
    .await
}

/// Runs every work item through one `buffer_unordered` pool so a multi-group
/// request (e.g. a search or browse fan-out across genres) stays inside
/// `ADDON_RESOURCE_CONCURRENCY` instead of multiplying the cap per group.
/// Returns each group's results in source order.
async fn run_catalog_work_pool(
    client: &AddonResourceClient,
    mut work: Vec<CatalogWorkItem>,
    group_count: usize,
    deadline: Option<tokio::time::Instant>,
    grace_start: CatalogGraceStart,
) -> Vec<Vec<(usize, Result<CatalogPage, String>)>> {
    let mut remaining = vec![0; group_count];
    for item in &work {
        remaining[item.group] += 1;
    }
    // Start each group's primary before queuing secondary sources, while
    // retaining the shared concurrency limit and source-order merge.
    work.sort_by_key(|item| (item.order, item.group));
    let outcomes = collect_catalog_outcomes(
        stream::iter(work.into_iter().map(|item| async move {
            let fetch = client.fetch_catalog(
                &item.addon_url,
                &item.media_type,
                &item.catalog_id,
                &item.extras,
                normalize_media_item,
            );
            let result = match deadline {
                Some(deadline) => tokio::time::timeout_at(deadline, fetch)
                    .await
                    .unwrap_or_else(|_| Err("Catalog scan time budget reached.".into())),
                None => fetch.await,
            }
            .map(|mut page| {
                for media_item in &mut page.items {
                    media_item.catalog_genre.clone_from(&item.catalog_genre);
                }
                page
            });
            (item.group, item.order, result)
        }))
        .buffer_unordered(ADDON_RESOURCE_CONCURRENCY),
        remaining,
        CATALOG_STRAGGLER_GRACE,
        grace_start,
    )
    .await;

    let mut grouped: Vec<Vec<(usize, Result<CatalogPage, String>)>> =
        (0..group_count).map(|_| Vec::new()).collect();
    for (group, order, result) in outcomes {
        grouped[group].push((order, result));
    }
    for bucket in &mut grouped {
        bucket.sort_by_key(|(order, _)| *order);
    }
    grouped
}

/// Multi-group catalog fetch: one bounded pool
/// serves every (group × source) fetch, merged back per group in target
/// order so per-group failures stay isolated for the caller's own merge.
pub(crate) async fn fetch_catalog_pages_for_target_groups(
    client: &AddonResourceClient,
    groups: Vec<CatalogGroupSelection>,
    deadline: Option<tokio::time::Instant>,
) -> Vec<Result<CatalogFetchPage, String>> {
    let group_count = groups.len();
    let mut work = Vec::new();
    let mut group_errors = Vec::with_capacity(group_count);
    let mut group_skips: Vec<u32> = Vec::with_capacity(group_count);

    for (group, entry) in groups.into_iter().enumerate() {
        match entry {
            Ok((targets, extras)) => {
                let skip = extra_skip_value(&extras);
                let targets = targets
                    .into_iter()
                    .filter(|target| skip == 0 || target.supports_skip);
                let mut supports_skip = Vec::new();
                group_skips.push(skip);
                for (order, target) in targets.enumerate() {
                    supports_skip.push(target.supports_skip);
                    work.push(CatalogWorkItem {
                        group,
                        order,
                        addon_url: target.url,
                        media_type: target.media_type,
                        catalog_id: target.catalog_id,
                        extras: target.extras,
                        catalog_genre: target.catalog_genre,
                    });
                }
                group_errors.push((None, supports_skip));
            }
            Err(error) => {
                group_errors.push((Some(error), Vec::new()));
                group_skips.push(0);
            }
        }
    }

    run_catalog_work_pool(
        client,
        work,
        group_count,
        deadline,
        CatalogGraceStart::AllGroupsReady,
    )
    .await
    .into_iter()
    .zip(group_errors)
    .zip(group_skips)
    .map(|((bucket, (error, supports_skip)), skip)| match error {
        Some(error) => Err(error),
        None if supports_skip.is_empty() => Ok(CatalogFetchPage::default()),
        None if deadline.is_some()
            && (bucket.len() != supports_skip.len()
                || bucket.iter().any(|(_, result)| result.is_err())) =>
        {
            Err("Catalog scan incomplete.".into())
        }
        None => {
            // Dropped stragglers have no outcome to carry the partial flag.
            let incomplete = bucket.len() != supports_skip.len();
            merge_catalog_pages(
                bucket.into_iter().map(|(order, result)| {
                    result.map(|page| {
                        let mut page = catalog_fetch_page_from_source(page, skip);
                        if !supports_skip[order] {
                            page.next_skip = None;
                        }
                        page
                    })
                }),
                "Failed to load catalog.",
            )
            .map(|mut page| {
                page.partial |= incomplete;
                page
            })
        }
    })
    .collect()
}

struct SearchCatalogSource {
    cursor: SearchSourceCursor,
    supports_skip: bool,
}

fn search_source_key(
    genre: Option<&str>,
    addon_url: &str,
    media_type: &str,
    catalog_id: &str,
) -> String {
    hash_segment(&(genre, addon_url, media_type, catalog_id))
}

/// The request's fixed catalog types plus, when allowed, every custom type in
/// which the addon itself declares a `search` catalog. Unclassified addons keep
/// only the fixed types — their `top` fallback must not fan out per extra type.
fn addon_search_types<'a>(
    addon: &'a AddonConfig,
    media_types: &[&'a str],
    include_custom_types: bool,
) -> Vec<&'a str> {
    let mut types = media_types.to_vec();
    let Some(snapshot) = addon.capabilities.as_ref() else {
        return types;
    };
    if include_custom_types {
        for catalog in &snapshot.catalogs {
            if catalog_declares_extra(catalog, "search")
                && !types
                    .iter()
                    .any(|item| item.eq_ignore_ascii_case(&catalog.type_))
            {
                types.push(catalog.type_.as_str());
            }
        }
    }
    types
}

fn select_search_catalog_work(
    snapshot: &[AddonConfig],
    query: &str,
    media_types: &[&str],
    genres: &[Option<String>],
    cursors: Option<&[SearchSourceCursor]>,
    include_custom_types: bool,
) -> (Vec<CatalogWorkItem>, Vec<Vec<SearchCatalogSource>>) {
    let cursors = cursors.map(|cursors| {
        cursors
            .iter()
            .map(|cursor| (cursor.key.as_str(), cursor))
            .collect::<HashMap<_, _>>()
    });
    let mut work = Vec::new();
    let mut sources = Vec::with_capacity(genres.len());
    let mut selected_keys = HashSet::new();

    for (group, genre) in genres.iter().enumerate() {
        let mut group_sources = Vec::new();
        'addons: for addon in snapshot {
            let cinemeta = is_default_cinemeta_url(&addon.url);
            for media_type in addon_search_types(addon, media_types, include_custom_types) {
                for (catalog_type, catalog_id, supports_skip) in
                    searchable_catalogs(addon, media_type)
                {
                    // Cinemeta's top text search ignores genre. Rust verifies genre after merging.
                    let genre = if cinemeta && catalog_id == "top" {
                        None
                    } else {
                        genre.as_deref()
                    };
                    let mut extras = catalog_request_extras(
                        addon.capabilities.as_ref(),
                        catalog_type,
                        catalog_id,
                        catalog_search_extras(query, genre, 0),
                    );
                    let sent_genre = extras
                        .iter()
                        .find(|extra| extra.name == "genre")
                        .map(|extra| extra.value.as_str());
                    let key = search_source_key(sent_genre, &addon.url, catalog_type, catalog_id);
                    let cursor = if let Some(cursors) = &cursors {
                        let Some(cursor) = cursors
                            .get(key.as_str())
                            .filter(|cursor| supports_skip || (cursor.retry && cursor.skip == 0))
                        else {
                            continue;
                        };
                        (*cursor).clone()
                    } else {
                        SearchSourceCursor {
                            key,
                            skip: 0,
                            retry: false,
                            page_hash: None,
                        }
                    };
                    if cursor.skip > 0 {
                        extras.retain(|extra| extra.name != "skip");
                        extras.extend(super::search_commands::catalog_browse_extras(
                            None,
                            cursor.skip,
                        ));
                    }
                    if !addon_allows_catalog(addon, catalog_type, catalog_id, &extras)
                        || !selected_keys.insert(cursor.key.clone())
                    {
                        continue;
                    }
                    work.push(CatalogWorkItem {
                        group,
                        order: group_sources.len(),
                        addon_url: addon.url.clone(),
                        media_type: catalog_type.to_string(),
                        catalog_id: catalog_id.to_string(),
                        extras,
                        catalog_genre: None,
                    });
                    group_sources.push(SearchCatalogSource {
                        cursor,
                        supports_skip,
                    });
                    if group_sources.len() == MAX_CATALOG_SOURCES {
                        break 'addons;
                    }
                }
            }
        }
        sources.push(group_sources);
    }
    (work, sources)
}

/// One shared pool for every genre/source, with independent provider offsets.
/// `include_custom_types` adds each addon's own search-capable catalog types to
/// the fixed `media_types` — the All tab searches addon-declared types too.
pub(crate) async fn search_catalog_pages_for_genres(
    snapshot: &[AddonConfig],
    client: &AddonResourceClient,
    query: &str,
    media_types: &[&str],
    genres: &[Option<String>],
    cursors: Option<&[SearchSourceCursor]>,
    include_custom_types: bool,
) -> Result<SearchCatalogFetchPage, String> {
    let (work, sources) = select_search_catalog_work(
        snapshot,
        query,
        media_types,
        genres,
        cursors,
        include_custom_types,
    );
    if work.is_empty() && cursors.is_none() {
        return Err(no_capable_addon_error(
            "a searchable catalog for this type",
            "catalog",
        ));
    }
    // A continuation can wait for a missed genre while the first page stays visible.
    let grace_start = if cursors.is_some_and(|cursors| cursors.iter().any(|cursor| cursor.retry)) {
        CatalogGraceStart::AllGroupsReady
    } else {
        CatalogGraceStart::FirstResults
    };
    merge_search_catalog_pages(
        sources,
        run_catalog_work_pool(client, work, genres.len(), None, grace_start).await,
        cursors.is_none(),
    )
}

fn catalog_search_extras(query: &str, genre: Option<&str>, skip: u32) -> Vec<CatalogExtra> {
    let mut extras = vec![CatalogExtra {
        name: "search".to_string(),
        value: query.to_string(),
    }];
    extras.extend(super::search_commands::catalog_browse_extras(genre, skip));
    extras
}

fn merge_search_catalog_pages(
    sources: Vec<Vec<SearchCatalogSource>>,
    outcomes: Vec<Vec<(usize, Result<CatalogPage, String>)>>,
    first_page: bool,
) -> Result<SearchCatalogFetchPage, String> {
    let mut pages = Vec::new();
    let mut cursors = Vec::new();
    let mut partial = false;
    let mut succeeded = false;
    let mut first_error = None;
    for (sources, bucket) in sources.into_iter().zip(outcomes) {
        let mut bucket = bucket.into_iter().peekable();
        for (order, source) in sources.into_iter().enumerate() {
            let outcome = if bucket.peek().is_some_and(|(index, _)| *index == order) {
                bucket.next().expect("peeked source outcome").1
            } else {
                Err("Search catalog source timed out.".into())
            };
            let mut cursor = source.cursor;
            match outcome {
                Ok(page) => {
                    succeeded = true;
                    if let Some(skip) = catalog_page_next_skip(cursor.skip, page.source_item_count)
                        .filter(|skip| source.supports_skip && *skip > cursor.skip)
                    {
                        let keys = page
                            .items
                            .iter()
                            .map(|item| catalog_dedup_key(&item.type_, &item.id))
                            .collect();
                        cursor.page_hash = Some(catalog_page_hash(keys));
                        cursor.skip = skip;
                        cursor.retry = false;
                        cursors.push(cursor);
                    }
                    if !page.items.is_empty() {
                        pages.push(page.items);
                    }
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                    if !cursor.retry {
                        cursor.retry = true;
                        cursors.push(cursor);
                    } else {
                        partial = true;
                    }
                }
            }
        }
    }
    if first_page && (!succeeded || (pages.is_empty() && first_error.is_some())) {
        return Err(first_error.unwrap_or_else(|| "Failed to search catalog.".into()));
    }
    Ok(SearchCatalogFetchPage {
        items: interleave_catalog_items(pages),
        cursors,
        partial,
    })
}

pub(super) fn catalog_page_hash(mut keys: Vec<impl Ord + std::hash::Hash>) -> String {
    keys.sort_unstable();
    keys.dedup();
    hash_segment(&keys)
}

pub(super) fn interleave_catalog_items(
    pages: impl IntoIterator<Item = Vec<MediaItem>>,
) -> Vec<MediaItem> {
    let mut pages: VecDeque<_> = pages.into_iter().map(Vec::into_iter).collect();
    let mut items = Vec::with_capacity(pages.iter().map(ExactSizeIterator::len).sum());
    while let Some(mut page) = pages.pop_front() {
        items.extend(page.next());
        if page.len() > 0 {
            pages.push_back(page);
        }
    }
    items
}

pub async fn fetch_meta_details(
    app: &AppHandle,
    client: &AddonResourceClient,
    type_: &str,
    id: &str,
) -> Result<Arc<MediaDetails>, String> {
    let snapshot = load_enabled_addons_snapshot(app).await?;
    fetch_meta_details_from_addons(client, &snapshot, type_, id, None).await
}

async fn fetch_ranked_meta(
    client: &AddonResourceClient,
    url: &str,
    type_: &str,
    id: &str,
    rank: usize,
) -> (usize, Result<Arc<MediaDetails>, String>) {
    let result = client
        .fetch_meta(url, type_, id, normalize_media_details)
        .await
        .and_then(|details| {
            use crate::providers::skip_times::normalize_imdb_id;
            if let Some(requested) = normalize_imdb_id(id) {
                let actual = details
                    .imdb_id
                    .as_deref()
                    .and_then(normalize_imdb_id)
                    .or_else(|| {
                        details
                            .imdb_id
                            .is_none()
                            .then(|| normalize_imdb_id(&details.id))
                            .flatten()
                    });
                if actual.is_some_and(|actual| actual != requested) {
                    return Err("Metadata IMDb ID does not match the requested title.".to_string());
                }
            }
            let response_type = super::normalize_watch_progress_type(&details.type_);
            if response_type.is_some()
                && response_type == super::normalize_watch_progress_type(type_)
            {
                Ok(details)
            } else {
                Err("Metadata type does not match the requested media type.".to_string())
            }
        });
    (rank, result)
}

pub(super) async fn fetch_meta_details_from_addons(
    client: &AddonResourceClient,
    snapshot: &[AddonConfig],
    type_: &str,
    id: &str,
    genres_deadline: Option<tokio::time::Instant>,
) -> Result<Arc<MediaDetails>, String> {
    let require_genres = genres_deadline.is_some();
    let targets: Vec<_> = snapshot
        .iter()
        .filter_map(|addon| {
            // Prefer an explicitly declared anime endpoint; legacy and series-only
            // sources retain the Cinemeta-compatible series request.
            let request_type = if type_ == "anime"
                && (addon.capabilities.is_none()
                    || !addon_allows_resource(addon, "meta", type_, id))
            {
                "series"
            } else {
                type_
            };
            addon_allows_resource(addon, "meta", request_type, id).then_some((addon, request_type))
        })
        .take(MAX_METADATA_SOURCES)
        .collect();

    let Some((first, first_type)) = targets.first() else {
        return Err(no_capable_addon_error(
            &format!("metadata for {type_}/{id}"),
            "metadata",
        ));
    };

    let generation = client.cache_generation();
    let mut recent_stragglers = [false; MAX_METADATA_SOURCES];
    recent_stragglers[0] = client.meta_is_recent_straggler(&first.url, first_type, id);
    let mut first_fetch = Box::pin(fetch_ranked_meta(client, &first.url, first_type, id, 0));
    let hedge = tokio::time::sleep(if recent_stragglers[0] {
        Duration::ZERO
    } else {
        META_HEDGE_DELAY
    });
    tokio::pin!(hedge);

    // Hedged start: the first capable source runs alone until it settles or
    // the hedge window expires, then the rest of the registry joins. A recently
    // stalled source still gets polled first, but cannot hold a ready fallback.
    let mut first_error: Option<String> = None;
    let hedged = tokio::select! {
        biased;
        (_, result) = &mut first_fetch => match result {
            Ok(details) if !require_genres || details.genres.is_some() => return Ok(details),
            Ok(_) => false,
            Err(error) => {
                first_error = Some(error);
                false
            }
        },
        _ = &mut hedge => true,
    };

    // Sources race in completion order, tagged by registry rank. The first
    // success wins once nothing better-ranked is still pending; while a
    // better-ranked source is pending, a ready result waits out one
    // META_FALLBACK_GRACE window — a dead primary holds a live fallback for
    // the grace, not its full request timeout.
    let mut outcomes = futures_util::stream::FuturesUnordered::new();
    let mut pending = HashSet::new();
    if hedged {
        // Still in flight: it keeps its rank-0 slot so a slow-but-valid
        // primary is preferred over a faster secondary inside the grace.
        pending.insert(0);
        outcomes.push(first_fetch);
    }
    for (index, (addon, request_type)) in targets.iter().enumerate().skip(1) {
        recent_stragglers[index] = client.meta_is_recent_straggler(&addon.url, request_type, id);
        pending.insert(index);
        outcomes.push(Box::pin(fetch_ranked_meta(
            client,
            &addon.url,
            request_type,
            id,
            index,
        )));
    }

    let mut best_ok: Option<(usize, Arc<MediaDetails>)> = None;
    let mut errors: Vec<(usize, String)> = Vec::new();
    if let Some(error) = first_error {
        errors.push((0, error));
    }
    let mut grace_deadline: Option<tokio::time::Instant> = None;
    let mut grace_expired = false;

    while !pending.is_empty() {
        // Copy for the async-move branch so the select handler can re-arm; the
        // genre budget binds the pre-result wait too, not just the post-ready grace.
        let deadline = match (grace_deadline, genres_deadline) {
            (Some(grace), Some(genres)) => Some(grace.min(genres)),
            (grace, genres) => grace.or(genres),
        };
        tokio::select! {
            // A result landing as the grace expires must win: the deadline
            // only matters when nothing better is ready.
            biased;
            next = outcomes.next() => {
                let Some((index, result)) = next else { break };
                pending.remove(&index);
                match result {
                    Ok(details) if !require_genres || details.genres.is_some() => {
                        let is_better = best_ok
                            .as_ref()
                            .is_none_or(|(best_index, _)| index < *best_index);
                        if is_better {
                            best_ok = Some((index, details));
                            grace_deadline.get_or_insert_with(|| {
                                tokio::time::Instant::now() + META_FALLBACK_GRACE
                            });
                        }
                    }
                    Ok(_) => {},
                    Err(error) => errors.push((index, error)),
                }
                if best_ok.as_ref().is_some_and(|(best_index, _)| {
                    !pending.iter().any(|pending_index| {
                        *pending_index < *best_index && !recent_stragglers[*pending_index]
                    })
                }) {
                    break;
                }
            }
            _ = async move {
                match deadline {
                    Some(instant) => tokio::time::sleep_until(instant).await,
                    None => std::future::pending().await,
                }
            } => {
                grace_expired = grace_deadline
                    .is_some_and(|deadline| tokio::time::Instant::now() >= deadline);
                break;
            },
        }
    }

    if let Some((best_index, details)) = best_ok {
        if grace_expired {
            for index in pending {
                if index < best_index && !recent_stragglers[index] {
                    let (addon, request_type) = targets[index];
                    client.note_meta_straggler(&addon.url, request_type, id, generation);
                }
            }
        }
        return Ok(details);
    }

    Err(errors
        .into_iter()
        .min_by_key(|(index, _)| *index)
        .map_or_else(|| "Metadata not found.".to_string(), |(_, error)| error))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcedAddonSubtitle {
    pub id: String,
    pub selection_key: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub mpv_title: String,
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
    query_ids: &[String],
) -> Result<Vec<SourcedAddonSubtitle>, String> {
    let snapshot = load_enabled_addons_snapshot(app).await?;
    fetch_subtitles_from_addons(
        client,
        &snapshot,
        type_,
        query_ids,
        SUBTITLE_STRAGGLER_GRACE,
    )
    .await
}

async fn fetch_subtitles_from_addons(
    client: &AddonResourceClient,
    addons: &[AddonConfig],
    type_: &str,
    query_ids: &[String],
    grace: Duration,
) -> Result<Vec<SourcedAddonSubtitle>, String> {
    let requests: Vec<_> = addons
        .iter()
        .filter(|addon| {
            query_ids
                .iter()
                .any(|id| subtitle_request_type(addon, type_, id).is_some())
        })
        .take(MAX_SUBTITLE_SOURCES)
        .enumerate()
        .map(|(index, addon)| async move {
            let result = fetch_subtitles_for_addon(client, type_, query_ids, addon).await;
            (index, addon, result)
        })
        .collect();

    if requests.is_empty() {
        let id = query_ids.first().map(String::as_str).unwrap_or_default();
        return Err(no_capable_addon_error(
            &format!("subtitles for {type_}/{id}"),
            "subtitle",
        ));
    }

    let mut outcomes = collect_with_deadline(
        stream::iter(requests).buffer_unordered(ADDON_RESOURCE_CONCURRENCY),
        grace,
        |(_, _, result)| result.as_ref().is_ok_and(|items| !items.is_empty()),
    )
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
                for item in items.iter() {
                    add_subtitle_if_unique(&mut subtitles, &mut seen, addon, item);
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

fn subtitle_request_type<'a>(addon: &'a AddonConfig, type_: &'a str, id: &str) -> Option<&'a str> {
    let fallback = super::media_type::addon_episode_lookup_type(type_);
    let Some(manifest) = addon.capabilities.as_ref() else {
        return Some(fallback);
    };
    snapshot_request_type(manifest, "subtitles", type_, id).or_else(|| {
        (fallback != type_)
            .then(|| snapshot_request_type(manifest, "subtitles", fallback, id))
            .flatten()
    })
}

async fn fetch_subtitles_for_addon(
    client: &AddonResourceClient,
    type_: &str,
    query_ids: &[String],
    addon: &AddonConfig,
) -> Result<Arc<[AddonSubtitle]>, String> {
    let mut had_success = false;
    let mut last_error = None;
    for (request_type, id) in query_ids
        .iter()
        .filter_map(|id| subtitle_request_type(addon, type_, id).map(|type_| (type_, id)))
    {
        match client.fetch_subtitles(&addon.url, request_type, id).await {
            Ok(items) => {
                had_success = true;
                if !items.is_empty() {
                    return Ok(items);
                }
            }
            Err(error) => last_error = Some(error),
        }
    }
    if !had_success {
        if let Some(error) = last_error {
            return Err(error);
        }
    }
    Ok(Arc::default())
}

fn add_subtitle_if_unique(
    subtitles: &mut Vec<SourcedAddonSubtitle>,
    seen: &mut HashSet<String>,
    addon: &AddonConfig,
    item: &AddonSubtitle,
) {
    let (id, url, lang) = item.dedup_identity();
    let selection_key = serde_json::to_string(&(&addon.id, id, url, lang))
        .expect("subtitle identity contains only strings");
    if !seen.insert(selection_key.clone()) {
        return;
    }

    let label = item.label.as_deref().map(js_trim);
    subtitles.push(SourcedAddonSubtitle {
        detail: label
            .map(|label| {
                let detail = label
                    .rsplit_once('.')
                    .filter(|(_, extension)| {
                        ["srt", "ass", "ssa", "vtt", "sub", "idx", "smi", "txt"]
                            .iter()
                            .any(|candidate| extension.eq_ignore_ascii_case(candidate))
                    })
                    .map_or(label, |(name, _)| name);
                js_trim(detail)
            })
            .filter(|detail| !detail.is_empty())
            .map(str::to_string),
        mpv_title: label
            .filter(|label| !label.is_empty())
            .unwrap_or(&item.id)
            .to_string(),
        id: item.id.clone(),
        selection_key,
        url: item.url.clone(),
        lang: item.lang.clone(),
        label: item.label.clone(),
        source_id: addon.id.clone(),
        source_name: addon.name.clone(),
    });
}

#[cfg(test)]
mod tests;
