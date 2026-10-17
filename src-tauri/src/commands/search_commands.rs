use super::{
    addon_registry::{catalog_dedup_key, CatalogFetchPage},
    normalize_non_empty, normalize_query, MEDIA_ID_MAX_CHARS,
};
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
const MAX_CATALOG_SEEN_KEYS: usize = 10_000;
// Provider type strings are bounded to 2,048 characters; ids use the IPC id bound.
const MAX_CATALOG_SEEN_KEY_CHARS: usize = 2_048 + 1 + MEDIA_ID_MAX_CHARS;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCatalogPage {
    pub items: Vec<MediaItem>,
    pub continuation: SearchCatalogContinuation,
    pub exhausted: bool,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCatalogContinuation {
    #[serde(skip_serializing_if = "Option::is_none")]
    skip: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    all_cursors: Option<AllBrowseCursors>,
    seen_keys: Vec<String>,
}

impl SearchCatalogContinuation {
    fn is_exhausted(&self) -> bool {
        self.seen_keys.len() >= MAX_CATALOG_SEEN_KEYS
            || self.all_cursors.map_or_else(
                || self.skip.is_none(),
                |cursors| cursors.movie.is_none() && cursors.series.is_none(),
            )
    }
}

#[derive(Debug, Default, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub struct AllBrowseCursors {
    #[serde(skip_serializing_if = "Option::is_none")]
    movie: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    series: Option<u32>,
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

    /// A single pinned year can be served by a provider `year` catalog instead of
    /// client-filtering a feed page-by-page. Ranges stay on the feed path.
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
    continuation: SearchCatalogContinuation,
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
    continuation: Option<SearchCatalogContinuation>,
}

impl SearchCatalogRequest {
    pub(crate) fn for_genre(media_type: &str, genre: String) -> Self {
        Self {
            query: None,
            media_type: Some(media_type.to_string()),
            feed: None,
            genres: Some(vec![genre]),
            year_from: None,
            year_to: None,
            continuation: None,
        }
    }
}

