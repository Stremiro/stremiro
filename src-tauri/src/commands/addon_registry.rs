use super::config_store::{addon_configs_generation, load_addon_configs, AddonConfig};
use super::media_normalization::{normalize_media_details, normalize_media_item};
use super::{js_trim, SETTINGS_STORE_FILE};
use crate::providers::addon_manifest::snapshot_supports_request;
use crate::providers::addon_resource::{
    catalog_declares_extra, snapshot_supports_catalog, AddonResourceClient, AddonSubtitle,
    CatalogExtra, CatalogPage,
};
use crate::providers::ttl_cache::hash_segment;
use crate::providers::{lock_or_recover, MediaDetails, MediaItem};
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{hash_map::Entry, HashMap, HashSet};
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
/// Arm only after each catalog group has usable items or exhausts its sources.
const CATALOG_STRAGGLER_GRACE: Duration = Duration::from_millis(1_500);
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

fn searchable_catalog_ids<'a>(addon: &'a AddonConfig, type_: &str) -> Vec<(&'a str, bool)> {
    match addon.capabilities.as_ref() {
        None => vec![("top", false)],
        Some(snapshot) => snapshot
            .catalogs
            .iter()
            .filter(|catalog| {
                catalog.type_.eq_ignore_ascii_case(type_)
                    && catalog_declares_extra(catalog, "search")
            })
            .map(|catalog| (catalog.id.as_str(), catalog_declares_extra(catalog, "skip")))
            .collect(),
    }
}

#[derive(Debug, Clone)]
pub struct CatalogFetchPage {
    pub items: Vec<MediaItem>,
    pub next_skip: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchSourceCursor {
    pub key: String,
    pub skip: u32,
    #[serde(default)]
    pub retry: bool,
}

/// Dedup key of each item -> index in `cursors` of its first claimant's
/// advanced cursor (`None` when that source cannot page further).
pub(crate) type SearchCursorClaims = HashMap<String, Option<usize>>;

#[derive(Debug)]
pub(crate) struct SearchCatalogFetchPage {
    pub items: Vec<MediaItem>,
    pub cursors: Vec<SearchSourceCursor>,
    pub claims: SearchCursorClaims,
    pub partial: bool,
}

/// Stable identity shared by source merging and cross-page catalog deduplication.
pub(crate) fn catalog_dedup_key(type_: &str, id: &str) -> String {
    let mut key = format!("{}:{}", js_trim(type_), js_trim(id));
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
    }
}

pub(crate) fn merge_catalog_pages(
    results: impl IntoIterator<Item = Result<CatalogFetchPage, String>>,
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

    if !had_success || (items.is_empty() && last_error.is_some()) {
        return Err(last_error.unwrap_or_else(|| empty_error.to_string()));
    }

    Ok(CatalogFetchPage { items, next_skip })
}

