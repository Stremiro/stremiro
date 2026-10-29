use super::{
    addon_registry::{catalog_dedup_key, CatalogFetchPage, SearchCursorClaims, SearchSourceCursor},
    config_store::AddonConfig,
    normalize_non_empty, normalize_query, MEDIA_ID_MAX_CHARS,
};
use crate::providers::{
    addon_resource::{AddonResourceClient, CatalogExtra},
    MediaItem,
};
use icu_normalizer::{
    properties::CanonicalCombiningClassMapBorrowed, DecomposingNormalizerBorrowed,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::{command, AppHandle, State};

const SEARCH_YEAR_MIN: u32 = 1889;
const SEARCH_YEAR_MAX: u32 = 2100;
const MAX_GENRE_FILTERS: usize = 6;
const CINEMETA_ANIME_GENRE: &str = "Animation";
const MAX_BROWSE_SOURCE_FETCHES: usize = 8;
const BROWSE_PAGE_TARGET: usize = 24;
const BROWSE_LOOKAHEAD_PAGES: usize = 4;
const BROWSE_SCAN_BUDGET: std::time::Duration = std::time::Duration::from_millis(500);
const MAX_CATALOG_SEEN_KEYS: usize = 10_000;
const MAX_SEARCH_SOURCE_CURSORS: usize =
    MAX_GENRE_FILTERS * super::addon_registry::MAX_CATALOG_SOURCES;
const _: () = assert!(MAX_SEARCH_SOURCE_CURSORS <= u64::BITS as usize);
// Provider type strings are bounded to 2,048 characters; ids use the IPC id bound.
const MAX_CATALOG_SEEN_KEY_CHARS: usize = 2_048 + 1 + MEDIA_ID_MAX_CHARS;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCatalogPage {
    pub items: Vec<MediaItem>,
    pub continuation: SearchCatalogContinuation,
    pub exhausted: bool,
    pub partial: bool,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCatalogContinuation {
    #[serde(skip_serializing_if = "Option::is_none")]
    skip: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    all_cursors: Option<AllBrowseCursors>,
    #[serde(skip_serializing_if = "Option::is_none")]
    search_cursors: Option<Vec<SearchSourceCursor>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    source_pages: Vec<String>,
    seen_keys: Vec<String>,
}

impl SearchCatalogContinuation {
    fn is_exhausted(&self) -> bool {
        if self.seen_keys.len() >= MAX_CATALOG_SEEN_KEYS {
            return true;
        }
        if let Some(cursors) = &self.search_cursors {
            return cursors.is_empty();
        }
        self.all_cursors.map_or_else(
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

    /// Anime is an app-level Animation category, not an addon media type.
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
        if requested.is_some_and(|value| value.trim().eq_ignore_ascii_case("featured")) {
            Self::Featured
        } else {
            Self::Popular
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
        self.year_from.is_none_or(|from| year >= from) && self.year_to.is_none_or(|to| year <= to)
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

fn normalize_genres(genres: Option<Vec<String>>) -> Vec<String> {
    let mut seen = HashSet::new();
    genres
        .unwrap_or_default()
        .into_iter()
        .filter_map(|genre| normalize_query(&genre))
        .filter(|genre| seen.insert(genre.to_ascii_lowercase()))
        .take(MAX_GENRE_FILTERS)
        .collect()
}

fn build_search_criteria(request: SearchCatalogRequest) -> Result<SearchCatalogCriteria, String> {
    let normalized_query = request.query.as_deref().and_then(normalize_query);
    let parsed_media_type = SearchMediaType::parse(request.media_type.as_deref());
    if request.media_type.is_some() && parsed_media_type.is_none() {
        return Err("Unsupported search media type.".into());
    }
    let is_hash =
        |value: &str| value.len() == 16 && value.bytes().all(|byte| byte.is_ascii_hexdigit());

    let all_browse = normalized_query.is_none()
        && (request.media_type.is_none() || parsed_media_type == Some(SearchMediaType::Anime));
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
            "Branch cursors require an All or Anime browse without a query or skip.".into(),
        );
    }
    if all_browse && continuation.all_cursors.is_none() {
        return Err("All-browse continuation requires branch cursors.".into());
    }
    if !all_browse && normalized_query.is_none() && parsed_media_type.is_none() {
        return Err("Media type is required to browse the search catalog.".to_string());
    }
    if let Some(cursors) = &continuation.search_cursors {
        if normalized_query.is_none()
            || continuation.skip.is_some()
            || continuation.all_cursors.is_some()
        {
            return Err("Search cursors require a query without browse cursors or skip.".into());
        }
        let mut keys = HashSet::new();
        if cursors.len() > MAX_SEARCH_SOURCE_CURSORS
            || cursors.iter().any(|cursor| {
                !is_hash(&cursor.key)
                    || cursor
                        .page_hash
                        .as_deref()
                        .is_some_and(|hash| !is_hash(hash))
                    || !keys.insert(&cursor.key)
                    || (cursor.skip == 0 && !cursor.retry)
            })
        {
            return Err("Invalid catalog continuation search cursors.".into());
        }
    } else if normalized_query.is_some() && continuation.skip.is_some_and(|skip| skip > 0) {
        return Err("Search continuation requires source cursors.".into());
    }
    if continuation.source_pages.len() > MAX_CATALOG_SEEN_KEYS
        || (!continuation.source_pages.is_empty() && normalized_query.is_none())
        || continuation.source_pages.iter().any(|page| {
            !page
                .split_once(':')
                .is_some_and(|(source, page)| is_hash(source) && is_hash(page))
        })
    {
        return Err("Invalid catalog continuation source pages.".into());
    }
    if continuation.seen_keys.len() > MAX_CATALOG_SEEN_KEYS
        || continuation
            .seen_keys
            .iter()
            .any(|key| key.is_empty() || key.chars().nth(MAX_CATALOG_SEEN_KEY_CHARS).is_some())
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

pub(crate) fn normalize_search_text(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut separator_pending = false;
    // NFD splits marks such as kana voicing off their letters; they must not split words.
    let combining_classes = CanonicalCombiningClassMapBorrowed::new();
    let lowercase = value.chars().flat_map(char::to_lowercase);
    for ch in DecomposingNormalizerBorrowed::new_nfd().normalize_iter(lowercase) {
        if matches!(ch, '\'' | '’' | '\u{0300}'..='\u{036f}') {
            continue;
        }
        if ch == '&' {
            if !normalized.is_empty() {
                normalized.push(' ');
            }
            normalized.push_str("and");
            separator_pending = true;
        } else if ch.is_alphanumeric() || combining_classes.get_u8(ch) != 0 {
            if separator_pending && !normalized.is_empty() {
                normalized.push(' ');
            }
            match ch {
                'ß' => normalized.push_str("ss"),
                'æ' => normalized.push_str("ae"),
                'œ' => normalized.push_str("oe"),
                'þ' => normalized.push_str("th"),
                'ø' => normalized.push('o'),
                'ł' => normalized.push('l'),
                'đ' | 'ð' => normalized.push('d'),
                'ı' => normalized.push('i'),
                _ => normalized.push(ch),
            }
            separator_pending = false;
        } else {
            separator_pending = true;
        }
    }
    normalized
}

fn without_search_article(title: &str) -> &str {
    ["the ", "an ", "a "]
        .into_iter()
        .find_map(|article| title.strip_prefix(article))
        .unwrap_or(title)
}

fn search_tier(title: &str, title_without_article: &str, query: &str) -> u8 {
    let query_without_article = without_search_article(query);
    let tier = if title.is_empty() {
        0
    } else if title == query || title_without_article == query_without_article {
        5
    } else if title.starts_with(query) || title_without_article.starts_with(query_without_article) {
        4
    } else if title
        .match_indices(' ')
        .any(|(index, _)| title[index + 1..].starts_with(query_without_article))
    {
        3
    } else if query_without_article
        .split_whitespace()
        .all(|token| title.split_whitespace().any(|word| word.starts_with(token)))
    {
        2
    } else if title.contains(query_without_article) {
        1
    } else {
        0
    };
    if tier >= 4 {
        return tier;
    }
    let mut compact_title = title_without_article.chars().filter(|ch| *ch != ' ');
    if query_without_article
        .chars()
        .filter(|ch| *ch != ' ')
        .all(|ch| compact_title.next() == Some(ch))
    {
        if compact_title.next().is_none() {
            5
        } else {
            4
        }
    } else {
        tier
    }
}

fn rank_search_results(
    query: &str,
    mut items: Vec<MediaItem>,
    year_range: SearchYearRange,
) -> Vec<MediaItem> {
    let mut seen = HashSet::new();
    items.retain(|item| {
        (!year_range.is_active()
            || item
                .primary_year
                .is_some_and(|year| year_range.contains(year)))
            && seen.insert(catalog_dedup_key(&item.type_, &item.id))
    });
    let normalized_query = normalize_search_text(query);
    if normalized_query.is_empty() {
        return items;
    }
    let year_query = normalized_query.rsplit_once(' ').and_then(|(query, year)| {
        let parsed = year.parse().ok()?;
        (year.len() == 4 && (1888..=2100).contains(&parsed)).then_some((query, parsed))
    });
    // Per-type catalog position preserves provider relevance across merged catalogs.
    let mut ranked_items: Vec<_> = items.into_iter().map(|item| (item, 0usize)).collect();
    let mut next_ranks = std::collections::HashMap::new();
    for (item, rank) in &mut ranked_items {
        let next_rank = next_ranks.entry(item.type_.as_str()).or_insert(0);
        *rank = *next_rank;
        *next_rank += 1;
    }
    ranked_items.sort_by_cached_key(|(item, provider_rank)| {
        let title = normalize_search_text(&item.title);
        let title_without_article = without_search_article(&title);
        let mut tier = search_tier(&title, title_without_article, &normalized_query);
        if let Some((query, _)) = year_query.filter(|(_, year)| item.primary_year == Some(*year)) {
            tier = tier.max(search_tier(&title, title_without_article, query));
        }
        (
            std::cmp::Reverse(item.matches_search_credit),
            std::cmp::Reverse(tier),
            *provider_rank,
            std::cmp::Reverse(item.primary_year.unwrap_or(0)),
        )
    });
    ranked_items.into_iter().map(|(item, _)| item).collect()
}

fn item_has_genre(item: &MediaItem, genre: &str) -> bool {
    let genre = genre.trim();
    item.genres.as_ref().is_some_and(|genres| {
        genres.iter().any(|value| {
            value.trim().eq_ignore_ascii_case(genre)
                || value
                    .split(" & ")
                    .any(|part| part.trim().eq_ignore_ascii_case(genre))
        })
    })
}

/// Genres sent as Cinemeta `genre` extras. Anime plus extra filters fetches the
/// extras and keeps titles also declaring Animation, instead of unioning the full
/// Animation catalog with unrelated live-action catalogs.
fn catalog_fetch_genres(media_type: SearchMediaType, genres: &[String]) -> Vec<String> {
    match media_type {
        SearchMediaType::Anime => {
            let extras = genres
                .iter()
                .filter(|genre| !genre.eq_ignore_ascii_case(CINEMETA_ANIME_GENRE))
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
    // Anime's category marker stays local even when the provider filtered Animation.
    let require_animation = matches!(media_type, SearchMediaType::Anime);
    if !filter_year && fetch_genres.is_empty() && !require_animation {
        return items;
    }

    items.retain(|item| {
        (!filter_year
            || item
                .primary_year
                .is_some_and(|year| year_range.contains(year)))
            && fetch_genres.iter().all(|genre| {
                item.catalog_genre
                    .as_deref()
                    .is_some_and(|sent| sent.eq_ignore_ascii_case(genre))
                    || item_has_genre(item, genre)
            })
            && (!require_animation || item_has_genre(item, CINEMETA_ANIME_GENRE))
    });
    items
}

async fn fetch_query_results(
    app: &AppHandle,
    client: &AddonResourceClient,
    criteria: SearchCatalogCriteria,
) -> Result<SearchCatalogPage, String> {
    let query = criteria.query.as_deref().expect("text search criteria");
    let media_types: &[&str] = match criteria.media_type {
        Some(SearchMediaType::Movie) => &["movie"],
        Some(SearchMediaType::Series) => &["series"],
        Some(SearchMediaType::Anime) | None => &["movie", "series"],
    };
    let fetch_genres = criteria
        .media_type
        .map(|media_type| catalog_fetch_genres(media_type, &criteria.genres))
        .unwrap_or_else(|| criteria.genres.clone());
    let genre_extras: Vec<Option<String>> = if fetch_genres.is_empty() {
        vec![None]
    } else {
        fetch_genres.into_iter().map(Some).collect()
    };

    let page = super::addon_registry::search_catalog_pages_for_genres(
        app,
        client,
        query,
        media_types,
        &genre_extras,
        criteria.continuation.search_cursors.as_deref(),
    )
    .await?;
    let items = retain_search_items_matching_genres(
        retain_titled_catalog_items(page.items),
        &criteria.genres,
        criteria.media_type,
    );
    let mut result = finish_catalog_page(
        rank_search_results(query, items, criteria.year_range),
        criteria.continuation,
        None,
        None,
        Some(page.cursors),
        page.claims,
    );
    result.partial = page.partial;
    Ok(result)
}

fn retain_titled_catalog_items(mut items: Vec<MediaItem>) -> Vec<MediaItem> {
    items.retain(|item| !item.title.is_empty());
    items
}

/// Genre enforcement for text search, where a provider may honor `search` while
/// ignoring `genre`. Hits often carry no genres (Cinemeta returns none), so only a
/// declared list can disqualify — strict matching would empty every filtered search.
fn retain_search_items_matching_genres(
    mut items: Vec<MediaItem>,
    genres: &[String],
    media_type: Option<SearchMediaType>,
) -> Vec<MediaItem> {
    let require_animation = media_type == Some(SearchMediaType::Anime);
    if genres.is_empty() && !require_animation {
        return items;
    }
    items.retain(|item| {
        item.genres.is_none()
            || ((!require_animation || item_has_genre(item, CINEMETA_ANIME_GENRE))
                && genres.iter().all(|genre| item_has_genre(item, genre)))
    });
    items
}

pub(super) fn catalog_browse_extras(genre: Option<&str>, skip: u32) -> Vec<CatalogExtra> {
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

async fn fetch_registry_browse_pages(
    snapshot: &[AddonConfig],
    client: &AddonResourceClient,
    media_type: SearchMediaType,
    catalog_id: &str,
    genres: &[Option<&str>],
    skips: &[u32],
    deadline: Option<tokio::time::Instant>,
) -> Vec<Result<CatalogFetchPage, String>> {
    let media_type = media_type.catalog_type();
    let groups = skips
        .iter()
        .flat_map(|skip| genres.iter().map(move |genre| (*skip, *genre)))
        .map(|(skip, genre)| {
            let extras = catalog_browse_extras(genre, skip);
            super::addon_registry::select_catalog_targets(snapshot, media_type, catalog_id, &extras)
                .map(|targets| (targets, extras))
        })
        .collect();
    super::addon_registry::fetch_catalog_pages_for_target_groups(
        client, media_type, groups, deadline,
    )
    .await
}

/// One first page per seed genre, sharing the captured registry and one fetch pool.
/// Keep pages separate: recommendation ranking uses each filtered page's positions.
pub(super) async fn fetch_genre_catalog_pages(
    snapshot: &[AddonConfig],
    client: &AddonResourceClient,
    media_type: &str,
    genres: Vec<String>,
) -> Result<Vec<Result<Vec<MediaItem>, String>>, String> {
    if genres.is_empty() {
        return Ok(Vec::new());
    }
    let media_type = SearchMediaType::parse(Some(media_type))
        .ok_or_else(|| "Media type is required to browse the search catalog.".to_string())?;
    let fetch_genres: Vec<_> = genres
        .into_iter()
        .map(|genre| catalog_fetch_genres(media_type, &normalize_genres(Some(vec![genre]))))
        .collect();
    // A single-genre request routes to one catalog, including anime's Animation fallback.
    let genres: Vec<_> = fetch_genres
        .iter()
        .map(|genres| genres.first().map(String::as_str))
        .collect();
    Ok(fetch_registry_browse_pages(
        snapshot,
        client,
        media_type,
        SearchFeed::Popular.cinemeta_catalog(),
        &genres,
        &[0],
        None,
    )
    .await
    .into_iter()
    .zip(fetch_genres)
    .map(|(page, fetch_genres)| {
        page.map(|page| {
            let mut items = apply_browse_filters(
                retain_titled_catalog_items(page.items),
                media_type,
                &fetch_genres,
                SearchYearRange::resolve(None, None),
            );
            let mut seen = HashSet::new();
            items.retain(|item| seen.insert(catalog_dedup_key(&item.type_, &item.id)));
            items
        })
    })
    .collect())
}

async fn fetch_registry_browse_batches(
    snapshot: &[AddonConfig],
    client: &AddonResourceClient,
    media_type: SearchMediaType,
    catalog_id: &str,
    genres: &[String],
    skips: &[u32],
    deadline: Option<tokio::time::Instant>,
) -> Vec<Result<CatalogFetchPage, String>> {
    let genre_groups: Vec<_> = genres
        .iter()
        .map(|genre| Some(genre.as_str()))
        .chain(genres.is_empty().then_some(None))
        .collect();
    let pages = fetch_registry_browse_pages(
        snapshot,
        client,
        media_type,
        catalog_id,
        &genre_groups,
        skips,
        deadline,
    )
    .await;
    let mut pages = pages.into_iter();
    skips
        .iter()
        .map(|_| {
            let pages: Vec<_> = pages.by_ref().take(genre_groups.len()).collect();
            if deadline.is_some() {
                if let Some(error) = pages.iter().find_map(|page| page.as_ref().err()) {
                    return Err(error.clone());
                }
            }
            super::addon_registry::merge_catalog_pages(pages, "Failed to load catalog.")
        })
        .collect()
}

async fn fetch_browse_page(
    snapshot: &[AddonConfig],
    client: &AddonResourceClient,
    criteria: &SearchCatalogCriteria,
    media_type: SearchMediaType,
    skip: u32,
) -> Result<(CatalogFetchPage, SearchCursorClaims), String> {
    let feed = criteria.feed;
    // Extra anime genres intersect Animation, not the general-TV genre catalogs.
    let filter_type = criteria
        .media_type
        .filter(|kind| *kind == SearchMediaType::Anime)
        .unwrap_or(media_type);
    let fetch_genres = if filter_type == SearchMediaType::Anime {
        vec![CINEMETA_ANIME_GENRE.to_string()]
    } else {
        criteria.genres.clone()
    };
    // Prefer the provider `year` catalog for a single pinned year; when no enabled
    // addon declares it, use the feed path with a client-side filter. `skip` is a
    // cursor into one result space, so the space is decided once by capability —
    // a fetch outcome cannot flip it or the client resumes with a foreign cursor.
    let mut year_catalog =
        browse_year_catalog(feed, media_type, &fetch_genres, criteria.year_range);
    if let Some(year) = year_catalog {
        let servable = super::addon_registry::select_catalog_targets(
            snapshot,
            media_type.catalog_type(),
            "year",
            &catalog_browse_extras(Some(&year.to_string()), skip),
        )
        .is_ok();
        if !servable {
            year_catalog = None;
        }
    }
    let year_genres = year_catalog.map(|year| [year.to_string()]);
    let catalog_genres = year_genres
        .as_ref()
        .map_or(fetch_genres.as_slice(), |genres| genres.as_slice());
    let catalog_id = if year_catalog.is_some() {
        "year"
    } else {
        feed.cinemeta_catalog()
    };
    let mut fetches = 0;
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    let mut claims = HashMap::new();
    let mut next_skip = Some(skip);
    let mut skips = vec![skip];
    let mut deadline = None;
    let mut stride = 0;
    let filtered = filter_type == SearchMediaType::Anime
        || criteria.year_range.is_active()
        || !criteria.genres.is_empty();

    'scan: loop {
        fetches += skips.len();
        let pages = fetch_registry_browse_batches(
            snapshot,
            client,
            media_type,
            catalog_id,
            catalog_genres,
            &skips,
            deadline,
        )
        .await;
        for (skip, result) in skips.into_iter().zip(pages) {
            // Speculative offsets are consumed only along the confirmed cursor chain.
            if next_skip != Some(skip) {
                break;
            }
            let page = match result {
                Ok(page) => page,
                // Keep the catalog's cursor space on failure: fail an empty
                // browse, or serve gathered items with the last good next_skip.
                Err(error) if claims.is_empty() => return Err(error),
                Err(_) => break 'scan,
            };
            next_skip = page.next_skip;
            stride = next_skip
                .and_then(|next| next.checked_sub(skip))
                .unwrap_or(0);
            let previous_claim_count = claims.len();
            claims.extend(page.items.iter().map(|item| {
                (
                    catalog_dedup_key(&item.type_, &item.id),
                    1_u64 << usize::from(media_type != SearchMediaType::Movie),
                )
            }));
            // Replayed pages cannot fill the grid, even when every title is filtered out.
            if claims.len() == previous_claim_count {
                next_skip = None;
            }

            let batch = apply_browse_filters(
                retain_titled_catalog_items(page.items),
                filter_type,
                &criteria.genres,
                criteria.year_range,
            );
            for item in batch {
                let key = catalog_dedup_key(&item.type_, &item.id);
                if seen.insert(key) {
                    items.push(item);
                }
            }

            if next_skip.is_none()
                || stride == 0
                || (!items.is_empty() && (!filtered || stride < BROWSE_PAGE_TARGET as u32))
                || items.len() >= BROWSE_PAGE_TARGET
            {
                break 'scan;
            }
        }
        let deadline =
            *deadline.get_or_insert_with(|| tokio::time::Instant::now() + BROWSE_SCAN_BUDGET);
        if fetches >= MAX_BROWSE_SOURCE_FETCHES || tokio::time::Instant::now() >= deadline {
            break;
        }
        let Some(next) = next_skip else { break };
        let window = if stride >= BROWSE_PAGE_TARGET as u32 {
            BROWSE_LOOKAHEAD_PAGES
        } else {
            1
        };
        skips = (0..window.min(MAX_BROWSE_SOURCE_FETCHES - fetches))
            .filter_map(|index| {
                stride
                    .checked_mul(index as u32)
                    .and_then(|offset| next.checked_add(offset))
            })
            .collect();
    }

    Ok((CatalogFetchPage { items, next_skip }, claims))
}

fn merge_all_browse_pages(
    continuation: SearchCatalogContinuation,
    movie: Option<Result<(CatalogFetchPage, SearchCursorClaims), String>>,
    series: Option<Result<(CatalogFetchPage, SearchCursorClaims), String>>,
) -> Result<SearchCatalogPage, String> {
    let cursors = continuation.all_cursors.unwrap_or_default();
    let mut next = AllBrowseCursors::default();
    let mut pages = [Vec::new(), Vec::new()];
    let mut claims = HashMap::new();
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
            Ok((page, page_claims)) => {
                succeeded = true;
                *cursor = page.next_skip.filter(|next_skip| *next_skip > skip);
                pages[index] = page.items;
                claims.reserve(page_claims.len());
                for (key, claimants) in page_claims {
                    *claims.entry(key).or_default() |= claimants;
                }
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
    Ok(finish_catalog_page(
        items,
        continuation,
        None,
        Some(next),
        None,
        claims,
    ))
}

pub(super) fn finish_catalog_page(
    items: Vec<MediaItem>,
    previous: SearchCatalogContinuation,
    next_skip: Option<u32>,
    all_cursors: Option<AllBrowseCursors>,
    search_cursors: Option<Vec<SearchSourceCursor>>,
    claims: SearchCursorClaims,
) -> SearchCatalogPage {
    let mut seen: HashSet<String> = previous.seen_keys.into_iter().collect();
    let mut source_pages: HashSet<String> = previous.source_pages.into_iter().collect();
    let mut progress = 0_u64;
    // Claims cover the page before genre/year filtering, so a source whose new titles
    // were all filtered out still advanced.
    for (key, claimant) in &claims {
        if !seen.contains(key) {
            progress |= claimant;
        }
    }
    let mut added_movie = search_cursors.is_none() && progress & 1 != 0;
    let mut added_series = search_cursors.is_none() && progress & 2 != 0;
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
    // Filtered-out titles are remembered too, or an addon that ignores `skip` would
    // replay them as progress forever.
    for key in claims.into_keys() {
        if seen.len() >= MAX_CATALOG_SEEN_KEYS {
            break;
        }
        seen.insert(key);
    }
    let continuation = SearchCatalogContinuation {
        skip: next_skip.filter(|next| {
            (!items.is_empty() || added_movie || added_series)
                && previous.skip.is_some_and(|skip| *next > skip)
        }),
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
        // Display deduplication must not stop a different source's advancing pages.
        search_cursors: search_cursors.map(|cursors| {
            cursors
                .into_iter()
                .enumerate()
                .filter_map(|(index, cursor)| {
                    let advanced = cursor.page_hash.as_ref().map_or_else(
                        || progress & (1_u64 << index) != 0,
                        |hash| {
                            source_pages.len() < MAX_CATALOG_SEEN_KEYS
                                && source_pages.insert(format!("{}:{hash}", cursor.key))
                        },
                    );
                    (cursor.retry || advanced).then_some(cursor)
                })
                .collect()
        }),
        source_pages: source_pages.into_iter().collect(),
        seen_keys: seen.into_iter().collect(),
    };
    SearchCatalogPage {
        exhausted: continuation.is_exhausted(),
        items,
        continuation,
        partial: false,
    }
}

#[command]
pub async fn query_search_catalog(
    app: AppHandle,
    client: State<'_, AddonResourceClient>,
    request: SearchCatalogRequest,
) -> Result<SearchCatalogPage, super::addon_registry::AddonResourceError> {
    Ok(query_search_catalog_for_request(&app, &client, request).await?)
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
            partial: false,
        });
    }

    if criteria.query.is_some() {
        return fetch_query_results(app, client, criteria).await;
    }

    let snapshot = super::addon_registry::load_enabled_addons_snapshot(app).await?;
    if let Some(cursors) = criteria.continuation.all_cursors {
        let fetch = |media_type, skip: Option<u32>| {
            let criteria = &criteria;
            let snapshot = snapshot.as_slice();
            async move {
                let skip = skip?;
                Some(fetch_browse_page(snapshot, client, criteria, media_type, skip).await)
            }
        };
        let (movie, series) = tokio::join!(
            fetch(SearchMediaType::Movie, cursors.movie),
            fetch(SearchMediaType::Series, cursors.series),
        );
        return merge_all_browse_pages(criteria.continuation, movie, series);
    }

    let skip = criteria.continuation.skip.unwrap_or(0);
    let media_type = criteria
        .media_type
        .ok_or_else(|| "Media type is required to browse the search catalog.".to_string())?;
    let (page, claims) = fetch_browse_page(&snapshot, client, &criteria, media_type, skip).await?;
    Ok(finish_catalog_page(
        page.items,
        criteria.continuation,
        page.next_skip,
        None,
        None,
        claims,
    ))
}

#[cfg(test)]
mod tests;