fn normalize_genres(genres: Option<Vec<String>>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for genre in genres.unwrap_or_default() {
        if normalized.len() >= MAX_GENRE_FILTERS {
            break;
        }

        let Some(genre) = normalize_query(&genre) else {
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

    let all_browse = normalized_query.is_none() && request.media_type.is_none();
    let continuation = request.continuation.unwrap_or_else(|| {
        if all_browse {
            SearchCatalogContinuation {
                all_cursors: Some(AllBrowseCursors {
                    movie: Some(0),
                    series: Some(0),
                }),
                ..Default::default()
            }
        } else {
            SearchCatalogContinuation {
                skip: Some(0),
                ..Default::default()
            }
        }
    });
    if continuation.all_cursors.is_some() && (!all_browse || continuation.skip.is_some()) {
        return Err(
            "All-browse cursors cannot be combined with a query, media type or skip.".into(),
        );
    }
    if all_browse && continuation.all_cursors.is_none() {
        return Err("All-browse continuation requires branch cursors.".into());
    }
    if !all_browse && normalized_query.is_none() && parsed_media_type.is_none() {
        return Err("Media type is required to browse the search catalog.".to_string());
    }
    if continuation.seen_keys.len() > MAX_CATALOG_SEEN_KEYS
        || continuation
            .seen_keys
            .iter()
            .any(|key| key.is_empty() || key.chars().count() > MAX_CATALOG_SEEN_KEY_CHARS)
    {
        return Err("Invalid catalog continuation seen keys.".into());
    }

    Ok(SearchCatalogCriteria {
        query: normalized_query,
        media_type: parsed_media_type,
        feed: SearchFeed::resolve(request.feed.as_deref()),
        genres: normalize_genres(request.genres),
        year_range: SearchYearRange::resolve(request.year_from, request.year_to),
        continuation,
    })
}

fn normalize_search_text(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut separator_pending = false;
    for ch in value.chars().flat_map(char::to_lowercase) {
        if matches!(ch, '\'' | '’' | '\u{0300}'..='\u{036f}') {
            continue;
        }
        if ch.is_alphanumeric() {
            if separator_pending && !normalized.is_empty() {
                normalized.push(' ');
            }
            match ch {
                'à'..='å' => normalized.push('a'),
                'ç' => normalized.push('c'),
                'è'..='ë' => normalized.push('e'),
                'ì'..='ï' => normalized.push('i'),
                'ñ' => normalized.push('n'),
                'ò'..='ö' | 'ø' => normalized.push('o'),
                'ù'..='ü' => normalized.push('u'),
                'ý' | 'ÿ' => normalized.push('y'),
                'ß' => normalized.push_str("ss"),
                'æ' => normalized.push_str("ae"),
                'œ' => normalized.push_str("oe"),
                _ => normalized.push(ch),
            }
            separator_pending = false;
        } else {
            separator_pending = true;
        }
    }
    normalized
}

fn rank_search_results(
    query: &str,
    mut items: Vec<MediaItem>,
    year_range: SearchYearRange,
) -> Vec<MediaItem> {
    items.retain(|item| {
        !year_range.is_active() || year_range.contains(item.primary_year.unwrap_or(0))
    });
    let normalized_query = normalize_search_text(query);
    if normalized_query.is_empty() {
        return items;
    }
    let query_tokens = normalized_query.split_whitespace();
    let word_start_query = format!(" {normalized_query}");
    // Per-type catalog position preserves provider relevance across merged catalogs.
    let provider_ranks = {
        let mut next_ranks = std::collections::HashMap::new();
        items
            .iter()
            .map(|item| {
                let next_rank = next_ranks.entry(item.type_.as_str()).or_insert(0usize);
                let rank = *next_rank;
                *next_rank += 1;
                rank
            })
            .collect::<Vec<_>>()
    };
    let mut ranked_items = items.into_iter().zip(provider_ranks).collect::<Vec<_>>();
    ranked_items.sort_by_cached_key(|(item, provider_rank)| {
        let title = normalize_search_text(&item.title);
        let tier = if title.is_empty() {
            0
        } else if title == normalized_query {
            4
        } else if title.starts_with(&normalized_query) {
            3
        } else if title.contains(&word_start_query) {
            2
        } else if query_tokens
            .clone()
            .all(|token| title.split_whitespace().any(|word| word.starts_with(token)))
        {
            1
        } else {
            0
        };
        (
            std::cmp::Reverse(tier),
            *provider_rank,
            std::cmp::Reverse(item.primary_year.unwrap_or(0)),
        )
    });
    ranked_items.into_iter().map(|(item, _)| item).collect()
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

/// Genres sent as Cinemeta `genre` extras. Anime plus extra filters fetches the
/// extras and keeps titles also declaring Animation, instead of unioning the full
/// Animation catalog with unrelated live-action catalogs.
fn catalog_fetch_genres(media_type: SearchMediaType, genres: &[String]) -> Vec<String> {
    match media_type {
        SearchMediaType::Anime => {
            let extras = genres
                .iter()
                .filter(|genre| !is_animation_genre(genre))
                .cloned()
                .collect::<Vec<_>>();
            if extras.is_empty() {
                vec![CINEMETA_ANIME_GENRE.to_string()]
            } else {
                extras
            }
        }
        SearchMediaType::Movie | SearchMediaType::Series => genres.to_vec(),
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

/// Keep pulling provider pages until the response fills a usable grid page —
/// sparse intersections (e.g. anime + Crime) keep only a few titles per page.
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
    skip: u32,
) -> Result<super::addon_registry::CatalogFetchPage, String> {
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
        fetch_genres.into_iter().map(Some).collect()
    };

    // One shared pool for the (genre × source) fan-out: per-genre outcomes stay
    // isolated while total concurrency stays at `ADDON_RESOURCE_CONCURRENCY`.
    let outcomes = super::addon_registry::search_catalog_pages_for_genres(
        app,
        client,
        query,
        media_types,
        &genre_extras,
        skip,
    )
    .await?;
    let mut page =
        super::addon_registry::merge_catalog_pages(outcomes, "Failed to search catalog.")?;

    page.items = retain_search_items_matching_genres(
        retain_titled_catalog_items(page.items),
        &required_genres,
    );
    Ok(page)
}

fn retain_titled_catalog_items(mut items: Vec<MediaItem>) -> Vec<MediaItem> {
    // Filter after merging so an empty first claimant still owns a duplicate identity.
    items.retain(|item| !item.title.is_empty());
    items
}

/// Genre enforcement for text search, where a provider may honor `search` while
/// ignoring `genre`. Hits often carry no genres (Cinemeta returns none), so only a
/// declared list can disqualify — strict matching would empty every filtered search.
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

/// Provider year catalog (`genre=<year>` required extra) applies only to a single
/// pinned year on the default Popular feed with no genre filters — Featured keeps
/// feed ordering, anime keeps Animation routing, ranges stay on the feed path.
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
        // One store snapshot for the fan-out; per-genre selection failures resolve
        // per genre so one bad genre can't fail the partial-tolerant merge.
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
                client, media_type, groups,
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
    media_type: SearchMediaType,
    mut skip: u32,
) -> Result<CatalogFetchPage, String> {
    let feed = criteria.feed;
    let fetch_genres = catalog_fetch_genres(media_type, &criteria.genres);
    // Prefer the provider `year` catalog for a single pinned year; when no enabled
    // addon declares it, use the feed path with a client-side filter. `skip` is a
    // cursor into one result space, so the space is decided once by capability —
    // a fetch outcome cannot flip it or the client resumes with a foreign cursor.
    let mut year_catalog =
        browse_year_catalog(feed, media_type, &fetch_genres, criteria.year_range);
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

        let batch = apply_browse_filters(
            retain_titled_catalog_items(page.items),
            media_type,
            &fetch_genres,
            criteria.year_range,
        );
        for item in batch {
            let key = catalog_dedup_key(&item.type_, &item.id);
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

    Ok(CatalogFetchPage { items, next_skip })
}

fn merge_all_browse_pages(
    continuation: SearchCatalogContinuation,
    movie: Option<Result<CatalogFetchPage, String>>,
    series: Option<Result<CatalogFetchPage, String>>,
) -> Result<SearchCatalogPage, String> {
    let cursors = continuation.all_cursors.unwrap_or_default();
    let mut next = AllBrowseCursors::default();
    let mut pages = [Vec::new(), Vec::new()];
    let mut succeeded = false;
    let mut first_error = None;
    for (index, skip, outcome) in [(0, cursors.movie, movie), (1, cursors.series, series)] {
        let (Some(skip), Some(outcome)) = (skip, outcome) else {
            continue;
        };
        let cursor = if index == 0 {
            &mut next.movie
        } else {
            &mut next.series
        };
        match outcome {
            Ok(page) => {
                succeeded = true;
                *cursor = page.next_skip.filter(|next_skip| *next_skip > skip);
                pages[index] = page.items;
            }
            Err(error) => {
                // Preserve a failed branch's cursor so the next page retries it.
                *cursor = Some(skip);
                first_error.get_or_insert(error);
            }
        }
    }
    if !succeeded {
        return Err(first_error.unwrap_or_else(|| "Failed to load catalog.".into()));
    }

    let [movie, series] = pages;
    let mut items = Vec::with_capacity(movie.len() + series.len());
    let mut movie = movie.into_iter();
    let mut series = series.into_iter();
    loop {
        let pair = (movie.next(), series.next());
        if pair.0.is_none() && pair.1.is_none() {
            break;
        }
        items.extend(pair.0);
        items.extend(pair.1);
    }
    Ok(finish_catalog_page(items, continuation, None, Some(next)))
}

fn finish_catalog_page(
    items: Vec<MediaItem>,
    previous: SearchCatalogContinuation,
    next_skip: Option<u32>,
    all_cursors: Option<AllBrowseCursors>,
) -> SearchCatalogPage {
    let mut seen: HashSet<String> = previous.seen_keys.into_iter().collect();
    let mut added_movie = false;
    let mut added_series = false;
    let items: Vec<_> = items
        .into_iter()
        .filter(|item| {
            if seen.len() >= MAX_CATALOG_SEEN_KEYS
                || !seen.insert(catalog_dedup_key(&item.type_, &item.id))
            {
                return false;
            }
            added_movie |= item.type_.eq_ignore_ascii_case("movie");
            added_series |= item.type_.eq_ignore_ascii_case("series");
            true
        })
        .collect();
    let continuation = SearchCatalogContinuation {
        skip: next_skip
            .filter(|next| !items.is_empty() && previous.skip.is_some_and(|skip| *next > skip)),
        all_cursors: all_cursors.map(|cursors| {
            let previous = previous.all_cursors.unwrap_or_default();
            AllBrowseCursors {
                movie: cursors
                    .movie
                    .filter(|skip| Some(*skip) == previous.movie || added_movie),
                series: cursors
                    .series
                    .filter(|skip| Some(*skip) == previous.series || added_series),
            }
        }),
        seen_keys: seen.into_iter().collect(),
    };
    SearchCatalogPage {
        exhausted: continuation.is_exhausted(),
        items,
        continuation,
    }
}

#[command]
pub async fn query_search_catalog(
    app: AppHandle,
    client: State<'_, AddonResourceClient>,
    request: SearchCatalogRequest,
) -> Result<SearchCatalogPage, String> {
    query_search_catalog_for_request(&app, &client, request).await
}

pub(crate) async fn query_search_catalog_for_request(
    app: &AppHandle,
    client: &AddonResourceClient,
    request: SearchCatalogRequest,
) -> Result<SearchCatalogPage, String> {
    let criteria = build_search_criteria(request)?;

    if criteria.continuation.is_exhausted() {
        return Ok(SearchCatalogPage {
            items: Vec::new(),
            continuation: criteria.continuation,
            exhausted: true,
        });
    }

    if let Some(cursors) = criteria.continuation.all_cursors {
        let fetch = |media_type, skip: Option<u32>| {
            let criteria = &criteria;
            async move {
                let skip = skip?;
                Some(fetch_browse_page(app, client, criteria, media_type, skip).await)
            }
        };
        let (movie, series) = tokio::join!(
            fetch(SearchMediaType::Movie, cursors.movie),
            fetch(SearchMediaType::Series, cursors.series),
        );
        return merge_all_browse_pages(criteria.continuation, movie, series);
    }

    let skip = criteria.continuation.skip.unwrap_or(0);
    if let Some(query) = criteria.query.as_deref() {
        // Items arrive normalized, so the scorer reads `primary_year` instead
        // of re-parsing year strings per item.
        let page = fetch_query_results(
            app,
            client,
            query,
            criteria.media_type,
            &criteria.genres,
            skip,
        )
        .await?;
        let items = rank_search_results(query, page.items, criteria.year_range);

        return Ok(finish_catalog_page(
            items,
            criteria.continuation,
            page.next_skip,
            None,
        ));
    }

    let media_type = criteria
        .media_type
        .ok_or_else(|| "Media type is required to browse the search catalog.".to_string())?;
    let page = fetch_browse_page(app, client, &criteria, media_type, skip).await?;
    Ok(finish_catalog_page(
        page.items,
        criteria.continuation,
        page.next_skip,
        None,
    ))
}

#[cfg(test)]
mod tests;