/// What a catalog fetch needs from a selected addon — never the whole config
/// with its capability snapshot.
pub(crate) struct CatalogTarget {
    url: String,
    catalog_id: String,
    catalog_genre: Option<String>,
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
            let catalog = match addon.capabilities.as_ref() {
                Some(snapshot) => {
                    Some(snapshot_supports_catalog(snapshot, type_, catalog_id, extras).ok()?)
                }
                None => None,
            };
            Some(CatalogTarget {
                url: addon.url.clone(),
                // Use the manifest's canonical id even for a case-insensitive match.
                catalog_id: catalog
                    .map_or(catalog_id, |catalog| catalog.id.as_str())
                    .to_string(),
                catalog_genre: catalog
                    .filter(|catalog| catalog_declares_extra(catalog, "genre"))
                    .and_then(|_| {
                        extras
                            .iter()
                            .find(|extra| extra.name.eq_ignore_ascii_case("genre"))
                    })
                    .map(|extra| extra.value.clone()),
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
async fn collect_with_deadline<S, T>(
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

async fn collect_catalog_outcomes<S>(
    outcomes: S,
    mut remaining: Vec<usize>,
    grace: Duration,
) -> Vec<(usize, usize, Result<CatalogPage, String>)>
where
    S: stream::Stream<Item = (usize, usize, Result<CatalogPage, String>)> + Unpin,
{
    let mut succeeded = vec![false; remaining.len()];
    collect_with_deadline(outcomes, grace, |(group, _, result)| {
        remaining[*group] -= 1;
        succeeded[*group] |= result.as_ref().is_ok_and(|page| !page.items.is_empty());
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
            let result = client
                .fetch_catalog(
                    &item.addon_url,
                    &item.media_type,
                    &item.catalog_id,
                    &item.extras,
                    normalize_media_item,
                )
                .await
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
    type_: &str,
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
                for (order, target) in targets.into_iter().enumerate() {
                    work.push(CatalogWorkItem {
                        group,
                        order,
                        addon_url: target.url,
                        media_type: type_.to_string(),
                        catalog_id: target.catalog_id,
                        extras: extras.clone(),
                        catalog_genre: target.catalog_genre,
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
                bucket.into_iter().map(|(_, result)| {
                    result.map(|page| catalog_fetch_page_from_source(page, skip))
                }),
                "Failed to load catalog.",
            ),
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

fn select_search_catalog_work(
    snapshot: &[AddonConfig],
    query: &str,
    media_types: &[&str],
    genres: &[Option<String>],
    cursors: Option<&[SearchSourceCursor]>,
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
            for media_type in media_types {
                for (catalog_id, supports_skip) in searchable_catalog_ids(addon, media_type) {
                    let key =
                        search_source_key(genre.as_deref(), &addon.url, media_type, catalog_id);
                    let cursor = if let Some(cursors) = &cursors {
                        let Some(cursor) = cursors.get(key.as_str()).filter(|_| supports_skip)
                        else {
                            continue;
                        };
                        (*cursor).clone()
                    } else {
                        SearchSourceCursor {
                            key,
                            skip: 0,
                            retry: false,
                        }
                    };
                    let extras = catalog_search_extras(query, genre.as_deref(), cursor.skip);
                    if !addon_allows_catalog(addon, media_type, catalog_id, &extras)
                        || !selected_keys.insert(cursor.key.clone())
                    {
                        continue;
                    }
                    work.push(CatalogWorkItem {
                        group,
                        order: group_sources.len(),
                        addon_url: addon.url.clone(),
                        media_type: (*media_type).to_string(),
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
pub(crate) async fn search_catalog_pages_for_genres(
    app: &AppHandle,
    client: &AddonResourceClient,
    query: &str,
    media_types: &[&str],
    genres: &[Option<String>],
    cursors: Option<&[SearchSourceCursor]>,
) -> Result<SearchCatalogFetchPage, String> {
    let snapshot = load_enabled_addons_snapshot(app).await?;
    let (work, sources) =
        select_search_catalog_work(&snapshot, query, media_types, genres, cursors);
    if work.is_empty() && cursors.is_none() {
        return Err(no_capable_addon_error(
            "a searchable catalog for this type",
            "catalog",
        ));
    }
    merge_search_catalog_pages(
        sources,
        run_catalog_work_pool(client, work, genres.len()).await,
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
    let mut items = Vec::new();
    let mut claims = HashMap::new();
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
                    let advanced = catalog_page_next_skip(cursor.skip, page.source_item_count)
                        .filter(|skip| source.supports_skip && *skip > cursor.skip)
                        .map(|skip| {
                            cursor.skip = skip;
                            cursor.retry = false;
                            cursors.push(cursor);
                            cursors.len() - 1
                        });
                    for item in page.items {
                        if let Entry::Vacant(entry) =
                            claims.entry(catalog_dedup_key(&item.type_, &item.id))
                        {
                            entry.insert(advanced);
                            items.push(item);
                        }
                    }
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                    if source.supports_skip && !cursor.retry {
                        cursor.retry = true;
                        cursors.push(cursor);
                    } else {
                        partial = true;
                    }
                }
            }
        }
    }
    if first_page && (!succeeded || (items.is_empty() && first_error.is_some())) {
        return Err(first_error.unwrap_or_else(|| "Failed to search catalog.".into()));
    }
    Ok(SearchCatalogFetchPage {
        items,
        cursors,
        claims,
        partial,
    })
}

pub async fn fetch_meta_details(
    app: &AppHandle,
    client: &AddonResourceClient,
    type_: &str,
    id: &str,
) -> Result<Arc<MediaDetails>, String> {
    let snapshot = load_enabled_addons_snapshot(app).await?;
    fetch_meta_details_from_addons(client, &snapshot, type_, id).await
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
        .await;
    (rank, result)
}

async fn fetch_meta_details_from_addons(
    client: &AddonResourceClient,
    snapshot: &[AddonConfig],
    type_: &str,
    id: &str,
) -> Result<Arc<MediaDetails>, String> {
    let targets: Vec<_> = snapshot
        .iter()
        .filter(|addon| addon_allows_resource(addon, "meta", type_, id))
        .take(MAX_METADATA_SOURCES)
        .collect();

    let Some(first) = targets.first() else {
        return Err(no_capable_addon_error(
            &format!("metadata for {type_}/{id}"),
            "metadata",
        ));
    };

    let generation = client.cache_generation();
    let mut recent_stragglers = [false; MAX_METADATA_SOURCES];
    recent_stragglers[0] = client.meta_is_recent_straggler(&first.url, type_, id);
    let mut first_fetch = Box::pin(fetch_ranked_meta(client, &first.url, type_, id, 0));
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
            Ok(details) => return Ok(details),
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
    for (index, addon) in targets.iter().enumerate().skip(1) {
        recent_stragglers[index] = client.meta_is_recent_straggler(&addon.url, type_, id);
        pending.insert(index);
        outcomes.push(Box::pin(fetch_ranked_meta(
            client, &addon.url, type_, id, index,
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
        // Copy for the async-move branch so the select handler can re-arm.
        let deadline = grace_deadline;
        tokio::select! {
            // A result landing as the grace expires must win: the deadline
            // only matters when nothing better is ready.
            biased;
            next = outcomes.next() => {
                let Some((index, result)) = next else { break };
                pending.remove(&index);
                match result {
                    Ok(details) => {
                        let is_better = best_ok
                            .as_ref()
                            .is_none_or(|(best_index, _)| index < *best_index);
                        if is_better {
                            best_ok = Some((index, details));
                            grace_deadline
                                .get_or_insert_with(|| {
                                    tokio::time::Instant::now() + META_FALLBACK_GRACE
                                });
                        }
                    }
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
                grace_expired = true;
                break;
            },
        }
    }

    if let Some((best_index, details)) = best_ok {
        if grace_expired {
            for index in pending {
                if index < best_index && !recent_stragglers[index] {
                    client.note_meta_straggler(&targets[index].url, type_, id, generation);
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
    let requests: Vec<_> = snapshot
        .iter()
        .filter(|addon| {
            query_ids
                .iter()
                .any(|id| addon_allows_resource(addon, "subtitles", type_, id))
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
        SUBTITLE_STRAGGLER_GRACE,
        |(_, _, result)| result.is_ok(),
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
                for item in items {
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

async fn fetch_subtitles_for_addon(
    client: &AddonResourceClient,
    type_: &str,
    query_ids: &[String],
    addon: &AddonConfig,
) -> Result<Vec<AddonSubtitle>, String> {
    let mut had_success = false;
    let mut last_error = None;
    for id in query_ids
        .iter()
        .filter(|id| addon_allows_resource(addon, "subtitles", type_, id))
    {
        match client.fetch_subtitles(&addon.url, type_, id).await {
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
    Ok(Vec::new())
}

fn add_subtitle_if_unique(
    subtitles: &mut Vec<SourcedAddonSubtitle>,
    seen: &mut HashSet<String>,
    addon: &AddonConfig,
    item: AddonSubtitle,
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
        id: item.id,
        selection_key,
        url: item.url,
        lang: item.lang,
        label: item.label,
        source_id: addon.id.clone(),
        source_name: addon.name.clone(),
    });
}

#[cfg(test)]
mod tests;
