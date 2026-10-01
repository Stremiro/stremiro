use super::{
    apply_browse_filters, browse_genres, browse_year_catalog, catalog_browse_extras,
    catalog_fetch_genres, retain_search_items_matching_genres, should_continue_browse_fetch,
    SearchFeed, SearchMediaType, SearchYearRange, CINEMETA_ANIME_GENRE,
};
use crate::commands::media_normalization::normalize_media_item;
use crate::providers::MediaItem;
use crate::test_helpers::test_media_item;

// Mirrors production: year filters and ordering read `primary_year`,
// which normalization computes from the raw year string.
fn build_item(id: &str, title: &str, year: Option<&str>) -> MediaItem {
    normalize_media_item(MediaItem {
        title: title.to_string(),
        year: year.map(str::to_string),
        ..test_media_item(id, "movie")
    })
}

/// No year constraint — the range most browse-filter tests pass through.
const NO_RANGE: SearchYearRange = SearchYearRange {
    year_from: None,
    year_to: None,
};

fn ids(items: &[MediaItem]) -> Vec<&str> {
    items.iter().map(|item| item.id.as_str()).collect()
}

#[test]
fn apply_browse_filters_enforces_requested_genres_provider_independently() {
    let mut horror = build_item("tt1", "Horror Night", Some("2024"));
    horror.genres = Some(vec!["Horror".to_string()]);
    let mut horror_comedy = build_item("tt2", "Horror Comedy", Some("2024"));
    horror_comedy.genres = Some(vec!["Horror".to_string(), "Comedy".to_string()]);
    let unlabeled = build_item("tt3", "Mystery", Some("2024"));

    let kept = apply_browse_filters(
        vec![horror, horror_comedy, unlabeled],
        SearchMediaType::Movie,
        &["Horror".to_string()],
        NO_RANGE,
    );
    assert_eq!(ids(&kept), vec!["tt1", "tt2"]);

    let mut animated = build_item("tt4", "Anime", Some("2024"));
    animated.genres = Some(vec!["Animation".to_string(), "Action".to_string()]);
    let live_action = build_item("tt5", "Live Action", Some("2024"));
    // Animation is also a real movie/series catalog genre — it enforces
    // like any other; the anime paths' marker gate sits on top, not here.
    let kept_animation_only = apply_browse_filters(
        vec![animated, live_action],
        SearchMediaType::Movie,
        &["Animation".to_string()],
        NO_RANGE,
    );
    assert_eq!(ids(&kept_animation_only), vec!["tt4"]);
}

#[test]
fn search_genre_filter_keeps_hits_without_declared_genres() {
    // Cinemeta search hits carry no genres: anime search must not drop them.
    let unlabeled = build_item("tt1", "Solo Leveling", Some("2024"));
    let mut animated = build_item("tt2", "Anime Action", Some("2024"));
    animated.genres = Some(vec!["Animation".to_string(), "Action".to_string()]);
    let mut live_action = build_item("tt3", "Live Action", Some("2024"));
    live_action.genres = Some(vec!["Action".to_string()]);

    let required = browse_genres(SearchMediaType::Anime, &["Action".to_string()]);
    let kept =
        retain_search_items_matching_genres(vec![unlabeled, animated, live_action], &required);
    assert_eq!(ids(&kept), vec!["tt1", "tt2"]);
}

#[test]
fn browse_genres_injects_cinemeta_animation_for_anime() {
    assert_eq!(
        browse_genres(SearchMediaType::Anime, &[]),
        vec![CINEMETA_ANIME_GENRE]
    );
    assert_eq!(
        browse_genres(SearchMediaType::Anime, &["Action".to_string()]),
        vec![CINEMETA_ANIME_GENRE, "Action"]
    );
    assert_eq!(
        browse_genres(SearchMediaType::Anime, &["animation".to_string()]),
        vec!["animation"]
    );
    assert!(browse_genres(SearchMediaType::Series, &[]).is_empty());
    assert_eq!(
        browse_genres(SearchMediaType::Movie, &["Action".to_string()]),
        vec!["Action"]
    );
}

#[test]
fn catalog_browse_extras_send_skip_only_when_advancing() {
    let first = catalog_browse_extras(Some("Animation"), 0);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].name, "genre");
    assert_eq!(first[0].value, "Animation");

    let next = catalog_browse_extras(Some("Animation"), 50);
    assert_eq!(next.len(), 2);
    assert_eq!(next[1].name, "skip");
    assert_eq!(next[1].value, "50");

    assert!(catalog_browse_extras(None, 0).is_empty());
    assert_eq!(catalog_browse_extras(None, 24)[0].value, "24");
}

#[test]
fn catalog_fetch_genres_does_not_union_animation_with_extra_anime_filters() {
    assert_eq!(
        catalog_fetch_genres(SearchMediaType::Anime, &[]),
        vec![CINEMETA_ANIME_GENRE]
    );
    assert_eq!(
        catalog_fetch_genres(SearchMediaType::Anime, &["Action".to_string()]),
        vec!["Action"]
    );
    assert_eq!(
        catalog_fetch_genres(SearchMediaType::Movie, &["Action".to_string()]),
        vec!["Action"]
    );
}

#[test]
fn apply_browse_filters_requires_declared_animation_genre() {
    let mut animated = build_item("tt1", "Anime Show", Some("2024"));
    animated.genres = Some(vec!["Animation".to_string(), "Action".to_string()]);
    let live_action = build_item("tt2", "Action Show", Some("2024"));
    let mut action_only = build_item("tt3", "Action Live", Some("2024"));
    action_only.genres = Some(vec!["Action".to_string()]);

    let kept = apply_browse_filters(
        vec![animated, live_action, action_only],
        SearchMediaType::Movie,
        &["Animation".to_string()],
        NO_RANGE,
    );
    assert_eq!(ids(&kept), vec!["tt1"]);
}

