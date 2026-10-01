use super::{media_normalization::normalize_media_items, normalize_non_empty, normalize_query};
use crate::providers::{
    addon_resource::{AddonResourceClient, CatalogExtra},
    MediaItem,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::{command, AppHandle, State};

const SEARCH_YEAR_MIN: u32 = 1889;
const SEARCH_YEAR_MAX: u32 = 2100;
const MAX_GENRE_FILTERS: usize = 6;
const CINEMETA_ANIME_GENRE: &str = "Animation";
const MAX_BROWSE_SOURCE_FETCHES: usize = 8;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCatalogPage {
    pub items: Vec<MediaItem>,
    pub next_skip: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchMediaType {
    Movie,
    Series,
    Anime,
}

impl SearchMediaType {
    fn parse(value: Option<&str>) -> Option<Self> {
        match value?.trim().to_ascii_lowercase().as_str() {
            "movie" => Some(Self::Movie),
            "series" => Some(Self::Series),
            "anime" => Some(Self::Anime),
            _ => None,
        }
    }

    /// Catalog type requested from the registry. Anime is an app-level category over
    /// Cinemeta series, so it maps to the series type at the addon boundary.
    fn catalog_type(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series | Self::Anime => "series",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchFeed {
    Popular,
    Featured,
}

impl SearchFeed {
    fn resolve(requested: Option<&str>) -> Self {
        match requested
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .unwrap_or_default()
            .as_str()
        {
            "featured" => Self::Featured,
            _ => Self::Popular,
        }
    }

    fn cinemeta_catalog(self) -> &'static str {
        match self {
            Self::Featured => "imdbRating",
            Self::Popular => "top",
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct SearchYearRange {
    year_from: Option<u32>,
    year_to: Option<u32>,
}

impl SearchYearRange {
    fn resolve(year_from: Option<u32>, year_to: Option<u32>) -> Self {
        let normalized_from =
            year_from.filter(|value| (SEARCH_YEAR_MIN..=SEARCH_YEAR_MAX).contains(value));
        let normalized_to =
            year_to.filter(|value| (SEARCH_YEAR_MIN..=SEARCH_YEAR_MAX).contains(value));

        match (normalized_from, normalized_to) {
            (Some(from), Some(to)) if from > to => Self {
                year_from: Some(to),
                year_to: Some(from),
            },
            _ => Self {
                year_from: normalized_from,
                year_to: normalized_to,
            },
        }
    }

    fn is_active(self) -> bool {
        self.year_from.is_some() || self.year_to.is_some()
    }

    /// A single pinned year can be served by a provider `year` catalog (whose
    /// required `genre` extra carries the year) instead of client-filtering a
    /// feed catalog page-by-page. Ranges stay on the feed path.
    fn single_year(self) -> Option<u32> {
        match (self.year_from, self.year_to) {
            (Some(from), Some(to)) if from == to => Some(from),
            _ => None,
        }
    }

    fn contains(self, year: u32) -> bool {
        if let Some(year_from) = self.year_from {
            if year < year_from {
                return false;
            }
        }

        if let Some(year_to) = self.year_to {
            if year > year_to {
                return false;
            }
        }

        true
    }
}

#[derive(Debug)]
struct SearchCatalogCriteria {
    query: Option<String>,
    media_type: Option<SearchMediaType>,
    feed: SearchFeed,
    genres: Vec<String>,
    year_range: SearchYearRange,
    skip: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCatalogRequest {
    query: Option<String>,
    media_type: Option<String>,
    feed: Option<String>,
    genres: Option<Vec<String>>,
    year_from: Option<u32>,
    year_to: Option<u32>,
    skip: Option<u32>,
}

#[derive(Debug)]
struct RankedSearchItem {
    item: MediaItem,
    score: i32,
    year: u32,
    original_index: usize,
}

fn normalize_genres(genres: Option<Vec<String>>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for genre in genres.unwrap_or_default() {
        if normalized.len() >= MAX_GENRE_FILTERS {
            break;
        }

        let Some(genre) = normalize_non_empty(&genre) else {
            continue;
        };

        if seen.insert(genre.to_ascii_lowercase()) {
            normalized.push(genre);
        }
    }

    normalized
}

fn build_search_criteria(request: SearchCatalogRequest) -> Result<SearchCatalogCriteria, String> {
    let normalized_query = request.query.as_deref().and_then(normalize_query);
    let parsed_media_type = SearchMediaType::parse(request.media_type.as_deref());

    if normalized_query.is_none() && parsed_media_type.is_none() {
        return Err("Media type is required to browse the search catalog.".to_string());
    }

    Ok(SearchCatalogCriteria {
        query: normalized_query,
        media_type: parsed_media_type,
        feed: SearchFeed::resolve(request.feed.as_deref()),
        genres: normalize_genres(request.genres),
        year_range: SearchYearRange::resolve(request.year_from, request.year_to),
        skip: request.skip.unwrap_or(0),
    })
}

fn normalize_search_text(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn score_search_item(
    normalized_query: &str,
    query_tokens: &[&str],
    spaced_query: &str,
    item: &MediaItem,
) -> i32 {
    let normalized_title = normalize_search_text(&item.title);
    if normalized_title.is_empty() {
        return 0;
    }

    if normalized_title == normalized_query {
        return 1200;
    }

    let mut score = 0;

    if normalized_title.starts_with(normalized_query) {
        score += 900;
    } else if normalized_title.contains(normalized_query) {
        score += 400;
    }

    let title_tokens = normalized_title.split_whitespace().collect::<Vec<_>>();
    let mut matched_tokens = 0i32;
    let mut prefix_token_matches = 0i32;

    for token in query_tokens.iter().copied() {
        if title_tokens
            .iter()
            .any(|segment| segment == &token || segment.starts_with(token))
        {
            matched_tokens += 1;
            prefix_token_matches += 1;
        } else if normalized_title.contains(token) {
            matched_tokens += 1;
        }
    }

    if matched_tokens > 0 {
        score += matched_tokens * 70;
    }
    if prefix_token_matches > 0 {
        score += prefix_token_matches * 40;
    }

    if !normalized_query.is_empty() && normalized_title.contains(spaced_query) {
        score += 120;
    }

    // Titles are truncated at ingress (2k chars), so the length penalty
    // always fits in `i32`; saturate defensively instead of wrapping.
    score.saturating_sub(i32::try_from(normalized_title.len()).unwrap_or(i32::MAX))
}

fn rank_search_results(
    query: &str,
    items: Vec<MediaItem>,
    year_range: SearchYearRange,
) -> Vec<MediaItem> {
    let normalized_query = normalize_search_text(query);
    let query_tokens = normalized_query.split_whitespace().collect::<Vec<_>>();
    let spaced_query = format!(" {normalized_query}");
    let mut ranked = items
        .into_iter()
        .map(|item| {
            // Items arrive normalized: reuse `primary_year` instead of
            // re-parsing `item.year` per item.
            let year = item.primary_year.unwrap_or(0);
            let score = score_search_item(&normalized_query, &query_tokens, &spaced_query, &item);
            (score, year, item)
        })
        .filter(|(_, year, _)| !year_range.is_active() || year_range.contains(*year))
        .enumerate()
        .map(|(original_index, (score, year, item))| RankedSearchItem {
            year,
            score,
            item,
            original_index,
        })
        .collect::<Vec<_>>();

    ranked.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| right.year.cmp(&left.year))
            .then_with(|| left.original_index.cmp(&right.original_index))
    });

    ranked.into_iter().map(|entry| entry.item).collect()
}

fn item_has_genre(item: &MediaItem, genre: &str) -> bool {
    item.genres
        .as_ref()
        .is_some_and(|genres| genres.iter().any(|value| value.eq_ignore_ascii_case(genre)))
}

fn is_animation_genre(genre: &str) -> bool {
    genre.eq_ignore_ascii_case(CINEMETA_ANIME_GENRE)
}

fn browse_genres(media_type: SearchMediaType, genres: &[String]) -> Vec<String> {
    match media_type {
        SearchMediaType::Anime => {
            if genres.iter().any(|genre| is_animation_genre(genre)) {
                genres.to_vec()
            } else {
                let mut injected = Vec::with_capacity(genres.len() + 1);
                injected.push(CINEMETA_ANIME_GENRE.to_string());
                injected.extend(genres.iter().cloned());
                injected
            }
        }
        SearchMediaType::Movie | SearchMediaType::Series => genres.to_vec(),
    }
}

/// Genres sent as Cinemeta `genre` extras. Anime plus extra filters fetches those
/// extras and keeps titles that also declare Animation, instead of unioning the
/// full Animation catalog with unrelated live-action catalogs.
fn catalog_fetch_genres(media_type: SearchMediaType, genres: &[String]) -> Vec<String> {
    let injected = browse_genres(media_type, genres);
    match media_type {
        SearchMediaType::Anime => {
            let extras = injected
                .into_iter()
                .filter(|genre| !is_animation_genre(genre))
                .collect::<Vec<_>>();
            if extras.is_empty() {
                vec![CINEMETA_ANIME_GENRE.to_string()]
            } else {
                extras
            }
        }
        SearchMediaType::Movie | SearchMediaType::Series => injected,
    }
}

fn apply_browse_filters(
    mut items: Vec<MediaItem>,
    media_type: SearchMediaType,
    fetch_genres: &[String],
    year_range: SearchYearRange,
) -> Vec<MediaItem> {
    let filter_year = year_range.is_active();
    // Anime needs Animation even when the requested extras omit it.
    let require_animation = matches!(media_type, SearchMediaType::Anime)
        && !fetch_genres.iter().any(|genre| is_animation_genre(genre));
    if !filter_year && fetch_genres.is_empty() && !require_animation {
        return items;
    }

    items.retain(|item| {
        (!filter_year
            || item
                .primary_year
                .is_some_and(|year| year_range.contains(year)))
            && fetch_genres.iter().all(|genre| item_has_genre(item, genre))
            && (!require_animation || item_has_genre(item, CINEMETA_ANIME_GENRE))
    });
    items
}

/// Keep pulling provider pages until the response is a usable grid page.
/// Sparse intersections (e.g. anime + Crime) keep only a few titles per
/// provider page; returning them one page at a time made the grid trickle in
/// a few titles per round-trip instead of filling a row.
const MIN_BROWSE_FILL_ITEMS: usize = 24;

fn should_continue_browse_fetch(item_count: usize, next_skip: Option<u32>, fetches: usize) -> bool {
    item_count < MIN_BROWSE_FILL_ITEMS && next_skip.is_some() && fetches < MAX_BROWSE_SOURCE_FETCHES
}

async fn fetch_query_results(
    app: &AppHandle,
    client: &AddonResourceClient,
    query: &str,
    media_type: Option<SearchMediaType>,
    genres: &[String],
) -> Result<Vec<MediaItem>, String> {
    let media_types: &[&str] = match media_type {
        Some(SearchMediaType::Movie) => &["movie"],
        Some(SearchMediaType::Series) => &["series"],
        // Anime films are only reachable through search: browse is series-only.
        Some(SearchMediaType::Anime) | None => &["movie", "series"],
    };
    let fetch_genres = media_type
        .map(|media_type| catalog_fetch_genres(media_type, genres))
        .unwrap_or_else(|| genres.to_vec());
    // Anime requires the Animation marker on top of the requested genres.
    let required_genres = media_type
        .map(|media_type| browse_genres(media_type, genres))
        .unwrap_or_else(|| genres.to_vec());

    let genre_extras: Vec<Option<String>> = if fetch_genres.is_empty() {
        vec![None]
    } else {
        fetch_genres
            .iter()
            .map(|genre| Some(genre.clone()))
            .collect()
    };

    // One shared pool for the whole (genre × source) fan-out: each genre's
    // outcome stays isolated for the merge below while total concurrency
    // stays at `ADDON_RESOURCE_CONCURRENCY` instead of multiplying per genre.
    let outcomes = super::addon_registry::search_catalog_items_for_genres(
        app,
        client,
        query,
        media_types,
        &genre_extras,
    )
    .await?;
    let items = super::addon_registry::merge_catalog_items(outcomes, "Failed to search catalog.")?;

    Ok(retain_search_items_matching_genres(
        normalize_media_items(items),
        &required_genres,
    ))
}

/// Genre enforcement for text search, where a provider may honor `search`
/// while ignoring `genre`. Search hits often carry no genres at all (Cinemeta
/// returns none), so only a declared list can disqualify one — strict
/// matching would empty every anime or genre-filtered search. Expects
/// normalized items (empty lists collapse to `None`).
fn retain_search_items_matching_genres(
    mut items: Vec<MediaItem>,
    genres: &[String],
) -> Vec<MediaItem> {
    items.retain(|item| {
        item.genres.is_none() || genres.iter().all(|genre| item_has_genre(item, genre))
    });
    items
}

fn catalog_browse_extras(genre: Option<&str>, skip: u32) -> Vec<CatalogExtra> {
    let mut extras = genre
        .and_then(normalize_non_empty)
        .map(|genre| CatalogExtra {
            name: "genre".to_string(),
            value: genre,
        })
        .into_iter()
        .collect::<Vec<_>>();

    if skip > 0 {
        extras.push(CatalogExtra {
            name: "skip".to_string(),
            value: skip.to_string(),
        });
    }

    extras
}

/// Provider year catalog (`genre=<year>`, required extra) applies only to a
/// single pinned year on the default Popular feed with no genre filters.
/// Featured keeps its feed ordering with a client-side year filter, anime
/// keeps its Animation-category routing, and ranges stay on the feed path.
fn browse_year_catalog(
    feed: SearchFeed,
    media_type: SearchMediaType,
    fetch_genres: &[String],
    year_range: SearchYearRange,
) -> Option<u32> {
    match (feed, media_type, year_range.single_year()) {
        (SearchFeed::Popular, SearchMediaType::Movie | SearchMediaType::Series, Some(year))
            if fetch_genres.is_empty() =>
        {
            Some(year)
        }
        _ => None,
    }
}

async fn fetch_registry_browse_page(
    app: &AppHandle,
    client: &AddonResourceClient,
    media_type: SearchMediaType,
    feed: SearchFeed,
    genres: &[String],
    skip: u32,
) -> Result<super::addon_registry::CatalogFetchPage, String> {
    let catalog_id = feed.cinemeta_catalog();
    let media_type = media_type.catalog_type();

    if genres.len() > 1 {
        // One store snapshot for the whole fan-out; per-genre selection
        // failures still resolve per genre so one bad genre cannot fail the
        // merge that tolerates partial errors. The fetches share a single
        // `ADDON_RESOURCE_CONCURRENCY` pool across genres.
        let snapshot = super::addon_registry::load_enabled_addons_snapshot(app).await?;
        let groups = genres
            .iter()
            .map(|genre| {
                let extras = catalog_browse_extras(Some(genre), skip);
                super::addon_registry::select_catalog_targets(
                    snapshot.as_slice(),
                    media_type,
                    catalog_id,
                    &extras,
                )
                .map(|targets| (targets, extras))
            })
            .collect();

        super::addon_registry::merge_catalog_pages(
            super::addon_registry::fetch_catalog_pages_for_target_groups(
                client, media_type, catalog_id, groups,
            )
            .await,
            "Failed to load catalog.",
        )
    } else {
        super::addon_registry::fetch_catalog_page(
            app,
            client,
            media_type,
            catalog_id,
            &catalog_browse_extras(genres.first().map(String::as_str), skip),
        )
        .await
    }
}

async fn fetch_year_catalog_browse_page(
    app: &AppHandle,
    client: &AddonResourceClient,
    media_type: SearchMediaType,
    year: u32,
    skip: u32,
) -> Result<super::addon_registry::CatalogFetchPage, String> {
    super::addon_registry::fetch_catalog_page(
        app,
        client,
        media_type.catalog_type(),
        "year",
        &catalog_browse_extras(Some(&year.to_string()), skip),
    )
    .await
}

async fn fetch_browse_page(
    app: &AppHandle,
    client: &AddonResourceClient,
    criteria: &SearchCatalogCriteria,
) -> Result<SearchCatalogPage, String> {
    let media_type = criteria
        .media_type
        .ok_or_else(|| "Media type is required to browse the search catalog.".to_string())?;
    let feed = criteria.feed;
    let fetch_genres = catalog_fetch_genres(media_type, &criteria.genres);
    // Prefer the provider `year` catalog for a single pinned year. When no
    // enabled addon declares it (e.g. a replacement metadata addon with only
    // feed catalogs), use the feed path with a client-side filter. `skip` is
    // a cursor into one result space for the whole browse, so the space is
    // decided once by capability: a fetch outcome cannot flip it or the
    // client would resume with a foreign cursor.
    let mut year_catalog =
        browse_year_catalog(feed, media_type, &fetch_genres, criteria.year_range);
    let mut skip = criteria.skip;
    if let Some(year) = year_catalog {
        let snapshot = super::addon_registry::load_enabled_addons_snapshot(app).await?;
        let servable = super::addon_registry::select_catalog_targets(
            snapshot.as_slice(),
            media_type.catalog_type(),
            "year",
            &catalog_browse_extras(Some(&year.to_string()), skip),
        )
        .is_ok();
        if !servable {
            year_catalog = None;
        }
    }
    let mut fetches = 0;
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    let mut next_skip = None;

    loop {
        fetches += 1;
        let result = if let Some(year) = year_catalog {
            fetch_year_catalog_browse_page(app, client, media_type, year, skip).await
        } else {
            fetch_registry_browse_page(app, client, media_type, feed, &fetch_genres, skip).await
        };
        let page = match result {
            Ok(page) => page,
            // Keep the catalog's cursor space on failure: fail an empty
            // browse, or serve gathered items with the last good next_skip.
            Err(error) if items.is_empty() => return Err(error),
            Err(_) => break,
        };
        next_skip = page.next_skip;

        // Normalize once per page up front: year/genre filters and the final
        // ordering all read the precomputed fields instead of re-parsing.
        let batch = apply_browse_filters(
            normalize_media_items(page.items),
            media_type,
            &fetch_genres,
            criteria.year_range,
        );
        for item in batch {
            let key = super::addon_registry::catalog_dedup_key(&item.type_, &item.id);
            if seen.insert(key) {
                items.push(item);
            }
        }

        match next_skip {
            Some(continue_skip)
                if should_continue_browse_fetch(items.len(), next_skip, fetches) =>
            {
                skip = continue_skip;
            }
            _ => break,
        }
    }

    Ok(SearchCatalogPage { items, next_skip })
}

#[command]
pub async fn query_search_catalog(
    app: AppHandle,
    client: State<'_, AddonResourceClient>,
    request: SearchCatalogRequest,
) -> Result<SearchCatalogPage, String> {
    let criteria = build_search_criteria(request)?;

    if let Some(query) = criteria.query.as_deref() {
        // Items arrive normalized, so the scorer reads `primary_year` instead
        // of re-parsing year strings per item.
        let items =
            fetch_query_results(&app, &client, query, criteria.media_type, &criteria.genres)
                .await?;
        let items = rank_search_results(query, items, criteria.year_range);

        return Ok(SearchCatalogPage {
            items,
            next_skip: None,
        });
    }

    fetch_browse_page(&app, &client, &criteria).await
}

#[cfg(test)]
mod tests;