#[test]
fn apply_browse_filters_year_range_excludes_unknown_years_when_active() {
    let items = vec![
        build_item("tt1", "Match", Some("2024")),
        build_item("tt2", "Unknown", None),
        build_item("tt3", "Older", Some("2019")),
    ];
    let kept = apply_browse_filters(
        items,
        SearchMediaType::Movie,
        &[],
        SearchYearRange {
            year_from: Some(2024),
            year_to: Some(2024),
        },
    );
    assert_eq!(ids(&kept), vec!["tt1"]);
}

#[test]
fn apply_browse_filters_intersects_extra_anime_genres_with_animation() {
    let mut animated_action = build_item("tt1", "Anime Action", Some("2024"));
    animated_action.genres = Some(vec!["Animation".to_string(), "Action".to_string()]);
    let mut live_action = build_item("tt2", "Live Action", Some("2024"));
    live_action.genres = Some(vec!["Action".to_string()]);
    // Genre+marker matches that fail the year gate still drop.
    let mut old_match = build_item("tt3", "Old Anime Action", Some("2019"));
    old_match.genres = Some(vec!["Animation".to_string(), "Action".to_string()]);
    let mut unknown_year = build_item("tt4", "Undated Anime Action", None);
    unknown_year.genres = Some(vec!["Animation".to_string(), "Action".to_string()]);
    let mut wrong_genre = build_item("tt5", "Animated Comedy", Some("2024"));
    wrong_genre.genres = Some(vec!["Animation".to_string(), "Comedy".to_string()]);

    let kept = apply_browse_filters(
        vec![
            live_action,
            old_match,
            animated_action,
            unknown_year,
            wrong_genre,
        ],
        SearchMediaType::Anime,
        &["Action".to_string()],
        SearchYearRange {
            year_from: Some(2024),
            year_to: Some(2024),
        },
    );
    assert_eq!(ids(&kept), vec!["tt1"]);
}

#[test]
fn apply_browse_filters_intersects_multiple_movie_genres() {
    let mut action_only = build_item("tt1", "Action Only", Some("2024"));
    action_only.genres = Some(vec!["Action".to_string()]);
    let mut comedy_only = build_item("tt2", "Comedy Only", Some("2024"));
    comedy_only.genres = Some(vec!["Comedy".to_string()]);
    let mut both = build_item("tt3", "Action Comedy", Some("2024"));
    both.genres = Some(vec!["Action".to_string(), "Comedy".to_string()]);

    let kept = apply_browse_filters(
        vec![action_only, comedy_only, both],
        SearchMediaType::Movie,
        &["Action".to_string(), "Comedy".to_string()],
        NO_RANGE,
    );
    assert_eq!(ids(&kept), vec!["tt3"]);
}

#[test]
fn apply_browse_filters_enforces_animation_for_genre_free_anime_browse() {
    let mut animated = build_item("tt1", "Anime", Some("2024"));
    animated.genres = Some(vec![CINEMETA_ANIME_GENRE.to_string()]);
    let live_action = build_item("tt2", "Live Action", Some("2024"));

    let kept = apply_browse_filters(
        vec![animated, live_action],
        SearchMediaType::Anime,
        &["aNiMaTiOn".to_string()],
        NO_RANGE,
    );
    assert_eq!(ids(&kept), vec!["tt1"]);
}

#[test]
fn should_continue_browse_fetch_fills_sparse_pages_until_bound() {
    assert!(should_continue_browse_fetch(0, Some(50), 1));
    // Sparse intersections fill until the page is a usable batch.
    assert!(should_continue_browse_fetch(3, Some(50), 1));
    assert!(!should_continue_browse_fetch(24, Some(50), 1));
    assert!(!should_continue_browse_fetch(0, None, 1));
    assert!(!should_continue_browse_fetch(0, Some(50), 8));
}

#[test]
fn browse_year_catalog_serves_only_single_year_genre_free_popular_browse() {
    let single_2024 = SearchYearRange {
        year_from: Some(2024),
        year_to: Some(2024),
    };
    let range = SearchYearRange {
        year_from: Some(2020),
        year_to: Some(2024),
    };
    let none = NO_RANGE;
    let action = vec!["Action".to_string()];

    assert_eq!(
        browse_year_catalog(
            SearchFeed::Popular,
            SearchMediaType::Movie,
            &[],
            single_2024
        ),
        Some(2024)
    );
    assert_eq!(
        browse_year_catalog(
            SearchFeed::Popular,
            SearchMediaType::Series,
            &[],
            single_2024
        ),
        Some(2024)
    );
    // Featured keeps its feed ordering; anime keeps Animation routing.
    assert_eq!(
        browse_year_catalog(
            SearchFeed::Featured,
            SearchMediaType::Movie,
            &[],
            single_2024
        ),
        None
    );
    assert_eq!(
        browse_year_catalog(
            SearchFeed::Popular,
            SearchMediaType::Anime,
            &[],
            single_2024
        ),
        None
    );
    // Combined genre or range filters stay on the feed path.
    assert_eq!(
        browse_year_catalog(
            SearchFeed::Popular,
            SearchMediaType::Movie,
            &action,
            single_2024
        ),
        None
    );
    assert_eq!(
        browse_year_catalog(SearchFeed::Popular, SearchMediaType::Movie, &[], range),
        None
    );
    assert_eq!(
        browse_year_catalog(SearchFeed::Popular, SearchMediaType::Movie, &[], none),
        None
    );
}
